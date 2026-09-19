import { describe, expect, it, vi } from "vitest";
import type { RemoteTrack } from "livekit-client";
import { applyPlayoutBuffer, applyPlayoutBufferToTracks, loadBufferPreference, saveBufferPreference } from "./playout";

describe("viewer playout buffer", () => {
  it("sets jitterBufferTarget in milliseconds and maps Auto to null", () => {
    const receiver = { jitterBufferTarget: null } as RTCRtpReceiver;
    const track = { receiver, setPlayoutDelay: vi.fn() } as unknown as RemoteTrack;
    expect(applyPlayoutBuffer(track, 1.5)).toBe("jitterBufferTarget");
    expect(receiver.jitterBufferTarget).toBe(1500);
    expect(applyPlayoutBuffer(track, null)).toBe("jitterBufferTarget");
    expect(receiver.jitterBufferTarget).toBeNull();
  });
  it("uses the LiveKit fallback in seconds", () => {
    const setPlayoutDelay = vi.fn();
    const track = { receiver: { playoutDelayHint: undefined }, setPlayoutDelay } as unknown as RemoteTrack;
    expect(applyPlayoutBuffer(track, 2.4)).toBe("playoutDelayHint");
    expect(setPlayoutDelay).toHaveBeenCalledWith(2.4);
  });
  it("does not interfere with viewing when no API is supported", () => {
    const track = { receiver: {}, setPlayoutDelay: vi.fn() } as unknown as RemoteTrack;
    expect(applyPlayoutBuffer(track, 1)).toBe("unsupported");
  });
  it("saves only Auto or exact tenths from 0.1 through 4.0", () => {
    let stored: string | null = null;
    const storage = { getItem: () => stored, setItem: (_key: string, value: string) => { stored = value; } } as unknown as Storage;
    saveBufferPreference(storage, 1.7);
    expect(loadBufferPreference(storage)).toBe(1.7);
    saveBufferPreference(storage, null);
    expect(loadBufferPreference(storage)).toBeNull();
    for (const value of [0, 4.1, 1.11, Number.NaN, Number.POSITIVE_INFINITY]) {
      saveBufferPreference(storage, value);
      expect(loadBufferPreference(storage)).toBeNull();
    }
    stored = "9";
    expect(loadBufferPreference(storage)).toBeNull();
  });
  it("applies the same preference to every track and reports aggregate support", () => {
    const supported = { receiver: { jitterBufferTarget: null } } as unknown as RemoteTrack;
    const unsupported = { receiver: {} } as unknown as RemoteTrack;
    expect(applyPlayoutBufferToTracks([unsupported, supported], 0.8)).toBe("jitterBufferTarget");
    expect((supported.receiver as RTCRtpReceiver).jitterBufferTarget).toBe(800);
    expect(applyPlayoutBufferToTracks([unsupported], 0.8)).toBe("unsupported");
  });
  it("treats storage failures as an unset preference", () => {
    const storage = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } } as unknown as Storage;
    expect(() => saveBufferPreference(storage, 1)).not.toThrow();
    expect(loadBufferPreference(storage)).toBeNull();
  });
  it("normalizes invalid direct application values to Auto", () => {
    for (const value of [0, 4.1, Number.NaN, Number.POSITIVE_INFINITY, 1.11]) {
      const receiver = { jitterBufferTarget: 123 } as RTCRtpReceiver;
      const track = { receiver, setPlayoutDelay: vi.fn() } as unknown as RemoteTrack;
      expect(applyPlayoutBuffer(track, value)).toBe("jitterBufferTarget");
      expect(receiver.jitterBufferTarget).toBeNull();
    }
  });
  it("overwrites a stored value with Auto when saving an invalid preference", () => {
    let stored: string | null = null;
    const storage = { getItem: () => stored, setItem: (_key: string, value: string) => { stored = value; } } as unknown as Storage;
    saveBufferPreference(storage, 1.5);
    saveBufferPreference(storage, 4.1);
    expect(loadBufferPreference(storage)).toBeNull();
  });
  it("normalizes invalid fallback values to Auto and preserves fallback support", () => {
    const setPlayoutDelay = vi.fn();
    const track = { receiver: { playoutDelayHint: undefined }, setPlayoutDelay } as unknown as RemoteTrack;
    expect(applyPlayoutBuffer(track, 4.1)).toBe("playoutDelayHint");
    expect(setPlayoutDelay).toHaveBeenCalledWith(0);
  });
});
