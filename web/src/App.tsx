import { lazy, Suspense } from "react";
import Home from "./Home";
import { Header, Scene } from "./shared";
const Studio = lazy(() => import("./Studio"));
const Viewer = lazy(() => import("./Viewer"));
export default function App() {
  const match = location.pathname.match(
    /^\/(studio|watch)\/([A-Za-z0-9_-]{32})$/,
  );
  if (match)
    return (
      <Suspense
        fallback={
          <div className="app">
            <Header />
            <Scene
              title="Загружаем комнату…"
              subtitle="Подготавливаем подключение"
            />
          </div>
        }
      >
        {match[1] === "studio" ? (
          <Studio id={match[2]} />
        ) : (
          <Viewer id={match[2]} />
        )}
      </Suspense>
    );
  if (location.pathname !== "/")
    return (
      <div className="app">
        <Header />
        <Scene
          title="Страница не найдена"
          subtitle="Проверьте ссылку или создайте новую комнату."
        >
          <a className="button primary" href="/">
            На главную
          </a>
        </Scene>
      </div>
    );
  return <Home />;
}
