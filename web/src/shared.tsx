import { useState, type ReactNode } from "react";
import { Radio, Check, Copy, Monitor, ShieldCheck } from "lucide-react";
export function Logo() {
  return (
    <a className="logo" href="/" aria-label="Эфир — главная">
      <span className="logo-icon">
        <Radio size={23} />
      </span>
      эфир<span className="logo-dot">.</span>
    </a>
  );
}
export function Header({ children }: { children?: ReactNode }) {
  return (
    <header className="header">
      <Logo />
      <div className="header-right">
        {children || (
          <>
            <span className="small muted hide-mobile">
              Делитесь моментом, а не настройками
            </span>
            <span className="pill">
              <span className="dot" />
              Без регистрации
            </span>
          </>
        )}
      </div>
    </header>
  );
}
export function ErrorBox({ error }: { error: string }) {
  return error ? (
    <div className="error" role="alert">
      {error}
    </div>
  ) : null;
}
export function CopyButton({
  value,
  label = "Скопировать ссылку",
}: {
  value: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  return (
    <>
      <button
        className="button secondary"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          } catch {
            setError("Не удалось скопировать. Выделите ссылку вручную.");
          }
        }}
      >
        {copied ? <Check size={16} /> : <Copy size={16} />}{" "}
        {copied ? "Скопировано" : label}
      </button>
      {error && <small role="alert">{error}</small>}
    </>
  );
}
export function Scene({
  title,
  subtitle,
  icon,
  children,
}: {
  title: string;
  subtitle: string;
  icon?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="scene">
      <div className="scene-icon">
        {icon || <Monitor size={36} strokeWidth={1.4} />}
      </div>
      <h2>{title}</h2>
      <p>{subtitle}</p>
      {children}
    </div>
  );
}
