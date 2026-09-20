export type Resolution = "auto" | "720" | "1080" | "1440" | "2160";
export type VideoCodec = "vp8" | "vp9" | "av1";
export type StreamSettings = {
  resolution: Resolution;
  fps: number;
  videoBitrateMbps: number;
  audioBitrateKbps: number;
  balance: number;
  codec: VideoCodec;
};

export const STREAM_SETTINGS_KEY = "broadcast:stream-settings:v1";
export const DEFAULT_STREAM_SETTINGS: StreamSettings = {
  resolution: "1080",
  fps: 60,
  videoBitrateMbps: 12,
  audioBitrateKbps: 128,
  balance: 35,
  codec: "vp8",
};
export const RESOLUTION_STEPS = [
  { value: "auto", label: "Исходное", width: 3840, height: 2160 },
  { value: "720", label: "720p", width: 1280, height: 720 },
  { value: "1080", label: "1080p", width: 1920, height: 1080 },
  { value: "1440", label: "1440p", width: 2560, height: 1440 },
  { value: "2160", label: "2160p · 4K", width: 3840, height: 2160 },
] as const;
export const SETTING_RANGES = {
  fps: { min: 15, max: 120, step: 5 },
  videoBitrateMbps: { min: 1, max: 80, step: 1 },
  audioBitrateKbps: { min: 32, max: 320, step: 16 },
  balance: { min: 0, max: 100, step: 1 },
} as const;

const isValidNumber = (
  value: unknown,
  range: { min: number; max: number; step: number },
) =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= range.min &&
  value <= range.max &&
  (value - range.min) % range.step === 0;

export function normalizeStreamSettings(value: unknown): StreamSettings {
  if (!value || typeof value !== "object") return DEFAULT_STREAM_SETTINGS;
  const settings = value as Partial<StreamSettings>;
  const resolution = RESOLUTION_STEPS.some(
    (item) => item.value === settings.resolution,
  );
  const codec =
    settings.codec === "vp8" ||
    settings.codec === "vp9" ||
    settings.codec === "av1";
  if (
    !resolution ||
    !codec ||
    !isValidNumber(settings.fps, SETTING_RANGES.fps) ||
    !isValidNumber(
      settings.videoBitrateMbps,
      SETTING_RANGES.videoBitrateMbps,
    ) ||
    !isValidNumber(
      settings.audioBitrateKbps,
      SETTING_RANGES.audioBitrateKbps,
    ) ||
    !isValidNumber(settings.balance, SETTING_RANGES.balance)
  )
    return DEFAULT_STREAM_SETTINGS;
  return settings as StreamSettings;
}

export function loadStreamSettings(storage: Storage): StreamSettings {
  try {
    const raw = storage.getItem(STREAM_SETTINGS_KEY);
    return raw === null
      ? DEFAULT_STREAM_SETTINGS
      : normalizeStreamSettings(JSON.parse(raw));
  } catch {
    return DEFAULT_STREAM_SETTINGS;
  }
}

export function saveStreamSettings(
  storage: Storage,
  settings: StreamSettings,
): void {
  try {
    storage.setItem(STREAM_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Storage may be unavailable or full; settings remain usable for this session.
  }
}

export function qualityHints(balance: number): {
  contentHint: "detail" | "motion";
  degradationPreference: RTCDegradationPreference;
} {
  if (balance < 40)
    return {
      contentHint: "detail",
      degradationPreference: "maintain-resolution",
    };
  if (balance <= 60)
    return { contentHint: "motion", degradationPreference: "balanced" };
  return { contentHint: "motion", degradationPreference: "maintain-framerate" };
}

export function qualityBalanceLabel(balance: number) {
  if (balance < 40) return "Чёткость";
  if (balance <= 60) return "Баланс";
  return "Движение";
}

export function constraints(settings: StreamSettings): MediaTrackConstraints {
  const size = RESOLUTION_STEPS.find(
    (item) => item.value === settings.resolution,
  )!;
  return {
    width: { ideal: size.width, max: size.width },
    height: { ideal: size.height, max: size.height },
    frameRate: { ideal: settings.fps, max: settings.fps },
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
