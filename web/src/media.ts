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
    if (
      !(error instanceof DOMException) ||
      error.name !== "OverconstrainedError"
    )
      throw error;
    await track.applyConstraints({ frameRate: { ideal: fps } });
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
  video.contentHint = "motion";
  const result = await room.localParticipant.publishTrack(video, {
    source: Track.Source.ScreenShare,
    simulcast: false,
    videoCodec: "vp8",
    screenShareEncoding: { maxBitrate: bitrate(res, fps), maxFramerate: fps },
    degradationPreference: "balanced",
  });
  try {
    const audio = stream.getAudioTracks()[0];
    if (audio)
      await room.localParticipant.publishTrack(audio, {
        source: Track.Source.ScreenShareAudio,
        audioPreset: { maxBitrate: 128_000 },
        dtx: false,
      });
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
