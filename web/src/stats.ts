export type CounterSample = {
  ssrc?: number;
  timestamp: number;
  bytes: number;
};

export type StreamMetrics = {
  bitrateKbps?: number;
  codec?: string;
  packets?: number;
  packetsLost?: number;
  lossPercent?: number;
  retransmittedPackets?: number;
  rttMs?: number;
  jitterMs?: number;
  bufferMs?: number;
  droppedFrames?: number;
  width?: number;
  height?: number;
  fps?: number;
  limitation?: string;
};

export type ParsedStats = {
  metrics: StreamMetrics;
  sample?: CounterSample;
};

const additiveMetricKeys = [
  "bitrateKbps",
  "packets",
  "packetsLost",
  "retransmittedPackets",
  "droppedFrames",
] as const satisfies readonly (keyof StreamMetrics)[];

const worstMetricKeys = [
  "lossPercent",
  "rttMs",
  "jitterMs",
  "bufferMs",
] as const satisfies readonly (keyof StreamMetrics)[];

const representativeMetricKeys = [
  "width",
  "height",
  "fps",
] as const satisfies readonly (keyof StreamMetrics)[];

const limitationRank = (reason: string) => {
  if (reason === "cpu") return 3;
  if (reason === "bandwidth") return 2;
  if (reason === "none") return 0;
  return 1;
};

export function aggregateOutboundMetrics(
  peerReports: readonly StreamMetrics[],
): StreamMetrics {
  const aggregate: StreamMetrics = {};

  for (const key of additiveMetricKeys) {
    const values = peerReports
      .map((report) => report[key])
      .filter(
        (value): value is number =>
          typeof value === "number" && Number.isFinite(value),
      );
    if (values.length > 0)
      (aggregate as Record<string, unknown>)[key] = values.reduce(
        (total, value) => total + value,
        0,
      );
  }

  for (const key of worstMetricKeys) {
    const values = peerReports
      .map((report) => report[key])
      .filter(
        (value): value is number =>
          typeof value === "number" && Number.isFinite(value),
      );
    if (values.length > 0)
      (aggregate as Record<string, unknown>)[key] = Math.max(...values);
  }

  for (const key of representativeMetricKeys) {
    const value = peerReports.find(
      (report) =>
        typeof report[key] === "number" && Number.isFinite(report[key]),
    )?.[key];
    if (value !== undefined)
      (aggregate as Record<string, unknown>)[key] = value;
  }

  aggregate.codec = peerReports.find((report) => report.codec)?.codec;
  if (aggregate.codec === undefined) delete aggregate.codec;

  let limitation: string | undefined;
  for (const report of peerReports) {
    if (
      report.limitation !== undefined &&
      (limitation === undefined ||
        limitationRank(report.limitation) > limitationRank(limitation))
    )
      limitation = report.limitation;
  }
  if (limitation !== undefined) aggregate.limitation = limitation;

  return aggregate;
}

type StatsRow = Record<string, unknown>;

