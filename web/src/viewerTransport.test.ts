import { afterEach, describe, expect, it, vi } from "vitest";
import { RoomEvent, Track } from "livekit-client";
import type { BroadcastStartedSignal, ServerSignal } from "./protocol";
import { createViewerTransportController } from "./viewerTransport";

const p2p = (generation: number): BroadcastStartedSignal => ({
  type: "broadcast-started",
  generation,
  transport: "p2p",
  viewerLimit: "10",
  iceServers: [{ urls: ["stun:localhost:3478"] }],
});
const server = (generation: number): BroadcastStartedSignal => ({
  type: "broadcast-started",
  generation,
  transport: "server",
  viewerLimit: "10",
  livekit: { url: "ws://media", token: `token-${generation}` },
});
const signal = (value: object) => value as ServerSignal;

class FakeRoom {
  handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  connect = vi.fn(async (_url: string, _token: string) => {});
  disconnect = vi.fn(async () => {});
  startAudio = vi.fn(async () => {});
  on(event: string, callback: (...args: unknown[]) => void) {
    const listeners = this.handlers.get(event) ?? [];
    listeners.push(callback);
    this.handlers.set(event, listeners);
    return this;
  }
  emit(event: string, ...args: unknown[]) {
    for (const callback of this.handlers.get(event) ?? []) callback(...args);
  }
}

class FakePeer {
  ontrack: ((event: RTCTrackEvent) => void) | null = null;
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  connectionState: RTCPeerConnectionState = "new";
  iceConnectionState: RTCIceConnectionState = "new";
  close = vi.fn();
  setRemoteDescription = vi.fn(
    async (_description: RTCSessionDescriptionInit) => {},
  );
  createAnswer = vi.fn(async () => ({
    type: "answer" as const,
    sdp: "answer-sdp",
  }));
  setLocalDescription = vi.fn(
    async (_description: RTCSessionDescriptionInit) => {},
  );
  addIceCandidate = vi.fn(async (_candidate: RTCIceCandidateInit) => {});
  addTransceiver = vi.fn();
}

function harness(pendingSecondConnect?: Promise<void>) {
  const rooms: FakeRoom[] = [];
  const peers: FakePeer[] = [];
  const send = vi.fn();
  const onTrack = vi.fn();
  const onTrackRemoved = vi.fn();
  const onState = vi.fn();
  const onError = vi.fn();
  const controller = createViewerTransportController({
    send,
    onTrack,
    onTrackRemoved,
    onState,
    onError,
    onPlaybackBlocked: vi.fn(),
    Room: class extends FakeRoom {
      constructor() {
        super();
        if (rooms.length === 1 && pendingSecondConnect)
          this.connect.mockImplementation(async () => {
            await pendingSecondConnect;
          });
        rooms.push(this);
      }
    } as never,
    RTCPeerConnection: class extends FakePeer {
      constructor(config: RTCConfiguration) {
        super();
        expect(config.iceServers).toEqual([{ urls: ["stun:localhost:3478"] }]);
        peers.push(this);
      }
    } as never,
  });
  return {
    controller,
    rooms,
    peers,
    send,
    onTrack,
    onTrackRemoved,
    onState,
    onError,
  };
}

afterEach(() => vi.useRealTimers());

