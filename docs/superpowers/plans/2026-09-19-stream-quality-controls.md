# Ручное качество и диагностика трансляции — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Дать ведущему ручное управление кодеком, разрешением, FPS и битрейтами, а ведущему и зрителю — WebRTC-статистику и независимый viewer buffer до 4 секунд.

**Architecture:** Браузерные настройки и RTC stats остаются на клиенте: чистые модули нормализуют параметры, статистику и playout delay, а `Studio`/`Viewer` отвечают только за жизненный цикл треков и отображение. Go API и LiveKit server config не меняются; активный медиапоток обновляется через capture constraints и sender parameters без переподключения.

**Tech Stack:** React 19, TypeScript 5.8, LiveKit Client 2.x, Vitest 3, Playwright 1.63, CSS.

**Spec:** `docs/superpowers/specs/2026-09-19-stream-quality-controls-design.md`

## Global Constraints

- Основной сценарий — актуальные Chrome и Edge на компьютере; зритель может использовать другой современный браузер.
- Simulcast остаётся выключенным.
- Кодеки: VP8, VP9, AV1; кодек меняется только до запуска эфира.
- Resolution steps: `Исходное`, 720p, 1080p, 1440p, 2160p.
- FPS: 15–120, шаг 5; video bitrate: 1–80 Мбит/с, шаг 1; audio bitrate: 32–320 кбит/с, шаг 16; balance: 0–100.
- Defaults: 1080p, 60 FPS, 12 Мбит/с video, 128 кбит/с audio, balance 35, VP8.
- Viewer buffer: `Авто` либо 0,1–4,0 секунды с шагом 0,1; одно значение для audio/video.
- WebRTC не объявляется lossless: заданные пределы и фактические показатели всегда различаются в интерфейсе.
- Go API, модель комнат, права участников и LiveKit server config не меняются.

---

### Task 1: Типизированные настройки и безопасное локальное сохранение

**Files:**
- Modify: `web/src/quality.ts`
- Modify: `web/src/quality.test.ts`

**Interfaces:**
- Produces: `StreamSettings`, `VideoCodec`, `DEFAULT_STREAM_SETTINGS`, `RESOLUTION_STEPS`, `SETTING_RANGES`, `normalizeStreamSettings(value)`, `loadStreamSettings(storage)`, `saveStreamSettings(storage, settings)`, `qualityHints(balance)` and `constraints(settings)`.
- Consumes: browser `Storage`, `MediaTrackConstraints`, `RTCDegradationPreference`.

- [ ] **Step 1: Replace the old bitrate-only expectations with failing settings-model tests**

Add literal, behavior-focused tests to `web/src/quality.test.ts`:

```ts
import {
  DEFAULT_STREAM_SETTINGS,
  RESOLUTION_STEPS,
  constraints,
  loadStreamSettings,
  normalizeStreamSettings,
  qualityHints,
  saveStreamSettings,
  type StreamSettings,
} from "./quality";

function memoryStorage(initial?: string): Storage {
  let value = initial ?? null;
  return {
    getItem: () => value,
    setItem: (_key, next) => { value = next; },
    removeItem: () => { value = null; },
    clear: () => { value = null; },
    key: () => null,
    get length() { return value === null ? 0 : 1; },
  };
}

it("восстанавливает безопасные defaults из повреждённого хранилища", () => {
  expect(loadStreamSettings(memoryStorage("not json"))).toEqual(
    DEFAULT_STREAM_SETTINGS,
  );
  expect(normalizeStreamSettings({
    resolution: "9000",
    fps: 999,
    videoBitrateMbps: -4,
    audioBitrateKbps: 7,
    balance: 1000,
    codec: "h265",
  })).toEqual(DEFAULT_STREAM_SETTINGS);
});

it("сохраняет и читает полный набор настроек", () => {
  const storage = memoryStorage();
  const settings: StreamSettings = {
    resolution: "2160",
    fps: 120,
    videoBitrateMbps: 80,
    audioBitrateKbps: 320,
    balance: 75,
    codec: "av1",
  };
  saveStreamSettings(storage, settings);
  expect(loadStreamSettings(storage)).toEqual(settings);
});

it("переводит баланс в независимые подсказки чёткости и плавности", () => {
  expect(qualityHints(20)).toEqual({
    contentHint: "detail",
    degradationPreference: "maintain-resolution",
  });
  expect(qualityHints(50)).toEqual({
    contentHint: "motion",
    degradationPreference: "balanced",
  });
  expect(qualityHints(80)).toEqual({
    contentHint: "motion",
    degradationPreference: "maintain-framerate",
  });
});

it("строит capture constraints из ручных resolution и FPS", () => {
  expect(constraints({ ...DEFAULT_STREAM_SETTINGS, resolution: "2160", fps: 120 })).toEqual({
    width: { ideal: 3840, max: 3840 },
    height: { ideal: 2160, max: 2160 },
    frameRate: { ideal: 120, max: 120 },
  });
  expect(RESOLUTION_STEPS.map((item) => item.value)).toEqual([
    "auto", "720", "1080", "1440", "2160",
  ]);
});
```

