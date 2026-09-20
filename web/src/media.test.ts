import { describe, it, expect, vi } from "vitest";
import {
  Track,
  type LocalAudioTrack,
  type LocalTrackPublication,
  type LocalVideoTrack,
  type Room,
} from "livekit-client";
import { DEFAULT_STREAM_SETTINGS } from "./quality";
import {
  applyQuality,
  displayCaptureOptions,
  publishScreen,
  updateQuality,
  type PublishedTracks,
} from "./media";

describe("display audio routing", () => {
  it("requests tab audio, window-only audio, and system audio for monitors", () => {
    expect(displayCaptureOptions()).toEqual({
      video: true,
      audio: {
        channelCount: 2,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      systemAudio: "include",
      windowAudio: "window",
    });
  });
});

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
    expect(
      await applyQuality(track("ok"), {
        ...DEFAULT_STREAM_SETTINGS,
        resolution: "1080",
        fps: 60,
      }),
    ).toBe("");
  });

  for (const [browser, error] of [
    ["Firefox", firefoxError],
    ["Chrome", chromeError],
  ] as const)
    it(`переходит на запасные параметры, а не срывает эфир (${browser})`, async () => {
      const source = track(error, "ok");
      expect(
        await applyQuality(source, {
          ...DEFAULT_STREAM_SETTINGS,
          resolution: "2160",
          fps: 60,
        }),
      ).toContain("Используются доступные настройки");
      expect(source.applyConstraints).toHaveBeenLastCalledWith({
        frameRate: { ideal: 60, max: 60 },
      });
    });

  it("не срывает эфир, если запасные параметры тоже отклонены", async () => {
    expect(
      await applyQuality(track(firefoxError, firefoxError), {
        ...DEFAULT_STREAM_SETTINGS,
        resolution: "2160",
        fps: 60,
      }),
    ).toContain("Используются доступные настройки");
  });

  it("пробрасывает ошибки, не связанные с ограничениями", async () => {
    const stopped = new DOMException("track ended", "InvalidStateError");
    await expect(
      applyQuality(track(stopped), {
        ...DEFAULT_STREAM_SETTINGS,
        resolution: "1080",
        fps: 30,
      }),
    ).rejects.toBe(stopped);
  });
});

describe("publishScreen", () => {
  it("restores the selected clarity hint after SVC publication mutates it", async () => {
    const source = {
      kind: "video",
      contentHint: "",
    } as unknown as MediaStreamTrack;
    const publishedVideo = { mediaStreamTrack: source } as LocalVideoTrack;
    const videoPublication = {
      track: publishedVideo,
      videoTrack: publishedVideo,
    } as unknown as LocalTrackPublication;
    const publishTrack = vi.fn(async (candidate: MediaStreamTrack) => {
      if (candidate === source) {
        source.contentHint = "motion";
        return videoPublication;
      }
      return { track: candidate };
    });
    const room = { localParticipant: { publishTrack } } as unknown as Room;
    const stream = {
      getVideoTracks: () => [source],
      getAudioTracks: () => [],
    } as unknown as MediaStream;

    const published = await publishScreen(room, stream, {
      ...DEFAULT_STREAM_SETTINGS,
      codec: "vp9",
      balance: 35,
    });

    expect(source.contentHint).toBe("detail");
    expect(published.videoPublication).toBe(videoPublication);
  });

  it("публикует звук в стерео и без речевой обработки", async () => {
    const publishTrack = vi.fn(async (track: MediaStreamTrack) => ({ track }));
    const room = { localParticipant: { publishTrack } } as unknown as Room;
    const audio = { kind: "audio" } as MediaStreamTrack;
    const stream = {
      getVideoTracks: () => [{ kind: "video" } as MediaStreamTrack],
      getAudioTracks: () => [audio],
    } as unknown as MediaStream;

    await publishScreen(room, stream, {
      ...DEFAULT_STREAM_SETTINGS,
      resolution: "1080",
      fps: 60,
    });

    expect(audio.contentHint).toBe("music");
    expect(publishTrack).toHaveBeenLastCalledWith(audio, {
      source: Track.Source.ScreenShareAudio,
      audioPreset: {
        maxBitrate: DEFAULT_STREAM_SETTINGS.audioBitrateKbps * 1_000,
      },
      forceStereo: true,
      dtx: false,
    });
  });
});

