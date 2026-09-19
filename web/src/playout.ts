import type { RemoteTrack } from "livekit-client";

export type BufferPreference = number | null;
export type PlayoutSupport = "jitterBufferTarget" | "playoutDelayHint" | "unsupported";

const STORAGE_KEY = "viewer.playoutBuffer";

function isValidBufferPreference(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0.1 && value <= 4 && Math.abs(value * 10 - Math.round(value * 10)) < Number.EPSILON;
}

export function loadBufferPreference(storage: Storage): BufferPreference {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (raw === null || raw === "null") return null;
    const value: unknown = JSON.parse(raw);
    return isValidBufferPreference(value) ? value : null;
  } catch {
    return null;
  }
}

export function saveBufferPreference(storage: Storage, value: BufferPreference): void {
  if (value !== null && !isValidBufferPreference(value)) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
}

export function applyPlayoutBuffer(track: RemoteTrack, seconds: BufferPreference): PlayoutSupport {
  const receiver = track.receiver;
  if (!receiver) return "unsupported";

  if ("jitterBufferTarget" in receiver) {
    try {
      receiver.jitterBufferTarget = seconds === null ? null : seconds * 1000;
      return "jitterBufferTarget";
    } catch {
      // Fall through to the LiveKit API if the browser rejects the property.
    }
  }

  if ("playoutDelayHint" in receiver) {
    try {
      track.setPlayoutDelay(seconds ?? 0);
      return "playoutDelayHint";
    } catch {
      return "unsupported";
    }
  }
  return "unsupported";
}

export function applyPlayoutBufferToTracks(tracks: Iterable<RemoteTrack>, value: BufferPreference): PlayoutSupport {
  let support: PlayoutSupport = "unsupported";
  for (const track of tracks) {
    const result = applyPlayoutBuffer(track, value);
    if (result !== "unsupported") support = support === "unsupported" ? result : support;
  }
  return support;
}
