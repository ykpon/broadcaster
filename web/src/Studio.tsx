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
import {
  normalizeViewerLimit,
  type BroadcastConfig,
  type TransportMode,
} from "./protocol";
import {
  createLiveKitPublisher,
  type PublisherQualityUpdateResult,
  type StudioPublisher,
  type RTCStatsProvider,
} from "./studioTransport";
import { createP2PPublisher, type P2PSignaling } from "./p2pPublisher";
import {
  formatLimitation,
  formatMetric,
  streamHealth,
  type CounterSample,
  type StreamMetrics,
} from "./stats";
import {
  createLatestSettingsUpdater,
  createStatsSessionGuard,
  formatCaptureFrameRate,
  loadBroadcastConfigSafely,
  loadStreamSettingsSafely,
  readPublisherMetrics,
  saveBroadcastConfigSafely,
  saveStreamSettingsSafely,
  startStudioBroadcast,
  stopStudioBroadcast,
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
type ActivePublisher = StudioPublisher & Partial<P2PSignaling>;
const transportLabel = (transport: TransportMode) =>
  transport === "p2p" ? "P2P — напрямую" : "Через сервер";

export default function Studio({ id }: { id: string }) {
  const { info, error: infoError } = useRoomInfo(id);
  const [secret] = useState(
    () => new URLSearchParams(location.hash.slice(1)).get("key") || "",
  );
  const [settings, setSettings] = useState<StreamSettings>(() =>
      loadStreamSettingsSafely(() => window.localStorage),
    ),
    [broadcastConfig, setBroadcastConfig] = useState<BroadcastConfig>(() =>
      loadBroadcastConfigSafely(() => window.localStorage),
    ),
    [activeConfig, setActiveConfig] = useState<BroadcastConfig | null>(null),
    [limitError, setLimitError] = useState(""),
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
    [peerCounts, setPeerCounts] = useState({ connected: 0, failed: 0 }),
    [elapsed, setElapsed] = useState(0);
  const publisherRef = useRef<ActivePublisher | null>(null),
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
    startAttempt = useRef(0),
    cancelControlAuthentication = useRef<(() => void) | null>(null),
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
      startAttempt.current += 1;
      cancelControlAuthentication.current?.();
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
      startAttempt.current += 1;
      cancelControlAuthentication.current?.();
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
        void readPublisherMetrics(video, previousVideoSample.current)
          .then((result) => {
            if (!mounted.current) {
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
            previousVideoSample.current = result.sample;
            setVideoMetrics(result.metrics);
          })
          .catch(() => statsSessionGuard.release(videoRead));
      if (sources.audio) {
        const audio = sources.audio;
        const audioRead = statsSessionGuard.capture(audio);
        if (audioRead)
          void readPublisherMetrics(audio, previousAudioSample.current)
            .then((result) => {
              if (!mounted.current) {
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
              previousAudioSample.current = result.sample;
              setAudioMetrics(result.metrics);
            })
            .catch(() => statsSessionGuard.release(audioRead));
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [live]);
  async function stopPublishing(
    stopGeneration: () => Promise<unknown> = async () => {},
  ) {
    setLive(false);
    startAttempt.current += 1;
    cancelControlAuthentication.current?.();
    cancelControlAuthentication.current = null;
    await settingsUpdater.settleAndCancel();
    const publisher = publisherRef.current;
    publisherRef.current = null;
    const control = controlRef.current;
    controlRef.current = null;
    const stream = streamRef.current;
    streamRef.current = null;
    generationRef.current = null;
    resetDiagnostics();
    setActiveConfig(null);
    setPeerCounts({ connected: 0, failed: 0 });
    stream?.getTracks().forEach((t) => {
      t.onended = null;
    });
    try {
      await stopStudioBroadcast({
        stopPublisher: async () => {
          control?.close();
          try {
            await publisher?.stop();
          } finally {
            stream?.getTracks().forEach((t) => t.stop());
          }
        },
        stopGeneration: async () => {
          await stopGeneration();
        },
      });
    } finally {
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
      await stopPublishing(async () => {
        if (generation !== null)
          await api(`/rooms/${id}/stop`, {
            hostSecret: secret,
            generation,
          });
      });
    } catch (e) {
      setError(message(e));
    } finally {
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
    const viewerLimit = normalizeViewerLimit(broadcastConfig.viewerLimit);
    if (viewerLimit === null) {
      setLimitError("Введите положительное целое число без пробелов.");
      return;
    }
    setLimitError("");
    settingsUpdater.cancel();
    setError("");
    setNote("");
    setBusy(true);
    resetDiagnostics();
    setPeerCounts({ connected: 0, failed: 0 });
    const attempt = ++startAttempt.current;
    let createdPublisher: ActivePublisher | null = null;
    let createdControl: ControlSocket | null = null;
    let published = false;
    try {
      if (!secret)
        throw new Error(
          "В ссылке нет ключа ведущего. Откройте полную ссылку студии.",
        );
      if (!window.isSecureContext || !navigator.mediaDevices?.getDisplayMedia)
        throw new Error(
          "Захват экрана требует HTTPS или localhost и поддерживаемый настольный браузер.",
        );
      const result = await startStudioBroadcast({
        transport: broadcastConfig.transport,
        viewerLimit,
        settings,
        // Capture stays first so the click retains browser user activation.
        capture: () =>
          navigator.mediaDevices.getDisplayMedia(displayCaptureOptions()),
        prepareCapture: async (stream) => {
          setNote(await applyQuality(stream.getVideoTracks()[0], settings));
        },
        startGeneration: (config) =>
          api(`/rooms/${id}/start`, { hostSecret: secret, ...config }),
        stopGeneration: (generation) =>
          api(`/rooms/${id}/stop`, {
            hostSecret: secret,
            generation,
          }),
        isCurrent: () =>
          mounted.current &&
          startAttempt.current === attempt &&
          !ending.current &&
          !stopping.current,
        createPublisher: (transport, response) => {
          const generation = response.generation;
          let statsVideo: RTCStatsProvider | undefined;
          const callbacks = {
            onConnectionState: (
              current: number,
              next: Parameters<typeof setState>[0],
            ) => {
              if (
                mounted.current &&
                publisherRef.current === createdPublisher &&
                current === generation
              )
                setState(next);
            },
            onDisconnected: (current: number) => {
              if (
                !published ||
                !mounted.current ||
                publisherRef.current !== createdPublisher ||
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
            onPublishedTracksChanged: (
              current: number,
              sources: ReturnType<StudioPublisher["getStatsSources"]>,
            ) => {
              if (
                publisherRef.current !== createdPublisher ||
                current !== generation
              )
                return;
              if (statsVideo && statsVideo !== sources.video) resetStats();
              statsVideo = sources.video;
            },
            onPeerCountsChanged: (
              current: number,
              connected: number,
              failed: number,
            ) => {
              if (
                publisherRef.current === createdPublisher &&
                current === generation
              )
                setPeerCounts({ connected, failed });
            },
          };
          createdPublisher =
            transport === "p2p"
              ? createP2PPublisher(callbacks)
              : createLiveKitPublisher(callbacks);
          publisherRef.current = createdPublisher;
          generationRef.current = generation;
          return createdPublisher;
        },
        connectControl: ({ response, publisher, handleSignal }) => {
          const generation = response.generation;
          let authenticated = false;
          let resolveAuthenticated!: () => void;
          let rejectAuthenticated!: (error: unknown) => void;
          const authenticatedPromise = new Promise<void>((resolve, reject) => {
            resolveAuthenticated = resolve;
            rejectAuthenticated = reject;
          });
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
              if (signal.type === "authenticated") {
                authenticated = true;
                cancelControlAuthentication.current = null;
                resolveAuthenticated();
                return;
              }
              if (signal.type === "room-ended") {
                void stopPublishing();
                return;
              }
              void handleSignal(signal).catch((failure: unknown) => {
                if (publisherRef.current === publisher && mounted.current)
                  setError(message(failure));
              });
            },
            onFatal: (failure) => {
              if (!authenticated) {
                rejectAuthenticated(failure);
                return;
              }
              if (publisherRef.current === publisher && mounted.current) {
                void pause().then(() => {
                  if (mounted.current && !publisherRef.current)
                    setError(message(failure));
                });
              }
            },
          });
          createdControl = control;
          controlRef.current = control;
          cancelControlAuthentication.current = () =>
            rejectAuthenticated(new Error("Запуск трансляции отменён"));
          control.connect(response.ticket);
          return { control, authenticated: authenticatedPromise };
        },
      });
      if (!result) return;
      const { stream, response, config, publisher, control } = result;
      if (!publisher || !control) return;
      streamRef.current = stream;
      publisherRef.current = publisher;
      controlRef.current = control as ControlSocket;
      generationRef.current = response.generation;
      published = true;
      setBroadcastConfig(config);
      setActiveConfig(config);
      saveBroadcastConfigSafely(() => window.localStorage, config);
      confirmedSettings.current = settings;
      setAppliedSettings(settings);
      setHasAudio(stream.getAudioTracks().length > 0);
      setSurface(stream.getVideoTracks()[0].getSettings().displaySurface || "");
      setMuted(false);
      if (config.transport === "p2p") setState("connected");
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
      cancelControlAuthentication.current = null;
      if (publisherRef.current === createdPublisher)
        publisherRef.current = null;
      if (controlRef.current === createdControl) controlRef.current = null;
      if (startAttempt.current === attempt) generationRef.current = null;
      if (mounted.current && startAttempt.current === attempt)
        setError(captureError(e));
    } finally {
      if (mounted.current && startAttempt.current === attempt) setBusy(false);
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
                ? `В прямом эфире · ${transportLabel(activeConfig?.transport ?? broadcastConfig.transport)}`
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
                <span
                  className="viewer-count"
                  title={`${info?.viewers || 0} / ${activeConfig?.viewerLimit ?? info?.viewerLimit ?? "10"} зрителей`}
                >
                  <Users size={15} />
                  {info?.viewers || 0} /{" "}
                  {activeConfig?.viewerLimit ?? info?.viewerLimit ?? "10"}{" "}
                  зрителей
                </span>
                {live && activeConfig && (
                  <span>{transportLabel(activeConfig.transport)}</span>
                )}
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
              <fieldset className="transport-picker">
                <legend>Способ подключения</legend>
                <div className="transport-options">
                  <label
                    className={`transport-option ${broadcastConfig.transport === "p2p" ? "selected" : ""}`}
                  >
                    <input
                      type="radio"
                      name="transport"
                      value="p2p"
                      checked={broadcastConfig.transport === "p2p"}
                      disabled={live || busy}
                      onChange={() =>
                        setBroadcastConfig((current) => ({
                          ...current,
                          transport: "p2p",
                        }))
                      }
                    />
                    <span>
                      <strong>P2P — напрямую</strong>
                      <small>Отдельная отправка каждому зрителю.</small>
                    </span>
                  </label>
                  <label
                    className={`transport-option ${broadcastConfig.transport === "server" ? "selected" : ""}`}
                  >
                    <input
                      type="radio"
                      name="transport"
                      value="server"
                      checked={broadcastConfig.transport === "server"}
                      disabled={live || busy}
                      onChange={() =>
                        setBroadcastConfig((current) => ({
                          ...current,
                          transport: "server",
                        }))
                      }
                    />
                    <span>
                      <strong>Через сервер</strong>
                      <small>Один upload ведущего, раздача через SFU.</small>
                    </span>
                  </label>
                </div>
              </fieldset>
              <p className="p2p-warning">
                Поток отправляется отдельно каждому зрителю. Участники могут
                видеть сетевые адреса друг друга. Если прямое соединение
                заблокировано NAT или firewall, автоматического перехода через
                сервер не будет.
              </p>
              <div className="viewer-limit-control">
                <label htmlFor="viewer-limit">Лимит зрителей</label>
                <input
                  id="viewer-limit"
                  className="viewer-limit-input"
                  type="text"
                  inputMode="numeric"
                  aria-label="Лимит зрителей"
                  aria-invalid={limitError ? "true" : undefined}
                  aria-describedby={
                    limitError ? "viewer-limit-error" : undefined
                  }
                  value={broadcastConfig.viewerLimit}
                  disabled={live || busy}
                  onChange={(event) => {
                    const viewerLimit = event.currentTarget.value;
                    setBroadcastConfig((current) => ({
                      ...current,
                      viewerLimit,
                    }));
                    if (limitError && normalizeViewerLimit(viewerLimit))
                      setLimitError("");
                  }}
                />
                {limitError && (
                  <p
                    id="viewer-limit-error"
                    className="field-error"
                    role="alert"
                  >
                    {limitError}
                  </p>
                )}
              </div>
              <div className="separator" />
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
                {activeConfig?.transport === "p2p" && (
                  <div className="metric-group peer-metrics">
                    <h3>Прямые подключения</h3>
                    <span className="metric-row">
                      Подключено <strong>{peerCounts.connected}</strong>
                    </span>
                    <span className="metric-row">
                      Не удалось <strong>{peerCounts.failed}</strong>
                    </span>
                  </div>
                )}
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
