import { describe, it, expect } from "vitest";
import {
  constraints,
  bitrate,
  captureError,
  audioHint,
  kbps,
  soundLabel,
  limitLabel,
  resolutions,
  type Resolution,
} from "./quality";
describe("качество трансляции", () => {
  it("использует целочисленный bitrate для protobuf LiveKit во всех режимах", () => {
    for (const resolution of Object.keys(resolutions))
      for (const fps of [30, 60] as const) {
        expect(Number.isInteger(bitrate(resolution as Resolution, fps))).toBe(
          true,
        );
      }
  });
  it("независимо задаёт 4K и 60 FPS", () => {
    expect(constraints("2160", 60)).toEqual({
      width: { ideal: 3840, max: 3840 },
      height: { ideal: 2160, max: 2160 },
      frameRate: { ideal: 60, max: 60 },
    });
    expect(constraints("2160", 30).width).toEqual(
      constraints("2160", 60).width,
    );
  });
  it("выделяет 25 Mbps для 4K60 и меньше для 720p", () => {
    expect(bitrate("2160", 60)).toBe(25_000_000);
    expect(bitrate("720", 30)).toBe(2_500_000);
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
