import { describe, it, expect, vi } from "vitest";
import { applyQuality } from "./media";

// Gecko rejects with a plain Error: Firefox exposes no OverconstrainedError
// interface at all (MDN BCD api.OverconstrainedError → firefox: false).
const firefoxError = Object.assign(
  new Error("Constraints could not be satisfied."),
  {
    name: "OverconstrainedError",
  },
);
const chromeError = new DOMException(
  "Cannot satisfy constraints",
  "OverconstrainedError",
);

function track(...outcomes: ("ok" | Error)[]) {
  const applyConstraints = vi.fn(() => {
    const outcome = outcomes.shift() ?? "ok";
    return outcome === "ok" ? Promise.resolve() : Promise.reject(outcome);
  });
  return { applyConstraints } as unknown as MediaStreamTrack & {
    applyConstraints: ReturnType<typeof vi.fn>;
  };
}

describe("applyQuality", () => {
  it("молчит, когда источник принял параметры", async () => {
    expect(await applyQuality(track("ok"), "1080", 60)).toBe("");
  });

  for (const [browser, error] of [
    ["Firefox", firefoxError],
    ["Chrome", chromeError],
  ] as const)
    it(`переходит на запасные параметры, а не срывает эфир (${browser})`, async () => {
      const source = track(error, "ok");
      expect(await applyQuality(source, "2160", 60)).toContain(
        "Используются доступные настройки",
      );
      expect(source.applyConstraints).toHaveBeenLastCalledWith({
        frameRate: { ideal: 60 },
      });
    });

  it("не срывает эфир, если запасные параметры тоже отклонены", async () => {
    expect(
      await applyQuality(track(firefoxError, firefoxError), "2160", 60),
    ).toContain("Используются доступные настройки");
  });

  it("пробрасывает ошибки, не связанные с ограничениями", async () => {
    const stopped = new DOMException("track ended", "InvalidStateError");
    await expect(applyQuality(track(stopped), "1080", 30)).rejects.toBe(
      stopped,
    );
  });
});
