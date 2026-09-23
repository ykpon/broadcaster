import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_STREAM_SETTINGS } from "./quality";
import { createP2PPublisher } from "./p2pPublisher";

class FakePeer {
  static instances: FakePeer[] = [];
  static codecCapabilities = [
    { mimeType: "video/VP8" },
    { mimeType: "video/AV1" },
  ];
  configuration: RTCConfiguration;
  connectionState = "new";
  iceConnectionState = "new";
  localDescription: RTCSessionDescriptionInit | null = null;
  onicecandidate:
    ((event: { candidate: RTCIceCandidate | null }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  transceivers: Array<{
    kind: string;
    options: RTCRtpTransceiverInit;
    sender: ReturnType<typeof sender>;
    setCodecPreferences: ReturnType<typeof vi.fn>;
  }> = [];
  createOffer = vi.fn(async () => ({
    type: "offer" as const,
    sdp: "offer-sdp",
  }));
  setLocalDescription = vi.fn(
    async (description: RTCSessionDescriptionInit) => {
      this.localDescription = description;
    },
  );
  setRemoteDescription = vi.fn(
    async (_description: RTCSessionDescriptionInit) => {},
  );
  addIceCandidate = vi.fn(async (_candidate: RTCIceCandidateInit) => {});
  close = vi.fn();
  getStats = vi.fn(async () => new Map() as RTCStatsReport);
  constructor(configuration: RTCConfiguration) {
    this.configuration = configuration;
    FakePeer.instances.push(this);
  }
  addTransceiver(track: MediaStreamTrack, options: RTCRtpTransceiverInit) {
    const result = {
      kind: track.kind,
      options,
      sender: sender(),
      setCodecPreferences: vi.fn(),
    };
    this.transceivers.push(result);
    return result;
  }
  connected() {
    this.connectionState = "connected";
    this.onconnectionstatechange?.();
  }
  failed() {
    this.connectionState = "failed";
    this.onconnectionstatechange?.();
  }
}

function sender() {
  return {
    getParameters: vi.fn(() => ({ encodings: [{}] }) as RTCRtpSendParameters),
    setParameters: vi.fn(async (_parameters: RTCRtpSendParameters) => {}),
  };
}

function fixture() {
  const video = {
    kind: "video",
    contentHint: "",
    applyConstraints: vi.fn(async () => {}),
    stop: vi.fn(),
  } as unknown as MediaStreamTrack;
  const audio = {
    kind: "audio",
    contentHint: "",
    stop: vi.fn(),
  } as unknown as MediaStreamTrack;
  const stream = {
    getVideoTracks: () => [video],
    getAudioTracks: () => [audio],
    getTracks: () => [video, audio],
  } as unknown as MediaStream;
  const send = vi.fn();
  const counts = vi.fn();
  const publisher = createP2PPublisher(
    { onPeerCountsChanged: counts },
    {
      RTCPeerConnection: FakePeer as unknown as typeof RTCPeerConnection,
      getSenderCapabilities: () =>
        ({
          codecs: FakePeer.codecCapabilities,
        }) as unknown as RTCRtpCapabilities,
    },
  );
  const start = () =>
    publisher.start({
      generation: 7,
      stream,
      settings: { ...DEFAULT_STREAM_SETTINGS, codec: "av1" },
      iceServers: [{ urls: ["stun:example.test:3478"] }],
      send,
    });
  return { publisher, start, send, counts, video, audio };
}

beforeEach(() => {
  FakePeer.instances = [];
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("P2P publisher lifecycle", () => {
  it("offers with send-only tracks, preferred codec, and local description before signaling", async () => {
    const { publisher, start, send, video, audio } = fixture();
    await start();
    await publisher.handleSignal({
      type: "peer-ready",
      generation: 7,
      viewer: "viewer-a",
    });
    const peer = FakePeer.instances[0];
    expect(FakePeer.instances).toHaveLength(1);
    expect(peer.configuration).toEqual({
      iceServers: [{ urls: ["stun:example.test:3478"] }],
    });
    expect(
      peer.transceivers.map(({ kind, options }) => [kind, options.direction]),
    ).toEqual([
      ["video", "sendonly"],
      ["audio", "sendonly"],
    ]);
    expect(peer.transceivers[0].setCodecPreferences).toHaveBeenCalledWith([
      FakePeer.codecCapabilities[1],
      FakePeer.codecCapabilities[0],
    ]);
    expect(peer.transceivers[0].options.streams).toEqual([
      expect.objectContaining({ getVideoTracks: expect.any(Function) }),
    ]);
    expect(peer.transceivers[0].options.streams?.[0].getVideoTracks()).toEqual([
      video,
    ]);
    expect(peer.transceivers[1].options.streams?.[0].getAudioTracks()).toEqual([
      audio,
    ]);
    expect(peer.setLocalDescription).toHaveBeenCalledWith({
      type: "offer",
      sdp: "offer-sdp",
    });
    expect(send).toHaveBeenCalledWith({
      type: "offer",
      generation: 7,
      viewer: "viewer-a",
      sdp: "offer-sdp",
    });
    expect(peer.localDescription).toEqual({ type: "offer", sdp: "offer-sdp" });
    await publisher.stop();
  });

  it("replaces a repeated ready, rejects stale signals, and routes local ICE by viewer", async () => {
    const { publisher, start, send } = fixture();
    await start();
    await publisher.handleSignal({
      type: "peer-ready",
      generation: 7,
      viewer: "viewer-a",
    });
    const oldPeer = FakePeer.instances[0];
    await publisher.handleSignal({
      type: "peer-ready",
      generation: 7,
      viewer: "viewer-a",
    });
    const current = FakePeer.instances[1];
    expect(oldPeer.close).toHaveBeenCalledTimes(1);
    await publisher.handleSignal({
      type: "answer",
      generation: 6,
      viewer: "viewer-a",
      sdp: "stale",
    });
    await publisher.handleSignal({
      type: "answer",
      generation: 7,
      viewer: "unknown",
      sdp: "stranger",
    });
    expect(current.setRemoteDescription).not.toHaveBeenCalled();
    await publisher.handleSignal({
      type: "answer",
      generation: 7,
      viewer: "viewer-a",
      sdp: "answer-sdp",
    });
    await publisher.handleSignal({
      type: "ice-candidate",
      generation: 7,
      viewer: "viewer-a",
      candidate: { candidate: "remote" },
    });
    expect(current.setRemoteDescription).toHaveBeenCalledWith({
      type: "answer",
      sdp: "answer-sdp",
    });
    expect(current.addIceCandidate).toHaveBeenCalledWith({
      candidate: "remote",
    });
    oldPeer.onicecandidate?.({
      candidate: { candidate: "old" } as RTCIceCandidate,
    });
    current.onicecandidate?.({
      candidate: {
        candidate: "local",
        toJSON: () => ({ candidate: "local" }),
      } as RTCIceCandidate,
    });
    expect(send).not.toHaveBeenCalledWith(
      expect.objectContaining({ candidate: { candidate: "old" } }),
    );
    expect(send).toHaveBeenCalledWith({
      type: "ice-candidate",
      generation: 7,
      viewer: "viewer-a",
      candidate: { candidate: "local" },
    });
    await publisher.stop();
  });

  it("isolates failure, retries, removes departed peers, and stops remaining peers", async () => {
    const { publisher, start, send, counts, video, audio } = fixture();
    await start();
    await publisher.handleSignal({
      type: "peer-ready",
      generation: 7,
      viewer: "a",
    });
    await publisher.handleSignal({
      type: "peer-ready",
      generation: 7,
      viewer: "b",
    });
    FakePeer.instances[1].connected();
    FakePeer.instances[0].failed();
    expect(FakePeer.instances[0].close).toHaveBeenCalledOnce();
    expect(FakePeer.instances[1].close).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith({
      type: "peer-failed",
      generation: 7,
      viewer: "a",
    });
    expect(counts).toHaveBeenCalledWith(7, 1, 1);
    await publisher.handleSignal({
      type: "peer-left",
      generation: 7,
      viewer: "a",
    });
    expect(counts).toHaveBeenLastCalledWith(7, 1, 0);
    await publisher.handleSignal({
      type: "peer-ready",
      generation: 7,
      viewer: "a",
    });
    expect(FakePeer.instances).toHaveLength(3);
    await publisher.handleSignal({
      type: "peer-left",
      generation: 7,
      viewer: "b",
    });
    expect(FakePeer.instances[1].close).toHaveBeenCalledOnce();
    await publisher.stop();
    expect(FakePeer.instances[2].close).toHaveBeenCalledOnce();
    expect(video.stop as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(audio.stop as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("fails an unconnected peer after twenty seconds and clears the timer on connection", async () => {
    const { publisher, start, send } = fixture();
    await start();
    await publisher.handleSignal({
      type: "peer-ready",
      generation: 7,
      viewer: "a",
    });
    await publisher.handleSignal({
      type: "peer-ready",
      generation: 7,
      viewer: "b",
    });
    FakePeer.instances[1].connected();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(FakePeer.instances[0].close).toHaveBeenCalledOnce();
    expect(FakePeer.instances[1].close).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith({
      type: "peer-failed",
      generation: 7,
      viewer: "a",
    });
    await publisher.stop();
  });

  it("suppresses late peer signaling once stopping begins", async () => {
    const { publisher, start, send } = fixture();
    await start();
    const ready = publisher.handleSignal({
      type: "peer-ready",
      generation: 7,
      viewer: "a",
    });
    await Promise.resolve();
    const peer = FakePeer.instances[0];
    send.mockClear();

    const stopping = publisher.stop();
    peer.onicecandidate?.({
      candidate: {
        candidate: "late-candidate",
        toJSON: () => ({ candidate: "late-candidate" }),
      } as RTCIceCandidate,
    });
    peer.failed();

    expect(send).not.toHaveBeenCalled();
    await Promise.all([ready, stopping]);
    expect(send).not.toHaveBeenCalled();
  });

  it("isolates a rejected remote signal to its current viewer", async () => {
    const { publisher, start, send } = fixture();
    await start();
    await publisher.handleSignal({
      type: "peer-ready",
      generation: 7,
      viewer: "a",
    });
    await publisher.handleSignal({
      type: "peer-ready",
      generation: 7,
      viewer: "b",
    });
    const failed = FakePeer.instances[0];
    const healthy = FakePeer.instances[1];
    failed.addIceCandidate.mockRejectedValueOnce(new Error("invalid ICE"));

    await expect(
      publisher.handleSignal({
        type: "ice-candidate",
        generation: 7,
        viewer: "a",
        candidate: { candidate: "invalid" },
      }),
    ).resolves.toBeUndefined();
    expect(failed.close).toHaveBeenCalledOnce();
    expect(healthy.close).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith({
      type: "peer-failed",
      generation: 7,
      viewer: "a",
    });
    await publisher.stop();
  });
});

describe("P2P sender quality", () => {
  it("updates the shared capture once and every sender sequentially", async () => {
    const { publisher, start, video } = fixture();
    await start();
    await publisher.handleSignal({
      type: "peer-ready",
      generation: 7,
      viewer: "a",
    });
    await publisher.handleSignal({
      type: "peer-ready",
      generation: 7,
      viewer: "b",
    });
    const next = {
      ...DEFAULT_STREAM_SETTINGS,
      codec: "av1" as const,
      resolution: "2160" as const,
      fps: 90,
      videoBitrateMbps: 42,
      audioBitrateKbps: 256,
      balance: 80,
    };
    for (const peer of FakePeer.instances) {
      peer.transceivers[0].sender.setParameters.mockClear();
      peer.transceivers[1].sender.setParameters.mockClear();
    }

    await publisher.updateSettings(
      { ...DEFAULT_STREAM_SETTINGS, codec: "av1" },
      next,
    );

    expect(video.applyConstraints).toHaveBeenCalledTimes(1);
    expect(video.applyConstraints).toHaveBeenCalledWith({
      width: { ideal: 3840, max: 3840 },
      height: { ideal: 2160, max: 2160 },
      frameRate: { ideal: 90, max: 90 },
    });
    expect(video.contentHint).toBe("motion");
    for (const peer of FakePeer.instances) {
      expect(peer.transceivers[0].sender.setParameters).toHaveBeenCalledWith(
        expect.objectContaining({
          encodings: [
            expect.objectContaining({
              maxBitrate: 42_000_000,
              maxFramerate: 90,
            }),
          ],
          degradationPreference: "maintain-framerate",
        }),
      );
      expect(peer.transceivers[1].sender.setParameters).toHaveBeenCalledWith(
        expect.objectContaining({
          encodings: [expect.objectContaining({ maxBitrate: 256_000 })],
        }),
      );
      expect(
        peer.transceivers[0].sender.setParameters.mock.invocationCallOrder[0],
      ).toBeLessThan(
        peer.transceivers[1].sender.setParameters.mock.invocationCallOrder[0],
      );
    }

    await publisher.handleSignal({
      type: "peer-ready",
      generation: 7,
      viewer: "c",
    });
    const later = FakePeer.instances[2];
    expect(later.transceivers[0].sender.setParameters).toHaveBeenCalledWith(
      expect.objectContaining({
        encodings: [
          expect.objectContaining({
            maxBitrate: 42_000_000,
            maxFramerate: 90,
          }),
        ],
        degradationPreference: "maintain-framerate",
      }),
    );
    expect(later.transceivers[1].sender.setParameters).toHaveBeenCalledWith(
      expect.objectContaining({
        encodings: [expect.objectContaining({ maxBitrate: 256_000 })],
      }),
    );
    await publisher.stop();
  });

  it("rejects live codec changes and supports restoring confirmed settings", async () => {
    const { publisher, start } = fixture();
    await start();
    await publisher.handleSignal({
      type: "peer-ready",
      generation: 7,
      viewer: "a",
    });
    const peer = FakePeer.instances[0];
    const failure = new DOMException(
      "sender rejected",
      "InvalidModificationError",
    );
    peer.transceivers[1].sender.setParameters
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(undefined);
    const confirmed = { ...DEFAULT_STREAM_SETTINGS, codec: "av1" as const };
    const failed = {
      ...confirmed,
      videoBitrateMbps: 42,
      audioBitrateKbps: 256,
    };

    await expect(publisher.updateSettings(confirmed, failed)).rejects.toBe(
      failure,
    );
    await expect(publisher.updateSettings(failed, confirmed)).resolves.toEqual({
      note: "",
      videoRepublished: false,
    });
    expect(peer.transceivers[0].sender.setParameters).toHaveBeenLastCalledWith({
      encodings: [{ maxBitrate: 12_000_000, maxFramerate: 60 }],
      degradationPreference: "maintain-resolution",
    });
    expect(peer.transceivers[1].sender.setParameters).toHaveBeenLastCalledWith({
      encodings: [{ maxBitrate: 128_000 }],
    });
    await expect(
      publisher.updateSettings(confirmed, { ...confirmed, codec: "vp9" }),
    ).rejects.toThrow("Codec cannot be changed during a live broadcast");
    await publisher.stop();
  });

  it("does not restart while stop is draining an in-flight quality update", async () => {
    const { publisher, start } = fixture();
    await start();
    await publisher.handleSignal({
      type: "peer-ready",
      generation: 7,
      viewer: "a",
    });
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    FakePeer.instances[0].transceivers[0].sender.setParameters.mockImplementationOnce(
      () => pending,
    );
    const previous = { ...DEFAULT_STREAM_SETTINGS, codec: "av1" as const };
    const updating = publisher.updateSettings(previous, {
      ...previous,
      videoBitrateMbps: 42,
    });
    await Promise.resolve();
    const stopping = publisher.stop();

    await expect(start()).rejects.toThrow("Publisher already started");
    release?.();
    await Promise.all([updating, stopping]);
    await expect(start()).resolves.toBeUndefined();
    await publisher.stop();
  });
});

describe("P2P publisher stats", () => {
  it("aggregates current peers using an independent counter sample per peer", async () => {
    const { publisher, start } = fixture();
    await start();
    await publisher.handleSignal({
      type: "peer-ready",
      generation: 7,
      viewer: "a",
    });
    await publisher.handleSignal({
      type: "peer-ready",
      generation: 7,
      viewer: "b",
    });
    const report = (
      id: string,
      timestamp: number,
      bytesSent: number,
      packetsSent: number,
      loss: number,
      rtt: number,
    ) =>
      new Map([
        [
          id,
          {
            id,
            type: "outbound-rtp",
            kind: "video",
            ssrc: Number(id.slice(1)),
            timestamp,
            bytesSent,
            packetsSent,
            remoteId: `${id}-remote`,
          },
        ],
        [
          `${id}-remote`,
          {
            id: `${id}-remote`,
            type: "remote-inbound-rtp",
            localId: id,
            fractionLost: loss,
            roundTripTime: rtt,
          },
        ],
      ]) as unknown as RTCStatsReport;
    FakePeer.instances[0].getStats
      .mockResolvedValueOnce(report("p1", 1000, 1000, 10, 0.01, 0.04))
      .mockResolvedValueOnce(report("p1", 2000, 151_000, 20, 0.02, 0.08));
    FakePeer.instances[1].getStats
      .mockResolvedValueOnce(report("p2", 1000, 2000, 20, 0.03, 0.06))
      .mockResolvedValueOnce(report("p2", 2000, 102_000, 30, 0.04, 0.13));
    const source = publisher.getStatsSources().video;

    expect(await source?.getMetrics?.()).toMatchObject({
      packets: 30,
      lossPercent: 3,
      rttMs: 60,
    });
    expect(await source?.getMetrics?.()).toMatchObject({
      bitrateKbps: 2000,
      packets: 50,
      lossPercent: 4,
      rttMs: 130,
    });
    await publisher.stop();
  });
});
