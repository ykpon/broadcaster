import { describe, expect, it, vi } from "vitest";
import {
  createLatestSettingsUpdater,
  createStatsSessionGuard,
  formatCaptureFrameRate,
  loadBroadcastConfigSafely,
  loadStreamSettingsSafely,
  readPublisherMetrics,
  saveBroadcastConfigSafely,
  saveStreamSettingsSafely,
  startStudioBroadcast,
  stopStudioBroadcast,
} from "./studioRuntime";
import { DEFAULT_STREAM_SETTINGS } from "./quality";
import type { StartResponse } from "./protocol";
import type { StudioPublisher } from "./studioTransport";

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
    const rollbackResults: string[] = [];
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
        return `restored:${previous}`;
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
      onRolledBack: (_confirmed, result) => {
        if (result) rollbackResults.push(result);
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
    expect(rollbackResults).toEqual(["restored:10"]);
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

  it("discards queued work and callbacks when the session is cancelled", async () => {
    const first = deferred<void>();
    const applied: number[] = [];
    const succeeded: number[] = [];
    const failed: number[] = [];
    const rolledBack: number[] = [];
    const busy: boolean[] = [];
    const updater = createLatestSettingsUpdater<number, void>({
      apply: async (next) => {
        applied.push(next);
        await first.promise;
      },
      rollback: async (confirmed) => {
        rolledBack.push(confirmed);
      },
      readConfirmed: () => 0,
      onBusy: (value) => busy.push(value),
      onStart: () => {},
      onApplied: () => {},
      onSuccess: (next) => succeeded.push(next),
      onFailure: (_error, _confirmed, _restore, next) => failed.push(next),
    });

    const running = updater.enqueue(1);
    updater.enqueue(2);
    updater.cancel();
    first.resolve();
    await running;

    expect(applied).toEqual([1]);
    expect(succeeded).toEqual([]);
    expect(failed).toEqual([]);
    expect(rolledBack).toEqual([]);
    expect(busy).toEqual([true, false]);
  });

  it("settles the active mutation before cancellation and discards queued work", async () => {
    const active = deferred<string>();
    const applied: number[] = [];
    let current = "original";
    const updater = createLatestSettingsUpdater<number, string>({
      apply: async (next) => {
        applied.push(next);
        return active.promise;
      },
      rollback: async () => {},
      readConfirmed: () => 0,
      onBusy: () => {},
      onStart: () => {},
      onApplied: (_next, result) => {
        current = result;
      },
      onSuccess: () => {},
      onFailure: () => {},
    });

    updater.enqueue(1);
    updater.enqueue(2);
    const settled = updater.settleAndCancel();
    expect(applied).toEqual([1]);
    expect(current).toBe("original");

    active.resolve("replacement");
    await settled;
    expect(applied).toEqual([1]);
    expect(current).toBe("replacement");
  });

  it("does not let an old completion clear a restarted session's state", async () => {
    const oldUpdate = deferred<void>();
    const newUpdate = deferred<void>();
    let busy = false;
    let error = "";
    const events: string[] = [];
    const updater = createLatestSettingsUpdater<number, void>({
      apply: (next) => (next === 1 ? oldUpdate.promise : newUpdate.promise),
      rollback: async () => {},
      readConfirmed: () => 0,
      onBusy: (value) => {
        busy = value;
        events.push(`busy:${value}`);
      },
      onStart: (next) => {
        error = "";
        events.push(`start:${next}`);
      },
      onSuccess: (next) => {
        error = `success:${next}`;
        events.push(`success:${next}`);
      },
      onFailure: () => {
        error = "failed";
      },
    });

    const oldRunning = updater.enqueue(1);
    updater.cancel();
    const newRunning = updater.enqueue(2);
    error = "new-session-error";

    oldUpdate.resolve();
    await oldRunning;
    expect(busy).toBe(true);
    expect(error).toBe("new-session-error");
    expect(events).not.toContain("success:1");

    newUpdate.resolve();
    await newRunning;
    expect(busy).toBe(false);
    expect(error).toBe("success:2");
  });

  it("does not rollback a rejected update after cancellation", async () => {
    const update = deferred<void>();
    const rollback: number[] = [];
    const failures: unknown[] = [];
    const updater = createLatestSettingsUpdater<number, void>({
      apply: () => update.promise,
      rollback: async (confirmed) => {
        rollback.push(confirmed);
      },
      readConfirmed: () => 10,
      onBusy: () => {},
      onStart: () => {},
      onSuccess: () => {},
      onFailure: (error) => failures.push(error),
    });

    const running = updater.enqueue(20);
    updater.cancel();
    update.reject(new Error("stale failure"));
    await running;

    expect(rollback).toEqual([]);
    expect(failures).toEqual([]);
  });
});

