import { describe, expect, it } from "vitest";
import { parseInboundStats, parseOutboundStats, streamHealth } from "./stats";

describe("outbound WebRTC stats", () => {
  it("считает bitrate, packets, loss, RTT и реальный codec", () => {
    const rows = [
      {
        id: "out",
        type: "outbound-rtp",
        kind: "video",
        ssrc: 7,
        timestamp: 2000,
        bytesSent: 6_000_000,
        packetsSent: 4200,
        retransmittedPacketsSent: 12,
        frameWidth: 3840,
        frameHeight: 2160,
        framesPerSecond: 60,
        codecId: "codec",
        remoteId: "remote",
        qualityLimitationReason: "bandwidth",
      },
      {
        id: "remote",
        type: "remote-inbound-rtp",
        localId: "out",
        packetsLost: 42,
        fractionLost: 0.01,
        roundTripTime: 0.12,
      },
      { id: "codec", type: "codec", mimeType: "video/AV1" },
    ] as unknown as RTCStats[];
    const result = parseOutboundStats(rows, {
      ssrc: 7,
      timestamp: 1000,
      bytes: 1_000_000,
    });
    expect(result.metrics).toMatchObject({
      bitrateKbps: 40_000,
      codec: "AV1",
      packets: 4200,
      packetsLost: 42,
      lossPercent: 1,
      retransmittedPackets: 12,
      rttMs: 120,
      width: 3840,
      height: 2160,
      fps: 60,
      limitation: "bandwidth",
    });
  });

  it("не создаёт отрицательную скорость после смены SSRC или сброса счётчика", () => {
    const rows = [
      {
        id: "out",
        type: "outbound-rtp",
        kind: "video",
        ssrc: 8,
        timestamp: 2000,
        bytesSent: 10,
        packetsSent: 1,
      },
    ] as unknown as RTCStats[];
    expect(
      parseOutboundStats(rows, { ssrc: 7, timestamp: 1000, bytes: 1000 })
        .metrics.bitrateKbps,
    ).toBeUndefined();
  });
});

describe("inbound WebRTC stats", () => {
  it("считает фактический jitter buffer и dropped frames", () => {
    const rows = [
      {
        id: "in",
        type: "inbound-rtp",
        kind: "video",
        ssrc: 9,
        timestamp: 3000,
        bytesReceived: 2_000_000,
        packetsReceived: 3000,
        packetsLost: -2,
        framesDropped: 7,
        frameWidth: 1920,
        frameHeight: 1080,
        framesPerSecond: 60,
        jitter: 0.018,
        jitterBufferDelay: 25,
        jitterBufferEmittedCount: 1000,
        codecId: "codec",
      },
      { id: "codec", type: "codec", mimeType: "video/VP9" },
    ] as unknown as RTCStats[];
    const result = parseInboundStats(rows, {
      ssrc: 9,
      timestamp: 2000,
      bytes: 1_000_000,
    });
    expect(result.metrics).toMatchObject({
      bitrateKbps: 8000,
      codec: "VP9",
      packets: 3000,
      packetsLost: 0,
      droppedFrames: 7,
      jitterMs: 18,
      bufferMs: 25,
    });
  });
});

describe("stream health", () => {
  it("приоритизирует encoder limits и использует literal thresholds", () => {
    expect(streamHealth({ limitation: "cpu", lossPercent: 0, rttMs: 20 })).toBe(
      "Ограничено CPU",
    );
    expect(
      streamHealth({ limitation: "bandwidth", lossPercent: 0, rttMs: 20 }),
    ).toBe("Ограничено сетью");
    expect(streamHealth({ lossPercent: 3, rttMs: 20 })).toBe("Есть потери");
    expect(streamHealth({ lossPercent: 1, rttMs: 20 })).toBe("Стабильно");
    expect(streamHealth({ lossPercent: 0.2, rttMs: 250 })).toBe("Стабильно");
    expect(streamHealth({ lossPercent: 0.2, rttMs: 40 })).toBe("Отлично");
    expect(streamHealth({})).toBe("Определяем");
  });
});
