import { useEffect, useRef, useState } from "react";
import {
  Room,
  RoomEvent,
  ConnectionState,
  Track,
  type LocalVideoTrack,
} from "livekit-client";
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
import { api, message, type Connection } from "./api";
import {
  resolutions,
  bitrate,
  captureError,
  audioHint,
  kbps,
  soundLabel,
  type Resolution,
  type FPS,
} from "./quality";
import { applyQuality, publishScreen, updateQuality } from "./media";
export default function Studio({ id }: { id: string }) {
  const { info, error: infoError } = useRoomInfo(id);
  const [secret] = useState(
    () => new URLSearchParams(location.hash.slice(1)).get("key") || "",
  );
  const [res, setRes] = useState<Resolution>("1080"),
    [fps, setFPS] = useState<FPS>(60),
    [busy, setBusy] = useState(false),
    [live, setLive] = useState(false),
    [ended, setEnded] = useState(false),
    [error, setError] = useState(""),
    [note, setNote] = useState(""),
    [muted, setMuted] = useState(false),
    [hasAudio, setHasAudio] = useState(false),
    [surface, setSurface] = useState(""),
    [state, setState] = useState(ConnectionState.Disconnected),
    [actual, setActual] = useState(""),
    [encoded, setEncoded] = useState(""),
    [sound, setSound] = useState(""),
    [elapsed, setElapsed] = useState(0);
  const roomRef = useRef<Room | null>(null),
    streamRef = useRef<MediaStream | null>(null),
    trackRef = useRef<LocalVideoTrack | null>(null),
    preview = useRef<HTMLVideoElement>(null),
    started = useRef(0),
    ending = useRef(false),
    sent = useRef({ bytes: 0, at: 0 }),
    mounted = useRef(true);
  const viewerURL = `${location.origin}/watch/${id}`;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      streamRef.current?.getTracks().forEach((t) => {
        t.onended = null;
        t.stop();
      });
      void roomRef.current?.disconnect();
    };
  }, []);
  useEffect(() => {
    if (info?.state === "ended") {
      setEnded(true);
      setLive(false);
      streamRef.current?.getTracks().forEach((t) => {
        t.onended = null;
        t.stop();
      });
      void roomRef.current?.disconnect();
    }
  }, [info?.state]);
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - started.current) / 1000));
      const settings = streamRef.current?.getVideoTracks()[0]?.getSettings();
      if (settings)
        setActual(
          `${settings.width} × ${settings.height} · ${Math.round(settings.frameRate || 0)} FPS`,
        );
      void trackRef.current
        ?.getRTCStatsReport()
        .then((stats) => {
          stats?.forEach((row) => {
            if (
              row.type === "outbound-rtp" &&
              row.kind === "video" &&
              mounted.current
            )
              setEncoded(
                `${row.frameWidth || "—"} × ${row.frameHeight || "—"} · ${Math.round(row.framesPerSecond || 0)} FPS`,
              );
          });
        })
        .catch(() => {});
      const audio = streamRef.current?.getAudioTracks()[0]?.getSettings();
      void roomRef.current?.localParticipant
        .getTrackPublication(Track.Source.ScreenShareAudio)
        ?.audioTrack?.getRTCStatsReport()
        .then((stats) => {
          stats?.forEach((row) => {
            if (row.type !== "outbound-rtp" || !mounted.current) return;
            setSound(
              soundLabel(
                audio,
                kbps(row.bytesSent, row.timestamp, sent.current),
              ),
            );
            sent.current = { bytes: row.bytesSent, at: row.timestamp };
          });
        })
        .catch(() => {});
    }, 1000);
    return () => clearInterval(timer);
  }, [live]);
  async function finish() {
    if (ending.current) return;
    ending.current = true;
    setBusy(true);
    setLive(false);
    streamRef.current?.getTracks().forEach((t) => {
      t.onended = null;
      t.stop();
    });
    await roomRef.current?.disconnect();
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
    setError("");
    setNote("");
    setBusy(true);
    let stream: MediaStream | null = null;
    let room: Room | null = null;
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
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        // Chrome's voice chain (gain control, noise suppression, echo cancel) is built
        // for a talking head and squashes the dynamics out of game and music audio.
        // Plain values are "ideal", so a source that ignores them still starts.
        audio: {
          channelCount: 2,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      if (!mounted.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      setNote(await applyQuality(stream.getVideoTracks()[0], res, fps));
      streamRef.current = stream;
      const auth = await api<Connection>(`/rooms/${id}/host-token`, {
        hostSecret: secret,
      });
      room = new Room({ adaptiveStream: false, dynacast: false });
      roomRef.current = room;
      room.on(RoomEvent.ConnectionStateChanged, setState);
      room.on(RoomEvent.Disconnected, () => {
        if (!ending.current && mounted.current) {
          streamRef.current?.getTracks().forEach((t) => {
            t.onended = null;
            t.stop();
          });
          setLive(false);
          setError(
            "Соединение прервано. Повторите запуск; убедитесь, что студия не открыта в другой вкладке.",
          );
        }
      });
      await room.connect(auth.url, auth.token);
      if (!mounted.current) {
        await room.disconnect();
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      trackRef.current = await publishScreen(room, stream, res, fps);
      setHasAudio(stream.getAudioTracks().length > 0);
      setSurface(stream.getVideoTracks()[0].getSettings().displaySurface || "");
      setMuted(false);
      stream.getVideoTracks()[0].onended = () => {
        void finish();
      };
      setLive(true);
      started.current = Date.now();
      setElapsed(0);
      if (preview.current) {
        preview.current.srcObject = stream;
        void preview.current.play().catch(() => {});
      }
    } catch (e) {
      stream?.getTracks().forEach((t) => t.stop());
      await room?.disconnect();
      setError(captureError(e));
    } finally {
      setBusy(false);
    }
  }
  async function quality(nextRes: Resolution, nextFPS: FPS) {
    const oldRes = res,
      oldFPS = fps;
    setRes(nextRes);
    setFPS(nextFPS);
    if (!trackRef.current || !live) return;
    setBusy(true);
    setError("");
    try {
      setNote(await updateQuality(trackRef.current, nextRes, nextFPS));
    } catch (e) {
      setRes(oldRes);
      setFPS(oldFPS);
      try {
        await updateQuality(trackRef.current, oldRes, oldFPS);
      } catch {}
      setError(`Не удалось изменить качество: ${message(e)}`);
    } finally {
      setBusy(false);
    }
  }
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
                        : "Что покажем сегодня?"
                    }
                    subtitle={
                      isEnded
                        ? "Трансляция завершена для всех зрителей."
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
                        {busy ? "Подключаем источник…" : "Выбрать источник"}
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
            <section className="panel">
              <div className="panel-title">
                <Settings2 size={18} />
                <h2>Настройки эфира</h2>
              </div>
              <label htmlFor="resolution">Разрешение</label>
              <select
                id="resolution"
                value={res}
                disabled={busy || isEnded}
                onChange={(e) =>
                  void quality(e.target.value as Resolution, fps)
                }
              >
                {Object.entries(resolutions).map(([key, item]) => (
                  <option value={key} key={key}>
                    {item.label}
                  </option>
                ))}
              </select>
              <label>Частота кадров</label>
              <div className="segmented">
                {([30, 60] as const).map((n) => (
                  <button
                    aria-pressed={fps === n}
                    disabled={busy || isEnded}
                    onClick={() => void quality(res, n)}
                    className={fps === n ? "selected" : ""}
                    key={n}
                  >
                    {n} <span>FPS</span>
                    {fps === n && <Check size={14} />}
                  </button>
                ))}
              </div>
              <div className="quality-note">
                До {(bitrate(res, fps) / 1_000_000).toFixed(1)} Мбит/с · зависит
                от источника и сети
              </div>
              {live && (
                <div className="actual">
                  <span>
                    Захват <strong>{actual || "Определяем…"}</strong>
                  </span>
                  <span>
                    Отправка <strong>{encoded || "Определяем…"}</strong>
                  </span>
                  {hasAudio && (
                    <span>
                      Звук <strong>{sound || "Определяем…"}</strong>
                    </span>
                  )}
                </div>
              )}
              <div className="separator" />
              <div className="audio-row">
                <div>
                  <strong>Звук источника</strong>
                  <small>
                    {live
                      ? hasAudio
                        ? "Передаётся вместе с экраном"
                        : audioHint(surface)
                      : "Включите в диалоге выбора"}
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
                    streamRef.current?.getAudioTracks().forEach((t) => {
                      t.enabled = muted;
                    });
                    setMuted(!muted);
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
              <button
                className="button danger"
                disabled={busy}
                onClick={() => void finish()}
              >
                <Square size={15} /> Завершить эфир
              </button>
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
