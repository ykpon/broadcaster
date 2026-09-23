import {
  DEFAULT_STREAM_SETTINGS,
  loadStreamSettings,
  saveStreamSettings,
  type StreamSettings,
} from "./quality";
import {
  DEFAULT_BROADCAST_CONFIG,
  loadBroadcastConfig,
  normalizeViewerLimit,
  saveBroadcastConfig,
  type BroadcastConfig,
  type StartResponse,
  type TransportMode,
} from "./protocol";
import {
  parseOutboundStats,
  type CounterSample,
  type StreamMetrics,
} from "./stats";
import type { RTCStatsProvider, StudioPublisher } from "./studioTransport";
import type { ControlSocketSignal } from "./controlSocket";

type StorageGetter = () => Storage;

export function loadStreamSettingsSafely(
  getStorage: StorageGetter,
): StreamSettings {
  try {
    return loadStreamSettings(getStorage());
  } catch {
    return DEFAULT_STREAM_SETTINGS;
  }
}

export function saveStreamSettingsSafely(
  getStorage: StorageGetter,
  settings: StreamSettings,
): void {
  try {
    saveStreamSettings(getStorage(), settings);
  } catch {
    // Acquiring localStorage can itself throw in restricted browser contexts.
  }
}

export function loadBroadcastConfigSafely(
  getStorage: StorageGetter,
): BroadcastConfig {
  try {
    return loadBroadcastConfig(getStorage());
  } catch {
    return { ...DEFAULT_BROADCAST_CONFIG };
  }
}

export function saveBroadcastConfigSafely(
  getStorage: StorageGetter,
  config: BroadcastConfig,
): void {
  try {
    saveBroadcastConfig(getStorage(), config);
  } catch {
    // Acquiring localStorage can itself throw in restricted browser contexts.
  }
}

type StudioControl = {
  send(signal: ControlSocketSignal): void;
  close(): void;
};

const CONTROL_AUTH_TIMEOUT_MS = 20_000;

export type StartedStudioBroadcast = {
  config: BroadcastConfig;
  stream: MediaStream;
  response: StartResponse;
  publisher?: StudioPublisher;
  control?: StudioControl;
};

export type StartStudioBroadcastOptions = {
  transport?: TransportMode;
  viewerLimit?: string;
  capture(): Promise<MediaStream>;
  prepareCapture?(stream: MediaStream): Promise<void>;
  startGeneration(config: BroadcastConfig): Promise<StartResponse>;
  createPublisher?(
    transport: TransportMode,
    response: StartResponse,
  ): StudioPublisher;
  connectControl?(input: {
    response: StartResponse;
    publisher: StudioPublisher;
  }): { control: StudioControl; authenticated: Promise<void> };
  stopGeneration?(generation: number): Promise<void>;
  settings?: StreamSettings;
  isCurrent?(): boolean;
  schedule?(callback: () => void, delay: number): unknown;
  cancelScheduled?(timer: unknown): void;
};

class StaleStudioStart extends Error {}

function stopTracks(stream: MediaStream | undefined) {
  stream?.getTracks().forEach((track) => track.stop());
}

export async function startStudioBroadcast(
  options: StartStudioBroadcastOptions,
): Promise<StartedStudioBroadcast | null> {
  const transport = options.transport ?? DEFAULT_BROADCAST_CONFIG.transport;
  const viewerLimit = normalizeViewerLimit(
    options.viewerLimit ?? DEFAULT_BROADCAST_CONFIG.viewerLimit,
  );
  if (viewerLimit === null)
    throw new Error("Лимит зрителей должен быть положительным целым числом.");

  const config = { transport, viewerLimit } satisfies BroadcastConfig;
  let stream: MediaStream;
  try {
    stream = await options.capture();
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError")
      return null;
    throw error;
  }

  let response: StartResponse | undefined;
  let publisher: StudioPublisher | undefined;
  let control: StudioControl | undefined;
  const ensureCurrent = () => {
    if (options.isCurrent && !options.isCurrent()) throw new StaleStudioStart();
  };
  const cleanup = async () => {
    control?.close();
    await publisher?.stop().catch(() => {});
    stopTracks(stream);
    if (response && options.stopGeneration)
      await options.stopGeneration(response.generation).catch(() => {});
  };

  try {
    ensureCurrent();
    await options.prepareCapture?.(stream);
    ensureCurrent();
    response = await options.startGeneration(config);
    ensureCurrent();
    if (response.transport !== config.transport)
      throw new Error("Сервер выбрал неожиданный режим трансляции");

    if (options.createPublisher) {
      publisher = options.createPublisher(response.transport, response);
      if (publisher.kind !== response.transport)
        throw new Error("Издатель не соответствует выбранному транспорту");
      if (options.connectControl) {
        const connected = options.connectControl({ response, publisher });
        control = connected.control;
        const schedule =
          options.schedule ??
          ((callback: () => void, delay: number) =>
            globalThis.setTimeout(callback, delay));
        const cancelScheduled =
          options.cancelScheduled ??
          ((timer: unknown) =>
            globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>));
        let authenticationTimer: unknown;
        try {
          await Promise.race([
            connected.authenticated,
            new Promise<never>((_resolve, reject) => {
              authenticationTimer = schedule(
                () =>
                  reject(
                    new Error(
                      "Не удалось завершить аутентификацию управляющего соединения.",
                    ),
                  ),
                CONTROL_AUTH_TIMEOUT_MS,
              );
            }),
          ]);
        } finally {
          if (authenticationTimer !== undefined)
            cancelScheduled(authenticationTimer);
        }
        ensureCurrent();
      }
      await publisher.start({
        generation: response.generation,
        stream,
        settings: options.settings ?? DEFAULT_STREAM_SETTINGS,
        livekit: response.transport === "server" ? response.livekit : undefined,
        iceServers:
          response.transport === "p2p" ? response.iceServers : undefined,
        send: control?.send ?? (() => {}),
      });
      ensureCurrent();
      control?.send({
        type: "broadcast-ready",
        generation: response.generation,
      });
    }

    return { config, stream, response, publisher, control };
  } catch (error) {
    await cleanup();
    if (error instanceof StaleStudioStart) return null;
    throw error;
  }
}

