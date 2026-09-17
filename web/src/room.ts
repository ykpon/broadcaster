import { useEffect, useState } from "react";
import { ConnectionState } from "livekit-client";
import { api, message, type RoomInfo } from "./api";
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
export function roomStateLabel(state: ConnectionState) {
  return state === ConnectionState.Connected
    ? "Соединение установлено"
    : state === ConnectionState.Reconnecting ||
        state === ConnectionState.SignalReconnecting
      ? "Переподключение…"
      : state === ConnectionState.Connecting
        ? "Подключение…"
        : "Не подключено";
}
