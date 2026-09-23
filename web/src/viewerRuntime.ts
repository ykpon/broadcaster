import {
  loadBufferPreference,
  saveBufferPreference,
  type BufferPreference,
} from "./playout";
import {
  createControlSocket,
  type ControlSocket,
  type ControlSocketOptions,
} from "./controlSocket";
import type { JoinResponse, ServerSignal } from "./protocol";

type StorageGetter = () => Storage;

export type ViewerSessionOptions = {
  roomId: string;
  readSession(): string;
  writeSession(session: string): void;
  postJoin(session: string): Promise<JoinResponse>;
  postTicket(session: string): Promise<string>;
  onAuthenticated(): void;
  onSignal(signal: ServerSignal): void;
  onFatal(error: Error): void;
  makeSocket?: (options: ControlSocketOptions) => ControlSocket;
};

export function createViewerSession(options: ViewerSessionOptions) {
  let disposed = false;
  let socket: ControlSocket | undefined;
  let joinPromise: Promise<void> | undefined;
  let authenticated = false;
  return {
    join() {
      if (disposed) return Promise.resolve();
      if (joinPromise) return joinPromise;
      joinPromise = (async () => {
        const response = await options.postJoin(options.readSession());
        if (disposed) return;
        options.writeSession(response.session);
        const control = (options.makeSocket ?? createControlSocket)({
          roomId: options.roomId,
          getTicket: () => options.postTicket(response.session),
          onSignal: (signal) => {
            if (disposed) return;
            if (signal.type === "authenticated") {
              if (!authenticated) {
                authenticated = true;
                options.onAuthenticated();
              }
              return;
            }
            options.onSignal(signal);
          },
          onFatal: (error) => {
            if (!disposed) options.onFatal(error);
          },
        });
        if (disposed) {
          control.close();
          return;
        }
        socket = control;
        control.connect(response.ticket);
      })();
      return joinPromise;
    },
    send: (signal: Parameters<ControlSocket["send"]>[0]) =>
      socket?.send(signal),
    close() {
      if (disposed) return;
      disposed = true;
      socket?.close();
      socket = undefined;
    },
  };
}

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
  sequence: number;
  track: T;
  previous: S | undefined;
};

export function createIncomingStatsTracker<T, S>() {
  let generation = 0;
  let sequence = 0;
  let track: T | null = null;
  let sample: S | undefined;
  let inFlight: IncomingStatsRead<T, S> | undefined;

  return {
    current() {
      return track;
    },
    replace(next: T | null) {
      if (track === next) return false;
      track = next;
      sample = undefined;
      inFlight = undefined;
      generation += 1;
      return true;
    },
    capture(candidate: T): IncomingStatsRead<T, S> | undefined {
      if (inFlight) return undefined;
      inFlight = {
        generation,
        sequence: ++sequence,
        track: candidate,
        previous: candidate === track ? sample : undefined,
      };
      return inFlight;
    },
    commit(read: IncomingStatsRead<T, S>, next: S | undefined) {
      if (inFlight !== read) return false;
      inFlight = undefined;
      if (read.generation !== generation || read.track !== track) return false;
      sample = next;
      return true;
    },
    release(read: IncomingStatsRead<T, S>) {
      if (inFlight === read) inFlight = undefined;
    },
  };
}