Keep the existing capture-error and audio-hint tests. Delete assertions tied to the removed computed `bitrate(res, fps)` policy.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `cd web && pnpm vitest run src/quality.test.ts`

Expected: FAIL because `StreamSettings`, normalization, storage, and `qualityHints` do not exist and `constraints` still takes two positional arguments.

- [ ] **Step 3: Implement the settings model and storage boundary**

In `web/src/quality.ts`, retain `captureError`, `audioHint`, and any formatting helper still used elsewhere, then add:

```ts
export type Resolution = "auto" | "720" | "1080" | "1440" | "2160";
export type VideoCodec = "vp8" | "vp9" | "av1";
export type StreamSettings = {
  resolution: Resolution;
  fps: number;
  videoBitrateMbps: number;
  audioBitrateKbps: number;
  balance: number;
  codec: VideoCodec;
};

export const STREAM_SETTINGS_KEY = "broadcast:stream-settings:v1";
export const DEFAULT_STREAM_SETTINGS: StreamSettings = {
  resolution: "1080",
  fps: 60,
  videoBitrateMbps: 12,
  audioBitrateKbps: 128,
  balance: 35,
  codec: "vp8",
};
export const RESOLUTION_STEPS = [
  { value: "auto", label: "Исходное", width: 3840, height: 2160 },
  { value: "720", label: "720p", width: 1280, height: 720 },
  { value: "1080", label: "1080p", width: 1920, height: 1080 },
  { value: "1440", label: "1440p", width: 2560, height: 1440 },
  { value: "2160", label: "2160p · 4K", width: 3840, height: 2160 },
] as const;
export const SETTING_RANGES = {
  fps: { min: 15, max: 120, step: 5 },
  videoBitrateMbps: { min: 1, max: 80, step: 1 },
  audioBitrateKbps: { min: 32, max: 320, step: 16 },
  balance: { min: 0, max: 100, step: 1 },
} as const;

export function qualityHints(balance: number): {
  contentHint: "detail" | "motion";
  degradationPreference: RTCDegradationPreference;
} {
  if (balance < 40)
    return { contentHint: "detail", degradationPreference: "maintain-resolution" };
  if (balance <= 60)
    return { contentHint: "motion", degradationPreference: "balanced" };
  return { contentHint: "motion", degradationPreference: "maintain-framerate" };
}
```

Implement `normalizeStreamSettings` with explicit membership/range/step checks; reject the complete stored object to defaults if any field is invalid. `loadStreamSettings` and `saveStreamSettings` must catch both JSON and Storage exceptions. Change `constraints` to accept a `StreamSettings` object and resolve the selected item from `RESOLUTION_STEPS`.

- [ ] **Step 4: Run quality tests and verify GREEN**

Run: `cd web && pnpm vitest run src/quality.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the settings model**

```sh
git add web/src/quality.ts web/src/quality.test.ts
git commit -m "feat: add manual stream quality settings"
```

---

### Task 2: Публикация и live-update видео и аудио

**Files:**
- Modify: `web/src/media.ts`
- Modify: `web/src/media.test.ts`

**Interfaces:**
- Consumes: `StreamSettings`, `qualityHints`, `constraints` from Task 1; LiveKit `Room`, `LocalVideoTrack`, `LocalAudioTrack`.
- Produces: `PublishedTracks { video: LocalVideoTrack; audio?: LocalAudioTrack }`, `publishScreen(room, stream, settings)`, `updateQuality(tracks, settings)`.

- [ ] **Step 1: Write failing publication and update tests**

Extend `web/src/media.test.ts` with two tests whose expected values are literal:

```ts
import { type LocalAudioTrack, type LocalVideoTrack, Track, type Room } from "livekit-client";
import { DEFAULT_STREAM_SETTINGS } from "./quality";
import { publishScreen, updateQuality, type PublishedTracks } from "./media";

