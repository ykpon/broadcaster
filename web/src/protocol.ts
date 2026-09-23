export type TransportMode = "p2p" | "server";

export type RoomInfo = {
  roomId: string;
  state: "waiting" | "live" | "ended";
  viewers: number;
  generation: number;
  transport?: TransportMode;
  viewerLimit: string;
};

export type LiveKitConnection = { url: string; token: string };
export type IceServer = { urls: string[] };

type StartResponseBase = {
  generation: number;
  ticket: string;
};

export type StartResponse =
  | (StartResponseBase & {
      transport: "p2p";
      iceServers: IceServer[];
      livekit?: never;
    })
  | (StartResponseBase & {
      transport: "server";
      livekit: LiveKitConnection;
      iceServers?: never;
    });

export type JoinResponse = { session: string; ticket: string };

export type ICECandidate = {
  candidate: string;
  sdpMid?: string;
  sdpMLineIndex?: number;
  usernameFragment?: string;
};

export type BroadcastStartedSignal =
  | {
      type: "broadcast-started";
      generation: number;
      transport: "p2p";
      viewerLimit: string;
      iceServers: IceServer[];
      livekit?: never;
    }
  | {
      type: "broadcast-started";
      generation: number;
      transport: "server";
      viewerLimit: string;
      livekit: LiveKitConnection;
      iceServers?: never;
    };

export type ServerSignal =
  | { type: "authenticated"; generation?: number; viewer?: string }
  | BroadcastStartedSignal
  | { type: "broadcast-stopped"; generation: number }
  | { type: "room-ended"; generation?: number }
  | { type: "peer-ready" | "peer-left"; generation: number; viewer: string }
  | {
      type: "offer" | "answer";
      generation: number;
      viewer: string;
      negotiationId: string;
      sdp: string;
    }
  | {
      type: "ice-candidate";
      generation: number;
      viewer: string;
      negotiationId: string;
      candidate: ICECandidate;
    }
  | {
      type: "peer-failed";
      generation: number;
      viewer: string;
      negotiationId?: string;
    }
  | { type: "error"; generation?: number; error: string };

export type ClientSignal =
  | { type: "authenticate"; ticket: string }
  | { type: "broadcast-ready" | "broadcast-stopped"; generation: number }
  | {
      type: "offer" | "answer";
      generation: number;
      viewer?: string;
      negotiationId: string;
      sdp: string;
    }
  | {
      type: "ice-candidate";
      generation: number;
      viewer?: string;
      negotiationId: string;
      candidate: ICECandidate;
    }
  | {
      type: "peer-ready";
      generation: number;
      viewer?: string;
    }
  | {
      type: "peer-failed";
      generation: number;
      viewer?: string;
      negotiationId?: string;
    };

export type BroadcastConfig = {
  transport: TransportMode;
  viewerLimit: string;
};

export const DEFAULT_BROADCAST_CONFIG: BroadcastConfig = {
  transport: "server",
  viewerLimit: "10",
};

const BROADCAST_CONFIG_KEY = "broadcast-config";

export function normalizeViewerLimit(raw: string): string | null {
  if (!/^[0-9]+$/.test(raw)) return null;
  const normalized = raw.replace(/^0+/, "");
  return normalized === "" ? null : normalized;
}

export function loadBroadcastConfig(
  storage: Pick<Storage, "getItem">,
): BroadcastConfig {
  try {
    const raw = storage.getItem(BROADCAST_CONFIG_KEY);
    if (raw === null) return { ...DEFAULT_BROADCAST_CONFIG };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null)
      return { ...DEFAULT_BROADCAST_CONFIG };
    const value = parsed as Record<string, unknown>;
    const viewerLimit =
      typeof value.viewerLimit === "string"
        ? normalizeViewerLimit(value.viewerLimit)
        : null;
    if (
      (value.transport !== "p2p" && value.transport !== "server") ||
      viewerLimit === null
    )
      return { ...DEFAULT_BROADCAST_CONFIG };
    return { transport: value.transport, viewerLimit };
  } catch {
    return { ...DEFAULT_BROADCAST_CONFIG };
  }
}

export function saveBroadcastConfig(
  storage: Pick<Storage, "setItem">,
  config: BroadcastConfig,
): void {
  const viewerLimit = normalizeViewerLimit(config.viewerLimit);
  if (viewerLimit === null) return;
  try {
    storage.setItem(
      BROADCAST_CONFIG_KEY,
      JSON.stringify({ transport: config.transport, viewerLimit }),
    );
  } catch {
    // Storage can be unavailable in private browsing or by user policy.
  }
}
