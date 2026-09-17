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