it("публикует AV1 4K120 с ручными video/audio bitrate", async () => {
  const video = { kind: "video", applyConstraints: vi.fn().mockResolvedValue(undefined) } as unknown as MediaStreamTrack;
  const audio = { kind: "audio" } as MediaStreamTrack;
  const publishedVideo = { mediaStreamTrack: video } as LocalVideoTrack;
  const publishedAudio = { mediaStreamTrack: audio } as LocalAudioTrack;
  const publishTrack = vi.fn()
    .mockResolvedValueOnce({ track: publishedVideo })
    .mockResolvedValueOnce({ track: publishedAudio });
  const room = { localParticipant: { publishTrack, unpublishTrack: vi.fn() } } as unknown as Room;
  const stream = {
    getVideoTracks: () => [video],
    getAudioTracks: () => [audio],
  } as unknown as MediaStream;
  const settings = {
    ...DEFAULT_STREAM_SETTINGS,
    resolution: "2160" as const,
    fps: 120,
    videoBitrateMbps: 80,
    audioBitrateKbps: 320,
    codec: "av1" as const,
  };

  expect(await publishScreen(room, stream, settings)).toEqual({
    video: publishedVideo,
    audio: publishedAudio,
  });
  expect(publishTrack).toHaveBeenNthCalledWith(1, video, expect.objectContaining({
    source: Track.Source.ScreenShare,
    simulcast: false,
    videoCodec: "av1",
    screenShareEncoding: { maxBitrate: 80_000_000, maxFramerate: 120 },
    degradationPreference: "maintain-resolution",
  }));
  expect(publishTrack).toHaveBeenNthCalledWith(2, audio, expect.objectContaining({
    source: Track.Source.ScreenShareAudio,
    audioPreset: { maxBitrate: 320_000 },
    forceStereo: true,
    dtx: false,
  }));
});

it("обновляет параметры обоих sender без перепубликации", async () => {
  const videoSet = vi.fn().mockResolvedValue(undefined);
  const audioSet = vi.fn().mockResolvedValue(undefined);
  const source = { applyConstraints: vi.fn().mockResolvedValue(undefined), contentHint: "" } as unknown as MediaStreamTrack;
  const tracks = {
    video: {
      mediaStreamTrack: source,
      sender: { getParameters: () => ({ encodings: [{}] }), setParameters: videoSet },
      setDegradationPreference: vi.fn().mockResolvedValue(undefined),
    } as unknown as LocalVideoTrack,
    audio: {
      sender: { getParameters: () => ({ encodings: [{}] }), setParameters: audioSet },
    } as unknown as LocalAudioTrack,
  } satisfies PublishedTracks;

  await updateQuality(tracks, {
    ...DEFAULT_STREAM_SETTINGS,
    fps: 90,
    videoBitrateMbps: 42,
    audioBitrateKbps: 256,
    balance: 80,
  });

  expect(videoSet).toHaveBeenCalledWith(expect.objectContaining({
    encodings: [expect.objectContaining({ maxBitrate: 42_000_000, maxFramerate: 90 })],
  }));
  expect(audioSet).toHaveBeenCalledWith(expect.objectContaining({
    encodings: [expect.objectContaining({ maxBitrate: 256_000 })],
  }));
  expect(source.contentHint).toBe("motion");
  expect(tracks.video.setDegradationPreference).toHaveBeenCalledWith("maintain-framerate");
});
```

Retain the existing OverconstrainedError fallback tests, updating their calls to pass `StreamSettings`.

- [ ] **Step 2: Run media tests and verify RED**

Run: `cd web && pnpm vitest run src/media.test.ts`

Expected: FAIL because `PublishedTracks` is missing and the functions still accept resolution/FPS positional arguments and fixed bitrate/codec values.

- [ ] **Step 3: Implement settings-driven publication and update**

Refactor `web/src/media.ts` around this public contract:

```ts
export type PublishedTracks = {
  video: LocalVideoTrack;
  audio?: LocalAudioTrack;
};

export async function applyQuality(
  track: MediaStreamTrack,
  settings: StreamSettings,
): Promise<string>;

export async function publishScreen(
  room: Room,
  stream: MediaStream,
  settings: StreamSettings,
): Promise<PublishedTracks>;

export async function updateQuality(
  tracks: PublishedTracks,
  settings: StreamSettings,
): Promise<string>;
```

Use `qualityHints(settings.balance)`, set `video.contentHint` before publication, pass `backupCodec: true`, preserve `simulcast: false`, and multiply user-facing Mbps/kbps by `1_000_000`/`1_000`. For live updates, call `applyQuality`, update every video encoding, update every audio encoding when present, and await `video.setDegradationPreference(...)`. Preserve the current cleanup that unpublishes video when audio publication fails.

- [ ] **Step 4: Run media and quality tests and verify GREEN**

Run: `cd web && pnpm vitest run src/media.test.ts src/quality.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit media control**

```sh
git add web/src/media.ts web/src/media.test.ts
git commit -m "feat: apply manual audio and video encoding settings"
```

---

### Task 3: Нормализованная WebRTC-статистика и оценка состояния

**Files:**
- Create: `web/src/stats.ts`
- Create: `web/src/stats.test.ts`

