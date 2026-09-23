import { Room, RoomEvent, type LocalAudioTrack, type LocalVideoTrack } from "livekit-client";
import {
  publishScreen,
  unpublishScreen,
  updateQuality,
  type PublishedTracks,
} from "./media";
import type { StreamSettings } from "./quality";
import type { LiveKitConnection, TransportMode } from "./protocol";
import type { ControlSocketSignal } from "./controlSocket";

export type RTCStatsProvider = { getStats(): Promise<RTCStatsReport> };
export type PublisherStatsSources = {
  video?: RTCStatsProvider;
  audio?: RTCStatsProvider;
};
export type PublisherStart = {
  generation: number;
  stream: MediaStream;
  settings: StreamSettings;
  livekit?: LiveKitConnection;
  iceServers?: RTCIceServer[];
  send(signal: ControlSocketSignal): void;
};
export type PublisherQualityUpdateResult = {
  note: string;
  videoRepublished: boolean;
};
export type PublisherConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "signalReconnecting";
export type StudioPublisher = {
  readonly kind: TransportMode;
  start(input: PublisherStart): Promise<void>;
  updateSettings(
    previous: StreamSettings,
    next: StreamSettings,
  ): Promise<PublisherQualityUpdateResult>;
  getStatsSources(): PublisherStatsSources;
  setMuted(muted: boolean): Promise<void>;
  stop(): Promise<void>;
};
export type PublisherCallbacks = {
  onConnectionState?(generation: number, state: PublisherConnectionState): void;
  onDisconnected?(generation: number): void;
  onPublishedTracksChanged?(
    generation: number,
    sources: PublisherStatsSources,
  ): void;
};

type RoomConstructor = new (
  options: ConstructorParameters<typeof Room>[0],
) => Room;

function statsProvider(
  track: LocalVideoTrack | LocalAudioTrack | undefined,
): RTCStatsProvider | undefined {
  if (!track) return undefined;
  return {
    async getStats() {
      const report = await track.getRTCStatsReport();
      if (!report) throw new Error("RTC stats unavailable");
      return report;
    },
  };
}

export function createLiveKitPublisher(
  callbacks: PublisherCallbacks,
  dependencies: { Room: RoomConstructor } = { Room },
): StudioPublisher {
  let room: Room | undefined;
  let tracks: PublishedTracks | undefined;
  let sources: PublisherStatsSources = {};
  let generation = 0;
  let epoch = 0;
  let startPromise: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  const updates = new Set<Promise<PublisherQualityUpdateResult>>();
  const disposals = new WeakMap<Room, Promise<void>>();

  function updateSources(next: PublishedTracks | undefined) {
    sources = {
      video: statsProvider(next?.video),
      audio: statsProvider(next?.audio),
    };
    callbacks.onPublishedTracksChanged?.(generation, sources);
  }

  function disposeRoom(
    current: Room,
    published: PublishedTracks | undefined,
  ): Promise<void> {
    const existing = disposals.get(current);
    if (existing) return existing;
    const operation = (async () => {
      try {
        if (published) {
          await unpublishScreen(current, published);
        }
      } finally {
        await current.disconnect(false);
      }
    })();
    disposals.set(current, operation);
    return operation;
  }

  return {
    kind: "server",
    start(input) {
      if (room || startPromise || stopPromise)
        return Promise.reject(new Error("Publisher already started"));
      if (!input.livekit)
        return Promise.reject(new Error("LiveKit connection is required"));
      const currentEpoch = ++epoch;
      generation = input.generation;
      const current = new dependencies.Room({
        adaptiveStream: false,
        dynacast: false,
      });
      room = current;
      current.on(RoomEvent.ConnectionStateChanged, (state) => {
        if (epoch === currentEpoch && room === current)
          callbacks.onConnectionState?.(input.generation, state);
      });
      current.on(RoomEvent.Disconnected, () => {
        if (epoch === currentEpoch && room === current)
          callbacks.onDisconnected?.(input.generation);
      });
      const operation = (async () => {
        try {
          await current.connect(input.livekit!.url, input.livekit!.token);
          if (epoch !== currentEpoch) return;
          const published = await publishScreen(
            current,
            input.stream,
            input.settings,
          );
          if (epoch !== currentEpoch) {
            await disposeRoom(current, published);
            return;
          }
          tracks = published;
          updateSources(published);
        } catch (error) {
          if (room === current) {
            room = undefined;
            tracks = undefined;
            sources = {};
          }
          await disposeRoom(current, undefined);
          throw error;
        }
      })();
      startPromise = operation;
      void operation
        .finally(() => {
          if (startPromise === operation) startPromise = undefined;
        })
        .catch(() => {});
      return operation;
    },
    updateSettings(previous, next) {
      if (!room || !tracks || stopPromise)
        return Promise.reject(new Error("Эфир завершён"));
      const current = room;
      const currentEpoch = epoch;
      const operation = (async () => {
        const result = await updateQuality(current, tracks!, previous, next);
        if (room === current) {
          tracks = result.tracks;
          if (epoch === currentEpoch && result.videoRepublished)
            updateSources(tracks);
        }
        return { note: result.note, videoRepublished: result.videoRepublished };
      })();
      updates.add(operation);
      void operation.finally(() => updates.delete(operation)).catch(() => {});
      return operation;
    },
    getStatsSources() {
      return sources;
    },
    async setMuted(muted) {
      if (!room || !tracks) throw new Error("Эфир завершён");
      if (tracks.audio) {
        if (muted) await tracks.audio.mute();
        else await tracks.audio.unmute();
      }
    },
    stop() {
      if (stopPromise) return stopPromise;
      epoch++;
      const operation = (async () => {
        if (startPromise) await startPromise.catch(() => {});
        await Promise.allSettled(Array.from(updates));
        const current = room;
        const published = tracks;
        room = undefined;
        tracks = undefined;
        sources = {};
        if (current) await disposeRoom(current, published);
      })();
      stopPromise = operation;
      void operation
        .finally(() => {
          if (stopPromise === operation) stopPromise = undefined;
        })
        .catch(() => {});
      return operation;
    },
  };
}