it("публикует AV1 4K120 с ручными video/audio bitrate", async () => {
  const video = {
    kind: "video",
    applyConstraints: vi.fn().mockResolvedValue(undefined),
  } as unknown as MediaStreamTrack;
  const audio = { kind: "audio" } as MediaStreamTrack;
  const publishedVideo = { mediaStreamTrack: video } as LocalVideoTrack;
  const publishedAudio = { mediaStreamTrack: audio } as LocalAudioTrack;
  const videoPublication = {
    track: publishedVideo,
    videoTrack: publishedVideo,
  } as unknown as LocalTrackPublication;
  const publishTrack = vi
    .fn()
    .mockResolvedValueOnce(videoPublication)
    .mockResolvedValueOnce({ track: publishedAudio });
  const room = {
    localParticipant: { publishTrack, unpublishTrack: vi.fn() },
  } as unknown as Room;
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
    videoPublication,
    audio: publishedAudio,
  });
  expect(publishTrack).toHaveBeenNthCalledWith(
    1,
    video,
    expect.objectContaining({
      source: Track.Source.ScreenShare,
      simulcast: false,
      videoCodec: "av1",
      backupCodec: {
        codec: "vp8",
        encoding: { maxBitrate: 80_000_000, maxFramerate: 120 },
      },
      screenShareEncoding: { maxBitrate: 80_000_000, maxFramerate: 120 },
      degradationPreference: "maintain-resolution",
    }),
  );
  expect(publishTrack).toHaveBeenNthCalledWith(
    2,
    audio,
    expect.objectContaining({
      source: Track.Source.ScreenShareAudio,
      audioPreset: { maxBitrate: 320_000 },
      forceStereo: true,
      dtx: false,
    }),
  );
});

it("updates VP8 video in one awaited sender transaction", async () => {
  const videoSet = vi.fn().mockResolvedValue(undefined);
  const audioSet = vi.fn().mockResolvedValue(undefined);
  const source = {
    applyConstraints: vi.fn().mockResolvedValue(undefined),
    contentHint: "",
  } as unknown as MediaStreamTrack;
  const videoPublication = {
    options: { name: "screen" },
  } as unknown as LocalTrackPublication;
  const tracks = {
    video: {
      mediaStreamTrack: source,
      sender: {
        getParameters: () => ({ encodings: [{}] }),
        setParameters: videoSet,
      },
    } as unknown as LocalVideoTrack,
    videoPublication,
    audio: {
      sender: {
        getParameters: () => ({ encodings: [{}] }),
        setParameters: audioSet,
      },
    } as unknown as LocalAudioTrack,
  } satisfies PublishedTracks;

  const room = {
    localParticipant: {
      publishTrack: vi.fn(),
      unpublishTrack: vi.fn(),
    },
  } as unknown as Room;
  await updateQuality(room, tracks, DEFAULT_STREAM_SETTINGS, {
    ...DEFAULT_STREAM_SETTINGS,
    fps: 90,
    videoBitrateMbps: 42,
    audioBitrateKbps: 256,
    balance: 80,
  });

  expect(videoSet).toHaveBeenCalledWith(
    expect.objectContaining({
      encodings: [
        expect.objectContaining({ maxBitrate: 42_000_000, maxFramerate: 90 }),
      ],
      degradationPreference: "maintain-framerate",
    }),
  );
  expect(audioSet).toHaveBeenCalledWith(
    expect.objectContaining({
      encodings: [expect.objectContaining({ maxBitrate: 256_000 })],
    }),
  );
  expect(source.contentHint).toBe("motion");
  expect(videoSet).toHaveBeenCalledTimes(1);
  expect(videoPublication.options).toEqual(
    expect.objectContaining({
      name: "screen",
      videoCodec: "vp8",
      backupCodec: true,
      screenShareEncoding: {
        maxBitrate: 42_000_000,
        maxFramerate: 90,
      },
      degradationPreference: "maintain-framerate",
    }),
  );
  expect(room.localParticipant.unpublishTrack).not.toHaveBeenCalled();
});

it("keeps an advanced-codec video published for an audio-only update", async () => {
  const audioSet = vi.fn().mockResolvedValue(undefined);
  const source = {
    applyConstraints: vi.fn().mockResolvedValue(undefined),
    contentHint: "detail",
  } as unknown as MediaStreamTrack;
  const tracks = {
    video: { mediaStreamTrack: source } as LocalVideoTrack,
    videoPublication: {} as LocalTrackPublication,
    audio: {
      sender: {
        getParameters: () => ({ encodings: [{}] }),
        setParameters: audioSet,
      },
    } as unknown as LocalAudioTrack,
  } satisfies PublishedTracks;
  const publishTrack = vi.fn();
  const unpublishTrack = vi.fn();
  const room = {
    localParticipant: { publishTrack, unpublishTrack },
  } as unknown as Room;
  const previous = { ...DEFAULT_STREAM_SETTINGS, codec: "av1" as const };

  await updateQuality(room, tracks, previous, {
    ...previous,
    audioBitrateKbps: 256,
  });

  expect(audioSet).toHaveBeenCalledWith({
    encodings: [{ maxBitrate: 256_000 }],
  });
  expect(source.applyConstraints).not.toHaveBeenCalled();
  expect(unpublishTrack).not.toHaveBeenCalled();
  expect(publishTrack).not.toHaveBeenCalled();
});

