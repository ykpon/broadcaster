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
      onSuccess: (next) => {
        confirmed = next;
      },
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
      onSuccess: (next) => {
        confirmed = next;
      },
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
      onSuccess: (next) => {
        confirmed = next;
      },
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

  it("rejects a report when the published track has been replaced", () => {
    const guard = createStatsSessionGuard<object>();
    const currentTrack = {};
    const currentRead = guard.capture(currentTrack);
    expect(guard.isCurrent(currentRead, currentTrack)).toBe(true);
    expect(guard.isCurrent(currentRead, {})).toBe(false);
  });
});

describe("Studio capture labels", () => {
  it("shows an em dash when capture FPS is unavailable", () => {
    expect(formatCaptureFrameRate(undefined)).toBe("—");
    expect(formatCaptureFrameRate(0)).toBe("—");
    expect(formatCaptureFrameRate(29.7)).toBe("30 FPS");
  });
});
