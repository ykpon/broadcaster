import { describe, it, expect } from "vitest";
import {
  constraints,
  bitrate,
  captureError,
  audioHint,
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