**Interfaces:**
- Produces: `CounterSample`, `StreamMetrics`, `parseOutboundStats(rows, previous)`, `parseInboundStats(rows, previous)`, `streamHealth(metrics)`, `formatMetric`.
- Consumes: iterable `RTCStats[]` obtained from `RTCStatsReport.values()`; no React or LiveKit dependency.

- [ ] **Step 1: Write failing tests for outgoing deltas, incoming buffer, and health thresholds**

Create `web/src/stats.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseInboundStats, parseOutboundStats, streamHealth } from "./stats";

describe("outbound WebRTC stats", () => {
  it("считает bitrate, packets, loss, RTT и реальный codec", () => {
    const rows = [
      { id: "out", type: "outbound-rtp", kind: "video", ssrc: 7, timestamp: 2000,
        bytesSent: 6_000_000, packetsSent: 4200, retransmittedPacketsSent: 12,
        frameWidth: 3840, frameHeight: 2160, framesPerSecond: 60,
        codecId: "codec", remoteId: "remote", qualityLimitationReason: "bandwidth" },
      { id: "remote", type: "remote-inbound-rtp", localId: "out",
        packetsLost: 42, fractionLost: 0.01, roundTripTime: 0.12 },
      { id: "codec", type: "codec", mimeType: "video/AV1" },
    ] as unknown as RTCStats[];
    const result = parseOutboundStats(rows, { ssrc: 7, timestamp: 1000, bytes: 1_000_000 });
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
    const rows = [{ id: "out", type: "outbound-rtp", kind: "video", ssrc: 8,
      timestamp: 2000, bytesSent: 10, packetsSent: 1 }] as unknown as RTCStats[];
    expect(parseOutboundStats(rows, { ssrc: 7, timestamp: 1000, bytes: 1000 }).metrics.bitrateKbps)
      .toBeUndefined();
  });
});

describe("inbound WebRTC stats", () => {
  it("считает фактический jitter buffer и dropped frames", () => {
    const rows = [
      { id: "in", type: "inbound-rtp", kind: "video", ssrc: 9, timestamp: 3000,
        bytesReceived: 2_000_000, packetsReceived: 3000, packetsLost: -2,
        framesDropped: 7, frameWidth: 1920, frameHeight: 1080, framesPerSecond: 60,
        jitter: 0.018, jitterBufferDelay: 25, jitterBufferEmittedCount: 1000,
        codecId: "codec" },
      { id: "codec", type: "codec", mimeType: "video/VP9" },
    ] as unknown as RTCStats[];
    const result = parseInboundStats(rows, { ssrc: 9, timestamp: 2000, bytes: 1_000_000 });
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
    expect(streamHealth({ limitation: "cpu", lossPercent: 0, rttMs: 20 })).toBe("Ограничено CPU");
    expect(streamHealth({ limitation: "bandwidth", lossPercent: 0, rttMs: 20 })).toBe("Ограничено сетью");
    expect(streamHealth({ lossPercent: 3, rttMs: 20 })).toBe("Есть потери");
    expect(streamHealth({ lossPercent: 1, rttMs: 20 })).toBe("Стабильно");
    expect(streamHealth({ lossPercent: 0.2, rttMs: 250 })).toBe("Стабильно");
    expect(streamHealth({ lossPercent: 0.2, rttMs: 40 })).toBe("Отлично");
    expect(streamHealth({})).toBe("Определяем");
  });
});
```

- [ ] **Step 2: Run the new test and verify RED**

Run: `cd web && pnpm vitest run src/stats.test.ts`

Expected: FAIL because `stats.ts` does not exist.

- [ ] **Step 3: Implement pure stats parsers**

Create `web/src/stats.ts` with these exported shapes:

```ts
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
```

Implement codec lookup by `codecId`, outbound/remote association by `remoteId` or `localId`, `Math.max(0, packetsLost)`, seconds-to-milliseconds conversion, and bitrate only when SSRC is unchanged, timestamp increases, and bytes do not decrease. Strip the `audio/` or `video/` prefix from MIME type. `formatMetric(undefined, suffix)` returns `—`; numeric output uses Russian locale-independent rounded text to keep tests deterministic.

- [ ] **Step 4: Run the stats tests and verify GREEN**

Run: `cd web && pnpm vitest run src/stats.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the stats model**

```sh
git add web/src/stats.ts web/src/stats.test.ts
git commit -m "feat: normalize WebRTC stream statistics"
```

---

### Task 4: Независимый viewer buffer с feature detection

**Files:**
- Create: `web/src/playout.ts`
- Create: `web/src/playout.test.ts`

**Interfaces:**
- Produces: `BufferPreference = number | null`, `loadBufferPreference(storage)`, `saveBufferPreference(storage, value)`, `applyPlayoutBuffer(track, value): PlayoutSupport`, `applyPlayoutBufferToTracks(tracks, value)`.
- Consumes: LiveKit `RemoteTrack.receiver`, `RemoteTrack.setPlayoutDelay`.

- [ ] **Step 1: Write failing tests for modern API, fallback, unsupported browser, and persistence**

Create `web/src/playout.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { RemoteTrack } from "livekit-client";
import {
  applyPlayoutBuffer,
  loadBufferPreference,
  saveBufferPreference,
} from "./playout";

