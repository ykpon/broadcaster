import { describe, expect, it } from "vitest";
import {
  createViewerSession,
  createIncomingStatsTracker,
  loadBufferPreferenceSafely,
  reduceViewerFailure,
  saveBufferPreferenceSafely,
  viewerErrorPresentation,
  visibleViewerError,
  viewerScene,
} from "./viewerRuntime";

describe("viewer failure lifecycle", () => {
  const p2pFailure =
    "Сеть, NAT или firewall не пропускают P2P. Повторите попытку или попросите ведущего запустить эфир через сервер.";

  it.each(["broadcast-stopped", "room-ended"] as const)(
    "does not render a strict P2P failure after %s",
    (type) => {
      const failed = reduceViewerFailure(undefined, {
        type: "error",
        scope: "transport",
        message: p2pFailure,
      });
      expect(visibleViewerError(failed, "")).toBe(p2pFailure);

      const inactive = reduceViewerFailure(failed, { type });
      expect(visibleViewerError(inactive, "")).toBe("");
    },
  );

  it("preserves unrelated room errors when a broadcast stops", () => {
    const failed = reduceViewerFailure(undefined, {
      type: "error",
      scope: "room",
      message: "Комната недоступна",
    });

    const stopped = reduceViewerFailure(failed, {
      type: "broadcast-stopped",
    });
    expect(visibleViewerError(stopped, "")).toBe("Комната недоступна");
  });

  it("replaces a transport failure after a fatal control failure", () => {
    const failed = reduceViewerFailure(undefined, {
      type: "error",
      scope: "transport",
      message: p2pFailure,
    });

    const fatal = reduceViewerFailure(failed, {
      type: "control-fatal",
      message: "Управляющее соединение потеряно",
    });
    expect(visibleViewerError(fatal, "")).toBe(
      "Управляющее соединение потеряно",
    );
  });

  it.each([
    {
      event: { type: "broadcast-stopped" as const },
      scene: {
        joined: true,
        active: false,
        transport: undefined,
        p2pFailed: false,
        ended: false,
      },
    },
    {
      event: { type: "room-ended" as const },
      scene: {
        joined: false,
        active: false,
        transport: undefined,
        p2pFailed: false,
        ended: true,
      },
    },
  ])("clears strict P2P presentation after $event.type", ({ event, scene }) => {
    const failed = reduceViewerFailure(undefined, {
      type: "error",
      scope: "transport",
      message: p2pFailure,
    });
    const cleared = reduceViewerFailure(failed, event);

    expect(viewerErrorPresentation(cleared, "", viewerScene(scene))).toBe("");
  });
});

describe("viewer scene presentation", () => {
  it("shows the strict P2P failure and retry action", () => {
    expect(
      viewerScene({
        joined: true,
        active: true,
        transport: "p2p",
        p2pFailed: true,
        ended: false,
      }),
    ).toEqual({
      title: "Прямое соединение не установлено",
      subtitle:
        "Сеть, NAT или firewall не пропускают P2P. Повторите попытку или попросите ведущего запустить эфир через сервер.",
      action: "retry-p2p",
    });
  });

  it("keeps an authenticated viewer in the waiting scene before broadcast", () => {
    expect(
      viewerScene({
        joined: true,
        active: false,
        transport: undefined,
        p2pFailed: false,
        ended: false,
      }),
    ).toEqual({
      title: "Ведущий готовится к эфиру",
      subtitle: "Оставайтесь здесь — изображение появится автоматически.",
      action: null,
    });
  });

  it("explains that the server transport is connecting", () => {
    expect(
      viewerScene({
        joined: true,
        active: true,
        transport: "server",
        p2pFailed: false,
        ended: false,
      }),
    ).toEqual({
      title: "Подключаемся через сервер",
      subtitle: "Изображение и звук появятся автоматически.",
      action: null,
    });
  });

  it("offers a same-generation retry after server media failure", () => {
    expect(
      viewerScene({
        joined: true,
        active: true,
        transport: "server",
        p2pFailed: false,
        serverFailed: true,
        ended: false,
      }),
    ).toEqual({
      title: "Соединение с медиасервером потеряно",
      subtitle: "Повторите подключение к текущему эфиру.",
      action: "retry-server",
    });
  });

  it("explains that a direct P2P connection is being established", () => {
    expect(
      viewerScene({
        joined: true,
        active: true,
        transport: "p2p",
        p2pFailed: false,
        ended: false,
      }),
    ).toEqual({
      title: "Устанавливаем прямое соединение",
      subtitle: "Изображение и звук появятся после подключения к ведущему.",
      action: null,
    });
  });

  it("keeps the ended scene terminal", () => {
    expect(
      viewerScene({
        joined: true,
        active: true,
        transport: "p2p",
        p2pFailed: true,
        ended: true,
      }),
    ).toEqual({
      title: "Этот эфир завершён",
      subtitle:
        "Спасибо, что были рядом. Здесь можно создать собственную комнату.",
      action: "create-room",
    });
  });
});

