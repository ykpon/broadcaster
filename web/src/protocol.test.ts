import { describe, expect, it } from "vitest";
import {
  DEFAULT_BROADCAST_CONFIG,
  loadBroadcastConfig,
  normalizeViewerLimit,
  saveBroadcastConfig,
} from "./protocol";

function memoryStorage(initial: string | null = null) {
  let value = initial;
  return {
    getItem: () => value,
    setItem: (_key: string, next: string) => {
      value = next;
    },
    value: () => value,
  } as Pick<Storage, "getItem" | "setItem"> & { value(): string | null };
}

describe("broadcast configuration", () => {
  it("normalizes arbitrary positive decimal limits without Number conversion", () => {
    expect(
      normalizeViewerLimit("000100000000000000000000000000000000000"),
    ).toBe("100000000000000000000000000000000000");
    for (const raw of ["", "0", "-1", "+1", "1.5", " 10", "10 "])
      expect(normalizeViewerLimit(raw)).toBeNull();
  });

  it("defaults to server transport and ten viewers when storage is absent", () => {
    expect(
      loadBroadcastConfig({ getItem: () => null } as unknown as Storage),
    ).toEqual({
      transport: "server",
      viewerLimit: "10",
    });
  });

  it("loads only valid stored transport and normalized limits", () => {
    const stored = memoryStorage(
      JSON.stringify({ transport: "p2p", viewerLimit: "00042" }),
    );
    expect(loadBroadcastConfig(stored)).toEqual({
      transport: "p2p",
      viewerLimit: "42",
    });

    for (const value of [
      "not json",
      JSON.stringify({ transport: "relay", viewerLimit: "42" }),
      JSON.stringify({ transport: "p2p", viewerLimit: "0" }),
    ]) {
      expect(loadBroadcastConfig(memoryStorage(value))).toEqual(
        DEFAULT_BROADCAST_CONFIG,
      );
    }
  });

  it("saves the normalized configuration and tolerates unavailable storage", () => {
    const storage = memoryStorage();
    saveBroadcastConfig(storage, { transport: "p2p", viewerLimit: "00012" });
    expect(JSON.parse(storage.value()!)).toEqual({
      transport: "p2p",
      viewerLimit: "12",
    });

    expect(() =>
      saveBroadcastConfig(
        {
          setItem: () => {
            throw new Error("denied");
          },
        } as unknown as Storage,
        { transport: "server", viewerLimit: "10" },
      ),
    ).not.toThrow();
  });
});
