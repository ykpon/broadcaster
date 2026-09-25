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
import type { JoinResponse, ServerSignal, TransportMode } from "./protocol";

type StorageGetter = () => Storage;

export type ViewerFailure = {
  message: string;
  scope: "transport" | "room";
};

export type ViewerFailureEvent =
  | { type: "error"; message: string; scope: ViewerFailure["scope"] }
  | {
      type:
        "broadcast-stopped" | "room-ended" | "transport-connecting" | "clear";
    }
  | { type: "control-fatal"; message: string };

export function reduceViewerFailure(
  current: ViewerFailure | undefined,
  event: ViewerFailureEvent,
): ViewerFailure | undefined {
  if (event.type === "error")
    return { message: event.message, scope: event.scope };
  if (event.type === "control-fatal")
    return { message: event.message, scope: "room" };
  if (event.type === "clear") return undefined;
  return current?.scope === "transport" ? undefined : current;
}

export function visibleViewerError(
  failure: ViewerFailure | undefined,
  roomError: string,
): string {
  return failure?.message || roomError;
}

export function viewerErrorPresentation(
  failure: ViewerFailure | undefined,
  roomError: string,
  scene: { action: ViewerSceneAction },
): string {
  if (scene.action === "retry-p2p" && failure?.scope === "transport")
    return roomError;
  return visibleViewerError(failure, roomError);
}

export type ViewerSceneAction =
  "join" | "retry-p2p" | "retry-server" | "create-room" | null;

export type ViewerSceneInput = {
  joined: boolean;
  active: boolean;
  transport: TransportMode | undefined;
  p2pFailed: boolean;
  serverFailed?: boolean;
  ended: boolean;
};

export function viewerScene({
  joined,
  active,
  transport,
  p2pFailed,
  serverFailed = false,
  ended,
}: ViewerSceneInput): {
  title: string;
  subtitle: string;
  action: ViewerSceneAction;
} {
  if (ended)
    return {
      title: "Этот эфир завершён",
      subtitle:
        "Спасибо, что были рядом. Здесь можно создать собственную комнату.",
      action: "create-room",
    };
  if (!joined)
    return {
      title: "Вы приглашены в эфир",
      subtitle: "Подключитесь, чтобы увидеть трансляцию и услышать звук.",
      action: "join",
    };
  if (!active || !transport)
    return {
      title: "Ведущий готовится к эфиру",
      subtitle: "Оставайтесь здесь — изображение появится автоматически.",
      action: null,
    };
  if (transport === "p2p" && p2pFailed)
    return {
      title: "Прямое соединение не установлено",
      subtitle:
        "Сеть, NAT или firewall не пропускают P2P. Повторите попытку или попросите ведущего запустить эфир через сервер.",
      action: "retry-p2p",
    };
  if (transport === "server" && serverFailed)
    return {
      title: "Соединение с медиасервером потеряно",
      subtitle: "Повторите подключение к текущему эфиру.",
      action: "retry-server",
    };
  if (transport === "p2p")
    return {
      title: "Устанавливаем прямое соединение",
      subtitle: "Изображение и звук появятся после подключения к ведущему.",
      action: null,
    };
  return {
    title: "Подключаемся через сервер",
    subtitle: "Изображение и звук появятся автоматически.",
    action: null,
  };
}

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
    leave() {
      if (disposed) return;
      socket?.send({ type: "leave" });
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