describe("logical viewer session", () => {
  it("joins once and reports joined only after control authentication", async () => {
    const events: string[] = [];
    let onSignal: ((signal: { type: string }) => void) | undefined;
    const close = () => events.push("closed");
    const session = createViewerSession({
      roomId: "room-a",
      readSession: () => "saved-session",
      writeSession: (value) => events.push(`saved:${value}`),
      postJoin: async (value) => {
        events.push(`join:${value}`);
        return { session: "viewer-a", ticket: "first-ticket" };
      },
      postTicket: async (value) => {
        events.push(`ticket:${value}`);
        return "next-ticket";
      },
      makeSocket: (options) => {
        onSignal = options.onSignal as typeof onSignal;
        return {
          connect: (ticket: string) => events.push(`connect:${ticket}`),
          send: () => {},
          close,
        };
      },
      onAuthenticated: () => events.push("joined"),
      onSignal: (signal) => events.push(signal.type),
      onFatal: () => events.push("fatal"),
    });
    await session.join();
    expect(events).toEqual([
      "join:saved-session",
      "saved:viewer-a",
      "connect:first-ticket",
    ]);
    onSignal?.({ type: "authenticated" });
    onSignal?.({ type: "broadcast-started" });
    expect(events).toEqual([
      "join:saved-session",
      "saved:viewer-a",
      "connect:first-ticket",
      "joined",
      "broadcast-started",
    ]);
    session.close();
    expect(events.at(-1)).toBe("closed");
  });

  it("does not open control after close while /join is pending", async () => {
    let resolveJoin!: (value: { session: string; ticket: string }) => void;
    let opened = false;
    const session = createViewerSession({
      roomId: "room-a",
      readSession: () => "",
      writeSession: () => {},
      postJoin: () =>
        new Promise((resolve) => {
          resolveJoin = resolve;
        }),
      postTicket: async () => "ticket",
      onAuthenticated: () => {},
      onSignal: () => {},
      onFatal: () => {},
      makeSocket: () => {
        opened = true;
        return { connect: () => {}, send: () => {}, close: () => {} };
      },
    });
    const pending = session.join();
    session.close();
    resolveJoin({ session: "viewer-a", ticket: "ticket" });
    await pending;
    expect(opened).toBe(false);
  });

  it("sends authenticated leave only for intentional departure", async () => {
    const sent: object[] = [];
    let closed = 0;
    const session = createViewerSession({
      roomId: "room-a",
      readSession: () => "",
      writeSession: () => {},
      postJoin: async () => ({ session: "viewer-a", ticket: "ticket" }),
      postTicket: async () => "next-ticket",
      onAuthenticated: () => {},
      onSignal: () => {},
      onFatal: () => {},
      makeSocket: () => ({
        connect: () => {},
        send: (signal) => sent.push(signal),
        close: () => {
          closed += 1;
        },
      }),
    });
    await session.join();
    session.leave();
    expect(sent).toEqual([{ type: "leave" }]);
    expect(closed).toBe(1);

    const unexpected = createViewerSession({
      roomId: "room-a",
      readSession: () => "",
      writeSession: () => {},
      postJoin: async () => ({ session: "viewer-b", ticket: "ticket" }),
      postTicket: async () => "next-ticket",
      onAuthenticated: () => {},
      onSignal: () => {},
      onFatal: () => {},
      makeSocket: () => ({
        connect: () => {},
        send: (signal) => sent.push(signal),
        close: () => {
          closed += 1;
        },
      }),
    });
    await unexpected.join();
    unexpected.close();
    expect(sent).toEqual([{ type: "leave" }]);
    expect(closed).toBe(2);
  });
});