export async function stopStudioBroadcast(options: {
  stopPublisher(): Promise<void>;
  stopGeneration(): Promise<void>;
}) {
  let failure: unknown;
  try {
    await options.stopPublisher();
  } catch (error) {
    failure = error;
  }
  try {
    await options.stopGeneration();
  } catch (error) {
    failure ??= error;
  }
  if (failure !== undefined) throw failure;
}

export async function readPublisherMetrics(
  source: RTCStatsProvider,
  previous?: CounterSample,
): Promise<{ metrics: StreamMetrics; sample?: CounterSample }> {
  if (source.getMetrics)
    return { metrics: await source.getMetrics(), sample: previous };
  const report = await source.getStats();
  return parseOutboundStats(report.values(), previous);
}

export type LatestSettingsUpdaterOptions<T, R> = {
  apply: (next: T) => Promise<R>;
  rollback: (confirmed: T, failed: T) => Promise<R | void>;
  readConfirmed: (failed: T) => T;
  equals?: (left: T, right: T) => boolean;
  onBusy: (busy: boolean) => void;
  onStart: (next: T) => void;
  onApplied?: (next: T, result: R) => void;
  onRolledBack?: (confirmed: T, result: R | void, failed: T) => void;
  onSuccess: (next: T, result: R) => void;
  onFailure: (
    error: unknown,
    confirmed: T,
    shouldRestoreDraft: boolean,
    failed: T,
  ) => void;
};

export function createLatestSettingsUpdater<T, R>(
  options: LatestSettingsUpdaterOptions<T, R>,
) {
  type Pending = { generation: number; value: T };
  let generation = 0;
  let pending: Pending | undefined;
  let running: { generation: number; promise: Promise<void> } | undefined;
  let busyGeneration: number | undefined;
  const hasPendingFor = (candidate: number) =>
    pending?.generation === candidate;

  async function drain(runGeneration: number) {
    busyGeneration = runGeneration;
    options.onBusy(true);
    try {
      while (
        generation === runGeneration &&
        pending?.generation === runGeneration
      ) {
        const next = pending.value;
        pending = undefined;
        options.onStart(next);
        try {
          const result = await options.apply(next);
          if (generation !== runGeneration) return;
          options.onApplied?.(next, result);
          options.onSuccess(next, result);
        } catch (error) {
          if (generation !== runGeneration) return;
          const confirmed = options.readConfirmed(next);
          const rollbackResult = await options
            .rollback(confirmed, next)
            .catch(() => undefined);
          if (generation !== runGeneration) return;
          options.onRolledBack?.(confirmed, rollbackResult, next);
          options.onFailure(
            error,
            confirmed,
            !hasPendingFor(runGeneration),
            next,
          );
        }
      }
    } finally {
      if (generation === runGeneration) {
        if (running?.generation === runGeneration) running = undefined;
        if (busyGeneration === runGeneration) {
          busyGeneration = undefined;
          options.onBusy(false);
        }
      }
    }
  }

  return {
    enqueue(next: T) {
      if (
        running?.generation !== generation &&
        options.equals?.(next, options.readConfirmed(next))
      )
        return Promise.resolve();
      pending = { generation, value: next };
      if (running?.generation !== generation) {
        const promise = drain(generation);
        running = { generation, promise };
      }
      return running.promise;
    },
    cancel() {
      const cancelledGeneration = generation;
      generation += 1;
      pending = undefined;
      if (running?.generation === cancelledGeneration) running = undefined;
      if (busyGeneration === cancelledGeneration) {
        busyGeneration = undefined;
        options.onBusy(false);
      }
    },
    async settleAndCancel() {
      const settledGeneration = generation;
      pending = undefined;
      const active =
        running?.generation === settledGeneration ? running.promise : undefined;
      if (active) await active;
      if (generation !== settledGeneration) return;
      generation += 1;
      pending = undefined;
      if (running?.generation === settledGeneration) running = undefined;
      if (busyGeneration === settledGeneration) {
        busyGeneration = undefined;
        options.onBusy(false);
      }
    },
  };
}

export function createStatsSessionGuard<T>() {
  let generation = 0;
  let sequence = 0;
  type Read = { generation: number; sequence: number; track: T };
  const inFlight = new Map<T, Read>();
  return {
    capture(track: T) {
      if (inFlight.has(track)) return undefined;
      const read = { generation, sequence: ++sequence, track };
      inFlight.set(track, read);
      return read;
    },
    invalidate() {
      generation += 1;
      inFlight.clear();
    },
    commit(read: Read, currentTrack: T) {
      if (inFlight.get(read.track) !== read) return false;
      inFlight.delete(read.track);
      return read.generation === generation && read.track === currentTrack;
    },
    release(read: Read) {
      if (inFlight.get(read.track) === read) inFlight.delete(read.track);
    },
  };
}

export function formatCaptureFrameRate(frameRate: number | undefined) {
  return frameRate !== undefined && Number.isFinite(frameRate) && frameRate > 0
    ? `${Math.round(frameRate)} FPS`
    : "—";
}
