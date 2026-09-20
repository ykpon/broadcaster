import { describe, it, expect } from "vitest";
import {
  DEFAULT_STREAM_SETTINGS,
  RESOLUTION_STEPS,
  constraints,
  captureError,
  audioHint,
  kbps,
  loadStreamSettings,
  normalizeStreamSettings,
  qualityHints,
  saveStreamSettings,
  soundLabel,
  limitLabel,
  type StreamSettings,
} from "./quality";

function memoryStorage(initial?: string): Storage {
  let value = initial ?? null;
  return {
    getItem: () => value,
    setItem: (_key, next) => {
      value = next;
    },
    removeItem: () => {
      value = null;
    },
    clear: () => {
      value = null;
    },
    key: () => null,
    get length() {
      return value === null ? 0 : 1;
    },
  };
}

describe("качество трансляции", () => {
  it("восстанавливает безопасные defaults из повреждённого хранилища", () => {
    expect(loadStreamSettings(memoryStorage("not json"))).toEqual(
      DEFAULT_STREAM_SETTINGS,
    );
    expect(
      normalizeStreamSettings({
        resolution: "9000",
        fps: 999,
        videoBitrateMbps: -4,
        audioBitrateKbps: 7,
        balance: 1000,
        codec: "h265",
      }),
    ).toEqual(DEFAULT_STREAM_SETTINGS);
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
    expect(
      constraints({ ...DEFAULT_STREAM_SETTINGS, resolution: "2160", fps: 120 }),
    ).toEqual({
      width: { ideal: 3840, max: 3840 },
      height: { ideal: 2160, max: 2160 },
      frameRate: { ideal: 120, max: 120 },
    });
    expect(RESOLUTION_STEPS.map((item) => item.value)).toEqual([
      "auto",
      "720",
      "1080",
      "1440",
      "2160",
    ]);
  });
  it("подсказывает про галочку системного звука для экрана и окна", () => {
    for (const surface of ["monitor", "window", ""])
      expect(audioHint(surface)).toContain("аудио системы");
    expect(audioHint("browser")).not.toContain("аудио системы");
  });
  it("объясняет отмену выбора пользователем", () => {
    expect(
      captureError(new DOMException("denied", "NotAllowedError")),
    ).toContain("отменён");
  });
});

describe("показания звука", () => {
  it("считает килобиты в секунду по приросту байт", () => {
    // 16000 байт за секунду = 128 кбит/с — ровно то, что просим у Opus.
    expect(kbps(16000, 1000, { bytes: 0, at: 0 })).toBe(0);
    expect(kbps(32000, 2000, { bytes: 16000, at: 1000 })).toBe(128);
  });

  it("называет частоту и каналы захвата", () => {
    expect(soundLabel({ sampleRate: 48000, channelCount: 2 }, 128)).toBe(
      "48 кГц · стерео · 128 кбит/с · потери 0.0%",
    );
    expect(soundLabel({ sampleRate: 16000, channelCount: 1 }, 24, 0.031)).toBe(
      "16 кГц · моно · 24 кбит/с · потери 3.1%",
    );
    expect(soundLabel(undefined, 0)).toBe("— · — · 0 кбит/с · потери 0.0%");
  });
});

describe("limitLabel", () => {
  it("называет причину, когда энкодер зажат", () => {
    expect(limitLabel("bandwidth")).toBe(" · упирается в сеть");
    expect(limitLabel("cpu")).toBe(" · упирается в CPU");
  });

  it("молчит, когда ограничения нет", () => {
    expect(limitLabel("none")).toBe("");
    expect(limitLabel(undefined)).toBe("");
  });
});
