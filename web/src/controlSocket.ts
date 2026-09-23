import type { ClientSignal, ServerSignal } from "./protocol";

type SocketEvent = { data?: unknown };

export type WebSocketLike = {
  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: SocketEvent) => void,
  ): void;
  send(message: string): void;
  close(): void;
};

export type ControlSocketOptions = {
  roomId: string;
  getTicket(): Promise<string>;
  onSignal(signal: ServerSignal): void;
  onFatal(error: Error): void;
  origin?: string;
  WebSocket?: new (url: string) => WebSocketLike;
  setTimeout?: (callback: () => void, delay: number) => unknown;
  clearTimeout?: (timer: unknown) => void;
};

export type ControlSocketSignal = Exclude<
  ClientSignal,
  { type: "authenticate" }
>;

export type ControlSocket = {
  connect(ticket: string): void;
  send(signal: ControlSocketSignal): void;
  close(): void;
};

const RECONNECT_DELAYS = [1000, 2000, 4000, 8000] as const;

function asError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error("Control connection failed");
}

export function createControlSocket(
  options: ControlSocketOptions,
): ControlSocket {
  const WebSocketConstructor =
    options.WebSocket ??
    (globalThis.WebSocket as unknown as new (url: string) => WebSocketLike);
  const schedule: (callback: () => void, delay: number) => unknown =
    options.setTimeout ?? ((callback, delay) => setTimeout(callback, delay));
  const cancel: (timer: unknown) => void =
    options.clearTimeout ??
    ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const origin = options.origin ?? globalThis.location.origin;
  const url = `${origin.replace(/^http/, "ws")}/api/rooms/${encodeURIComponent(options.roomId)}/signal`;

  let socket: WebSocketLike | undefined;
  let writableSocket: WebSocketLike | undefined;
  let reconnectTimer: unknown;
  let reconnectAttempts = 0;
  let highestGeneration = 0;
  let disposed = false;
  let fatal = false;
  let queue: ControlSocketSignal[] = [];

  const fail = (error: unknown) => {
    if (disposed || fatal) return;
    fatal = true;
    options.onFatal(asError(error));
  };

  const scheduleReconnect = () => {
    if (disposed || fatal || reconnectTimer !== undefined) return;
    if (reconnectAttempts >= RECONNECT_DELAYS.length) {
      fail(new Error("Unable to reconnect the control connection"));
      return;
    }
    const delay = RECONNECT_DELAYS[reconnectAttempts];
    reconnectTimer = schedule(() => {
      reconnectTimer = undefined;
      reconnectAttempts += 1;
      void options.getTicket().then(openSocket, () => scheduleReconnect());
    }, delay);
  };

  const handleSignal = (source: WebSocketLike, event: SocketEvent) => {
    if (disposed || typeof event.data !== "string") return;
    let signal: ServerSignal;
    try {
      const parsed: unknown = JSON.parse(event.data);
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        typeof (parsed as { type?: unknown }).type !== "string"
      )
        return;
      signal = parsed as ServerSignal;
    } catch {
      return;
    }
    if ("generation" in signal && typeof signal.generation === "number") {
      if (signal.generation < highestGeneration) return;
      highestGeneration = signal.generation;
    }
    if (signal.type === "authenticated") {
      reconnectAttempts = 0;
      writableSocket = source;
      const pending = queue;
      queue = [];
      for (const queued of pending) source.send(JSON.stringify(queued));
    }
    options.onSignal(signal);
  };

  function openSocket(ticket: string) {
    if (disposed || fatal) return;
    let next: WebSocketLike;
    try {
      next = new WebSocketConstructor(url);
    } catch (error) {
      scheduleReconnect();
      return;
    }
    socket = next;
    let authenticated = false;
    next.addEventListener("open", () => {
      if (disposed || socket !== next || authenticated) return;
      authenticated = true;
      next.send(JSON.stringify({ type: "authenticate", ticket }));
    });
    next.addEventListener("message", (event) => {
      if (socket === next) handleSignal(next, event);
    });
    next.addEventListener("close", () => {
      if (disposed || socket !== next) return;
      socket = undefined;
      if (writableSocket === next) writableSocket = undefined;
      scheduleReconnect();
    });
    next.addEventListener("error", () => {
      // Browsers deliver a close event after a connection error. Reconnecting
      // from close keeps each failed socket to one retry transition.
    });
  }

  return {
    connect(ticket) {
      if (disposed || socket !== undefined || reconnectTimer !== undefined)
        return;
      openSocket(ticket);
    },
    send(signal) {
      if (disposed || fatal) return;
      if ((signal as ClientSignal).type === "authenticate") return;
      if (socket === undefined || writableSocket !== socket) {
        queue.push(signal);
        return;
      }
      socket.send(JSON.stringify(signal));
    },
    close() {
      if (disposed) return;
      disposed = true;
      queue = [];
      if (reconnectTimer !== undefined) {
        cancel(reconnectTimer);
        reconnectTimer = undefined;
      }
      const active = socket;
      socket = undefined;
      writableSocket = undefined;
      active?.close();
    },
  };
}
