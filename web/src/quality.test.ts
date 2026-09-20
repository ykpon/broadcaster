import { describe, it, expect } from "vitest";
import {
  DEFAULT_STREAM_SETTINGS,
  RESOLUTION_STEPS,
  constraints,
  captureError,
  audioHint,
  loadStreamSettings,
  normalizeStreamSettings,
  qualityBalanceLabel,
  qualityHints,
  saveStreamSettings,
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
    expect([39, 40, 60, 61].map(qualityBalanceLabel)).toEqual([
      "Чёткость",
      "Баланс",
      "Баланс",
      "Движение",
    ]);
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
  it("объясняет фактическую маршрутизацию захваченного звука", () => {
    expect(audioHint("browser", true)).toContain("выбранной вкладки");
    expect(audioHint("window", true)).toContain("выбранного окна");
    expect(audioHint("window", true)).toContain("весь звук системы");
    expect(audioHint("monitor", true)).toContain("весь звук системы");
    expect(audioHint("monitor", true)).toContain("Discord");
    expect(audioHint("browser", false)).toContain("включите передачу звука");
  });
  it("объясняет отмену выбора пользователем", () => {
    expect(
      captureError(new DOMException("denied", "NotAllowedError")),
    ).toContain("отменён");
  });
});
