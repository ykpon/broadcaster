import { describe, expect, it, vi } from "vitest";
import { createControlSocket } from "./controlSocket";
import type { ClientSignal, ServerSignal } from "./protocol";

class FakeWebSocket {
  readonly sent: string[] = [];
  readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  closeCalls = 0;

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: (event: unknown) => void) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(message: string) {
    this.sent.push(message);
  }

  close() {
    this.closeCalls += 1;
    this.emit("close", {});
  }

  emitOpen() {
    this.emit("open", {});
  }

  emitClose() {
    this.emit("close", {});
  }

  emitMessage(message: ServerSignal) {
    this.emit("message", { data: JSON.stringify(message) });
  }

  private emit(type: string, event: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function socketHarness(overrides: Record<string, unknown> = {}) {
  const sockets: FakeWebSocket[] = [];
  const events: ServerSignal[] = [];
  const timers: Array<{
    delay: number;
    callback: () => void;
    cleared: boolean;
  }> = [];
  const WebSocket = class extends FakeWebSocket {
    constructor(url: string) {
      super(url);
      sockets.push(this);
    }
  };
  const options = {
    roomId: "room /?",
    origin: "https://broadcast.example:8443",
    WebSocket,
    getTicket: vi.fn(async () => "fresh-ticket"),
    onSignal: (event: ServerSignal) => events.push(event),
    onFatal: vi.fn(),
    setTimeout: (callback: () => void, delay: number) => {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer: { cleared: boolean }) => {
      timer.cleared = true;
    },
    ...overrides,
  };
  const control = createControlSocket(options as never);
  const fireNextTimer = async () => {
    const timer = timers.find((candidate) => !candidate.cleared);
    if (!timer) throw new Error("no pending timer");
    timer.cleared = true;
    timer.callback();
    await Promise.resolve();
    await Promise.resolve();
  };
  return { control, sockets, events, timers, options, fireNextTimer };
}

describe("control socket", () => {
  it("authenticates first exactly once and filters stale generations", () => {
    const { control, sockets, events } = socketHarness();
    control.connect("ticket-1");

    expect(sockets[0].url).toBe(
      "wss://broadcast.example:8443/api/rooms/room%20%2F%3F/signal",
    );
    sockets[0].emitOpen();
    sockets[0].emitOpen();
    expect(sockets[0].sent).toEqual([
      JSON.stringify({ type: "authenticate", ticket: "ticket-1" }),
    ]);

    sockets[0].emitMessage({
      type: "broadcast-started",
      generation: 2,
      transport: "p2p",
      viewerLimit: "10",
      iceServers: [{ urls: ["stun:example.test:3478"] }],
    });
    sockets[0].emitMessage({ type: "broadcast-stopped", generation: 1 });
    expect(events.map((event) => event.generation)).toEqual([2]);
  });

  it("queues application messages until server authentication", () => {
    const { control, sockets } = socketHarness();
    const message: ClientSignal = { type: "broadcast-ready", generation: 4 };
    control.connect("ticket-1");
    control.send(message);
    expect(sockets[0].sent).toEqual([]);

    sockets[0].emitOpen();
    const next: ClientSignal = { type: "broadcast-stopped", generation: 4 };
    control.send(next);
    expect(sockets[0].sent).toEqual([
      JSON.stringify({ type: "authenticate", ticket: "ticket-1" }),
    ]);

    sockets[0].emitMessage({ type: "authenticated", generation: 4 });
    expect(sockets[0].sent).toEqual([
      JSON.stringify({ type: "authenticate", ticket: "ticket-1" }),
      JSON.stringify(message),
      JSON.stringify(next),
    ]);

    const after: ClientSignal = { type: "broadcast-ready", generation: 4 };
    control.send(after);
    expect(sockets[0].sent.at(-1)).toBe(JSON.stringify(after));
  });

  it("keeps queued messages when an unauthenticated socket is rejected", async () => {
    const harness = socketHarness();
    const message: ClientSignal = { type: "broadcast-ready", generation: 4 };
    harness.control.connect("ticket-1");
    harness.control.send(message);
    harness.sockets[0].emitOpen();
    harness.sockets[0].emitClose();

    await harness.fireNextTimer();
    harness.sockets[1].emitOpen();
    expect(harness.sockets[1].sent).toEqual([
      JSON.stringify({ type: "authenticate", ticket: "fresh-ticket" }),
    ]);
    harness.sockets[1].emitMessage({
      type: "authenticated",
      generation: 4,
    });
    expect(harness.sockets[1].sent).toEqual([
      JSON.stringify({ type: "authenticate", ticket: "fresh-ticket" }),
      JSON.stringify(message),
    ]);
  });

  it("rejects caller-supplied authentication frames", () => {
    const { control, sockets } = socketHarness();
    const injected = { type: "authenticate", ticket: "attacker-ticket" };
    control.send(injected as never);
    control.connect("ticket-1");
    sockets[0].emitOpen();
    control.send(injected as never);
    sockets[0].emitMessage({ type: "authenticated", generation: 1 });
    control.send(injected as never);

    expect(sockets[0].sent).toEqual([
      JSON.stringify({ type: "authenticate", ticket: "ticket-1" }),
    ]);
  });

  it("reconnects after 1/2/4/8 seconds with fresh tickets then fails", async () => {
    const getTicket = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("ticket-2")
      .mockResolvedValueOnce("ticket-3")
      .mockResolvedValueOnce("ticket-4")
      .mockResolvedValueOnce("ticket-5");
    const onFatal = vi.fn();
    const harness = socketHarness({ getTicket, onFatal });
    harness.control.connect("ticket-1");
    harness.sockets[0].emitOpen();
    harness.sockets[0].emitClose();

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      expect(harness.timers.at(-1)?.delay).toBe(2 ** (attempt - 1) * 1000);
      await harness.fireNextTimer();
      harness.sockets[attempt].emitOpen();
      expect(harness.sockets[attempt].sent[0]).toBe(
        JSON.stringify({
          type: "authenticate",
          ticket: `ticket-${attempt + 1}`,
        }),
      );
      harness.sockets[attempt].emitClose();
    }

    expect(getTicket).toHaveBeenCalledTimes(4);
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(harness.timers.map((timer) => timer.delay)).toEqual([
      1000, 2000, 4000, 8000,
    ]);
  });

  it("resets reconnect backoff only after server authentication", async () => {
    const harness = socketHarness();
    harness.control.connect("ticket-1");
    harness.sockets[0].emitClose();
    await harness.fireNextTimer();
    harness.sockets[1].emitOpen();
    harness.sockets[1].emitMessage({
      type: "authenticated",
      generation: 3,
      viewer: "viewer-a",
    });
    harness.sockets[1].emitClose();
    expect(harness.timers.at(-1)?.delay).toBe(1000);
  });

  it("ignores late messages from a superseded socket", async () => {
    const harness = socketHarness();
    harness.control.connect("ticket-1");
    harness.sockets[0].emitClose();
    await harness.fireNextTimer();
    harness.sockets[1].emitOpen();

    harness.sockets[0].emitMessage({
      type: "broadcast-started",
      generation: 99,
      transport: "p2p",
      viewerLimit: "10",
      iceServers: [],
    });
    harness.sockets[1].emitMessage({
      type: "broadcast-started",
      generation: 2,
      transport: "p2p",
      viewerLimit: "10",
      iceServers: [],
    });

    expect(harness.events.map((event) => event.generation)).toEqual([2]);
  });

  it("closes the socket, cancels reconnects, and never flushes queued messages", () => {
    const harness = socketHarness();
    harness.control.connect("ticket-1");
    harness.control.send({ type: "broadcast-ready", generation: 1 });
    harness.control.close();
    harness.sockets[0].emitOpen();

    expect(harness.sockets[0].closeCalls).toBe(1);
    expect(harness.sockets[0].sent).toEqual([]);

    const reconnecting = socketHarness();
    reconnecting.control.connect("ticket-1");
    reconnecting.control.send({ type: "broadcast-ready", generation: 1 });
    reconnecting.sockets[0].emitClose();
    reconnecting.control.close();
    reconnecting.sockets[0].emitOpen();

    expect(reconnecting.sockets[0].sent).toEqual([]);
    expect(reconnecting.timers[0].cleared).toBe(true);
    expect(reconnecting.options.getTicket).not.toHaveBeenCalled();
  });
});
