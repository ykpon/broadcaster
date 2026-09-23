import { useEffect, useRef, useState } from "react";
import { Track, ConnectionState } from "livekit-client";
import {
  Check,
  Radio,
  Volume2,
  VolumeX,
  Maximize,
  Users,
  Play,
  ShieldCheck,
  Layers,
  Loader2,
  ArrowUpRight,
} from "lucide-react";
import { Header, ErrorBox, CopyButton, Scene } from "./shared";
import { useRoomInfo, roomStateLabel } from "./room";
import { api, message } from "./api";
import type { JoinResponse } from "./protocol";
import {
  applyPlayoutBuffer,
  applyPlayoutBufferToTracks,
  type BufferPreference,
  type PlayoutSupport,
} from "./playout";
import {
  formatMetric,
  parseInboundStats,
  type CounterSample,
  type StreamMetrics,
} from "./stats";
import {
  createIncomingStatsTracker,
  createViewerSession,
  loadBufferPreferenceSafely,
  saveBufferPreferenceSafely,
} from "./viewerRuntime";
import {
  createViewerTransportController,
  type ViewerMediaTrack,
  type ViewerTransportController,
} from "./viewerTransport";
export default function Viewer({ id }: { id: string }) {
  const { info, error: infoError } = useRoomInfo(id);
  const [error, setError] = useState(""),
    [joined, setJoined] = useState(false),
    [busy, setBusy] = useState(false),
    [hasVideo, setHasVideo] = useState(false),
    [hasAudio, setHasAudio] = useState(false),
    [blocked, setBlocked] = useState(false),
    [roomEnded, setRoomEnded] = useState(false),
    [volume, setVolume] = useState(0.8),
    [muted, setMuted] = useState(false),
    [fit, setFit] = useState(false),
    [idle, setIdle] = useState(false),
    [buffer, setBuffer] = useState<BufferPreference>(() =>
      loadBufferPreferenceSafely(() => window.localStorage),
    ),
    [playoutSupport, setPlayoutSupport] = useState<PlayoutSupport | "unknown">(
      "unknown",
    ),
    [videoMetrics, setVideoMetrics] = useState<StreamMetrics>({}),
    [audioMetrics, setAudioMetrics] = useState<StreamMetrics>({}),
    [state, setState] = useState<string>(ConnectionState.Disconnected);
  const controllerRef = useRef<ViewerTransportController | null>(null),
    sessionRef = useRef<ReturnType<typeof createViewerSession> | null>(null),
    video = useRef<HTMLVideoElement>(null),
    audio = useRef<HTMLAudioElement>(null),
    player = useRef<HTMLDivElement>(null),
    bufferRef = useRef(buffer),
    remoteTracks = useRef(new Set<ViewerMediaTrack>()),
    videoStats = useRef(
      createIncomingStatsTracker<ViewerMediaTrack, CounterSample>(),
    ),
    audioStats = useRef(
      createIncomingStatsTracker<ViewerMediaTrack, CounterSample>(),
    ),
    mounted = useRef(true);
  const ended = roomEnded || info?.state === "ended";

  function replaceStatsTrack(kind: Track.Kind, track: ViewerMediaTrack | null) {
    const tracker =
      kind === Track.Kind.Video ? videoStats.current : audioStats.current;
    if (!tracker.replace(track)) return;
    if (kind === Track.Kind.Video) setVideoMetrics({});
    else setAudioMetrics({});
  }

  function resetRemoteState(updateUi = true) {
    for (const track of remoteTracks.current) track.detach();
    remoteTracks.current.clear();
    videoStats.current.replace(null);
    audioStats.current.replace(null);
    if (!updateUi) return;
    setHasVideo(false);
    setHasAudio(false);
    setVideoMetrics({});
    setAudioMetrics({});
    setPlayoutSupport("unknown");
  }

  function refreshPlayoutSupport() {
    const tracks = [...remoteTracks.current];
    setPlayoutSupport(
      tracks.length === 0
        ? "unknown"
        : applyPlayoutBufferToTracks(tracks, bufferRef.current),
    );
  }

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      sessionRef.current?.close();
      controllerRef.current?.dispose();
      resetRemoteState(false);
    };
  }, []);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const wake = () => {
      setIdle(false);
      clearTimeout(timer);
      timer = setTimeout(() => setIdle(true), 2500);
    };
    // Only fullscreen needs this; windowed playback keeps the bar permanently.
    const track = () => {
      clearTimeout(timer);
      document.removeEventListener("mousemove", wake);
      if (document.fullscreenElement) {
        document.addEventListener("mousemove", wake);
        wake();
      } else setIdle(false);
    };
    document.addEventListener("fullscreenchange", track);
    return () => {
      document.removeEventListener("fullscreenchange", track);
      document.removeEventListener("mousemove", wake);
      clearTimeout(timer);
    };
  }, []);
  useEffect(() => {
    if (audio.current) {
      audio.current.volume = volume;
      audio.current.muted = muted;
    }
  }, [volume, muted]);
  useEffect(() => {
    if (ended) {
      sessionRef.current?.close();
      controllerRef.current?.dispose();
      resetRemoteState();
      setJoined(false);
      setBusy(false);
    }
  }, [ended]);
  useEffect(() => {
    if (!joined) return;
    const poll = (
      tracker: ReturnType<
        typeof createIncomingStatsTracker<ViewerMediaTrack, CounterSample>
      >,
      setMetrics: (metrics: StreamMetrics) => void,
    ) => {
      const track = tracker.current();
      if (!track) return;
      const read = tracker.capture(track);
      if (!read) return;
      void track
        .getRTCStatsReport()
        .then((report) => {
          if (!report || !mounted.current) {
            tracker.release(read);
            return;
          }
          const parsed = parseInboundStats(
            Array.from(report.values()),
            read.previous,
          );
          if (!tracker.commit(read, parsed.sample)) return;
          setMetrics(parsed.metrics);
        })
        .catch(() => tracker.release(read));
    };
    const timer = setInterval(() => {
      poll(videoStats.current, setVideoMetrics);
      poll(audioStats.current, setAudioMetrics);
    }, 1000);
    return () => clearInterval(timer);
  }, [joined]);

  function changeBuffer(value: string) {
    const tenths = Number(value);
    const next = tenths === 0 ? null : tenths / 10;
    bufferRef.current = next;
    setBuffer(next);
    saveBufferPreferenceSafely(() => window.localStorage, next);
    refreshPlayoutSupport();
  }

  async function join() {
    setBusy(true);
    setError("");
    sessionRef.current?.close();
    controllerRef.current?.dispose();
    resetRemoteState();
    setBlocked(false);
    let session: ReturnType<typeof createViewerSession>;
    const controller = createViewerTransportController({
      send: (signal) => session.send(signal),
      onState: (next) => {
        if (!mounted.current) return;
        setState(next);
        if (next === "connecting") setError("");
        if (next === "connecting" || next === "disconnected") setBlocked(false);
      },
      onPlaybackBlocked: () => {
        if (mounted.current) setBlocked(true);
      },
      onError: (failure) => {
        if (mounted.current) setError(failure);
      },
      onTrack: (track) => {
        if (!mounted.current) return;
        remoteTracks.current.add(track);
        const trackSupport = applyPlayoutBuffer(track, bufferRef.current);
        if (remoteTracks.current.size === 1) setPlayoutSupport(trackSupport);
        else refreshPlayoutSupport();
        if (track.kind === Track.Kind.Video && video.current) {
          replaceStatsTrack(Track.Kind.Video, track);
          track.attach(video.current);
          setHasVideo(true);
          void video.current.play().catch(() => setBlocked(true));
        }
        if (track.kind === Track.Kind.Audio && audio.current) {
          replaceStatsTrack(Track.Kind.Audio, track);
          track.attach(audio.current);
          setHasAudio(true);
          void audio.current.play().catch(() => setBlocked(true));
        }
      },
      onTrackRemoved: (track) => {
        if (!mounted.current || !remoteTracks.current.has(track)) return;
        remoteTracks.current.delete(track);
        track.detach();
        if (
          track.kind === Track.Kind.Video &&
          videoStats.current.current() === track
        ) {
          replaceStatsTrack(Track.Kind.Video, null);
          setHasVideo(false);
        } else if (
          track.kind === Track.Kind.Audio &&
          audioStats.current.current() === track
        ) {
          replaceStatsTrack(Track.Kind.Audio, null);
          setHasAudio(false);
        }
        refreshPlayoutSupport();
      },
    });
    controllerRef.current = controller;
    session = createViewerSession({
      roomId: id,
      readSession: () => {
        try {
          return sessionStorage.getItem(`viewer:${id}`) || "";
        } catch {
          return "";
        }
      },
      writeSession: (value) => {
        try {
          sessionStorage.setItem(`viewer:${id}`, value);
        } catch {
          /* Session persistence is best effort. */
        }
      },
      postJoin: (saved) =>
        api<JoinResponse>(`/rooms/${id}/join`, { session: saved }),
      postTicket: async (saved) => {
        const response = await api<{ ticket: string }>(
          `/rooms/${id}/signal-ticket`,
          { session: saved },
        );
        return response.ticket;
      },
      onAuthenticated: () => {
        if (!mounted.current || sessionRef.current !== session) return;
        setJoined(true);
        setBusy(false);
      },
      onSignal: (signal) => {
        if (!mounted.current || sessionRef.current !== session) return;
        if (signal.type === "room-ended") {
          setRoomEnded(true);
          session.close();
          controller.dispose();
          setJoined(false);
          return;
        }
        if (signal.type === "error") {
          setError(signal.error);
          return;
        }
        void controller.handleSignal(signal);
      },
      onFatal: (failure) => {
        if (!mounted.current || sessionRef.current !== session) return;
        session.close();
        controller.dispose();
        setJoined(false);
        setBusy(false);
        setError(message(failure));
      },
    });
    sessionRef.current = session;
    try {
      await session.join();
    } catch (e) {
      if (mounted.current && sessionRef.current === session) {
        setError(message(e));
        setBusy(false);
      }
      session.close();
      controller.dispose();
    }
  }
  async function enablePlayback() {
    try {
      await controllerRef.current?.startAudio();
      await video.current?.play();
      if (hasAudio) await audio.current?.play();
      setBlocked(false);
    } catch {
      setError(
        "Браузер заблокировал воспроизведение. Проверьте разрешение звука для сайта.",
      );
    }
  }
  const receivedVideo =
    videoMetrics.width !== undefined || videoMetrics.height !== undefined
      ? `${formatMetric(videoMetrics.width)} × ${formatMetric(videoMetrics.height)} · ${formatMetric(videoMetrics.fps, " FPS")}`
      : "—";
  return (
    <div className="app">
      <Header>
        <span className="pill">
          <Users size={14} />
          {info?.viewers || 0} / 10 зрителей
        </span>
        <span className={`status-pill ${hasVideo ? "on" : ""}`}>
          <span className="dot" />
          {ended ? "Завершён" : hasVideo ? "LIVE" : "Ожидание"}
        </span>
      </Header>
      <main className="viewer-page">
        <div className="viewer-heading">
          <div>
            <span className="eyebrow">ВЫ СМОТРИТЕ</span>
            <h1>
              По ту сторону экрана<span className="heading-dot">.</span>
            </h1>
          </div>
          <CopyButton value={location.href} label="Пригласить" />
        </div>
        <div
          ref={player}
          className={`player viewer-player${idle ? " idle" : ""}`}
        >
          <div className="video-stage">
            <video
              ref={video}
              muted
              autoPlay
              playsInline
              style={{ objectFit: fit ? "cover" : "contain" }}
              className={hasVideo ? "" : "invisible"}
            />
            <audio ref={audio} autoPlay />
            {!hasVideo && (
              <Scene
                title={
                  ended
                    ? "Этот эфир завершён"
                    : joined
                      ? "Ведущий готовится к эфиру"
                      : "Вы приглашены в эфир"
                }
                subtitle={
                  ended
                    ? "Спасибо, что были рядом. Здесь можно создать собственную комнату."
                    : joined
                      ? "Оставайтесь здесь — изображение появится автоматически."
                      : "Подключитесь, чтобы увидеть трансляцию и услышать звук."
                }
                icon={ended ? <Check size={36} /> : <Radio size={36} />}
              >
                {" "}
                {!joined && !ended && (
                  <button
                    className="button primary"
                    onClick={() => void join()}
                    disabled={busy || !info}
                  >
                    {busy ? (
                      <Loader2 className="spin" size={18} />
                    ) : (
                      <Play size={18} />
                    )}{" "}
                    {busy ? "Подключаемся…" : "Смотреть эфир"}
                  </button>
                )}
                {ended && (
                  <a href="/" className="button primary">
                    Создать свою комнату <ArrowUpRight size={16} />
                  </a>
                )}
                {joined && (
                  <span className="waiting-dots">
                    <i />
                    <i />
                    <i />
                  </span>
                )}
              </Scene>
            )}
            {blocked && hasVideo && (
              <button
                className="button primary playback-button"
                onClick={() => void enablePlayback()}
              >
                <Volume2 size={18} /> Включить воспроизведение
              </button>
            )}
          </div>
          <div className="viewer-controls">
            <div className="volume-controls">
              <button
                className="icon-button"
                aria-label={muted ? "Включить звук" : "Выключить звук"}
                onClick={() => setMuted(!muted)}
              >
                {muted || volume === 0 ? (
                  <VolumeX size={19} />
                ) : (
                  <Volume2 size={19} />
                )}
              </button>
              <input
                aria-label="Громкость"
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={muted ? 0 : volume}
                onChange={(e) => {
                  setVolume(Number(e.target.value));
                  setMuted(false);
                }}
              />
              <span>{Math.round((muted ? 0 : volume) * 100)}%</span>
            </div>
            <span className="stream-label hide-mobile">
              <span className={`dot ${hasVideo ? "green" : ""}`} />
              {hasVideo
                ? hasAudio
                  ? "Видео и звук"
                  : "Без аудио источника"
                : roomStateLabel(state)}
            </span>
            <div className="view-actions">
              <button
                className="icon-button"
                title="Заполнить / вписать"
                aria-label="Изменить масштаб видео"
                aria-pressed={fit}
                onClick={() => setFit(!fit)}
              >
                <Layers size={18} />
              </button>
              <button
                className="icon-button"
                aria-label="Полный экран"
                onClick={() => {
                  const action = document.fullscreenElement
                    ? document.exitFullscreen()
                    : player.current?.requestFullscreen();
                  void action?.catch(() =>
                    setError("Полноэкранный режим недоступен в этом браузере."),
                  );
                }}
              >
                <Maximize size={19} />
              </button>
            </div>
          </div>
        </div>
        <section
          className="viewer-diagnostics"
          aria-labelledby="viewer-diagnostics-title"
        >
          <div className="viewer-buffer">
            <div className="viewer-diagnostics-heading">
              <h2 id="viewer-diagnostics-title">Диагностика приёма</h2>
              <output htmlFor="playout-buffer">
                {buffer === null ? "Авто" : `${buffer.toFixed(1)} с`}
              </output>
            </div>
            <label htmlFor="playout-buffer">Буфер воспроизведения</label>
            <input
              id="playout-buffer"
              aria-label="Буфер воспроизведения"
              type="range"
              min="0"
              max="40"
              step="1"
              value={buffer === null ? 0 : Math.round(buffer * 10)}
              disabled={playoutSupport === "unsupported"}
              onChange={(event) => changeBuffer(event.currentTarget.value)}
            />
            <div className="range-scale">
              <span>Авто</span>
              <span>4.0 с</span>
            </div>
            {playoutSupport === "unsupported" && (
              <p className="viewer-buffer-note">
                Браузер использует автоматический буфер
              </p>
            )}
          </div>
          <div className="viewer-metrics">
            <div className="metric-group" aria-label="Видео">
              <h3>Видео</h3>
              <span className="metric-row">
                Кодек <strong>{videoMetrics.codec ?? "—"}</strong>
              </span>
              <span className="metric-row">
                Битрейт
                <strong>
                  {formatMetric(videoMetrics.bitrateKbps, " кбит/с")}
                </strong>
              </span>
              <span className="metric-row">
                Разрешение / FPS <strong>{receivedVideo}</strong>
              </span>
              <span className="metric-row">
                <span>Пакеты получены</span>
                <strong>{formatMetric(videoMetrics.packets)}</strong>
              </span>
              <span className="metric-row">
                Потеряно{" "}
                <strong>{formatMetric(videoMetrics.packetsLost)}</strong>
              </span>
              <span className="metric-row">
                Пропущено кадров
                <strong>{formatMetric(videoMetrics.droppedFrames)}</strong>
              </span>
              <span className="metric-row">
                Jitter{" "}
                <strong>{formatMetric(videoMetrics.jitterMs, " мс")}</strong>
              </span>
              <span className="metric-row">
                Фактический буфер
                <strong>{formatMetric(videoMetrics.bufferMs, " мс")}</strong>
              </span>
            </div>
            <div className="metric-group" aria-label="Аудио">
              <h3>Аудио</h3>
              <span className="metric-row">
                Кодек <strong>{audioMetrics.codec ?? "—"}</strong>
              </span>
              <span className="metric-row">
                Битрейт
                <strong>
                  {formatMetric(audioMetrics.bitrateKbps, " кбит/с")}
                </strong>
              </span>
              <span className="metric-row">
                Пакеты аудио{" "}
                <strong>{formatMetric(audioMetrics.packets)}</strong>
              </span>
              <span className="metric-row">
                Потеряно аудио
                <strong>{formatMetric(audioMetrics.packetsLost)}</strong>
              </span>
              <span className="metric-row">
                Jitter{" "}
                <strong>{formatMetric(audioMetrics.jitterMs, " мс")}</strong>
              </span>
              <span className="metric-row">
                Фактический буфер
                <strong>{formatMetric(audioMetrics.bufferMs, " мс")}</strong>
              </span>
            </div>
          </div>
        </section>
        <ErrorBox error={error || infoError} />
        <div className="viewer-note">
          <ShieldCheck size={15} /> Комната доступна только по ссылке.
          <span>Устраивайтесь поудобнее.</span>
        </div>
      </main>
      <footer>
        <a href="/">
          Создайте собственный эфир <ArrowUpRight size={13} />
        </a>
        <span>
          С экрана на экран <Radio size={14} />
        </span>
      </footer>
    </div>
  );
}
