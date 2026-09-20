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
    const firstRead = tracker.capture(firstTrack)!;
    expect(firstRead.previous).toBeUndefined();
    expect(tracker.commit(firstRead, 10)).toBe(true);
    const resumedRead = tracker.capture(firstTrack)!;
    expect(resumedRead.previous).toBe(10);
    tracker.release(resumedRead);

    const pendingRead = tracker.capture(firstTrack)!;
    expect(tracker.replace(replacementTrack)).toBe(true);
    const replacementRead = tracker.capture(replacementTrack)!;
    expect(replacementRead.previous).toBeUndefined();
    expect(tracker.commit(pendingRead, 99)).toBe(false);
    expect(tracker.capture(replacementTrack)).toBeUndefined();
    expect(tracker.commit(replacementRead, 20)).toBe(true);
    expect(tracker.capture(replacementTrack)?.previous).toBe(20);
  });

  it("rejects a pending report after unsubscribe or reset", () => {
    const tracker = createIncomingStatsTracker<object, number>();
    const track = {};

    tracker.replace(track);
    const pendingRead = tracker.capture(track)!;
    expect(tracker.replace(null)).toBe(true);
    expect(tracker.commit(pendingRead, 12)).toBe(false);
    expect(tracker.current()).toBeNull();
  });

  it("allows only one in-flight report for the same track", () => {
    const tracker = createIncomingStatsTracker<object, number>();
    const track = {};

    tracker.replace(track);
    const first = tracker.capture(track)!;
    expect(tracker.capture(track)).toBeUndefined();
    expect(tracker.commit(first, 10)).toBe(true);
    expect(tracker.capture(track)).toBeDefined();
  });

  it("does not let a stale report release a newer same-track report", () => {
    const tracker = createIncomingStatsTracker<object, number>();
    const track = {};

    tracker.replace(track);
    const stale = tracker.capture(track)!;
    tracker.replace(null);
    tracker.replace(track);
    const current = tracker.capture(track)!;
    expect(tracker.commit(stale, 99)).toBe(false);
    expect(tracker.capture(track)).toBeUndefined();
    expect(tracker.commit(current, 10)).toBe(true);
  });
});
