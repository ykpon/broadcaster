import { useEffect, useRef, useState } from "react";
import {
  Room,
  RoomEvent,
  Track,
  ConnectionState,
  type RemoteTrack,
} from "livekit-client";
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
import { api, message, type Connection } from "./api";
export default function Viewer({ id }: { id: string }) {
  const { info, error: infoError } = useRoomInfo(id);
  const [error, setError] = useState(""),
    [joined, setJoined] = useState(false),
    [busy, setBusy] = useState(false),
    [hasVideo, setHasVideo] = useState(false),
    [hasAudio, setHasAudio] = useState(false),
    [blocked, setBlocked] = useState(false),
    [volume, setVolume] = useState(0.8),
    [muted, setMuted] = useState(false),
    [fit, setFit] = useState(false),
    [idle, setIdle] = useState(false),
    [state, setState] = useState(ConnectionState.Disconnected);
  const roomRef = useRef<Room | null>(null),
    video = useRef<HTMLVideoElement>(null),
    audio = useRef<HTMLAudioElement>(null),
    player = useRef<HTMLDivElement>(null),
    mounted = useRef(true);
  const ended = info?.state === "ended";
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      void roomRef.current?.disconnect();
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
      void roomRef.current?.disconnect();
      setHasVideo(false);
      setJoined(false);
    }
  }, [ended]);
  async function join() {
    setBusy(true);
    setError("");
    await roomRef.current?.disconnect();
    setHasVideo(false);
    setHasAudio(false);
    const room = new Room({ adaptiveStream: false });
    roomRef.current = room;
    room.on(RoomEvent.ConnectionStateChanged, setState);
    room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
      if (track.kind === Track.Kind.Video && video.current) {
        track.attach(video.current);
        setHasVideo(true);
        void video.current.play().catch(() => setBlocked(true));
      }
      if (track.kind === Track.Kind.Audio && audio.current) {
        track.attach(audio.current);
        setHasAudio(true);
        void audio.current.play().catch(() => setBlocked(true));
      }
    });
    room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
      track.detach();
      if (track.kind === Track.Kind.Video) setHasVideo(false);
      else setHasAudio(false);
    });
    room.on(RoomEvent.Disconnected, () => {
      if (mounted.current) {
        setJoined(false);
        setHasVideo(false);
      }
    });
    try {
      let session = "";
      try {
        session = sessionStorage.getItem(`viewer:${id}`) || "";
      } catch {}
      const auth = await api<Connection>(`/rooms/${id}/viewer-token`, {
        session,
      });
      if (auth.session)
        try {
          sessionStorage.setItem(`viewer:${id}`, auth.session);
        } catch {}
      if (!mounted.current) return;
      await room.connect(auth.url, auth.token);
      if (!mounted.current) {
        await room.disconnect();
        return;
      }
      setJoined(true);
      await room.startAudio().catch(() => setBlocked(true));
    } catch (e) {
      setError(message(e));
      await room.disconnect();
    } finally {
      setBusy(false);
    }
  }
  async function enablePlayback() {
    try {
      await roomRef.current?.startAudio();
      await video.current?.play();
      if (hasAudio) await audio.current?.play();
      setBlocked(false);
    } catch {
      setError(
        "Браузер заблокировал воспроизведение. Проверьте разрешение звука для сайта.",
      );
    }
  }
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
