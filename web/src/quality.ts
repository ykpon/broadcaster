export type Resolution = "auto" | "720" | "1080" | "1440" | "2160";
export type FPS = 30 | 60;
export const resolutions: Record<
  Resolution,
  { label: string; width: number; height: number }
> = {
  auto: { label: "Авто · исходное", width: 3840, height: 2160 },
  "720": { label: "720p · HD", width: 1280, height: 720 },
  "1080": { label: "1080p · Full HD", width: 1920, height: 1080 },
  "1440": { label: "1440p · QHD", width: 2560, height: 1440 },
  "2160": { label: "2160p · 4K", width: 3840, height: 2160 },
};
export function bitrate(res: Resolution, fps: FPS) {
  return Math.round(
    { auto: 14, 720: 2.5, 1080: 5, 1440: 9, 2160: 14 }[res] *
      (fps === 60 ? 25 / 14 : 1) *
      1_000_000,
  );
}
export function constraints(res: Resolution, fps: FPS): MediaTrackConstraints {
  const size = resolutions[res];
  return {
    width: { ideal: size.width, max: size.width },
    height: { ideal: size.height, max: size.height },
    frameRate: { ideal: fps, max: fps },
  };
}
export function captureError(error: unknown) {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError")
      return "Выбор источника отменён или доступ запрещён. Нажмите «Выбрать источник», чтобы попробовать снова.";
    if (error.name === "NotReadableError")
      return "Браузер не смог захватить источник. Для игры попробуйте оконный режим без рамки или весь монитор.";
    if (error.name === "InvalidStateError")
      return "Вернитесь на вкладку студии и снова выберите источник.";
  }
  return error instanceof Error
    ? error.message
    : "Не удалось начать трансляцию";
}
// Chrome offers system audio only on Windows, and only when the user ticks the box in
// the picker; macOS cannot capture it at all. Firefox has no display audio anywhere.
// The browser gives us no way to ask afterwards, so name the surface and let the user act.
export function audioHint(surface: string) {
  if (surface === "browser")
    return "Вкладка молчала при выборе — звук пойдёт, как только в ней заиграет.";
  return "Нет звука: в диалоге выбора включите «Также передать аудио системы». Для всего экрана это работает в Chrome на Windows; на macOS выберите вкладку браузера.";
}

// Stats timestamps are milliseconds, so bits over milliseconds is already kbit/s.
export function kbps(
  bytes: number,
  at: number,
  prev: { bytes: number; at: number },
) {
  return prev.at && at > prev.at
    ? ((bytes - prev.bytes) * 8) / (at - prev.at)
    : 0;
}
// The host cannot hear what viewers hear, so name the two things that decide it:
// a speech-processed capture arrives at 16 kHz mono, and a squeezed uplink shows
// up as a bitrate far below the 128 kbit/s we ask Opus for.
export function soundLabel(
  settings: MediaTrackSettings | undefined,
  rate: number,
  loss = 0,
) {
  const hz = settings?.sampleRate ? `${settings.sampleRate / 1000} кГц` : "—",
    channels =
      settings?.channelCount === 2
        ? "стерео"
        : settings?.channelCount
          ? "моно"
          : "—";
  return `${hz} · ${channels} · ${Math.round(rate)} кбит/с · потери ${(loss * 100).toFixed(1)}%`;
}
// Opus rebuilds lost packets from a band-limited FEC copy, so steady loss is heard as
// dull audio long before it is heard as dropouts. The encoder reports why it is holding
// back, which separates a saturated uplink from a CPU that cannot keep up with 4K.
const limits: Record<string, string> = {
  bandwidth: "сеть",
  cpu: "CPU",
  other: "другое",
};
export function limitLabel(reason?: string) {
  const name = limits[reason ?? ""];
  return name ? ` · упирается в ${name}` : "";
}
