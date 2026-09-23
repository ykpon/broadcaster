import {
  aggregateOutboundMetrics,
  parseOutboundStats,
  type CounterSample,
  type StreamMetrics,
} from "./stats";
import type { ICECandidate, ServerSignal } from "./protocol";
import {
  applyAudioSenderSettings,
  applyQuality,
  applyVideoSenderSettings,
  videoSettingsChanged,
} from "./media";
import { qualityHints, type StreamSettings } from "./quality";
import type {
  PublisherCallbacks,
  PublisherStart,
  StudioPublisher,
} from "./studioTransport";

const PEER_TIMEOUT_MS = 20_000;

export type P2PSignaling = {
  handleSignal(signal: ServerSignal): Promise<void>;
};

type PeerState = {
  connection: RTCPeerConnection;
  negotiationId: string;
  timer: ReturnType<typeof setTimeout>;
  videoSender?: RTCRtpSender;
  audioSender?: RTCRtpSender;
  videoSample?: CounterSample;
  audioSample?: CounterSample;
  connected: boolean;
  remoteDescriptionSet: boolean;
  drainingCandidates: boolean;
  pendingCandidates: ICECandidate[];
};

type PeerConnectionConstructor = new (
  configuration?: RTCConfiguration,
) => RTCPeerConnection;

type P2PDependencies = {
  RTCPeerConnection: PeerConnectionConstructor;
  getSenderCapabilities(kind: "video"): RTCRtpCapabilities | null;
  createNegotiationId(): string;
};

const defaultDependencies: P2PDependencies = {
  RTCPeerConnection: globalThis.RTCPeerConnection,
  getSenderCapabilities: (kind) => RTCRtpSender.getCapabilities(kind),
  createNegotiationId: () => globalThis.crypto.randomUUID(),
};

function preferredCodecs(
  capabilities: RTCRtpCapabilities | null,
  codec: string,
): RTCRtpCodec[] {
  if (!capabilities) return [];
  const mimeType = `video/${codec}`.toLowerCase();
  const preferred = capabilities.codecs.filter(
    (candidate) => candidate.mimeType.toLowerCase() === mimeType,
  );
  const others = capabilities.codecs.filter(
    (candidate) => candidate.mimeType.toLowerCase() !== mimeType,
  );
  return [...preferred, ...others];
}

