import { LocalVideoTrack, type Room, Track } from "livekit-client";
import { bitrate, constraints, type FPS, type Resolution } from "./quality";

export async function applyQuality(
  track: MediaStreamTrack,
  res: Resolution,
  fps: FPS,
) {
  try {
    await track.applyConstraints(constraints(res, fps));
    return "";
  } catch (error) {
    // Firefox has no OverconstrainedError interface (MDN BCD: api.OverconstrainedError
    // firefox = false) and rejects with a plain Error named OverconstrainedError, so an
    // instanceof DOMException check silently skips the fallback there and kills the
    // whole broadcast. Chrome and Safari inherit DOMException, which inherits Error.
    if (!(error instanceof Error) || error.name !== "OverconstrainedError")
      throw error;
    // Gecko refuses applyConstraints outright on some capture sources, so the retry can
    // fail too. The note below is the report; a quality preference is never worth
    // losing the stream over.
    await track.applyConstraints({ frameRate: { ideal: fps } }).catch(() => {});
    return "Источник не поддерживает выбранные параметры. Используются доступные настройки.";
  }
}
export async function publishScreen(
  room: Room,
  stream: MediaStream,
  res: Resolution,
  fps: FPS,
) {
  const video = stream.getVideoTracks()[0];
  // Screen content is detail-bound, not motion-bound: "motion" lets Chrome trade
  // resolution away for frame rate and, on tab capture, pushes that demand all the
  // way down to the capturer, which then delivers a downscaled surface.
  video.contentHint = "detail";
  const result = await room.localParticipant.publishTrack(video, {
    source: Track.Source.ScreenShare,
    simulcast: false,
    videoCodec: "vp8",
    screenShareEncoding: { maxBitrate: bitrate(res, fps), maxFramerate: fps },
    // Readable text beats smooth motion for a shared screen; "balanced" permits
    // sacrificing both resolution and frame rate at once.
    degradationPreference: "maintain-resolution",
  });
  try {
    const audio = stream.getAudioTracks()[0];
    if (audio) {
      // Opus stays mono unless stereo is negotiated, and without a hint the encoder is
      // tuned for speech. Both collapse game and music audio into a flat mix.
      audio.contentHint = "music";
      await room.localParticipant.publishTrack(audio, {
        source: Track.Source.ScreenShareAudio,
        audioPreset: { maxBitrate: 128_000 },
        forceStereo: true,
        dtx: false,
      });
    }
  } catch (error) {
    await room.localParticipant.unpublishTrack(video, false);
    throw error;
  }
  return result.track as LocalVideoTrack;
}
export async function updateQuality(
  track: LocalVideoTrack,
  res: Resolution,
  fps: FPS,
) {
  const note = await applyQuality(track.mediaStreamTrack, res, fps);
  const sender = track.sender;
  if (sender) {
    const params = sender.getParameters();
    for (const encoding of params.encodings) {
      encoding.maxBitrate = bitrate(res, fps);
      encoding.maxFramerate = fps;
    }
    await sender.setParameters(params);
  }
  return note;
}