describe("Studio stats sessions", () => {
  it("keeps an invalidated report from replacing metrics or samples", async () => {
    const guard = createStatsSessionGuard<object>();
    const oldTrack = {};
    const pendingReport = deferred<number>();
    const read = guard.capture(oldTrack)!;
    let metrics: number | undefined;
    let sample: number | undefined;
    const update = pendingReport.promise.then((value) => {
      if (!guard.commit(read, oldTrack)) return;
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
    const read = guard.capture(trackA)!;
    let metrics: number | undefined;
    let sample: number | undefined;
    const update = pendingReport.promise.then((value) => {
      if (!guard.commit(read, currentTrack)) return;
      sample = value;
      metrics = value;
    });

    currentTrack = trackB;
    pendingReport.resolve(42);
    await update;
    expect(sample).toBeUndefined();
    expect(metrics).toBeUndefined();
  });

  it("allows only one in-flight read for the same track", () => {
    const guard = createStatsSessionGuard<object>();
    const track = {};

    const first = guard.capture(track)!;
    expect(guard.capture(track)).toBeUndefined();
    expect(guard.commit(first, track)).toBe(true);
    expect(guard.capture(track)).toBeDefined();
  });

  it("does not let an invalidated read release a newer same-track read", () => {
    const guard = createStatsSessionGuard<object>();
    const track = {};

    const stale = guard.capture(track)!;
    guard.invalidate();
    const current = guard.capture(track)!;
    expect(guard.commit(stale, track)).toBe(false);
    expect(guard.capture(track)).toBeUndefined();
    expect(guard.commit(current, track)).toBe(true);
  });
});

describe("Studio storage acquisition", () => {
  const blockedStorage = () => {
    throw new DOMException("Storage access denied", "SecurityError");
  };

  it("uses stream defaults when acquiring localStorage throws", () => {
    expect(loadStreamSettingsSafely(blockedStorage)).toEqual(
      DEFAULT_STREAM_SETTINGS,
    );
  });

  it("keeps the Studio usable when storage acquisition fails on save", () => {
    expect(() =>
      saveStreamSettingsSafely(blockedStorage, DEFAULT_STREAM_SETTINGS),
    ).not.toThrow();
  });
});

describe("Studio capture labels", () => {
  it("shows an em dash when capture FPS is unavailable", () => {
    expect(formatCaptureFrameRate(undefined)).toBe("—");
    expect(formatCaptureFrameRate(0)).toBe("—");
    expect(formatCaptureFrameRate(29.7)).toBe("30 FPS");
  });
});

function fakeStream(stop = vi.fn()) {
  return {
    getTracks: () => [{ stop }],
    getVideoTracks: () => [{ applyConstraints: vi.fn() }],
    getAudioTracks: () => [],
  } as unknown as MediaStream;
}

function fakePublisher(
  kind: StudioPublisher["kind"],
  overrides: Partial<StudioPublisher> = {},
): StudioPublisher {
  return {
    kind,
    start: vi.fn().mockResolvedValue(undefined),
    updateSettings: vi.fn(),
    getStatsSources: vi.fn().mockReturnValue({}),
    setMuted: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("Studio broadcast orchestration", () => {
  it("does not register a generation when capture is cancelled", async () => {
    const startGeneration = vi.fn();

    await expect(
      startStudioBroadcast({
        capture: () => Promise.reject(new DOMException("cancel", "AbortError")),
        startGeneration,
      }),
    ).resolves.toBeNull();

    expect(startGeneration).not.toHaveBeenCalled();
  });

  it("stops captured tracks when generation preparation fails", async () => {
    const stop = vi.fn();
    const stream = fakeStream(stop);

    await expect(
      startStudioBroadcast({
        capture: async () => stream,
        startGeneration: async () => {
          throw new Error("LiveKit offline");
        },
      }),
    ).rejects.toThrow("LiveKit offline");

    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid limit before capture and preserves an arbitrary-length limit", async () => {
    const capture = vi.fn(async () => fakeStream());
    const startGeneration = vi.fn(async () => ({
      generation: 7,
      ticket: "ticket",
      transport: "p2p" as const,
      iceServers: [],
    }));

    await expect(
      startStudioBroadcast({
        transport: "p2p",
        viewerLimit: "0",
        capture,
        startGeneration,
      }),
    ).rejects.toThrow("Лимит зрителей");
    expect(capture).not.toHaveBeenCalled();

    const hugeLimit = "9".repeat(120);
    await startStudioBroadcast({
      transport: "p2p",
      viewerLimit: hugeLimit,
      capture,
      startGeneration,
    });
    expect(startGeneration).toHaveBeenCalledWith({
      transport: "p2p",
      viewerLimit: hugeLimit,
    });
  });

  it("selects the publisher factory from the confirmed response transport", async () => {
    const response: StartResponse = {
      generation: 4,
      ticket: "ticket",
      transport: "p2p",
      iceServers: [{ urls: ["stun:example.test:3478"] }],
    };
    const publisher = fakePublisher("p2p");
    const createPublisher = vi.fn(() => publisher);

    await startStudioBroadcast({
      transport: "p2p",
      viewerLimit: "10",
      capture: async () => fakeStream(),
      startGeneration: async () => response,
      createPublisher,
    });

    expect(createPublisher).toHaveBeenCalledWith("p2p", response);
    expect(publisher.start).toHaveBeenCalledWith(
      expect.objectContaining({
        generation: 4,
        iceServers: response.iceServers,
      }),
    );
  });

  it("waits for host control authentication before starting and announcing the publisher", async () => {
    const authenticated = deferred<void>();
    const events: string[] = [];
    const publisher = fakePublisher("server", {
      start: vi.fn(async () => {
        events.push("publisher:start");
      }),
    });
    const control = {
      send: vi.fn(() => events.push("broadcast-ready")),
      close: vi.fn(),
    };
    const starting = startStudioBroadcast({
      capture: async () => fakeStream(),
      startGeneration: async () => ({
        generation: 3,
        ticket: "ticket",
        transport: "server" as const,
        livekit: { url: "wss://livekit.test", token: "token" },
      }),
      createPublisher: () => publisher,
      connectControl: () => {
        events.push("control:connect");
        return {
          control,
          authenticated: authenticated.promise.then(() => {
            events.push("control:authenticated");
          }),
        };
      },
    });

    await Promise.resolve();
    expect(publisher.start).not.toHaveBeenCalled();
    authenticated.resolve();
    await starting;
    expect(events).toEqual([
      "control:connect",
      "control:authenticated",
      "publisher:start",
      "broadcast-ready",
    ]);
  });

  it("times out silent host authentication and cleans the prepared generation", async () => {
    const authenticated = deferred<void>();
    const publisher = fakePublisher("server");
    const control = { send: vi.fn(), close: vi.fn() };
    const stopTrack = vi.fn();
    const stopGeneration = vi.fn().mockResolvedValue(undefined);
    let expire!: () => void;
    const starting = startStudioBroadcast({
      capture: async () => fakeStream(stopTrack),
      startGeneration: async () => ({
        generation: 6,
        ticket: "ticket",
        transport: "server" as const,
        livekit: { url: "wss://livekit.test", token: "token" },
      }),
      createPublisher: () => publisher,
      connectControl: () => ({ control, authenticated: authenticated.promise }),
      stopGeneration,
      schedule: (callback) => {
        expire = callback;
        return "authentication-timeout";
      },
      cancelScheduled: vi.fn(),
    });

    await vi.waitFor(() => expect(expire).toBeTypeOf("function"));
    expire();

    await expect(starting).rejects.toThrow("аутентификацию");
    expect(control.close).toHaveBeenCalledTimes(1);
    expect(publisher.stop).toHaveBeenCalledTimes(1);
    expect(stopTrack).toHaveBeenCalledTimes(1);
    expect(stopGeneration).toHaveBeenCalledWith(6);
  });

  it("cleans every owned resource and registered generation after publisher failure", async () => {
    const stopTrack = vi.fn();
    const publisher = fakePublisher("server", {
      start: vi.fn().mockRejectedValue(new Error("publish failed")),
    });
    const control = { send: vi.fn(), close: vi.fn() };
    const stopGeneration = vi.fn().mockResolvedValue(undefined);

    await expect(
      startStudioBroadcast({
        capture: async () => fakeStream(stopTrack),
        startGeneration: async () => ({
          generation: 9,
          ticket: "ticket",
          transport: "server" as const,
          livekit: { url: "wss://livekit.test", token: "token" },
        }),
        createPublisher: () => publisher,
        connectControl: () => ({
          control,
          authenticated: Promise.resolve(),
        }),
        stopGeneration,
      }),
    ).rejects.toThrow("publish failed");

    expect(control.close).toHaveBeenCalledTimes(1);
    expect(publisher.stop).toHaveBeenCalledTimes(1);
    expect(stopTrack).toHaveBeenCalledTimes(1);
    expect(stopGeneration).toHaveBeenCalledWith(9);
  });

  it("discards a stale publisher completion before broadcast-ready", async () => {
    const started = deferred<void>();
    let current = true;
    const publisher = fakePublisher("p2p", {
      start: vi.fn(() => started.promise),
    });
    const control = { send: vi.fn(), close: vi.fn() };
    const stopGeneration = vi.fn().mockResolvedValue(undefined);
    const starting = startStudioBroadcast({
      transport: "p2p",
      viewerLimit: "10",
      capture: async () => fakeStream(),
      startGeneration: async () => ({
        generation: 12,
        ticket: "ticket",
        transport: "p2p" as const,
        iceServers: [],
      }),
      createPublisher: () => publisher,
      connectControl: () => ({
        control,
        authenticated: Promise.resolve(),
      }),
      stopGeneration,
      isCurrent: () => current,
    });

    await vi.waitFor(() => expect(publisher.start).toHaveBeenCalledTimes(1));
    current = false;
    started.resolve();

    await expect(starting).resolves.toBeNull();
    expect(control.send).not.toHaveBeenCalled();
    expect(control.close).toHaveBeenCalledTimes(1);
    expect(publisher.stop).toHaveBeenCalledTimes(1);
    expect(stopGeneration).toHaveBeenCalledWith(12);
  });

  it("stops the publisher before unregistering its generation", async () => {
    const events: string[] = [];

    await stopStudioBroadcast({
      stopPublisher: async () => {
        events.push("publisher.stop");
      },
      stopGeneration: async () => {
        events.push("/stop");
      },
    });

    expect(events).toEqual(["publisher.stop", "/stop"]);
  });
});

describe("Studio broadcast config storage", () => {
  const blockedStorage = () => {
    throw new DOMException("Storage access denied", "SecurityError");
  };

  it("uses broadcast defaults when acquiring localStorage throws", () => {
    expect(loadBroadcastConfigSafely(blockedStorage)).toEqual({
      transport: "server",
      viewerLimit: "10",
    });
  });

  it("keeps the Studio usable when localStorage acquisition fails on save", () => {
    expect(() =>
      saveBroadcastConfigSafely(blockedStorage, {
        transport: "p2p",
        viewerLimit: "123456789012345678901234567890",
      }),
    ).not.toThrow();
  });
});

describe("Studio publisher metrics", () => {
  it("uses publisher-provided aggregate metrics instead of reparsing a synthetic report", async () => {
    const getStats = vi.fn();
    const metrics = { bitrateKbps: 2400, packets: 42, rttMs: 80 };

    await expect(
      readPublisherMetrics({
        getStats,
        getMetrics: async () => metrics,
      }),
    ).resolves.toEqual({ metrics, sample: undefined });
    expect(getStats).not.toHaveBeenCalled();
  });
});
