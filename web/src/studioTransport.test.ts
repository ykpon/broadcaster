import { describe, expect, it, vi } from "vitest";
import { RoomEvent } from "livekit-client";
import { DEFAULT_STREAM_SETTINGS } from "./quality";
import { createLiveKitPublisher } from "./studioTransport";

describe("LiveKit publisher", () => {
  it("connects, publishes, updates, mutes, and disposes through one interface", async () => {
    const events: string[] = [];
    const source = {
      kind: "video",
      contentHint: "",
      applyConstraints: vi.fn(async () => {}),
      stop: vi.fn(),
    } as unknown as MediaStreamTrack & { stop: ReturnType<typeof vi.fn> };
    const audioSource = {
      kind: "audio",
      contentHint: "",
      stop: vi.fn(),
    } as unknown as MediaStreamTrack & { stop: ReturnType<typeof vi.fn> };
    const video = {
      mediaStreamTrack: source,
      sender: {
        getParameters: () => ({ encodings: [{}] }),
        setParameters: vi.fn(async () => {
          events.push("update");
        }),
      },
    };
    const audio = {
      mediaStreamTrack: audioSource,
      mute: vi.fn(async () => {
        events.push("mute:true");
      }),
      unmute: vi.fn(async () => {}),
    };
    const publication = { videoTrack: video, track: video, options: {} };
    const audioPublication = { audioTrack: audio, track: audio, options: {} };
    const participant = {
      publishTrack: vi.fn(async (candidate: MediaStreamTrack) => {
        if (candidate === source) events.push("publish");
        return candidate === source ? publication : audioPublication;
      }),
      getTrackPublication: vi.fn(() => publication),
      unpublishTrack: vi.fn(async () => {
        events.push("unpublish");
      }),
    };
    class FakeRoom {
      localParticipant = participant;
      on() {
        return this;
      }
      off() {
        return this;
      }
      async connect() {
        events.push("connect");
      }
      async disconnect() {
        events.push("disconnect");
      }
    }
    const stream = {
      getVideoTracks: () => [source],
      getAudioTracks: () => [audioSource],
      getTracks: () => [source, audioSource],
    } as unknown as MediaStream;
    const publisher = createLiveKitPublisher({}, { Room: FakeRoom as never });
    await publisher.start({
      generation: 1,
      stream,
      settings: DEFAULT_STREAM_SETTINGS,
      livekit: { url: "ws://livekit", token: "token" },
      send: () => {},
    });
    await publisher.updateSettings(DEFAULT_STREAM_SETTINGS, {
      ...DEFAULT_STREAM_SETTINGS,
      fps: 90,
    });
    await publisher.setMuted(true);
    await publisher.stop();
    expect(events).toEqual([
      "connect",
      "publish",
      "update",
      "mute:true",
      "unpublish",
      "unpublish",
      "disconnect",
    ]);
    expect(source.stop).not.toHaveBeenCalled();
    expect(audioSource.stop).not.toHaveBeenCalled();
  });

  it("ignores disconnect callbacks from a stopped generation", async () => {
    const disconnected: number[] = [];
    const rooms: FakeRoom[] = [];
    class FakeRoom {
      listeners = new Map<string, (value?: unknown) => void>();
      localParticipant = {
        publishTrack: async () => ({
          videoTrack: { mediaStreamTrack: {} },
          track: { mediaStreamTrack: {} },
          options: {},
        }),
        getTrackPublication: () => ({}),
        unpublishTrack: async () => {},
      };
      constructor() {
        rooms.push(this);
      }
      on(event: string, callback: (value?: unknown) => void) {
        this.listeners.set(event, callback);
        return this;
      }
      async connect() {}
      async disconnect() {}
      emit(event: string) {
        this.listeners.get(event)?.();
      }
    }
    const stream = {
      getVideoTracks: () => [{ contentHint: "" }],
      getAudioTracks: () => [],
    } as unknown as MediaStream;
    const publisher = createLiveKitPublisher(
      {
        onDisconnected: (generation) => disconnected.push(generation),
      },
      { Room: FakeRoom as never },
    );
    const input = {
      stream,
      settings: DEFAULT_STREAM_SETTINGS,
      livekit: { url: "ws://livekit", token: "token" },
      send: () => {},
    };
    await publisher.start({ ...input, generation: 1 });
    await publisher.stop();
    await publisher.start({ ...input, generation: 2 });
    rooms[0].emit(RoomEvent.Disconnected);
    expect(disconnected).toEqual([]);
    rooms[1].emit(RoomEvent.Disconnected);
    expect(disconnected).toEqual([2]);
    await publisher.stop();
  });

  it("stops an in-flight start once without stopping the captured source", async () => {
    let releasePublish: (() => void) | undefined;
    const publishing = new Promise<void>((resolve) => {
      releasePublish = resolve;
    });
    const source = {
      kind: "video",
      contentHint: "",
      stop: vi.fn(),
    } as unknown as MediaStreamTrack & { stop: ReturnType<typeof vi.fn> };
    const video = { mediaStreamTrack: source };
    const participant = {
      publishTrack: async () => {
        await publishing;
        return { videoTrack: video, track: video, options: {} };
      },
      getTrackPublication: () => ({}),
      unpublishTrack: vi.fn(async () => {}),
    };
    const disconnect = vi.fn(async () => {});
    class FakeRoom {
      localParticipant = participant;
      on() {
        return this;
      }
      async connect() {}
      disconnect = disconnect;
    }
    const stream = {
      getVideoTracks: () => [source],
      getAudioTracks: () => [],
    } as unknown as MediaStream;
    const publisher = createLiveKitPublisher({}, { Room: FakeRoom as never });
    const starting = publisher.start({
      generation: 1,
      stream,
      settings: DEFAULT_STREAM_SETTINGS,
      livekit: { url: "ws://livekit", token: "token" },
      send: () => {},
    });
    await Promise.resolve();
    const stopping = publisher.stop();
    releasePublish?.();
    await Promise.all([starting, stopping]);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledWith(false);
    expect(source.stop).not.toHaveBeenCalled();
  });

  it("waits for an in-flight quality update before unpublishing", async () => {
    let releaseUpdate: (() => void) | undefined;
    const updating = new Promise<void>((resolve) => {
      releaseUpdate = resolve;
    });
    const source = {
      kind: "video",
      contentHint: "",
      applyConstraints: vi.fn(async () => {}),
      stop: vi.fn(),
    } as unknown as MediaStreamTrack & { stop: ReturnType<typeof vi.fn> };
    const video = {
      mediaStreamTrack: source,
      sender: {
        getParameters: () => ({ encodings: [{}] }),
        setParameters: vi.fn(() => updating),
      },
    };
    const publication = { videoTrack: video, track: video, options: {} };
    const participant = {
      publishTrack: async () => publication,
      getTrackPublication: () => publication,
      unpublishTrack: vi.fn(async () => {}),
    };
    const disconnect = vi.fn(async () => {});
    class FakeRoom {
      localParticipant = participant;
      on() {
        return this;
      }
      async connect() {}
      disconnect = disconnect;
    }
    const stream = {
      getVideoTracks: () => [source],
      getAudioTracks: () => [],
    } as unknown as MediaStream;
    const publisher = createLiveKitPublisher({}, { Room: FakeRoom as never });
    await publisher.start({
      generation: 1,
      stream,
      settings: DEFAULT_STREAM_SETTINGS,
      livekit: { url: "ws://livekit", token: "token" },
      send: () => {},
    });
    const quality = publisher.updateSettings(DEFAULT_STREAM_SETTINGS, {
      ...DEFAULT_STREAM_SETTINGS,
      fps: 90,
    });
    await Promise.resolve();
    const stopping = publisher.stop();
    await Promise.resolve();
    expect(participant.unpublishTrack).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();
    releaseUpdate?.();
    await Promise.all([quality, stopping]);
    expect(participant.unpublishTrack).toHaveBeenCalledWith(video, false);
    expect(disconnect).toHaveBeenCalledWith(false);
    expect(source.stop).not.toHaveBeenCalled();
  });
});