describe("viewer transport switching", () => {
  it("reports an unavailable peer API as a strict P2P failure", async () => {
    const onError = vi.fn();
    const controller = createViewerTransportController({
      send: vi.fn(),
      onTrack: vi.fn(),
      onTrackRemoved: vi.fn(),
      onState: vi.fn(),
      onPlaybackBlocked: vi.fn(),
      onError,
      RTCPeerConnection: class {
        constructor() {
          throw new Error("unavailable");
        }
      } as never,
    });
    await expect(controller.switchTo(p2p(1))).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(
      expect.stringMatching(/NAT|firewall/i),
    );
  });
  it("connects a server generation using its personalized LiveKit token", async () => {
    const { controller, rooms } = harness();
    await controller.switchTo(server(1));
    expect(rooms).toHaveLength(1);
    expect(rooms[0].connect).toHaveBeenCalledWith("ws://media", "token-1");
  });

  it("receives a P2P offer, echoes its attempt ID, and applies remote ICE", async () => {
    const { controller, peers, send } = harness();
    await controller.switchTo(p2p(2));
    expect(peers).toHaveLength(1);
    expect(peers[0].ontrack).toBeTypeOf("function");
    expect(peers[0].addTransceiver).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith({ type: "peer-ready", generation: 2 });
    await controller.handleSignal(
      signal({
        type: "ice-candidate",
        generation: 2,
        viewer: "viewer-a",
        negotiationId: "attempt-a",
        candidate: { candidate: "ice-a" },
      }),
    );
    await controller.handleSignal(
      signal({
        type: "offer",
        generation: 2,
        viewer: "viewer-a",
        negotiationId: "attempt-a",
        sdp: "offer-sdp",
      }),
    );
    expect(peers[0].setRemoteDescription).toHaveBeenCalledWith({
      type: "offer",
      sdp: "offer-sdp",
    });
    expect(peers[0].addIceCandidate).toHaveBeenCalledWith({
      candidate: "ice-a",
    });
    expect(send).toHaveBeenCalledWith({
      type: "answer",
      generation: 2,
      negotiationId: "attempt-a",
      sdp: "answer-sdp",
    });
    peers[0].onicecandidate?.({
      candidate: { toJSON: () => ({ candidate: "local-ice" }) },
    } as unknown as RTCPeerConnectionIceEvent);
    expect(send).toHaveBeenCalledWith({
      type: "ice-candidate",
      generation: 2,
      negotiationId: "attempt-a",
      candidate: { candidate: "local-ice" },
    });
    peers[0].onicecandidate?.({
      candidate: { candidate: "fallback-ice", sdpMid: "video" },
    } as RTCPeerConnectionIceEvent);
    expect(send).toHaveBeenCalledWith({
      type: "ice-candidate",
      generation: 2,
      negotiationId: "attempt-a",
      candidate: { candidate: "fallback-ice", sdpMid: "video" },
    });
  });

  it("closes each old transport once across server to P2P to server", async () => {
    const { controller, rooms, peers } = harness();
    await controller.switchTo(server(1));
    await controller.switchTo(p2p(2));
    await controller.switchTo(server(3));
    expect(rooms[0].disconnect).toHaveBeenCalledTimes(1);
    expect(peers[0].close).toHaveBeenCalledTimes(1);
    expect(rooms[1].connect).toHaveBeenCalledWith("ws://media", "token-3");
  });

  it("stops media without changing the caller's logical joined state", async () => {
    const { controller, rooms, onTrackRemoved } = harness();
    const joined = true;
    await controller.switchTo(server(1));
    const track = {
      kind: Track.Kind.Video,
      receiver: {},
      attach: vi.fn(),
      detach: vi.fn(),
    };
    rooms[0].emit(RoomEvent.TrackSubscribed, track);
    controller.stopGeneration(1);
    expect(onTrackRemoved).toHaveBeenCalledWith(track);
    expect(rooms[0].disconnect).toHaveBeenCalledTimes(1);
    expect(joined).toBe(true);
  });

  it("rejects stale server callbacks and stale P2P attempt signals after retry", async () => {
    const { controller, rooms, peers, onTrack, onState, send } = harness();
    await controller.switchTo(server(1));
    await controller.switchTo(p2p(2));
    rooms[0].emit(RoomEvent.TrackSubscribed, { kind: Track.Kind.Video });
    rooms[0].emit(RoomEvent.Disconnected);
    expect(onTrack).not.toHaveBeenCalled();
    expect(onState).not.toHaveBeenCalledWith("disconnected");
    await controller.handleSignal(
      signal({
        type: "offer",
        generation: 2,
        viewer: "viewer-a",
        negotiationId: "old",
        sdp: "offer-old",
      }),
    );
    controller.retryP2P();
    expect(peers[0].close).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenLastCalledWith({
      type: "peer-ready",
      generation: 2,
    });
    await controller.handleSignal(
      signal({
        type: "offer",
        generation: 2,
        viewer: "viewer-a",
        negotiationId: "old",
        sdp: "stale",
      }),
    );
    await controller.handleSignal(
      signal({
        type: "ice-candidate",
        generation: 2,
        viewer: "viewer-a",
        negotiationId: "old",
        candidate: { candidate: "stale" },
      }),
    );
    await controller.handleSignal(
      signal({
        type: "peer-failed",
        generation: 2,
        viewer: "viewer-a",
        negotiationId: "old",
      }),
    );
    expect(peers[1].setRemoteDescription).not.toHaveBeenCalled();
    expect(peers[1].addIceCandidate).not.toHaveBeenCalled();
    expect(peers[1].close).not.toHaveBeenCalled();
  });

  it("ignores a server connect that finishes after a new generation starts", async () => {
    let resolveConnect!: () => void;
    const pendingConnect = new Promise<void>((resolve) => {
      resolveConnect = resolve;
    });
    const { controller, rooms } = harness(pendingConnect);
    await controller.switchTo(server(1));
    const second = controller.switchTo(server(2));
    await controller.switchTo(p2p(3));
    resolveConnect();
    await second;
    expect(rooms[1].startAudio).not.toHaveBeenCalled();
    expect(rooms[1].disconnect).toHaveBeenCalledTimes(1);
  });

  it("exposes the native P2P receiver and removes its track on a switch", async () => {
    const { controller, peers, onTrack, onTrackRemoved } = harness();
    await controller.switchTo(p2p(1));
    const report = new Map() as RTCStatsReport;
    const receiver = {
      getStats: vi.fn(async () => report),
    } as unknown as RTCRtpReceiver;
    const media = { kind: "video" } as MediaStreamTrack;
    const stream = {} as MediaStream;
    peers[0].ontrack?.({
      track: media,
      receiver,
      streams: [stream],
    } as unknown as RTCTrackEvent);
    const wrapped = onTrack.mock.calls[0][0];
    expect(wrapped.receiver).toBe(receiver);
    expect(await wrapped.getRTCStatsReport()).toBe(report);
    const element = { srcObject: null } as unknown as HTMLMediaElement;
    wrapped.attach(element);
    expect(element.srcObject).toBe(stream);
    await controller.switchTo(server(2));
    expect(onTrackRemoved).toHaveBeenCalledWith(wrapped);
  });

  it("reports strict P2P failure after 20 seconds without constructing LiveKit", async () => {
    vi.useFakeTimers();
    const { controller, rooms, peers, onError } = harness();
    await controller.switchTo(p2p(4));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(peers[0].close).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      expect.stringMatching(/NAT|firewall/i),
    );
    expect(rooms).toHaveLength(0);
    controller.retryP2P();
    expect(peers).toHaveLength(2);
    expect(peers[1].close).not.toHaveBeenCalled();
  });
});
