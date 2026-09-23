import { useEffect, useState } from "react";
import { api, message } from "./api";
import type { RoomInfo } from "./protocol";
export function useRoomInfo(id: string) {
  const [info, setInfo] = useState<RoomInfo>(),
    [error, setError] = useState("");
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const data = await api<RoomInfo>(`/rooms/${id}`);
        if (!stopped) {
          setInfo(data);
          setError("");
        }
      } catch (e) {
        if (!stopped) setError(message(e));
      }
      if (!stopped) timer = setTimeout(poll, 3000);
    }
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [id]);
  return { info, error };
}
export type ConnectionStatus =
  "disconnected" | "connecting" | "connected" | "reconnecting";

export function roomStateLabel(state: ConnectionStatus): string;
export function roomStateLabel(state: string): string;
export function roomStateLabel(state: string) {
  return state === "connected"
    ? "Соединение установлено"
    : state === "reconnecting" || state === "signalReconnecting"
      ? "Переподключение…"
      : state === "connecting"
        ? "Подключение…"
        : "Не подключено";
}