it("задаёт jitterBufferTarget в миллисекундах и возвращает Auto в null", () => {
  const receiver = { jitterBufferTarget: null } as RTCRtpReceiver;
  const track = { receiver, setPlayoutDelay: vi.fn() } as unknown as RemoteTrack;
  expect(applyPlayoutBuffer(track, 1.5)).toBe("jitterBufferTarget");
  expect(receiver.jitterBufferTarget).toBe(1500);
  expect(applyPlayoutBuffer(track, null)).toBe("jitterBufferTarget");
  expect(receiver.jitterBufferTarget).toBeNull();
});

it("использует LiveKit fallback в секундах", () => {
  const setPlayoutDelay = vi.fn();
  const track = {
    receiver: { playoutDelayHint: undefined },
    setPlayoutDelay,
  } as unknown as RemoteTrack;
  expect(applyPlayoutBuffer(track, 2.4)).toBe("playoutDelayHint");
  expect(setPlayoutDelay).toHaveBeenCalledWith(2.4);
});

it("не мешает просмотру без поддерживаемого API", () => {
  const track = { receiver: {}, setPlayoutDelay: vi.fn() } as unknown as RemoteTrack;
  expect(applyPlayoutBuffer(track, 1)).toBe("unsupported");
});

it("сохраняет только Auto или шаги 0.1–4.0", () => {
  let stored: string | null = null;
  const storage = {
    getItem: () => stored,
    setItem: (_key: string, value: string) => { stored = value; },
  } as Storage;
  saveBufferPreference(storage, 1.7);
  expect(loadBufferPreference(storage)).toBe(1.7);
  stored = "9";
  expect(loadBufferPreference(storage)).toBeNull();
});
```

- [ ] **Step 2: Run the playout test and verify RED**

Run: `cd web && pnpm vitest run src/playout.test.ts`

Expected: FAIL because `playout.ts` does not exist.

- [ ] **Step 3: Implement playout feature detection and storage**

Create `web/src/playout.ts`. Use runtime property checks rather than assuming TypeScript DOM availability:

```ts
export type BufferPreference = number | null;
export type PlayoutSupport = "jitterBufferTarget" | "playoutDelayHint" | "unsupported";

export function applyPlayoutBuffer(
  track: RemoteTrack,
  seconds: BufferPreference,
): PlayoutSupport {
  const receiver = track.receiver;
  if (!receiver) return "unsupported";
  if ("jitterBufferTarget" in receiver) {
    receiver.jitterBufferTarget = seconds === null ? null : seconds * 1000;
    return "jitterBufferTarget";
  }
  if ("playoutDelayHint" in receiver) {
    track.setPlayoutDelay(seconds ?? 0);
    return "playoutDelayHint";
  }
  return "unsupported";
}
```

Validate finite values from 0.1 through 4.0 on exact tenths; catch Storage exceptions. `applyPlayoutBufferToTracks` applies the same value to every track and returns `unsupported` only when no track accepted either mechanism.

- [ ] **Step 4: Run the playout tests and verify GREEN**

Run: `cd web && pnpm vitest run src/playout.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit viewer buffer primitives**

```sh
git add web/src/playout.ts web/src/playout.test.ts
git commit -m "feat: add viewer playout buffer control"
```

---

### Task 5: Интеграция ручных настроек и исходящей статистики в Studio

**Files:**
- Modify: `web/src/Studio.tsx`
- Modify: `web/src/styles.css`
- Modify: `web/e2e/broadcast.spec.ts`

**Interfaces:**
- Consumes: settings APIs from Task 1, `PublishedTracks` and media APIs from Task 2, outgoing parser and health from Task 3.
- Produces: accessible host controls with labels `Разрешение`, `Частота кадров`, `Видеобитрейт`, `Аудиобитрейт`, `Баланс качества`, `Кодек`; section heading `Диагностика отправки`.

- [ ] **Step 1: Add failing E2E assertions for the Studio controls**

In the existing real-SFU test, after opening the studio and before starting capture, replace the old select/button interactions with:

