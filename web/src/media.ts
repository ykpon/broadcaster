import { LocalAudioTrack, LocalVideoTrack, type Room, Track } from "livekit-client";
import { constraints, qualityHints, type StreamSettings } from "./quality";

export type PublishedTracks = { video: LocalVideoTrack; audio?: LocalAudioTrack };

export async function applyQuality(track: MediaStreamTrack, settings: StreamSettings): Promise<string> {
  try {
    await track.applyConstraints(constraints(settings));
    return "";
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "OverconstrainedError") throw error;
    await track.applyConstraints({ frameRate: { ideal: settings.fps } }).catch(() => {});
    return "Источник не поддерживает выбранные параметры. Используются доступные настройки.";
  }
}

export async function publishScreen(room: Room, stream: MediaStream, settings: StreamSettings): Promise<PublishedTracks> {
  const video = stream.getVideoTracks()[0];
  const hints = qualityHints(settings.balance);
  video.contentHint = hints.contentHint;
  const result = await room.localParticipant.publishTrack(video, {
    source: Track.Source.ScreenShare,
    simulcast: false,
    videoCodec: settings.codec,
    backupCodec: true,
    screenShareEncoding: { maxBitrate: settings.videoBitrateMbps * 1_000_000, maxFramerate: settings.fps },
    degradationPreference: hints.degradationPreference,
  });
  try {
    const audio = stream.getAudioTracks()[0];
    if (!audio) return { video: result.track as LocalVideoTrack };
    audio.contentHint = "music";
    const audioResult = await room.localParticipant.publishTrack(audio, {
      source: Track.Source.ScreenShareAudio,
      audioPreset: { maxBitrate: settings.audioBitrateKbps * 1_000 },
      forceStereo: true,
      dtx: false,
    });
    return { video: result.track as LocalVideoTrack, audio: audioResult.track as LocalAudioTrack };
  } catch (error) {
    await room.localParticipant.unpublishTrack(video, false);
    throw error;
  }
}

export async function updateQuality(tracks: PublishedTracks, settings: StreamSettings): Promise<string> {
  const note = await applyQuality(tracks.video.mediaStreamTrack, settings);
  const hints = qualityHints(settings.balance);
  tracks.video.mediaStreamTrack.contentHint = hints.contentHint;
  const videoSender = tracks.video.sender;
  if (videoSender) {
    const params = videoSender.getParameters();
    for (const encoding of params.encodings ?? []) {
      encoding.maxBitrate = settings.videoBitrateMbps * 1_000_000;
      encoding.maxFramerate = settings.fps;
    }
    await videoSender.setParameters(params);
  }
  await tracks.video.setDegradationPreference(hints.degradationPreference);
  const audioSender = tracks.audio?.sender;
  if (audioSender) {
    const params = audioSender.getParameters();
    for (const encoding of params.encodings ?? []) encoding.maxBitrate = settings.audioBitrateKbps * 1_000;
    await audioSender.setParameters(params);
  }
  return note;
}
