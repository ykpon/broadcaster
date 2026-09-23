export type { Connection, RoomInfo } from "./protocol";
export async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res
    .json()
    .catch(() => ({ error: "Сервер вернул неожиданный ответ" }));
  if (!res.ok) throw new Error(data.error || "Не удалось выполнить запрос");
  return data as T;
}
export function message(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Что-то пошло не так. Попробуйте ещё раз.";
}