```ts
await expect(page.getByLabel("Кодек")).toHaveValue("vp8");
await page.getByLabel("Кодек").selectOption("vp9");
await page.getByLabel("Разрешение").fill("4");
await page.getByLabel("Частота кадров").fill("30");
await page.getByLabel("Видеобитрейт").fill("20");
await page.getByLabel("Аудиобитрейт").fill("192");
await page.getByLabel("Баланс качества").fill("65");
```

After the host reaches live state, assert:

```ts
await expect(page.getByLabel("Кодек")).toBeDisabled();
await expect(page.getByRole("heading", { name: "Диагностика отправки" })).toBeVisible();
await expect(page.getByText("Пакеты отправлены", { exact: true })).toBeVisible();
```

For CI reliability, set VP8 back before starting the synthetic broadcast; codec behavior itself is covered by unit tests and hardware/browser capability varies.

```ts
await page.getByLabel("Кодек").selectOption("vp8");
```

- [ ] **Step 2: Run the E2E test against the current application and verify RED**

Run with the Docker stack already up: `cd web && pnpm playwright test e2e/broadcast.spec.ts -g "реальный SFU"`

Expected: FAIL because the new range controls and diagnostic heading do not exist.

- [ ] **Step 3: Refactor Studio state around `StreamSettings` and published track refs**

In `Studio.tsx`:

```ts
const [settings, setSettings] = useState<StreamSettings>(() =>
  loadStreamSettings(localStorage),
);
const confirmedSettings = useRef(settings);
const tracksRef = useRef<PublishedTracks | null>(null);
```

Replace the old `res`, `fps`, `trackRef`, `encoded`, `sound`, and single `sent` state/refs. Persist valid draft settings in an effect. `start()` passes the full settings object to `applyQuality`/`publishScreen`; assign the returned `PublishedTracks`.

Implement `commitSettings(next)` to update the draft, skip sender work when not live, and otherwise call `updateQuality(tracks, next)`. On error, call `updateQuality(tracks, confirmedSettings.current)`, restore the confirmed state, and display `Не удалось изменить качество: …`. On success update `confirmedSettings.current`.

Range sliders update their visible draft during drag and commit on pointer-up, keyboard key-up, or blur. Resolution uses the numeric index into `RESOLUTION_STEPS`; codec remains a `<select>` and is disabled while live.

- [ ] **Step 4: Replace the old stats loop with normalized audio/video snapshots**

Maintain separate previous `CounterSample` refs for video and audio. Each second, call `getRTCStatsReport()` on `tracksRef.current.video` and optional audio track, pass `Array.from(report.values())` to `parseOutboundStats`, store the returned sample, and render the returned metrics.

The diagnostics section renders literal labels:

```tsx
<h2>Диагностика отправки</h2>
<span>Состояние <strong>{streamHealth(videoMetrics)}</strong></span>
<span>Кодек <strong>{videoMetrics.codec ?? "—"}</strong></span>
<span>Битрейт <strong>{formatMetric(videoMetrics.bitrateKbps, " кбит/с")}</strong></span>
<span>Предел <strong>{settings.videoBitrateMbps} Мбит/с</strong></span>
<span>Пакеты отправлены <strong>{formatMetric(videoMetrics.packets)}</strong></span>
<span>Потеряно <strong>{formatMetric(videoMetrics.packetsLost)}</strong></span>
<span>Повторно отправлено <strong>{formatMetric(videoMetrics.retransmittedPackets)}</strong></span>
<span>RTT <strong>{formatMetric(videoMetrics.rttMs, " мс")}</strong></span>
```

Add the corresponding audio group, capture settings, actual encoded resolution/FPS, and loss percent. Reset samples and metrics on stop/disconnect/new start.

- [ ] **Step 5: Style accessible range controls and diagnostics**

In `styles.css`, add focused classes rather than styling every input globally:

```css
.range-control { margin-top: 18px; }
.range-heading { display: flex; justify-content: space-between; gap: 12px; }
.range-value { color: var(--accent); font-variant-numeric: tabular-nums; }
.range-control input[type="range"] { width: 100%; accent-color: var(--accent); }
.range-scale { display: flex; justify-content: space-between; color: #727a87; font-size: 9px; }
.diagnostics { display: grid; gap: 14px; }
.metric-group { display: grid; gap: 7px; }
.metric-row { display: flex; justify-content: space-between; gap: 10px; font-size: 10px; }
.metric-row strong { color: #c5d7b5; font-weight: 500; text-align: right; }
```

At the existing tablet/mobile breakpoints, keep a single-column metrics layout and ensure long codec/status strings wrap instead of widening the page.

- [ ] **Step 6: Run unit tests, build, then E2E and verify GREEN**

Run:

```sh
cd web
pnpm test
pnpm run build
pnpm playwright test e2e/broadcast.spec.ts -g "реальный SFU"
```

Expected: all PASS; TypeScript reports no stale positional media API calls; the actual SFU test sees the controls and outgoing diagnostics.

