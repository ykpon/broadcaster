import { describe, expect, it } from "vitest";
import {
  createLatestSettingsUpdater,
  createStatsSessionGuard,
  formatCaptureFrameRate,
} from "./studioRuntime";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("Studio settings updates", () => {
  it("notifies applied state only after a successful media mutation", async () => {
    const update = deferred<string>();
    const notifications: number[] = [];
    let applied = 10;
    const updater = createLatestSettingsUpdater<number, string>({
      apply: () => update.promise,
      rollback: async () => {},
      readConfirmed: () => applied,
      onBusy: () => {},
      onStart: () => {},
      onApplied: (next) => {
        notifications.push(next);
        applied = next;
      },
      onSuccess: () => {},
      onFailure: () => {},
    });

    const running = updater.enqueue(20);
    expect(applied).toBe(10);
    expect(notifications).toEqual([]);

    update.resolve("updated");
    await running;
    expect(applied).toBe(20);
    expect(notifications).toEqual([20]);
  });

  it("does not advance applied state when the media mutation fails", async () => {
    const notifications: number[] = [];
    let applied = 10;
    const updater = createLatestSettingsUpdater<number, void>({
      apply: async () => {
        throw new Error("failed");
      },
      rollback: async () => {},
      readConfirmed: () => applied,
      onBusy: () => {},
      onStart: () => {},
      onApplied: (next) => {
        notifications.push(next);
        applied = next;
      },
      onSuccess: () => {},
      onFailure: () => {},
    });

    await updater.enqueue(20);
    expect(applied).toBe(10);
    expect(notifications).toEqual([]);
  });

  it("skips an idle confirmed value but queues a revert behind an in-flight update", async () => {
    const first = deferred<void>();
    const applied: number[] = [];
    let confirmed = 10;
    const updater = createLatestSettingsUpdater<number, void>({
      apply: async (next) => {
        applied.push(next);
        if (next === 20) await first.promise;
      },
      rollback: async () => {},
      readConfirmed: () => confirmed,
      equals: Object.is,
      onBusy: () => {},
      onStart: () => {},
      onApplied: (next) => {
        confirmed = next;
      },
      onSuccess: () => {},
      onFailure: () => {},
    });

    await updater.enqueue(10);
    expect(applied).toEqual([]);

    const running = updater.enqueue(20);
    updater.enqueue(10);
    expect(applied).toEqual([20]);

    first.resolve();
    await running;
    expect(applied).toEqual([20, 10]);
    expect(confirmed).toBe(10);
  });

  it("serializes a later commit behind a failed update without restoring stale UI", async () => {
    const first = deferred<string>();
    const applied: number[] = [];
    const rolledBack: number[] = [];
    const events: string[] = [];
    const appliedNotifications: number[] = [];
    const busy: boolean[] = [];
    const restoreDraft: boolean[] = [];
    let confirmed = 10;
    let draft = 10;
    let error = "";

    const updater = createLatestSettingsUpdater<number, string>({
      apply: async (next) => {
        applied.push(next);
        events.push(`apply:${next}`);
        if (next === 20) return first.promise;
        return `note:${next}`;
      },
      rollback: async (previous) => {
        rolledBack.push(previous);
        events.push(`rollback:${previous}`);
      },
      readConfirmed: () => confirmed,
      onBusy: (value) => busy.push(value),
      onStart: () => {
        error = "";
      },
      onApplied: (next) => {
        appliedNotifications.push(next);
        confirmed = next;
      },
      onSuccess: () => {},
      onFailure: (_failure, previous, shouldRestoreDraft) => {
        restoreDraft.push(shouldRestoreDraft);
        if (shouldRestoreDraft) draft = previous;
        error = "failed";
      },
    });

    draft = 20;
    const firstCommit = updater.enqueue(20);
    draft = 30;
    const secondCommit = updater.enqueue(30);

    expect(applied).toEqual([20]);
    first.reject(new Error("first failed"));
    await Promise.all([firstCommit, secondCommit]);

    expect(applied).toEqual([20, 30]);
    expect(rolledBack).toEqual([10]);
    expect(events).toEqual(["apply:20", "rollback:10", "apply:30"]);
    expect(appliedNotifications).toEqual([30]);
    expect(restoreDraft).toEqual([false]);
    expect(confirmed).toBe(30);
    expect(draft).toBe(30);
    expect(error).toBe("");
    expect(busy).toEqual([true, false]);
  });

  it("coalesces queued commits to the latest value", async () => {
    const first = deferred<void>();
    const applied: number[] = [];
    let confirmed = 0;
    const updater = createLatestSettingsUpdater<number, void>({
      apply: async (next) => {
        applied.push(next);
        if (next === 1) await first.promise;
      },
      rollback: async () => {},
      readConfirmed: () => confirmed,
      onBusy: () => {},
      onStart: () => {},
      onApplied: (next) => {
        confirmed = next;
      },
      onSuccess: () => {},
      onFailure: () => {},
    });

    const running = updater.enqueue(1);
    updater.enqueue(2);
    updater.enqueue(3);
    expect(applied).toEqual([1]);

    first.resolve();
    await running;
    expect(applied).toEqual([1, 3]);
    expect(confirmed).toBe(3);
  });
});

describe("Studio stats sessions", () => {
  it("keeps an invalidated report from replacing metrics or samples", async () => {
    const guard = createStatsSessionGuard<object>();
    const oldTrack = {};
    const pendingReport = deferred<number>();
    const read = guard.capture(oldTrack);
    let metrics: number | undefined;
    let sample: number | undefined;
    const update = pendingReport.promise.then((value) => {
      if (!guard.isCurrent(read, oldTrack)) return;
      sample = value;
      metrics = value;
    });

    guard.invalidate();
    pendingReport.resolve(42);
    await update;
    expect(sample).toBeUndefined();
    expect(metrics).toBeUndefined();
  });

  it("keeps a replaced track's pending report from replacing metrics or samples", async () => {
    const guard = createStatsSessionGuard<object>();
    const trackA = {};
    const trackB = {};
    let currentTrack = trackA;
    const pendingReport = deferred<number>();
    const read = guard.capture(trackA);
    let metrics: number | undefined;
    let sample: number | undefined;
    const update = pendingReport.promise.then((value) => {
      if (!guard.isCurrent(read, currentTrack)) return;
      sample = value;
      metrics = value;
    });

    currentTrack = trackB;
    pendingReport.resolve(42);
    await update;
    expect(sample).toBeUndefined();
    expect(metrics).toBeUndefined();
  });
});

describe("Studio capture labels", () => {
  it("shows an em dash when capture FPS is unavailable", () => {
    expect(formatCaptureFrameRate(undefined)).toBe("—");
    expect(formatCaptureFrameRate(0)).toBe("—");
    expect(formatCaptureFrameRate(29.7)).toBe("30 FPS");
  });
});
