import { useState, type ReactNode } from "react";
import {
  ArrowUpRight,
  ArrowRight,
  Radio,
  Monitor,
  Check,
  Volume2,
  Maximize,
  Users,
  Settings2,
  MousePointer2,
  Loader2,
  ShieldCheck,
} from "lucide-react";
import { Header, ErrorBox } from "./shared";
import { api, message } from "./api";
export default function Home() {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function create() {
    setBusy(true);
    setError("");
    try {
      const data = await api<{ hostUrl: string }>("/rooms", {});
      window.location.assign(data.hostUrl);
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  }
  return (
    <div className="app home">
      <Header />
      <main className="landing">
        <div className="hero-copy">
          <div className="eyebrow">
            <span className="line" />
            ВАШ ЛИЧНЫЙ ПРЯМОЙ ЭФИР
          </div>
          <h1>
            Ваш экран.
            <br />
            <span>Общий момент.</span>
          </h1>
          <p className="hero-description">
            Покажите игру, идею или целый рабочий стол.
            <br className="hide-mobile" /> Создайте комнату и пригласите своих
            по ссылке.
          </p>
          <button
            className="button primary large"
            onClick={create}
            disabled={busy}
          >
            {busy ? (
              <Loader2 className="spin" size={20} />
            ) : (
              <Radio size={20} />
            )}{" "}
            {busy ? "Создаём комнату…" : "Создать комнату"}
            <ArrowUpRight size={20} />
          </button>
          <ErrorBox error={error} />
          <div className="hero-notes">
            <span>
              <Check size={14} /> Без установки
            </span>
            <span>
              <Check size={14} /> До 10 зрителей
            </span>
          </div>
        </div>
        <div
          className="hero-visual"
          aria-label="Предпросмотр интерфейса трансляции"
        >
          <div className="window-bar">
            <div className="traffic">
              <i />
              <i />
              <i />
            </div>
            <span>Ваша следующая трансляция</span>
            <span className="live-badge">
              <span className="dot" /> LIVE
            </span>
          </div>
          <div className="demo-screen">
            <div className="orbital one" />
            <div className="orbital two" />
            <div className="demo-center">
              <span className="screen-icon">
                <Monitor size={46} strokeWidth={1.3} />
              </span>
              <span>Всё, чем хочется поделиться</span>
              <small>Один экран. Ваша компания.</small>
            </div>
            <div className="demo-cursor">
              <MousePointer2 size={22} fill="currentColor" />
              <span>Вы в эфире</span>
            </div>
            <div className="demo-label">
              <span className="dot" /> ВАШ ЭКРАН
            </div>
          </div>
          <div className="demo-footer">
            <div>
              <Volume2 size={16} />
              <span className="volume-demo" />
            </div>
            <span>
              4K <i /> 60 FPS
            </span>
            <Maximize size={16} />
          </div>
          <div className="float-note">
            <Users size={19} />
            <div>
              <strong>Вместе, даже на расстоянии</strong>
              <span>Приватная комната по ссылке</span>
            </div>
            <span className="avatars">
              <i>А</i>
              <i>М</i>
              <i>+8</i>
            </span>
          </div>
        </div>
      </main>
      <section className="features">
        <Feature
          icon={<Monitor />}
          title="Любой источник"
          text="Экран, отдельное окно или вкладка — выбираете вы."
        />
        <Feature
          icon={<Settings2 />}
          title="Вплоть до 4K / 60 FPS"
          text="Настройте чёткость и плавность под свой эфир."
        />
        <Feature
          icon={<ShieldCheck />}
          title="Только по вашей ссылке"
          text="Без профилей и каталогов. Просто вы и ваши зрители."
        />
      </section>
      <section className="how">
        <span className="eyebrow">ТРИ ШАГА ДО ЭФИРА</span>
        <div>
          <span>
            <b>01</b> Создайте комнату
          </span>
          <ArrowRight size={18} />
          <span>
            <b>02</b> Выберите источник
          </span>
          <ArrowRight size={18} />
          <span>
            <b>03</b> Отправьте ссылку
          </span>
        </div>
      </section>
      <footer>
        Эфир — ближе, чем кажется.
        <span>
          С экрана на экран <Radio size={14} />
        </span>
      </footer>
    </div>
  );
}
function Feature({
  icon,
  title,
  text,
}: {
  icon: ReactNode;
  title: string;
  text: string;
}) {
  return (
    <article className="feature">
      <div className="feature-icon">{icon}</div>
      <div>
        <h3>{title}</h3>
        <p>{text}</p>
      </div>
    </article>
  );
}
