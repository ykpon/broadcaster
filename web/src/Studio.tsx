import { useEffect, useRef, useState } from "react";
import {
  Monitor,
  Check,
  Volume2,
  VolumeX,
  Users,
  Wifi,
  Square,
  Settings2,
  ChevronLeft,
  ExternalLink,
  ShieldCheck,
  Layers,
  Loader2,
  ArrowUpRight,
  Link2,
} from "lucide-react";
import { Header, ErrorBox, CopyButton, Scene } from "./shared";
import { useRoomInfo, roomStateLabel } from "./room";
import { api, message } from "./api";
import {
  RESOLUTION_STEPS,
  SETTING_RANGES,
  captureError,
  audioHint,
  qualityBalanceLabel,
  type StreamSettings,
} from "./quality";
import { applyQuality, displayCaptureOptions } from "./media";
import { createControlSocket, type ControlSocket } from "./controlSocket";
import type { StartResponse } from "./protocol";
import {
  createLiveKitPublisher,
  type PublisherQualityUpdateResult,
  type StudioPublisher,
  type RTCStatsProvider,
} from "./studioTransport";
import {
  formatLimitation,
  formatMetric,
  parseOutboundStats,
  streamHealth,
  type CounterSample,
  type StreamMetrics,
} from "./stats";
import {
  createLatestSettingsUpdater,
  createStatsSessionGuard,
  formatCaptureFrameRate,
  loadStreamSettingsSafely,
  saveStreamSettingsSafely,
} from "./studioRuntime";

type NumericSetting =
  "fps" | "videoBitrateMbps" | "audioBitrateKbps" | "balance";
const sameSettings = (left: StreamSettings, right: StreamSettings) =>
  left.resolution === right.resolution &&
  left.fps === right.fps &&
  left.videoBitrateMbps === right.videoBitrateMbps &&
  left.audioBitrateKbps === right.audioBitrateKbps &&
  left.balance === right.balance &&
  left.codec === right.codec;