- [ ] **Step 7: Commit the Studio integration**

```sh
git add web/src/Studio.tsx web/src/styles.css web/e2e/broadcast.spec.ts
git commit -m "feat: add studio quality controls and diagnostics"
```

---

### Task 6: Интеграция viewer buffer и входящей статистики

**Files:**
- Modify: `web/src/Viewer.tsx`
- Modify: `web/src/styles.css`
- Modify: `web/e2e/broadcast.spec.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: playout APIs from Task 4 and inbound stats parser from Task 3.
- Produces: range input `Буфер воспроизведения`, section heading `Диагностика приёма`, persisted per-browser preference and graceful unsupported state.

- [ ] **Step 1: Add failing E2E assertions for viewer buffer and diagnostics**

After the first viewer receives video, add:

```ts
await expect(viewer.getByLabel("Буфер воспроизведения")).toBeEnabled();
await viewer.getByLabel("Буфер воспроизведения").fill("10");
await expect(viewer.getByText("1.0 с", { exact: true })).toBeVisible();
await expect(viewer.getByRole("heading", { name: "Диагностика приёма" })).toBeVisible();
await expect(viewer.getByText("Пакеты получены", { exact: true })).toBeVisible();
```

The slider stores tenths as integers (`0` means Auto, `1..40` means `0.1..4.0` seconds), avoiding floating-point range drift.

- [ ] **Step 2: Run the focused E2E test and verify RED**

Run: `cd web && pnpm playwright test e2e/broadcast.spec.ts -g "реальный SFU"`

Expected: FAIL because viewer buffer and incoming diagnostics do not exist.

- [ ] **Step 3: Track subscribed media, apply buffer preference, and poll incoming stats**

In `Viewer.tsx`, add:

```ts
const [buffer, setBuffer] = useState<BufferPreference>(() =>
  loadBufferPreference(localStorage),
);
const [playoutSupport, setPlayoutSupport] = useState<PlayoutSupport | "unknown">("unknown");
const remoteTracks = useRef(new Set<RemoteTrack>());
```

On `TrackSubscribed`, add the track to the set, attach it as today, then call `applyPlayoutBuffer(track, buffer)` and update support. On `TrackUnsubscribed`, remove it and clear its corresponding metrics/sample. On disconnect/unmount, clear the set.

When the slider changes, map `0` to `null` and `1..40` to tenths, save it, and call `applyPlayoutBufferToTracks([...remoteTracks.current], next)`. Disable the control and show `Браузер использует автоматический буфер` only after all subscribed tracks report `unsupported`; do not block playback.

While joined, poll each remote track's `getRTCStatsReport()` once per second. Use separate audio/video counter samples and `parseInboundStats`. Render codec, bitrate, resolution/FPS, packets received/lost, dropped frames, jitter, and actual buffer delay. Reset counters when track identity changes.

- [ ] **Step 4: Add the viewer control and diagnostics markup/styles**

Place a compact buffer panel below `.viewer-player`, not inside the fullscreen control bar, so it remains usable on touch devices:

```tsx
<section className="viewer-diagnostics" aria-labelledby="viewer-diagnostics-title">
  <h2 id="viewer-diagnostics-title">Диагностика приёма</h2>
  <label htmlFor="playout-buffer">Буфер воспроизведения</label>
  <input id="playout-buffer" aria-label="Буфер воспроизведения"
    type="range" min="0" max="40" step="1" />
  <output>{buffer === null ? "Авто" : `${buffer.toFixed(1)} с`}</output>
  <div className="metric-group" aria-label="Видео">
    <span className="metric-row">Кодек <strong>{videoMetrics.codec ?? "—"}</strong></span>
    <span className="metric-row">Битрейт <strong>{formatMetric(videoMetrics.bitrateKbps, " кбит/с")}</strong></span>
    <span className="metric-row">Пакеты получены <strong>{formatMetric(videoMetrics.packets)}</strong></span>
    <span className="metric-row">Потеряно <strong>{formatMetric(videoMetrics.packetsLost)}</strong></span>
    <span className="metric-row">Пропущено кадров <strong>{formatMetric(videoMetrics.droppedFrames)}</strong></span>
    <span className="metric-row">Jitter <strong>{formatMetric(videoMetrics.jitterMs, " мс")}</strong></span>
    <span className="metric-row">Фактический буфер <strong>{formatMetric(videoMetrics.bufferMs, " мс")}</strong></span>
  </div>
  <div className="metric-group" aria-label="Аудио">
    <span className="metric-row">Кодек <strong>{audioMetrics.codec ?? "—"}</strong></span>
    <span className="metric-row">Битрейт <strong>{formatMetric(audioMetrics.bitrateKbps, " кбит/с")}</strong></span>
    <span className="metric-row">Пакеты получены <strong>{formatMetric(audioMetrics.packets)}</strong></span>
    <span className="metric-row">Потеряно <strong>{formatMetric(audioMetrics.packetsLost)}</strong></span>
    <span className="metric-row">Jitter <strong>{formatMetric(audioMetrics.jitterMs, " мс")}</strong></span>
  </div>
