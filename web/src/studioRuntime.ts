export type LatestSettingsUpdaterOptions<T, R> = {
  apply: (next: T) => Promise<R>;
  rollback: (confirmed: T) => Promise<void>;
  readConfirmed: (failed: T) => T;
  equals?: (left: T, right: T) => boolean;
  onBusy: (busy: boolean) => void;
  onStart: (next: T) => void;
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
  let pending: T | undefined;
  let running: Promise<void> | undefined;

  async function drain() {
    options.onBusy(true);
    try {
      while (pending !== undefined) {
        const next = pending;
        pending = undefined;
        options.onStart(next);
        try {
          options.onSuccess(next, await options.apply(next));
        } catch (error) {
          const confirmed = options.readConfirmed(next);
          await options.rollback(confirmed).catch(() => {});
          options.onFailure(error, confirmed, pending === undefined, next);
        }
      }
    } finally {
      options.onBusy(false);
      running = undefined;
    }
  }

  return {
    enqueue(next: T) {
      if (
        running === undefined &&
        options.equals?.(next, options.readConfirmed(next))
      )
        return Promise.resolve();
      pending = next;
      running ??= drain();
      return running;
    },
  };
}

export function createStatsSessionGuard<T>() {
  let generation = 0;
  return {
    capture(track: T) {
      return { generation, track };
    },
    invalidate() {
      generation += 1;
    },
    isCurrent(read: { generation: number; track: T }, currentTrack: T) {
      return read.generation === generation && read.track === currentTrack;
    },
  };
}

export function formatCaptureFrameRate(frameRate: number | undefined) {
  return frameRate !== undefined && Number.isFinite(frameRate) && frameRate > 0
    ? `${Math.round(frameRate)} FPS`
    : "—";
}