const numberValue = (row: StatsRow, key: string): number | undefined => {
  const value = row[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
};

const stringValue = (row: StatsRow, key: string): string | undefined => {
  const value = row[key];
  return typeof value === "string" ? value : undefined;
};

const rowsOf = (rows: Iterable<RTCStats>): StatsRow[] =>
  Array.from(rows, (row) => row as unknown as StatsRow);

const codecName = (rows: StatsRow[], codecId: string | undefined) => {
  if (!codecId) return undefined;
  const codec = rows.find((row) => row.id === codecId && row.type === "codec");
  const mimeType = codec && stringValue(codec, "mimeType");
  return mimeType?.replace(/^(?:audio|video)\//, "");
};

const sampleFor = (
  row: StatsRow,
  byteKey: "bytesSent" | "bytesReceived",
): CounterSample | undefined => {
  const timestamp = numberValue(row, "timestamp");
  const bytes = numberValue(row, byteKey);
  if (timestamp === undefined || bytes === undefined) return undefined;

  const sample: CounterSample = { timestamp, bytes };
  const ssrc = numberValue(row, "ssrc");
  if (ssrc !== undefined) sample.ssrc = ssrc;
  return sample;
};

const bitrate = (
  sample: CounterSample | undefined,
  previous?: CounterSample,
) => {
  if (!sample || !previous) return undefined;
  if (sample.ssrc !== previous.ssrc || sample.timestamp <= previous.timestamp)
    return undefined;
  if (sample.bytes < previous.bytes) return undefined;
  return (
    ((sample.bytes - previous.bytes) * 8) /
    (sample.timestamp - previous.timestamp)
  );
};

const baseVideoMetrics = (row: StatsRow, rows: StatsRow[]): StreamMetrics => {
  const metrics: StreamMetrics = {
    codec: codecName(rows, stringValue(row, "codecId")),
    width: numberValue(row, "frameWidth"),
    height: numberValue(row, "frameHeight"),
    fps: numberValue(row, "framesPerSecond"),
  };
  return metrics;
};

const mediaRow = (rows: StatsRow[], type: "outbound-rtp" | "inbound-rtp") =>
  rows.find(
    (candidate) => candidate.type === type && candidate.kind === "video",
  ) ?? rows.find((candidate) => candidate.type === type);

export function parseOutboundStats(
  rows: Iterable<RTCStats>,
  previous?: CounterSample,
): ParsedStats {
  const allRows = rowsOf(rows);
  const row = mediaRow(allRows, "outbound-rtp");
  if (!row) return { metrics: {} };

  const metrics = baseVideoMetrics(row, allRows);
  const sample = sampleFor(row, "bytesSent");
  const rate = bitrate(sample, previous);
  if (rate !== undefined) metrics.bitrateKbps = rate;

  metrics.packets = numberValue(row, "packetsSent");
  metrics.retransmittedPackets = numberValue(row, "retransmittedPacketsSent");
  const limitation = stringValue(row, "qualityLimitationReason");
  if (limitation !== undefined && limitation !== "none")
    metrics.limitation = limitation;

  const remoteId = stringValue(row, "remoteId");
  const remoteById =
    remoteId === undefined
      ? undefined
      : allRows.find(
          (candidate) =>
            candidate.type === "remote-inbound-rtp" &&
            candidate.id === remoteId,
        );
  const remote =
    remoteById ??
    allRows.find(
      (candidate) =>
        candidate.type === "remote-inbound-rtp" && candidate.localId === row.id,
    );
  if (remote) {
    const packetsLost = numberValue(remote, "packetsLost");
    if (packetsLost !== undefined)
      metrics.packetsLost = Math.max(0, packetsLost);
    const fractionLost = numberValue(remote, "fractionLost");
    if (fractionLost !== undefined)
      metrics.lossPercent = Math.max(0, fractionLost * 100);
    const roundTripTime = numberValue(remote, "roundTripTime");
    if (roundTripTime !== undefined) metrics.rttMs = roundTripTime * 1000;
  }

  return { metrics, sample };
}

export function parseInboundStats(
  rows: Iterable<RTCStats>,
  previous?: CounterSample,
): ParsedStats {
  const allRows = rowsOf(rows);
  const row = mediaRow(allRows, "inbound-rtp");
  if (!row) return { metrics: {} };

  const metrics = baseVideoMetrics(row, allRows);
  const sample = sampleFor(row, "bytesReceived");
  const rate = bitrate(sample, previous);
  if (rate !== undefined) metrics.bitrateKbps = rate;

  metrics.packets = numberValue(row, "packetsReceived");
  const packetsLost = numberValue(row, "packetsLost");
  if (packetsLost !== undefined) metrics.packetsLost = Math.max(0, packetsLost);
  const framesDropped = numberValue(row, "framesDropped");
  if (framesDropped !== undefined) metrics.droppedFrames = framesDropped;
  const jitter = numberValue(row, "jitter");
  if (jitter !== undefined) metrics.jitterMs = jitter * 1000;

  const jitterBufferDelay = numberValue(row, "jitterBufferDelay");
  const emittedCount = numberValue(row, "jitterBufferEmittedCount");
  if (
    jitterBufferDelay !== undefined &&
    emittedCount !== undefined &&
    emittedCount > 0
  ) {
    metrics.bufferMs = (jitterBufferDelay / emittedCount) * 1000;
  }

  return { metrics, sample };
}

export function streamHealth(metrics: StreamMetrics): string {
  if (metrics.limitation === "cpu") return "Ограничено CPU";
  if (metrics.limitation === "bandwidth") return "Ограничено сетью";
  if (metrics.limitation && metrics.limitation !== "none")
    return `Ограничено: ${metrics.limitation === "other" ? "другое" : metrics.limitation}`;

  const hasLoss = metrics.lossPercent !== undefined;
  const hasRtt = metrics.rttMs !== undefined;
  if (!hasLoss && !hasRtt) return "Определяем";
  if (metrics.lossPercent !== undefined && metrics.lossPercent >= 3)
    return "Есть потери";
  if (
    (metrics.lossPercent !== undefined && metrics.lossPercent >= 1) ||
    (metrics.rttMs !== undefined && metrics.rttMs >= 250)
  )
    return "Стабильно";
  if (
    metrics.lossPercent !== undefined &&
    metrics.lossPercent < 1 &&
    metrics.rttMs !== undefined &&
    metrics.rttMs < 250
  )
    return "Отлично";
  return "Определяем";
}

const limitationLabels: Record<string, string> = {
  bandwidth: "Сеть",
  cpu: "CPU",
  other: "Другое",
};

export function formatLimitation(reason: string | undefined): string {
  if (!reason || reason === "none") return "—";
  return limitationLabels[reason] ?? reason;
}

export function formatMetric(value: number | undefined, suffix = ""): string {
  return value === undefined || !Number.isFinite(value)
    ? "—"
    : `${Math.round(value)}${suffix}`;
}