export default function Studio({ id }: { id: string }) {
  const { info, error: infoError } = useRoomInfo(id);
  const [secret] = useState(
    () => new URLSearchParams(location.hash.slice(1)).get("key") || "",
  );
  const [settings, setSettings] = useState<StreamSettings>(() =>
      loadStreamSettingsSafely(() => window.localStorage),
    ),
    [appliedSettings, setAppliedSettings] = useState(settings),
    [busy, setBusy] = useState(false),
    [qualityBusy, setQualityBusy] = useState(false),
    [live, setLive] = useState(false),
    [hasBroadcast, setHasBroadcast] = useState(false),
    [ended, setEnded] = useState(false),
    [error, setError] = useState(""),
    [note, setNote] = useState(""),
    [muted, setMuted] = useState(false),
    [hasAudio, setHasAudio] = useState(false),
    [surface, setSurface] = useState(""),
    [state, setState] = useState("disconnected"),
    [captureVideo, setCaptureVideo] = useState(""),
    [captureAudio, setCaptureAudio] = useState(""),
    [videoMetrics, setVideoMetrics] = useState<StreamMetrics>({}),
    [audioMetrics, setAudioMetrics] = useState<StreamMetrics>({}),
    [elapsed, setElapsed] = useState(0);
  const publisherRef = useRef<StudioPublisher | null>(null),
    controlRef = useRef<ControlSocket | null>(null),
    generationRef = useRef<number | null>(null),
    streamRef = useRef<MediaStream | null>(null),
    confirmedSettings = useRef(settings),
    preview = useRef<HTMLVideoElement>(null),
    started = useRef(0),
    ending = useRef(false),
    stopping = useRef(false),
    previousVideoSample = useRef<CounterSample | undefined>(undefined),
    previousAudioSample = useRef<CounterSample | undefined>(undefined),
    mounted = useRef(true);
  const statsSessionGuard = useRef(
    createStatsSessionGuard<RTCStatsProvider | undefined>(),
  ).current;
  const [settingsUpdater] = useState(() =>
    createLatestSettingsUpdater<StreamSettings, PublisherQualityUpdateResult>({
      apply: (next) => {
        const publisher = publisherRef.current;
        if (!publisher) return Promise.reject(new Error("Эфир завершён"));
        return publisher.updateSettings(confirmedSettings.current, next);
      },
      rollback: (confirmed, failed) => {
        const publisher = publisherRef.current;
        if (!publisher) return Promise.resolve();
        return publisher.updateSettings(failed, confirmed);
      },
      readConfirmed: () => confirmedSettings.current,
      equals: sameSettings,
      onBusy: setQualityBusy,
      onStart: () => setError(""),
      onApplied: (next) => {
        confirmedSettings.current = next;
        setAppliedSettings(next);
      },
      onSuccess: (_next, result) => setNote(result.note),
      onFailure: (failure, confirmed, shouldRestoreDraft) => {
        if (shouldRestoreDraft) setSettings(confirmed);
        setError(`Не удалось изменить качество: ${message(failure)}`);
      },
    }),
  );
  const viewerURL = `${location.origin}/watch/${id}`;

  function resetStats() {
    statsSessionGuard.invalidate();
    previousVideoSample.current = undefined;
    previousAudioSample.current = undefined;
    setVideoMetrics({});
    setAudioMetrics({});
  }

  function resetDiagnostics() {
    resetStats();
    setCaptureVideo("");
    setCaptureAudio("");
  }

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      settingsUpdater.cancel();
      streamRef.current?.getTracks().forEach((t) => {
        t.onended = null;
        t.stop();
      });
      controlRef.current?.close();
      void publisherRef.current?.stop();
      publisherRef.current = null;
    };
  }, []);
  useEffect(() => {
    saveStreamSettingsSafely(() => window.localStorage, settings);
  }, [settings]);
  useEffect(() => {
    if (info?.state === "ended") {
      settingsUpdater.cancel();
      setEnded(true);
      setLive(false);
      resetDiagnostics();
      streamRef.current?.getTracks().forEach((t) => {
        t.onended = null;
        t.stop();
      });
      controlRef.current?.close();
      controlRef.current = null;
      void publisherRef.current?.stop();
      publisherRef.current = null;
    }
  }, [info?.state]);
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - started.current) / 1000));
      const stream = streamRef.current;
      const videoCapture = stream?.getVideoTracks()[0]?.getSettings();
      if (videoCapture)
        setCaptureVideo(
          `${videoCapture.width ?? "—"} × ${videoCapture.height ?? "—"} · ${formatCaptureFrameRate(videoCapture.frameRate)}`,
        );
      const audioCapture = stream?.getAudioTracks()[0]?.getSettings();
      if (audioCapture)
        setCaptureAudio(
          `${audioCapture.sampleRate ? `${audioCapture.sampleRate / 1000} кГц` : "—"} · ${audioCapture.channelCount === 2 ? "стерео" : audioCapture.channelCount ? "моно" : "—"}`,
        );

      const sources = publisherRef.current?.getStatsSources();
      if (!sources?.video) return;
      const video = sources.video;
      const videoRead = statsSessionGuard.capture(video);
      if (videoRead)
        void video
          .getStats()
          .then((report) => {
            if (!report || !mounted.current) {
              statsSessionGuard.release(videoRead);
              return;
            }
            if (
              !statsSessionGuard.commit(
                videoRead,
                publisherRef.current?.getStatsSources().video,
              )
            )
              return;
            const parsed = parseOutboundStats(
              Array.from(report.values()),
              previousVideoSample.current,
            );
            previousVideoSample.current = parsed.sample;
            setVideoMetrics(parsed.metrics);
          })
          .catch(() => statsSessionGuard.release(videoRead));
      if (sources.audio) {
        const audio = sources.audio;
        const audioRead = statsSessionGuard.capture(audio);
        if (audioRead)
          void audio
            .getStats()
            .then((report) => {
              if (!report || !mounted.current) {
                statsSessionGuard.release(audioRead);
                return;
              }
              if (
                !statsSessionGuard.commit(
                  audioRead,
                  publisherRef.current?.getStatsSources().audio,
                )
              )
                return;
              const parsed = parseOutboundStats(
                Array.from(report.values()),
                previousAudioSample.current,
              );
              previousAudioSample.current = parsed.sample;
              setAudioMetrics(parsed.metrics);
            })
            .catch(() => statsSessionGuard.release(audioRead));
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [live]);
  async function stopPublishing() {
    setLive(false);
    await settingsUpdater.settleAndCancel();
    const publisher = publisherRef.current;
    publisherRef.current = null;
    const control = controlRef.current;
    controlRef.current = null;
    const stream = streamRef.current;
    streamRef.current = null;
    resetDiagnostics();
    control?.close();
    stream?.getTracks().forEach((t) => {
      t.onended = null;
    });
    try {
      await publisher?.stop();
    } finally {
      stream?.getTracks().forEach((t) => t.stop());
      if (preview.current) preview.current.srcObject = null;
      setState("disconnected");
    }
  }
  async function pause() {
    if (ending.current || stopping.current || !publisherRef.current) return;
    stopping.current = true;
    setBusy(true);
    setError("");
    const generation = generationRef.current;
    try {
      await stopPublishing();
    } catch (e) {
      setError(message(e));
    } finally {
      if (generation !== null) {
        try {
          await api(`/rooms/${id}/stop`, { hostSecret: secret, generation });
        } catch (e) {
          setError(message(e));
        }
      }
      generationRef.current = null;
      stopping.current = false;
      setBusy(false);
    }
  }
  async function finish() {
    if (ending.current) return;
    ending.current = true;
    setBusy(true);
    await stopPublishing().catch(() => {});
    generationRef.current = null;
    try {
      await api(`/rooms/${id}/end`, { hostSecret: secret });
      setEnded(true);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
      ending.current = false;
    }
  }
  async function start() {
    if (busy || publisherRef.current || ending.current || stopping.current)
      return;
    settingsUpdater.cancel();
    setError("");
    setNote("");
    setBusy(true);
    resetDiagnostics();
    let stream: MediaStream | null = null;
    let response: StartResponse | null = null;
    try {
      if (!secret)
        throw new Error(
          "В ссылке нет ключа ведущего. Откройте полную ссылку студии.",
        );
      if (!window.isSecureContext || !navigator.mediaDevices?.getDisplayMedia)
        throw new Error(
          "Захват экрана требует HTTPS или localhost и поддерживаемый настольный браузер.",
        );
      // Capture first, while the click still provides user activation.
      stream = await navigator.mediaDevices.getDisplayMedia(
        displayCaptureOptions(),
      );
      if (!mounted.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      setNote(await applyQuality(stream.getVideoTracks()[0], settings));
      streamRef.current = stream;
      response = await api<StartResponse>(`/rooms/${id}/start`, {
        hostSecret: secret,
        transport: "server",
        viewerLimit: "10",
      });
      if (response.transport !== "server")
        throw new Error("Сервер выбрал неожиданный режим трансляции");
      generationRef.current = response.generation;
      if (!mounted.current) {
        await api(`/rooms/${id}/stop`, {
          hostSecret: secret,
          generation: response.generation,
        }).catch(() => {});
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const generation = response.generation;
      let published = false;
      let statsVideo: RTCStatsProvider | undefined;
      const publisher = createLiveKitPublisher({
        onConnectionState: (current, next) => {
          if (
            mounted.current &&
            publisherRef.current === publisher &&
            current === generation
          )
            setState(next);
        },
        onDisconnected: (current) => {
          if (
            !published ||
            !mounted.current ||
            publisherRef.current !== publisher ||
            current !== generation ||
            ending.current ||
            stopping.current
          )
            return;
          void pause().then(() => {
            if (mounted.current && !publisherRef.current)
              setError(
                "Соединение прервано. Повторите запуск; убедитесь, что студия не открыта в другой вкладке.",
              );
          });
        },
        onPublishedTracksChanged: (current, sources) => {
          if (publisherRef.current !== publisher || current !== generation)
            return;
          if (statsVideo && statsVideo !== sources.video) resetStats();
          statsVideo = sources.video;
        },
      });
      publisherRef.current = publisher;
      const control = createControlSocket({
        roomId: id,
        getTicket: async () =>
          (
            await api<{ ticket: string }>(`/rooms/${id}/signal-ticket`, {
              hostSecret: secret,
              generation,
            })
          ).ticket,
        onSignal: (signal) => {
          if (
            publisherRef.current !== publisher ||
            generationRef.current !== generation
          )
            return;
          if (signal.type === "room-ended") void stopPublishing();
        },
        onFatal: (failure) => {
          if (publisherRef.current === publisher && mounted.current) {
            void pause().then(() => {
              if (mounted.current && !publisherRef.current)
                setError(message(failure));
            });
          }
        },
      });
      controlRef.current = control;
      control.connect(response.ticket);
      await publisher.start({
        generation,
        stream,
        settings,
        livekit: response.livekit,
        send: control.send,
      });
      if (!mounted.current || publisherRef.current !== publisher) return;
      published = true;
      control.send({ type: "broadcast-ready", generation });
      confirmedSettings.current = settings;
      setAppliedSettings(settings);
      setHasAudio(stream.getAudioTracks().length > 0);
      setSurface(stream.getVideoTracks()[0].getSettings().displaySurface || "");
      setMuted(false);
      stream.getVideoTracks()[0].onended = () => {
        void pause();
      };
      setLive(true);
      setHasBroadcast(true);
      started.current = Date.now();
      setElapsed(0);
      if (preview.current) {
        preview.current.srcObject = stream;
        void preview.current.play().catch(() => {});
      }
    } catch (e) {
      settingsUpdater.cancel();
      await stopPublishing().catch(() => {});
      if (response) {
        await api(`/rooms/${id}/stop`, {
          hostSecret: secret,
          generation: response.generation,
        }).catch(() => {});
      }
      generationRef.current = null;
      if (mounted.current) setError(captureError(e));
    } finally {
      setBusy(false);
    }
  }
  function commitSettings(next: StreamSettings) {
    setSettings(next);
    if (stopping.current || !publisherRef.current || !live) {
      confirmedSettings.current = next;
      return;
    }
    void settingsUpdater.enqueue(next);
  }

  const draftNumber = (key: NumericSetting, value: string) => ({
    ...settings,
    [key]: Number(value),
  });
  const commitNumber = (key: NumericSetting, value: string) =>
    commitSettings(draftNumber(key, value));
  const draftResolution = (value: string): StreamSettings => ({
    ...settings,
    resolution: RESOLUTION_STEPS[Number(value)]?.value ?? settings.resolution,
  });
  const resolutionIndex = Math.max(
    0,
    RESOLUTION_STEPS.findIndex((item) => item.value === settings.resolution),
  );
  const encodedVideo =
    videoMetrics.width !== undefined || videoMetrics.height !== undefined
      ? `${formatMetric(videoMetrics.width)} × ${formatMetric(videoMetrics.height)} · ${formatMetric(videoMetrics.fps, " FPS")}`
      : "—";
  const balanceLabel = qualityBalanceLabel(settings.balance);
  const isEnded = ended || info?.state === "ended";
  return (
    <div className="app">
      <Header>
        <span className="pill">
          <ShieldCheck size={14} /> Студия ведущего
        </span>
      </Header>
      <main className="room-page">
        <div className="page-heading">
          <div>
            <a className="back" href="/">
              <ChevronLeft size={14} /> На главную
            </a>
            <h1>
              Ваша студия<span className="heading-dot">.</span>
            </h1>
            <p>Один источник. Все свои — рядом.</p>
          </div>
          <span className={`status-pill ${live ? "on" : ""}`}>
            <span className="dot" />
            {isEnded
              ? "Эфир завершён"
              : live
                ? "В прямом эфире"
                : "Готовы к эфиру"}
          </span>
        </div>
        <div className="studio-grid">
          <div className="video-column">
            <div className="player">
              <div className="player-top">
                <span>
                  <Monitor size={15} /> ПРЕДПРОСМОТР
                </span>
                <span>
                  {live
                    ? `${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(elapsed % 60).padStart(2, "0")}`
                    : "— : —"}
                </span>
              </div>
              <div className="video-stage">
                <video
                  ref={preview}
                  autoPlay
                  muted
                  playsInline
                  className={live ? "" : "invisible"}
                />
                {!live && (
                  <Scene
                    title={
                      isEnded
                        ? "Хороший эфир. До следующего!"
                        : hasBroadcast
                          ? "Готовы продолжить?"
                          : "Что покажем сегодня?"
                    }
                    subtitle={
                      isEnded
                        ? "Трансляция завершена для всех зрителей."
                        : hasBroadcast
                          ? "Настройки сохранены. Выберите источник для нового запуска."
                          : "Выберите экран, окно приложения или вкладку браузера."
                    }
                    icon={isEnded ? <Check size={36} /> : undefined}
                  >
                    {!isEnded && (
                      <button
                        className="button primary"
                        disabled={busy || !secret}
                        onClick={start}
                      >
                        {busy ? (
                          <Loader2 size={18} className="spin" />
                        ) : (
                          <Monitor size={18} />
                        )}{" "}
                        {busy
                          ? hasBroadcast
                            ? "Подготавливаем запуск…"
                            : "Подключаем источник…"
                          : hasBroadcast
                            ? "Запустить снова"
                            : "Выбрать источник"}
                      </button>
                    )}
                    {isEnded && (
                      <a className="button primary" href="/">
                        Создать новый эфир <ArrowUpRight size={16} />
                      </a>
                    )}
                  </Scene>
                )}
              </div>
              <div className="player-bottom">
                <span>
                  <Wifi size={15} />
                  {roomStateLabel(state)}
                </span>
                <span>
                  <Users size={15} />
                  {info?.viewers || 0} / 10 зрителей
                </span>
              </div>
            </div>
            <ErrorBox
              error={
                error ||
                infoError ||
                (!secret
                  ? "Откройте ссылку ведущего целиком, включая #key=…"
                  : "")
              }
            />
            {note && <div className="notice">{note}</div>}
            <div className="source-help">
              <Layers size={20} />
              <p>
                <strong>Играете? Можно показать и игру.</strong>
                <br />
                Выберите окно игры или весь монитор. Если изображение чёрное,
                попробуйте оконный режим без рамки. Звук доступен, если его
                поддерживает выбранный источник.
              </p>
            </div>
          </div>
          <aside className="studio-sidebar">
            <section className="panel" aria-busy={qualityBusy}>
              <div className="panel-title">
                <Settings2 size={18} />
                <h2>Настройки эфира</h2>
              </div>
              <div className="range-control">
                <div className="range-heading">
                  <label htmlFor="resolution">Разрешение</label>
                  <span className="range-value">
                    {RESOLUTION_STEPS[resolutionIndex].label}
                  </span>
                </div>
                <input
                  id="resolution"
                  type="range"
                  min="0"
                  max={RESOLUTION_STEPS.length - 1}
                  step="1"
                  value={resolutionIndex}
                  disabled={(busy && !live) || isEnded}
                  onChange={(event) =>
                    setSettings(draftResolution(event.currentTarget.value))
                  }
                  onPointerUp={(event) =>
                    void commitSettings(
                      draftResolution(event.currentTarget.value),
                    )
                  }
                  onKeyUp={(event) =>
                    void commitSettings(
                      draftResolution(event.currentTarget.value),
                    )
                  }
                  onBlur={(event) =>
                    void commitSettings(
                      draftResolution(event.currentTarget.value),
                    )
                  }
                />
                <div className="range-scale">
                  <span>Исходное</span>
                  <span>4K</span>
                </div>
              </div>
              <div className="range-control">
                <div className="range-heading">
                  <label htmlFor="fps">Частота кадров</label>
                  <span className="range-value">{settings.fps} FPS</span>
                </div>
                <input
                  id="fps"
                  type="range"
                  {...SETTING_RANGES.fps}
                  value={settings.fps}
                  disabled={(busy && !live) || isEnded}
                  onChange={(event) =>
                    setSettings(draftNumber("fps", event.currentTarget.value))
                  }
                  onPointerUp={(event) =>
                    void commitNumber("fps", event.currentTarget.value)
                  }
                  onKeyUp={(event) =>
                    void commitNumber("fps", event.currentTarget.value)
                  }
                  onBlur={(event) =>
                    void commitNumber("fps", event.currentTarget.value)
                  }
                />
                <div className="range-scale">
                  <span>15</span>
                  <span>120 FPS</span>
                </div>
              </div>
              <div className="range-control">
                <div className="range-heading">
                  <label htmlFor="video-bitrate">Видеобитрейт</label>
                  <span className="range-value">
                    {settings.videoBitrateMbps} Мбит/с
                  </span>
                </div>
                <input
                  id="video-bitrate"
                  type="range"
                  {...SETTING_RANGES.videoBitrateMbps}
                  value={settings.videoBitrateMbps}
                  disabled={(busy && !live) || isEnded}
                  onChange={(event) =>
                    setSettings(
                      draftNumber(
                        "videoBitrateMbps",
                        event.currentTarget.value,
                      ),
                    )
                  }
                  onPointerUp={(event) =>
                    void commitNumber(
                      "videoBitrateMbps",
                      event.currentTarget.value,
                    )
                  }
                  onKeyUp={(event) =>
                    void commitNumber(
                      "videoBitrateMbps",
                      event.currentTarget.value,
                    )
                  }
                  onBlur={(event) =>
                    void commitNumber(
                      "videoBitrateMbps",
                      event.currentTarget.value,
                    )
                  }
                />
                <div className="range-scale">
                  <span>1</span>
                  <span>80 Мбит/с</span>
                </div>
              </div>
              <div className="range-control">
                <div className="range-heading">
                  <label htmlFor="audio-bitrate">Аудиобитрейт</label>
                  <span className="range-value">
                    {settings.audioBitrateKbps} кбит/с
                  </span>
                </div>
                <input
                  id="audio-bitrate"
                  type="range"
                  {...SETTING_RANGES.audioBitrateKbps}
                  value={settings.audioBitrateKbps}
                  disabled={(busy && !live) || isEnded}
                  onChange={(event) =>
                    setSettings(
                      draftNumber(
                        "audioBitrateKbps",
                        event.currentTarget.value,
                      ),
                    )
                  }
                  onPointerUp={(event) =>
                    void commitNumber(
                      "audioBitrateKbps",
                      event.currentTarget.value,
                    )
                  }
                  onKeyUp={(event) =>
                    void commitNumber(
                      "audioBitrateKbps",
                      event.currentTarget.value,
                    )
                  }
                  onBlur={(event) =>
                    void commitNumber(
                      "audioBitrateKbps",
                      event.currentTarget.value,
                    )
                  }
                />
                <div className="range-scale">
                  <span>32</span>
                  <span>320 кбит/с</span>
                </div>
              </div>
              <div className="range-control">
                <div className="range-heading">
                  <label htmlFor="balance">Баланс качества</label>
                  <span className="range-value">
                    {settings.balance}% · {balanceLabel}
                  </span>
                </div>
                <input
                  id="balance"
                  type="range"
                  {...SETTING_RANGES.balance}
                  value={settings.balance}
                  disabled={(busy && !live) || isEnded}
                  onChange={(event) =>
                    setSettings(
                      draftNumber("balance", event.currentTarget.value),
                    )
                  }
                  onPointerUp={(event) =>
                    void commitNumber("balance", event.currentTarget.value)
                  }
                  onKeyUp={(event) =>
                    void commitNumber("balance", event.currentTarget.value)
                  }
                  onBlur={(event) =>
                    void commitNumber("balance", event.currentTarget.value)
                  }
                />
                <div className="range-scale quality-balance-scale">
                  {(["Чёткость", "Баланс", "Движение"] as const).map(
                    (label) => (
                      <span
                        key={label}
                        className={balanceLabel === label ? "active" : ""}
                      >
                        {label}
                      </span>
                    ),
                  )}
                </div>
              </div>
              <label htmlFor="codec">Кодек</label>
              <select
                id="codec"
                value={settings.codec}
                disabled={busy || live || isEnded}
                onChange={(event) =>
                  void commitSettings({
                    ...settings,
                    codec: event.currentTarget.value as StreamSettings["codec"],
                  })
                }
              >
                <option value="vp8">VP8</option>
                <option value="vp9">VP9</option>
                <option value="av1">AV1</option>
              </select>
              <div className="separator" />
              <div className="audio-row">
                <div>
                  <strong>Звук источника</strong>
                  <small>
                    {live
                      ? audioHint(surface, hasAudio)
                      : "Источник звука определяется выбранной вкладкой, окном или экраном"}
                  </small>
                </div>
                <button
                  className={`icon-button ${muted ? "" : "active"}`}
                  aria-label={
                    muted
                      ? "Включить звук источника"
                      : "Выключить звук источника"
                  }
                  disabled={!live || !hasAudio}
                  onClick={() => {
                    const publisher = publisherRef.current;
                    if (!publisher) return;
                    const next = !muted;
                    void publisher
                      .setMuted(next)
                      .then(() => {
                        if (publisherRef.current === publisher) setMuted(next);
                      })
                      .catch((failure) => {
                        if (publisherRef.current === publisher)
                          setError(message(failure));
                      });
                  }}
                >
                  {muted || !hasAudio ? (
                    <VolumeX size={19} />
                  ) : (
                    <Volume2 size={19} />
                  )}
                </button>
              </div>
            </section>
            {live && (
              <section className="panel diagnostics">
                <h2>Диагностика отправки</h2>
                <div className="metric-group">
                  <h3>Видео</h3>
                  <span className="metric-row">
                    Состояние <strong>{streamHealth(videoMetrics)}</strong>
                  </span>
                  <span className="metric-row">
                    Ограничение
                    <strong>{formatLimitation(videoMetrics.limitation)}</strong>
                  </span>
                  <span className="metric-row">
                    Кодек <strong>{videoMetrics.codec ?? "—"}</strong>
                  </span>
                  <span className="metric-row">
                    Битрейт{" "}
                    <strong>
                      {formatMetric(videoMetrics.bitrateKbps, " кбит/с")}
                    </strong>
                  </span>
                  <span className="metric-row">
                    Предел{" "}
                    <strong>{appliedSettings.videoBitrateMbps} Мбит/с</strong>
                  </span>
                  <span className="metric-row">
                    Захват <strong>{captureVideo || "—"}</strong>
                  </span>
                  <span className="metric-row">
                    Кодирование <strong>{encodedVideo}</strong>
                  </span>
                  <span className="metric-row">
                    <span>Пакеты отправлены</span>
                    <strong>{formatMetric(videoMetrics.packets)}</strong>
                  </span>
                  <span className="metric-row">
                    Потеряно{" "}
                    <strong>{formatMetric(videoMetrics.packetsLost)}</strong>
                  </span>
                  <span className="metric-row">
                    Потери{" "}
                    <strong>
                      {formatMetric(videoMetrics.lossPercent, "%")}
                    </strong>
                  </span>
                  <span className="metric-row">
                    Повторно отправлено{" "}
                    <strong>
                      {formatMetric(videoMetrics.retransmittedPackets)}
                    </strong>
                  </span>
                  <span className="metric-row">
                    RTT{" "}
                    <strong>{formatMetric(videoMetrics.rttMs, " мс")}</strong>
                  </span>
                </div>
                <div className="metric-group">
                  <h3>Аудио</h3>
                  <span className="metric-row">
                    Состояние аудио{" "}
                    <strong>{streamHealth(audioMetrics)}</strong>
                  </span>
                  <span className="metric-row">
                    Аудиокодек <strong>{audioMetrics.codec ?? "—"}</strong>
                  </span>
                  <span className="metric-row">
                    Аудиобитрейт{" "}
                    <strong>
                      {formatMetric(audioMetrics.bitrateKbps, " кбит/с")}
                    </strong>
                  </span>
                  <span className="metric-row">
                    Предел аудио{" "}
                    <strong>{appliedSettings.audioBitrateKbps} кбит/с</strong>
                  </span>
                  <span className="metric-row">
                    Захват аудио <strong>{captureAudio || "—"}</strong>
                  </span>
                  <span className="metric-row">
                    Пакеты аудио{" "}
                    <strong>{formatMetric(audioMetrics.packets)}</strong>
                  </span>
                  <span className="metric-row">
                    Потеряно аудио{" "}
                    <strong>{formatMetric(audioMetrics.packetsLost)}</strong>
                  </span>
                  <span className="metric-row">
                    Потери аудио{" "}
                    <strong>
                      {formatMetric(audioMetrics.lossPercent, "%")}
                    </strong>
                  </span>
                  <span className="metric-row">
                    Повторно отправлено аудио{" "}
                    <strong>
                      {formatMetric(audioMetrics.retransmittedPackets)}
                    </strong>
                  </span>
                  <span className="metric-row">
                    RTT аудио{" "}
                    <strong>{formatMetric(audioMetrics.rttMs, " мс")}</strong>
                  </span>
                </div>
              </section>
            )}
            <section className="panel share-panel">
              <div className="panel-title">
                <Link2 size={18} />
                <h2>Позовите своих</h2>
              </div>
              <p>
                Эта ссылка — для зрителей.
                <br />
                Ссылку студии оставьте себе.
              </p>
              <input
                aria-label="Ссылка для зрителей"
                readOnly
                value={viewerURL}
                onFocus={(e) => e.target.select()}
              />
              <CopyButton value={viewerURL} />
              <a
                className="text-link"
                href={viewerURL}
                target="_blank"
                rel="noreferrer"
              >
                Открыть просмотр <ExternalLink size={13} />
              </a>
            </section>
            {!isEnded && (
              <div className="room-actions">
                {live && (
                  <button
                    className="button danger"
                    disabled={busy}
                    onClick={() => void pause()}
                  >
                    <Square size={15} /> Остановить трансляцию
                  </button>
                )}
                <button
                  className="button secondary close-room"
                  disabled={busy}
                  onClick={() => void finish()}
                >
                  Закрыть комнату
                </button>
              </div>
            )}
            <p className="sidebar-footnote">
              Ваше превью всегда без звука,
              <br />
              чтобы не возникало эхо.
            </p>
          </aside>
        </div>
      </main>
      <footer>
        Пространство для ваших моментов.<span>эфир.</span>
      </footer>
    </div>
  );
}
