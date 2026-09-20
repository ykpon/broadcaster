import {
  DEFAULT_STREAM_SETTINGS,
  loadStreamSettings,
  saveStreamSettings,
  type StreamSettings,
} from "./quality";

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
