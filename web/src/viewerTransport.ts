import {
  ConnectionState,
  Room,
  RoomEvent,
  Track,
  type RemoteTrack,
} from "livekit-client";
import type {
  BroadcastStartedSignal,
  ICECandidate,
  ServerSignal,
} from "./protocol";
import type { ControlSocketSignal } from "./controlSocket";

export const P2P_CONNECTION_ERROR =
  "Сеть, NAT или firewall не пропускают P2P. Повторите попытку или попросите ведущего запустить эфир через сервер.";
export const SERVER_CONNECTION_ERROR =
  "Соединение с медиасервером потеряно. Повторите подключение к текущему эфиру.";

export type ViewerMediaTrack = {
  kind: Track.Kind;
  receiver?: RTCRtpReceiver;
  attach(element: HTMLMediaElement): void;
  detach(): void;
  getRTCStatsReport(): Promise<RTCStatsReport | undefined>;
  setPlayoutDelay?(seconds: number): void;
};

type RoomConstructor = new (options: { adaptiveStream: false }) => Room;
type PeerConstructor = new (
  configuration: RTCConfiguration,
) => RTCPeerConnection;

export type ViewerTransportOptions = {
  send(signal: ControlSocketSignal): void;
  onTrack(track: ViewerMediaTrack): void;
  onTrackRemoved(track: ViewerMediaTrack): void;
  onState(state: ConnectionState | RTCPeerConnectionState): void;
  onPlaybackBlocked(): void;
  onError(message: string): void;
  Room?: RoomConstructor;
  RTCPeerConnection?: PeerConstructor;
};

type BaseState = {
  generation: number;
  tracks: Set<ViewerMediaTrack>;
  closed: boolean;
};
type ServerState = BaseState & { kind: "server"; room: Room };
type P2PState = BaseState & {
  kind: "p2p";
  peer: RTCPeerConnection;
  iceServers: RTCIceServer[];
  negotiationId?: string;
  pendingCandidates: Map<string, ICECandidate[]>;
  remoteReady: boolean;
  draining: boolean;
  timer: ReturnType<typeof setTimeout>;
};
type State = ServerState | P2PState;

function nativeTrack(event: RTCTrackEvent): ViewerMediaTrack {
  const media = event.track;
  const receiver = event.receiver;
  let attached: HTMLMediaElement | undefined;
  let stream: MediaStream | undefined;
  return {
    kind: media.kind as Track.Kind,
    receiver,
    attach(element) {
      stream = event.streams[0] ?? new MediaStream([media]);
      element.srcObject = stream;
      attached = element;
    },
    detach() {
      if (attached && attached.srcObject === stream) attached.srcObject = null;
      attached = undefined;
      stream = undefined;
    },
    getRTCStatsReport: () => receiver.getStats(),
  };
}