export function createP2PPublisher(
  callbacks: PublisherCallbacks,
  dependencies: P2PDependencies = defaultDependencies,
): StudioPublisher & P2PSignaling {
  const peers = new Map<string, PeerState>();
  const peerRequests = new Map<string, object>();
  const failedViewers = new Set<string>();
  let startInput: PublisherStart | undefined;
  let settings: StreamSettings | undefined;
  let qualityUpdate: Promise<unknown> | undefined;
  let stopPromise: Promise<void> | undefined;

  const readMetrics = async (
    kind: "video" | "audio",
  ): Promise<StreamMetrics> => {
    const reports: StreamMetrics[] = [];
    for (const [viewer, state] of Array.from(peers)) {
      const sender = kind === "video" ? state.videoSender : state.audioSender;
      if (!sender) continue;
      try {
        const report = await state.connection.getStats(sender.track ?? null);
        if (peers.get(viewer) !== state) continue;
        const previous =
          kind === "video" ? state.videoSample : state.audioSample;
        const parsed = parseOutboundStats(report.values(), previous);
        if (kind === "video") state.videoSample = parsed.sample;
        else state.audioSample = parsed.sample;
        reports.push(parsed.metrics);
      } catch {
        // A stats read is diagnostic only and must not affect healthy peers.
      }
    }
    return aggregateOutboundMetrics(reports);
  };

  const statsSource = (kind: "video" | "audio") => ({
    async getStats() {
      for (const state of peers.values()) {
        const sender = kind === "video" ? state.videoSender : state.audioSender;
        if (sender) return state.connection.getStats(sender.track ?? null);
      }
      return new Map() as RTCStatsReport;
    },
    getMetrics: () => readMetrics(kind),
  });

  const videoStats = statsSource("video");
  const audioStats = statsSource("audio");

  const notifyCounts = () => {
    if (!startInput) return;
    let connected = 0;
    for (const state of peers.values()) {
      if (state.connected) connected += 1;
    }
    callbacks.onPeerCountsChanged?.(
      startInput.generation,
      connected,
      failedViewers.size,
    );
  };

  const closePeer = (viewer: string, expected?: PeerState) => {
    const state = peers.get(viewer);
    if (!state || (expected && state !== expected)) return false;
    peers.delete(viewer);
    clearTimeout(state.timer);
    state.connection.close();
    return true;
  };

  const failPeer = (viewer: string, state: PeerState) => {
    if (!startInput || stopPromise || !closePeer(viewer, state)) return;
    failedViewers.add(viewer);
    startInput.send({
      type: "peer-failed",
      generation: startInput.generation,
      viewer,
      negotiationId: state.negotiationId,
    });
    notifyCounts();
  };

  const createPeer = async (viewer: string, request: object) => {
    const requestedInput = startInput;
    await qualityUpdate?.catch(() => {});
    const input = startInput;
    const currentSettings = settings;
    if (
      !input ||
      input !== requestedInput ||
      stopPromise ||
      !currentSettings ||
      peerRequests.get(viewer) !== request
    )
      return;

    peerRequests.delete(viewer);
    closePeer(viewer);
    failedViewers.delete(viewer);

    const connection = new dependencies.RTCPeerConnection({
      iceServers: input.iceServers ?? [],
    });
    const negotiationId = dependencies.createNegotiationId();
    const videoTrack = input.stream.getVideoTracks()[0];
    const audioTrack = input.stream.getAudioTracks()[0];
    const videoTransceiver = videoTrack
      ? connection.addTransceiver(videoTrack, {
          direction: "sendonly",
          streams: [input.stream],
        })
      : undefined;
    const audioTransceiver = audioTrack
      ? connection.addTransceiver(audioTrack, {
          direction: "sendonly",
          streams: [input.stream],
        })
      : undefined;
    const codecs = preferredCodecs(
      dependencies.getSenderCapabilities("video"),
      input.settings.codec,
    );
    if (videoTransceiver && codecs.length > 0)
      videoTransceiver.setCodecPreferences(codecs);

    const state: PeerState = {
      connection,
      negotiationId,
      timer: setTimeout(() => failPeer(viewer, state), PEER_TIMEOUT_MS),
      videoSender: videoTransceiver?.sender,
      audioSender: audioTransceiver?.sender,
      connected: false,
      remoteDescriptionSet: false,
      drainingCandidates: false,
      pendingCandidates: [],
    };
    peers.set(viewer, state);
    notifyCounts();

    connection.onicecandidate = (event) => {
      const current = startInput;
      if (
        !current ||
        current !== input ||
        stopPromise ||
        peers.get(viewer) !== state ||
        !event.candidate
      )
        return;
      const serialized = event.candidate.toJSON
        ? event.candidate.toJSON()
        : {
            candidate: event.candidate.candidate,
            sdpMid: event.candidate.sdpMid ?? undefined,
            sdpMLineIndex: event.candidate.sdpMLineIndex ?? undefined,
            usernameFragment: event.candidate.usernameFragment ?? undefined,
          };
      const candidate = {
        candidate: serialized.candidate ?? event.candidate.candidate,
        ...(serialized.sdpMid == null ? {} : { sdpMid: serialized.sdpMid }),
        ...(serialized.sdpMLineIndex == null
          ? {}
          : { sdpMLineIndex: serialized.sdpMLineIndex }),
        ...(serialized.usernameFragment == null
          ? {}
          : { usernameFragment: serialized.usernameFragment }),
      };
      current.send({
        type: "ice-candidate",
        generation: current.generation,
        viewer,
        negotiationId,
        candidate,
      });
    };

    const handleConnectionState = () => {
      if (stopPromise || peers.get(viewer) !== state) return;
      if (
        connection.connectionState === "failed" ||
        connection.iceConnectionState === "failed"
      ) {
        failPeer(viewer, state);
        return;
      }
      if (
        connection.connectionState === "connected" ||
        connection.iceConnectionState === "connected" ||
        connection.iceConnectionState === "completed"
      ) {
        if (!state.connected) {
          state.connected = true;
          clearTimeout(state.timer);
          notifyCounts();
        }
        return;
      }
    };
    connection.onconnectionstatechange = handleConnectionState;
    connection.oniceconnectionstatechange = handleConnectionState;

    try {
      if (state.videoSender)
        await applyVideoSenderSettings(state.videoSender, currentSettings);
      if (state.audioSender)
        await applyAudioSenderSettings(state.audioSender, currentSettings);
      if (startInput !== input || stopPromise || peers.get(viewer) !== state)
        return;
      const offer = await connection.createOffer();
      if (startInput !== input || stopPromise || peers.get(viewer) !== state)
        return;
      await connection.setLocalDescription(offer);
      if (startInput !== input || stopPromise || peers.get(viewer) !== state)
        return;
      input.send({
        type: "offer",
        generation: input.generation,
        viewer,
        negotiationId,
        sdp: offer.sdp ?? "",
      });
    } catch {
      failPeer(viewer, state);
    }
  };

  const publisher: StudioPublisher & P2PSignaling = {
    kind: "p2p",
    async start(input) {
      if (startInput || stopPromise)
        throw new Error("Publisher already started");
      startInput = input;
      settings = { ...input.settings };
      failedViewers.clear();
      notifyCounts();
    },
    async handleSignal(signal) {
      const input = startInput;
      if (
        !input ||
        stopPromise ||
        !("generation" in signal) ||
        signal.generation !== input.generation
      )
        return;
      if (signal.type === "peer-ready") {
        const request = {};
        peerRequests.set(signal.viewer, request);
        await createPeer(signal.viewer, request);
        return;
      }
      if (signal.type === "peer-left") {
        peerRequests.delete(signal.viewer);
        const closed = closePeer(signal.viewer);
        const wasFailed = failedViewers.delete(signal.viewer);
        if (closed || wasFailed) notifyCounts();
        return;
      }
      if (signal.type !== "answer" && signal.type !== "ice-candidate") return;
      const state = peers.get(signal.viewer);
      if (!state) return;
      if (
        !("negotiationId" in signal) ||
        signal.negotiationId !== state.negotiationId
      )
        return;
      try {
        if (signal.type === "answer") {
          await state.connection.setRemoteDescription({
            type: "answer",
            sdp: signal.sdp,
          });
          if (
            startInput !== input ||
            stopPromise ||
            peers.get(signal.viewer) !== state
          )
            return;
          state.remoteDescriptionSet = true;
          state.drainingCandidates = true;
          while (state.pendingCandidates.length > 0) {
            const candidate = state.pendingCandidates.shift()!;
            await state.connection.addIceCandidate(candidate);
            if (
              startInput !== input ||
              stopPromise ||
              peers.get(signal.viewer) !== state
            )
              return;
          }
          state.drainingCandidates = false;
          return;
        }
        if (signal.type === "ice-candidate") {
          const candidate = signal.candidate;
          if (!state.remoteDescriptionSet || state.drainingCandidates) {
            state.pendingCandidates.push(candidate);
            return;
          }
          await state.connection.addIceCandidate(candidate);
        }
      } catch {
        failPeer(signal.viewer, state);
      }
    },
    updateSettings(previous, next) {
      const input = startInput;
      if (!input || stopPromise)
        return Promise.reject(new Error("Эфир завершён"));
      if (previous.codec !== next.codec)
        return Promise.reject(
          new Error("Codec cannot be changed during a live broadcast"),
        );
      const operation = (async () => {
        let note = "";
        const updateVideo = videoSettingsChanged(previous, next);
        const updateAudio = previous.audioBitrateKbps !== next.audioBitrateKbps;
        if (updateVideo) {
          const track = input.stream.getVideoTracks()[0];
          if (track) {
            note = await applyQuality(track, next);
            track.contentHint = qualityHints(next.balance).contentHint;
          }
        }
        for (const [viewer, state] of Array.from(peers)) {
          if (startInput !== input) throw new Error("Эфир завершён");
          if (peers.get(viewer) !== state) continue;
          if (updateVideo && state.videoSender)
            await applyVideoSenderSettings(state.videoSender, next);
          if (peers.get(viewer) !== state) continue;
          if (updateAudio && state.audioSender)
            await applyAudioSenderSettings(state.audioSender, next);
        }
        if (startInput === input) settings = { ...next };
        return { note, videoRepublished: false };
      })();
      qualityUpdate = operation;
      void operation
        .finally(() => {
          if (qualityUpdate === operation) qualityUpdate = undefined;
        })
        .catch(() => {});
      return operation;
    },
    getStatsSources() {
      if (!startInput) return {};
      return {
        video: startInput.stream.getVideoTracks()[0] ? videoStats : undefined,
        audio: startInput.stream.getAudioTracks()[0] ? audioStats : undefined,
      };
    },
    async setMuted(muted) {
      if (!startInput) throw new Error("Эфир завершён");
      const audio = startInput.stream.getAudioTracks()[0];
      if (audio) audio.enabled = !muted;
    },
    stop() {
      if (stopPromise) return stopPromise;
      if (!startInput) return Promise.resolve();
      const input = startInput;
      peerRequests.clear();
      const operation = (async () => {
        await qualityUpdate?.catch(() => {});
        if (startInput === input) {
          startInput = undefined;
          settings = undefined;
          for (const [viewer] of peers) closePeer(viewer);
          failedViewers.clear();
        }
      })();
      stopPromise = operation;
      void operation.finally(() => {
        if (stopPromise === operation) stopPromise = undefined;
      });
      return operation;
    },
  };

  return publisher;
}