it("republishes only advanced-codec video with the updated fallback template", async () => {
  const source = {
    applyConstraints: vi.fn().mockResolvedValue(undefined),
    contentHint: "motion",
  } as unknown as MediaStreamTrack;
  const oldVideo = { mediaStreamTrack: source } as LocalVideoTrack;
  const newVideo = { mediaStreamTrack: source } as LocalVideoTrack;
  const oldPublication = {
    track: oldVideo,
    videoTrack: oldVideo,
  } as unknown as LocalTrackPublication;
  const newPublication = {
    track: newVideo,
    videoTrack: newVideo,
  } as unknown as LocalTrackPublication;
  const audio = {} as LocalAudioTrack;
  const tracks = {
    video: oldVideo,
    videoPublication: oldPublication,
    audio,
  } satisfies PublishedTracks;
  const unpublishTrack = vi.fn().mockResolvedValue(oldPublication);
  const publishTrack = vi.fn(async () => {
    source.contentHint = "motion";
    return newPublication;
  });
  const room = {
    localParticipant: { publishTrack, unpublishTrack },
  } as unknown as Room;
  const previous = { ...DEFAULT_STREAM_SETTINGS, codec: "vp9" as const };
  const next = {
    ...previous,
    resolution: "2160" as const,
    fps: 90,
    videoBitrateMbps: 42,
    balance: 20,
  };

  const result = await updateQuality(room, tracks, previous, next);

  expect(unpublishTrack).toHaveBeenCalledWith(oldVideo, false);
  expect(publishTrack).toHaveBeenCalledWith(
    oldVideo,
    expect.objectContaining({
      source: Track.Source.ScreenShare,
      videoCodec: "vp9",
      screenShareEncoding: { maxBitrate: 42_000_000, maxFramerate: 90 },
      backupCodec: {
        codec: "vp8",
        encoding: { maxBitrate: 42_000_000, maxFramerate: 90 },
      },
      degradationPreference: "maintain-resolution",
    }),
  );
  expect(source.contentHint).toBe("detail");
  expect(result.tracks).toEqual({
    video: newVideo,
    videoPublication: newPublication,
    audio,
  });
  expect(result.videoRepublished).toBe(true);
});

it("propagates a rejected VP8 sender transaction and can restore confirmed parameters", async () => {
  const failure = new DOMException(
    "sender rejected",
    "InvalidModificationError",
  );
  const setParameters = vi
    .fn()
    .mockRejectedValueOnce(failure)
    .mockResolvedValueOnce(undefined);
  const source = {
    applyConstraints: vi.fn().mockResolvedValue(undefined),
    contentHint: "detail",
  } as unknown as MediaStreamTrack;
  const tracks = {
    video: {
      mediaStreamTrack: source,
      sender: {
        getParameters: () => ({ encodings: [{}] }),
        setParameters,
      },
    } as unknown as LocalVideoTrack,
    videoPublication: {} as LocalTrackPublication,
  } satisfies PublishedTracks;
  const room = { localParticipant: {} } as unknown as Room;
  const failed = {
    ...DEFAULT_STREAM_SETTINGS,
    fps: 90,
    videoBitrateMbps: 42,
    balance: 80,
  };

  await expect(
    updateQuality(room, tracks, DEFAULT_STREAM_SETTINGS, failed),
  ).rejects.toBe(failure);
  await expect(
    updateQuality(room, tracks, failed, DEFAULT_STREAM_SETTINGS),
  ).resolves.toMatchObject({ videoRepublished: false });
  expect(setParameters).toHaveBeenLastCalledWith({
    encodings: [{ maxBitrate: 12_000_000, maxFramerate: 60 }],
    degradationPreference: "maintain-resolution",
  });
});

it("can republish the previous advanced-codec video after a failed replacement", async () => {
  const failure = new Error("publish failed");
  const source = {
    applyConstraints: vi.fn().mockResolvedValue(undefined),
    contentHint: "detail",
  } as unknown as MediaStreamTrack;
  const video = { mediaStreamTrack: source } as LocalVideoTrack;
  const originalPublication = {
    track: video,
    videoTrack: video,
  } as unknown as LocalTrackPublication;
  const restoredPublication = {
    track: video,
    videoTrack: video,
  } as unknown as LocalTrackPublication;
  const tracks = {
    video,
    videoPublication: originalPublication,
  } satisfies PublishedTracks;
  const publishTrack = vi
    .fn()
    .mockRejectedValueOnce(failure)
    .mockResolvedValueOnce(restoredPublication);
  const room = {
    localParticipant: {
      unpublishTrack: vi.fn().mockResolvedValue(originalPublication),
      publishTrack,
    },
  } as unknown as Room;
  const confirmed = { ...DEFAULT_STREAM_SETTINGS, codec: "av1" as const };
  const failed = { ...confirmed, videoBitrateMbps: 40 };

  await expect(updateQuality(room, tracks, confirmed, failed)).rejects.toBe(
    failure,
  );
  const restored = await updateQuality(room, tracks, failed, confirmed);

  expect(publishTrack).toHaveBeenLastCalledWith(
    video,
    expect.objectContaining({
      videoCodec: "av1",
      screenShareEncoding: { maxBitrate: 12_000_000, maxFramerate: 60 },
      backupCodec: {
        codec: "vp8",
        encoding: { maxBitrate: 12_000_000, maxFramerate: 60 },
      },
    }),
  );
  expect(restored.tracks.videoPublication).toBe(restoredPublication);
});
