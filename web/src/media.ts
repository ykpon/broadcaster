import {
  LocalAudioTrack,
  type LocalTrackPublication,
  LocalVideoTrack,
  type Room,
  Track,
  type TrackPublishOptions,
} from "livekit-client";
import { constraints, qualityHints, type StreamSettings } from "./quality";

export type PublishedTracks = {
  video: LocalVideoTrack;
  videoPublication: LocalTrackPublication;
  audio?: LocalAudioTrack;
};

export type QualityUpdateResult = {
  note: string;
  tracks: PublishedTracks;
  videoRepublished: boolean;
};

const videoSettingsChanged = (previous: StreamSettings, next: StreamSettings) =>
  previous.resolution !== next.resolution ||
  previous.fps !== next.fps ||
  previous.videoBitrateMbps !== next.videoBitrateMbps ||
  previous.balance !== next.balance ||
  previous.codec !== next.codec;

const videoEncoding = (settings: StreamSettings) => ({
  maxBitrate: settings.videoBitrateMbps * 1_000_000,
  maxFramerate: settings.fps,
});

function videoPublishOptions(settings: StreamSettings): TrackPublishOptions {
  const hints = qualityHints(settings.balance);
  const encoding = videoEncoding(settings);
  return {
    source: Track.Source.ScreenShare,
    simulcast: false,
    videoCodec: settings.codec,
    backupCodec:
      settings.codec === "vp8"
        ? true
        : { codec: "vp8", encoding: { ...encoding } },
    screenShareEncoding: { ...encoding },
    degradationPreference: hints.degradationPreference,
  };
}

async function publishVideo(
  room: Room,
  video: MediaStreamTrack | LocalVideoTrack,
  settings: StreamSettings,
): Promise<{ video: LocalVideoTrack; publication: LocalTrackPublication }> {
  const hints = qualityHints(settings.balance);
  const source = "mediaStreamTrack" in video ? video.mediaStreamTrack : video;
  source.contentHint = hints.contentHint;
  const options = videoPublishOptions(settings);
  const publication = await room.localParticipant.publishTrack(video, options);
  const publishedVideo = (publication.videoTrack ??
    publication.track) as LocalVideoTrack;
  // LiveKit forces SVC screen shares to `motion` while publishing. The user's
  // clarity choice is authoritative once the sender has been created.
  source.contentHint = hints.contentHint;
  if (publishedVideo?.mediaStreamTrack)
    publishedVideo.mediaStreamTrack.contentHint = hints.contentHint;
  // This is also the documented template LiveKit uses if it creates VP8 later.
  publication.options = { ...publication.options, ...options };
  return { video: publishedVideo, publication };
}

export async function applyQuality(
  track: MediaStreamTrack,
  settings: StreamSettings,
): Promise<string> {
  try {
    await track.applyConstraints(constraints(settings));
    return "";
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "OverconstrainedError")
      throw error;
    await track
      .applyConstraints({
        frameRate: { ideal: settings.fps, max: settings.fps },
      })
      .catch(() => {});
    return "Источник не поддерживает выбранные параметры. Используются доступные настройки.";
  }
}

export async function publishScreen(
  room: Room,
  stream: MediaStream,
  settings: StreamSettings,
): Promise<PublishedTracks> {
  const video = stream.getVideoTracks()[0];
  const published = await publishVideo(room, video, settings);
  try {
    const audio = stream.getAudioTracks()[0];
    if (!audio)
      return {
        video: published.video,
        videoPublication: published.publication,
      };
    audio.contentHint = "music";
    const audioResult = await room.localParticipant.publishTrack(audio, {
      source: Track.Source.ScreenShareAudio,
      audioPreset: { maxBitrate: settings.audioBitrateKbps * 1_000 },
      forceStereo: true,
      dtx: false,
    });
    return {
      video: published.video,
      videoPublication: published.publication,
      audio: (audioResult.audioTrack ?? audioResult.track) as LocalAudioTrack,
    };
  } catch (error) {
    await room.localParticipant.unpublishTrack(published.video, false);
    throw error;
  }
}

export async function updateQuality(
  room: Room,
  tracks: PublishedTracks,
  previous: StreamSettings,
  next: StreamSettings,
): Promise<QualityUpdateResult> {
  if (tracks.audio && previous.audioBitrateKbps !== next.audioBitrateKbps) {
    const audioSender = tracks.audio.sender;
    if (audioSender) {
      const params = audioSender.getParameters();
      for (const encoding of params.encodings ?? [])
        encoding.maxBitrate = next.audioBitrateKbps * 1_000;
      await audioSender.setParameters(params);
    }
  }

  if (!videoSettingsChanged(previous, next)) {
    return { note: "", tracks, videoRepublished: false };
  }

  const note = await applyQuality(tracks.video.mediaStreamTrack, next);
  const hints = qualityHints(next.balance);
  tracks.video.mediaStreamTrack.contentHint = hints.contentHint;

  if (next.codec !== "vp8") {
    await room.localParticipant.unpublishTrack(tracks.video, false);
    const published = await publishVideo(room, tracks.video, next);
    return {
      note,
      tracks: {
        ...tracks,
        video: published.video,
        videoPublication: published.publication,
      },
      videoRepublished: true,
    };
  }

  const videoSender = tracks.video.sender;
  if (videoSender) {
    const params = videoSender.getParameters();
    for (const encoding of params.encodings ?? []) {
      encoding.maxBitrate = next.videoBitrateMbps * 1_000_000;
      encoding.maxFramerate = next.fps;
    }
    params.degradationPreference = hints.degradationPreference;
    await videoSender.setParameters(params);
  }
  tracks.videoPublication.options = {
    ...tracks.videoPublication.options,
    ...videoPublishOptions(next),
  };
  return { note, tracks, videoRepublished: false };
}
