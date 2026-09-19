import { describe, it, expect, vi } from "vitest";
import { Track, type LocalAudioTrack, type LocalVideoTrack, type Room } from "livekit-client";
import { DEFAULT_STREAM_SETTINGS } from "./quality";
import { applyQuality, publishScreen, updateQuality, type PublishedTracks } from "./media";

// Gecko rejects with a plain Error: Firefox exposes no OverconstrainedError
// interface at all (MDN BCD api.OverconstrainedError → firefox: false).
const firefoxError = Object.assign(
  new Error("Constraints could not be satisfied."),
  {
    name: "OverconstrainedError",
  },
);
const chromeError = new DOMException(
  "Cannot satisfy constraints",
  "OverconstrainedError",
);

function track(...outcomes: ("ok" | Error)[]) {
  const applyConstraints = vi.fn(() => {
    const outcome = outcomes.shift() ?? "ok";
    return outcome === "ok" ? Promise.resolve() : Promise.reject(outcome);
  });
  return { applyConstraints } as unknown as MediaStreamTrack & {
    applyConstraints: ReturnType<typeof vi.fn>;
  };
}

describe("applyQuality", () => {
  it("молчит, когда источник принял параметры", async () => {
    expect(await applyQuality(track("ok"), { ...DEFAULT_STREAM_SETTINGS, resolution: "1080", fps: 60 })).toBe("");
  });

  for (const [browser, error] of [
    ["Firefox", firefoxError],
    ["Chrome", chromeError],
  ] as const)
    it(`переходит на запасные параметры, а не срывает эфир (${browser})`, async () => {
      const source = track(error, "ok");
      expect(await applyQuality(source, { ...DEFAULT_STREAM_SETTINGS, resolution: "2160", fps: 60 })).toContain(
        "Используются доступные настройки",
      );
      expect(source.applyConstraints).toHaveBeenLastCalledWith({
        frameRate: { ideal: 60 },
      });
    });

  it("не срывает эфир, если запасные параметры тоже отклонены", async () => {
    expect(
      await applyQuality(track(firefoxError, firefoxError), { ...DEFAULT_STREAM_SETTINGS, resolution: "2160", fps: 60 }),
    ).toContain("Используются доступные настройки");
  });

  it("пробрасывает ошибки, не связанные с ограничениями", async () => {
    const stopped = new DOMException("track ended", "InvalidStateError");
    await expect(applyQuality(track(stopped), { ...DEFAULT_STREAM_SETTINGS, resolution: "1080", fps: 30 })).rejects.toBe(
      stopped,
    );
  });
});

describe("publishScreen", () => {
  it("публикует звук в стерео и без речевой обработки", async () => {
    const publishTrack = vi.fn(async (track: MediaStreamTrack) => ({ track }));
    const room = { localParticipant: { publishTrack } } as unknown as Room;
    const audio = { kind: "audio" } as MediaStreamTrack;
    const stream = {
      getVideoTracks: () => [{ kind: "video" } as MediaStreamTrack],
      getAudioTracks: () => [audio],
    } as unknown as MediaStream;

    await publishScreen(room, stream, { ...DEFAULT_STREAM_SETTINGS, resolution: "1080", fps: 60 });

    expect(audio.contentHint).toBe("music");
    expect(publishTrack).toHaveBeenLastCalledWith(audio, {
      source: Track.Source.ScreenShareAudio,
      audioPreset: { maxBitrate: DEFAULT_STREAM_SETTINGS.audioBitrateKbps * 1_000 },
      forceStereo: true,
      dtx: false,
    });
  });
});

it("публикует AV1 4K120 с ручными video/audio bitrate", async () => {
  const video = { kind: "video", applyConstraints: vi.fn().mockResolvedValue(undefined) } as unknown as MediaStreamTrack;
  const audio = { kind: "audio" } as MediaStreamTrack;
  const publishedVideo = { mediaStreamTrack: video } as LocalVideoTrack;
  const publishedAudio = { mediaStreamTrack: audio } as LocalAudioTrack;
  const publishTrack = vi.fn()
    .mockResolvedValueOnce({ track: publishedVideo })
    .mockResolvedValueOnce({ track: publishedAudio });
  const room = { localParticipant: { publishTrack, unpublishTrack: vi.fn() } } as unknown as Room;
  const stream = {
    getVideoTracks: () => [video],
    getAudioTracks: () => [audio],
  } as unknown as MediaStream;
  const settings = {
    ...DEFAULT_STREAM_SETTINGS,
    resolution: "2160" as const,
    fps: 120,
    videoBitrateMbps: 80,
    audioBitrateKbps: 320,
    codec: "av1" as const,
  };

  expect(await publishScreen(room, stream, settings)).toEqual({
    video: publishedVideo,
    audio: publishedAudio,
  });
  expect(publishTrack).toHaveBeenNthCalledWith(1, video, expect.objectContaining({
    source: Track.Source.ScreenShare,
    simulcast: false,
    videoCodec: "av1",
    backupCodec: true,
    screenShareEncoding: { maxBitrate: 80_000_000, maxFramerate: 120 },
    degradationPreference: "maintain-resolution",
  }));
  expect(publishTrack).toHaveBeenNthCalledWith(2, audio, expect.objectContaining({
    source: Track.Source.ScreenShareAudio,
    audioPreset: { maxBitrate: 320_000 },
    forceStereo: true,
    dtx: false,
  }));
});

it("обновляет параметры обоих sender без перепубликации", async () => {
  const videoSet = vi.fn().mockResolvedValue(undefined);
  const audioSet = vi.fn().mockResolvedValue(undefined);
  const source = { applyConstraints: vi.fn().mockResolvedValue(undefined), contentHint: "" } as unknown as MediaStreamTrack;
  const tracks = {
    video: {
      mediaStreamTrack: source,
      sender: { getParameters: () => ({ encodings: [{}] }), setParameters: videoSet },
      setDegradationPreference: vi.fn().mockResolvedValue(undefined),
    } as unknown as LocalVideoTrack,
    audio: {
      sender: { getParameters: () => ({ encodings: [{}] }), setParameters: audioSet },
    } as unknown as LocalAudioTrack,
  } satisfies PublishedTracks;

  await updateQuality(tracks, {
    ...DEFAULT_STREAM_SETTINGS,
    fps: 90,
    videoBitrateMbps: 42,
    audioBitrateKbps: 256,
    balance: 80,
  });

  expect(videoSet).toHaveBeenCalledWith(expect.objectContaining({
    encodings: [expect.objectContaining({ maxBitrate: 42_000_000, maxFramerate: 90 })],
  }));
  expect(audioSet).toHaveBeenCalledWith(expect.objectContaining({
    encodings: [expect.objectContaining({ maxBitrate: 256_000 })],
  }));
  expect(source.contentHint).toBe("motion");
  expect(tracks.video.setDegradationPreference).toHaveBeenCalledWith("maintain-framerate");
});