export function createViewerTransportController(
  options: ViewerTransportOptions,
) {
  const RoomClass = options.Room ?? Room;
  const PeerClass = options.RTCPeerConnection ?? globalThis.RTCPeerConnection;
  let active: State | undefined;
  let latestGeneration = 0;
  let disposed = false;
  let lastP2P: { generation: number; iceServers: RTCIceServer[] } | undefined;
  let lastServerGeneration: number | undefined;
  const retiredAttempts = new Set<string>();

  const current = (state: State) =>
    !disposed && active === state && !state.closed;

  const closeState = (state: State) => {
    if (state.closed) return;
    state.closed = true;
    for (const track of state.tracks) options.onTrackRemoved(track);
    state.tracks.clear();
    if (state.kind === "server") void state.room.disconnect();
    else {
      clearTimeout(state.timer);
      if (state.negotiationId) retiredAttempts.add(state.negotiationId);
      state.peer.close();
    }
  };

  const clearActive = () => {
    const previous = active;
    active = undefined;
    if (previous) closeState(previous);
  };

  const failP2P = (state: P2PState) => {
    if (!current(state)) return;
    const negotiationId = state.negotiationId;
    clearActive();
    options.onState("failed");
    options.onError(P2P_CONNECTION_ERROR);
    options.send({
      type: "peer-failed",
      generation: state.generation,
      ...(negotiationId ? { negotiationId } : {}),
    });
  };

  const failServer = (state: ServerState) => {
    if (!current(state)) return;
    clearActive();
    options.onState("failed");
    options.onError(SERVER_CONNECTION_ERROR);
  };

  const startP2P = (generation: number, iceServers: RTCIceServer[]) => {
    lastP2P = { generation, iceServers };
    let peer: RTCPeerConnection;
    try {
      peer = new PeerClass({ iceServers });
    } catch {
      options.onState("failed");
      options.onError(P2P_CONNECTION_ERROR);
      return;
    }
    const state: P2PState = {
      kind: "p2p",
      generation,
      peer,
      iceServers,
      tracks: new Set(),
      closed: false,
      pendingCandidates: new Map(),
      remoteReady: false,
      draining: false,
      timer: undefined as unknown as ReturnType<typeof setTimeout>,
    };
    active = state;
    peer.ontrack = (event) => {
      if (!current(state)) return;
      const track = nativeTrack(event);
      state.tracks.add(track);
      options.onTrack(track);
    };
    peer.onicecandidate = (event) => {
      if (!current(state) || !event.candidate || !state.negotiationId) return;
      const candidate = event.candidate.toJSON
        ? event.candidate.toJSON()
        : event.candidate;
      options.send({
        type: "ice-candidate",
        generation,
        negotiationId: state.negotiationId,
        candidate: {
          candidate: candidate.candidate ?? event.candidate.candidate,
          ...(candidate.sdpMid == null ? {} : { sdpMid: candidate.sdpMid }),
          ...(candidate.sdpMLineIndex == null
            ? {}
            : { sdpMLineIndex: candidate.sdpMLineIndex }),
          ...(candidate.usernameFragment == null
            ? {}
            : { usernameFragment: candidate.usernameFragment }),
        },
      });
    };
    const connectionChanged = () => {
      if (!current(state)) return;
      if (
        peer.connectionState === "failed" ||
        peer.iceConnectionState === "failed"
      ) {
        failP2P(state);
      } else if (
        peer.connectionState === "connected" ||
        peer.iceConnectionState === "connected" ||
        peer.iceConnectionState === "completed"
      ) {
        clearTimeout(state.timer);
        options.onState("connected");
      } else {
        options.onState(peer.connectionState);
      }
    };
    peer.onconnectionstatechange = connectionChanged;
    peer.oniceconnectionstatechange = connectionChanged;
    state.timer = setTimeout(() => failP2P(state), 20_000);
    options.onState("connecting");
    options.send({ type: "peer-ready", generation });
    return state;
  };

  const drainCandidates = async (state: P2PState) => {
    if (!state.negotiationId || !state.remoteReady || state.draining) return;
    state.draining = true;
    try {
      const candidates = state.pendingCandidates.get(state.negotiationId) ?? [];
      while (candidates.length > 0 && current(state)) {
        await state.peer.addIceCandidate(candidates.shift()!);
      }
      state.pendingCandidates.delete(state.negotiationId);
    } finally {
      state.draining = false;
    }
  };

  return {
    async switchTo(event: BroadcastStartedSignal) {
      if (
        disposed ||
        event.generation < latestGeneration ||
        (event.generation === latestGeneration && !event.resync)
      )
        return;
      latestGeneration = event.generation;
      clearActive();
      if (event.transport === "p2p") {
        lastServerGeneration = undefined;
        startP2P(event.generation, event.iceServers);
        return;
      }
      lastP2P = undefined;
      lastServerGeneration = event.generation;
      const room = new RoomClass({ adaptiveStream: false });
      const state: ServerState = {
        kind: "server",
        generation: event.generation,
        room,
        tracks: new Set(),
        closed: false,
      };
      active = state;
      room.on(RoomEvent.ConnectionStateChanged, (connectionState) => {
        if (current(state)) options.onState(connectionState);
      });
      room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
        if (!current(state)) return;
        state.tracks.add(track);
        options.onTrack(track);
      });
      room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
        if (!current(state) || !state.tracks.delete(track)) return;
        options.onTrackRemoved(track);
      });
      room.on(RoomEvent.Disconnected, () => {
        failServer(state);
      });
      options.onState(ConnectionState.Connecting);
      try {
        await room.connect(event.livekit.url, event.livekit.token);
        if (!current(state)) return;
        await room.startAudio().catch(() => {
          if (current(state)) options.onPlaybackBlocked();
        });
      } catch (error) {
        if (current(state)) failServer(state);
      }
    },
    async handleSignal(event: ServerSignal) {
      if (event.type === "broadcast-started") return this.switchTo(event);
      if (event.type === "broadcast-stopped")
        return this.stopGeneration(event.generation);
      const state = active;
      if (
        !state ||
        state.kind !== "p2p" ||
        !current(state) ||
        !("generation" in event) ||
        event.generation !== state.generation
      )
        return;
      if (event.type === "peer-failed") {
        if (event.negotiationId && event.negotiationId === state.negotiationId)
          failP2P(state);
        return;
      }
      if (event.type !== "offer" && event.type !== "ice-candidate") return;
      if (!event.negotiationId || retiredAttempts.has(event.negotiationId))
        return;
      if (state.negotiationId && event.negotiationId !== state.negotiationId)
        return;
      if (event.type === "ice-candidate") {
        const pending = state.pendingCandidates.get(event.negotiationId) ?? [];
        pending.push(event.candidate);
        state.pendingCandidates.set(event.negotiationId, pending);
        try {
          await drainCandidates(state);
        } catch {
          failP2P(state);
        }
        return;
      }
      if (state.negotiationId) return;
      state.negotiationId = event.negotiationId;
      try {
        await state.peer.setRemoteDescription({
          type: "offer",
          sdp: event.sdp,
        });
        if (!current(state)) return;
        state.remoteReady = true;
        await drainCandidates(state);
        if (!current(state)) return;
        const answer = await state.peer.createAnswer();
        if (!current(state)) return;
        await state.peer.setLocalDescription(answer);
        if (!current(state)) return;
        options.send({
          type: "answer",
          generation: state.generation,
          negotiationId: event.negotiationId,
          sdp: answer.sdp ?? "",
        });
      } catch {
        failP2P(state);
      }
    },
    retryP2P() {
      const state = active;
      if (state && (state.kind !== "p2p" || !current(state))) return;
      const target = lastP2P;
      if (!target || target.generation !== latestGeneration || disposed) return;
      if (state) clearActive();
      startP2P(target.generation, target.iceServers);
    },
    retryServer() {
      if (
        disposed ||
        lastServerGeneration === undefined ||
        lastServerGeneration !== latestGeneration
      )
        return;
      options.send({
        type: "viewer-retry",
        generation: lastServerGeneration,
      });
    },
    stopGeneration(generation: number) {
      if (disposed || generation < latestGeneration) return;
      latestGeneration = generation;
      if (active && active.generation <= generation) clearActive();
      lastP2P = undefined;
      lastServerGeneration = undefined;
      options.onState(ConnectionState.Disconnected);
    },
    async startAudio() {
      const state = active;
      if (state?.kind === "server" && current(state))
        await state.room.startAudio();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      lastP2P = undefined;
      lastServerGeneration = undefined;
      clearActive();
    },
  };
}

export type ViewerTransportController = ReturnType<
  typeof createViewerTransportController
>;
