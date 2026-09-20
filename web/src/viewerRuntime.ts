import {
  loadBufferPreference,
  saveBufferPreference,
  type BufferPreference,
} from "./playout";

type StorageGetter = () => Storage;

export function loadBufferPreferenceSafely(
  getStorage: StorageGetter,
): BufferPreference {
  try {
    return loadBufferPreference(getStorage());
  } catch {
    return null;
  }
}

export function saveBufferPreferenceSafely(
  getStorage: StorageGetter,
  value: BufferPreference,
): void {
  try {
    saveBufferPreference(getStorage(), value);
  } catch {
    // Acquiring localStorage can itself throw in restricted browser contexts.
  }
}

export type IncomingStatsRead<T, S> = {
  generation: number;
  track: T;
  previous: S | undefined;
};

export function createIncomingStatsTracker<T, S>() {
  let generation = 0;
  let track: T | null = null;
  let sample: S | undefined;

  return {
    current() {
      return track;
    },
    replace(next: T | null) {
      if (track === next) return false;
      track = next;
      sample = undefined;
      generation += 1;
      return true;
    },
    capture(candidate: T): IncomingStatsRead<T, S> {
      return {
        generation,
        track: candidate,
        previous: candidate === track ? sample : undefined,
      };
    },
    commit(read: IncomingStatsRead<T, S>, next: S | undefined) {
      if (read.generation !== generation || read.track !== track) return false;
      sample = next;
      return true;
    },
  };
}