describe("Viewer storage acquisition", () => {
  const blockedStorage = () => {
    throw new DOMException("Storage access denied", "SecurityError");
  };

  it("uses Auto when acquiring localStorage throws", () => {
    expect(loadBufferPreferenceSafely(blockedStorage)).toBeNull();
  });

  it("swallows acquisition failure so playout application continues", () => {
    const applied: Array<number | null> = [];

    expect(() => {
      saveBufferPreferenceSafely(blockedStorage, 1.2);
      applied.push(1.2);
    }).not.toThrow();
    expect(applied).toEqual([1.2]);
  });
});

describe("Viewer incoming stats lifecycle", () => {
  it("resets samples on track replacement and rejects stale reports", () => {
    const tracker = createIncomingStatsTracker<object, number>();
    const firstTrack = {};
    const replacementTrack = {};

    expect(tracker.replace(firstTrack)).toBe(true);
    const firstRead = tracker.capture(firstTrack)!;
    expect(firstRead.previous).toBeUndefined();
    expect(tracker.commit(firstRead, 10)).toBe(true);
    const resumedRead = tracker.capture(firstTrack)!;
    expect(resumedRead.previous).toBe(10);
    tracker.release(resumedRead);

    const pendingRead = tracker.capture(firstTrack)!;
    expect(tracker.replace(replacementTrack)).toBe(true);
    const replacementRead = tracker.capture(replacementTrack)!;
    expect(replacementRead.previous).toBeUndefined();
    expect(tracker.commit(pendingRead, 99)).toBe(false);
    expect(tracker.capture(replacementTrack)).toBeUndefined();
    expect(tracker.commit(replacementRead, 20)).toBe(true);
    expect(tracker.capture(replacementTrack)?.previous).toBe(20);
  });

  it("rejects a pending report after unsubscribe or reset", () => {
    const tracker = createIncomingStatsTracker<object, number>();
    const track = {};

    tracker.replace(track);
    const pendingRead = tracker.capture(track)!;
    expect(tracker.replace(null)).toBe(true);
    expect(tracker.commit(pendingRead, 12)).toBe(false);
    expect(tracker.current()).toBeNull();
  });

  it("allows only one in-flight report for the same track", () => {
    const tracker = createIncomingStatsTracker<object, number>();
    const track = {};

    tracker.replace(track);
    const first = tracker.capture(track)!;
    expect(tracker.capture(track)).toBeUndefined();
    expect(tracker.commit(first, 10)).toBe(true);
    expect(tracker.capture(track)).toBeDefined();
  });

  it("does not let a stale report release a newer same-track report", () => {
    const tracker = createIncomingStatsTracker<object, number>();
    const track = {};

    tracker.replace(track);
    const stale = tracker.capture(track)!;
    tracker.replace(null);
    tracker.replace(track);
    const current = tracker.capture(track)!;
    expect(tracker.commit(stale, 99)).toBe(false);
    expect(tracker.capture(track)).toBeUndefined();
    expect(tracker.commit(current, 10)).toBe(true);
  });
});