</section>
```

Use a two-column desktop grid for video/audio metrics and one column below the existing mobile breakpoint. Keep the player dimensions unchanged.

- [ ] **Step 5: Update README with controls, diagnostics, and truthful limits**

Update the feature list and bandwidth section to state:

- VP8/VP9/AV1 is selectable before broadcast; compatibility and actual codec are visible in diagnostics.
- Video can be limited from 1–80 Мбит/с and audio from 32–320 кбит/с; these are ceilings, not guaranteed throughput.
- Capture supports 15–120 requested FPS, but actual capture/encode may be lower.
- Viewer buffer is Auto or 0.1–4.0 seconds and is a browser preference, not a precise delay guarantee.
- WebRTC output is lossy and cannot guarantee pixel-identical 1:1 frames.
- At 80 Мбит/с with 10 viewers, the host-to-SFU upload is about 80 Мбит/с and SFU egress can approach 800 Мбит/с plus protocol overhead; actual traffic varies.

Update the development verification count without claiming AV1/4K120 hardware validation unless it was manually performed.

- [ ] **Step 6: Run the complete verification suite**

Run:

```sh
cd web
pnpm test
pnpm run build
pnpm test:e2e
cd ..
go test ./...
go vet ./...
git diff --check
```

Expected: all commands exit 0. If Docker/LiveKit is not running, report E2E as blocked rather than claiming it passed; unit tests, TypeScript build, Go tests/vet, and diff check must still pass.

- [ ] **Step 7: Perform targeted manual browser verification**

In current Chrome or Edge:

1. Start VP8 at defaults and confirm capture continues while changing every range control.
2. Start separate VP9 and AV1 sessions and confirm the diagnostics reports the negotiated codec or an explicit compatible fallback.
3. Verify audio bitrate applies only when the selected source supplies an audio track.
4. Open two viewer contexts, set Auto on one and 2.0 seconds on the other, and confirm preferences remain independent after reload.
5. Throttle the host network in browser devtools and confirm bitrate/loss/limitation metrics update without terminating the room.
6. Check 390 px width for horizontal overflow and usable sliders.

- [ ] **Step 8: Commit viewer diagnostics and documentation**

```sh
git add web/src/Viewer.tsx web/src/styles.css web/e2e/broadcast.spec.ts README.md
git commit -m "feat: add viewer buffer and receive diagnostics"
```

---

### Task 7: Final regression review and cleanup

**Files:**
- Modify only files already listed if verification exposes a defect.

**Interfaces:**
- Consumes: all tasks above.
- Produces: a clean, verified branch with no stale helpers (`bitrate(res, fps)`, positional `updateQuality`, old Studio stats strings) and no unrelated workspace changes.

- [ ] **Step 1: Search for stale APIs and duplicate calculations**

Run:

```sh
rg -n "bitrate\(|updateQuality\([^,]+,[^,]+,[^,]+\)|soundLabel|limitLabel" web/src
rg -n "getRTCStatsReport" web/src/Studio.tsx web/src/Viewer.tsx
```

Expected: no old bitrate policy or legacy formatting helpers; RTC report traversal occurs only at component integration boundaries and arithmetic stays in `stats.ts`.

- [ ] **Step 2: Run formatting and inspect the exact diff**

Run:

```sh
cd web
pnpm exec prettier --write src/quality.ts src/quality.test.ts src/media.ts src/media.test.ts src/stats.ts src/stats.test.ts src/playout.ts src/playout.test.ts src/Studio.tsx src/Viewer.tsx src/styles.css e2e/broadcast.spec.ts ../README.md
cd ..
git diff --check
git status --short
git diff --stat
```

Expected: no whitespace errors; status lists only planned implementation files plus pre-existing unrelated user files.

- [ ] **Step 3: Re-run all non-manual checks after formatting**

Run:

```sh
cd web
pnpm test
pnpm run build
cd ..
go test ./...
go vet ./...
```

Run `cd web && pnpm test:e2e` as well when the local Docker stack is available.

Expected: all available checks PASS with no warnings introduced by this change.

- [ ] **Step 4: Commit only cleanup caused by the final review**

If formatting or a verified defect changed tracked files:

```sh
git add README.md web/src web/e2e/broadcast.spec.ts
git commit -m "chore: finalize stream quality controls"
```

If there is no diff, do not create an empty commit.
