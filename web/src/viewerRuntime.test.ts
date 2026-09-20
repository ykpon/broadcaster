import { describe, expect, it } from "vitest";
import {
  createIncomingStatsTracker,
  loadBufferPreferenceSafely,
  saveBufferPreferenceSafely,
} from "./viewerRuntime";

describe("Viewer storage acquisition", () => {
  const blockedStorage = () => {
    throw new DOMException("Storage access denied", "SecurityError");
  };

  it("uses Auto when acquiring localStorage throws", () => {
    expect(loadBufferPreferenceSafely(blockedStorage)).toBeNull();
  });

  it("swallows acquisition failure so playout application continues", () => {
    const applied: Array<number | null> = [];

    expect(() => {
      saveBufferPreferenceSafely(blockedStorage, 1.2);
      applied.push(1.2);
    }).not.toThrow();
    expect(applied).toEqual([1.2]);
  });
});

describe("Viewer incoming stats lifecycle", () => {
  it("resets samples on track replacement and rejects stale reports", () => {
    const tracker = createIncomingStatsTracker<object, number>();
    const firstTrack = {};
    const replacementTrack = {};

    expect(tracker.replace(firstTrack)).toBe(true);
    const firstRead = tracker.capture(firstTrack);
    expect(firstRead.previous).toBeUndefined();
    expect(tracker.commit(firstRead, 10)).toBe(true);
    expect(tracker.capture(firstTrack).previous).toBe(10);

    const pendingRead = tracker.capture(firstTrack);
    expect(tracker.replace(replacementTrack)).toBe(true);
    expect(tracker.capture(replacementTrack).previous).toBeUndefined();
    expect(tracker.commit(pendingRead, 99)).toBe(false);
    expect(tracker.capture(replacementTrack).previous).toBeUndefined();
  });

  it("rejects a pending report after unsubscribe or reset", () => {
    const tracker = createIncomingStatsTracker<object, number>();
    const track = {};

    tracker.replace(track);
    const pendingRead = tracker.capture(track);
    expect(tracker.replace(null)).toBe(true);
    expect(tracker.commit(pendingRead, 12)).toBe(false);
    expect(tracker.current()).toBeNull();
  });
});
