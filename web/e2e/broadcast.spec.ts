import { test, expect, type BrowserContext, type Page } from "@playwright/test";

async function installCanvasCapture(page: Page) {
  await page.addInitScript(() => {
    navigator.mediaDevices.getDisplayMedia = async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 1280;
      canvas.height = 720;
      const ctx = canvas.getContext("2d")!;
      const draw = () => {
        ctx.fillStyle = "#30442a";
        ctx.fillRect(0, 0, 1280, 720);
        ctx.fillStyle = "#b7f36b";
        ctx.font = "60px sans-serif";
        ctx.fillText("Broadcast · " + Date.now(), 60, 360);
        requestAnimationFrame(draw);
      };
      draw();
      const stream = canvas.captureStream(60);
      const audio = new AudioContext();
      const osc = audio.createOscillator();
      const out = audio.createMediaStreamDestination();
      osc.connect(out);
      osc.start();
      stream.addTrack(out.stream.getAudioTracks()[0]);
      await audio.resume();
      return stream;
    };
  });
}

async function observeNativePeers(context: BrowserContext, relayOnly = false) {
  await context.addInitScript((forceRelay) => {
    const NativePeer = window.RTCPeerConnection;
    const peers: RTCPeerConnection[] = [];
    const observedWindow = window as Window & {
      __testPeers?: RTCPeerConnection[];
    };
    observedWindow.__testPeers = peers;
    class ObservedPeer extends NativePeer {
      constructor(config?: RTCConfiguration) {
        super(forceRelay ? { ...config, iceTransportPolicy: "relay" } : config);
        peers.push(this);
      }
    }
    window.RTCPeerConnection = ObservedPeer;
  }, relayOnly);
}

async function observeControlSockets(context: BrowserContext) {
  await context.addInitScript(() => {
    const NativeSocket = window.WebSocket;
    const sockets: WebSocket[] = [];
    const observedWindow = window as Window & {
      __testControlSockets?: WebSocket[];
    };
    observedWindow.__testControlSockets = sockets;
    class ObservedSocket extends NativeSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        if (String(url).includes("/signal")) sockets.push(this);
      }
    }
    window.WebSocket = ObservedSocket;
  });
}

async function dropLatestControlSocket(page: Page) {
  await page.evaluate(() => {
    const sockets =
      (window as Window & { __testControlSockets?: WebSocket[] })
        .__testControlSockets ?? [];
    sockets.at(-1)?.close();
  });
}

async function nativePeerCount(page: Page) {
  return page.evaluate(
    () =>
      (window as Window & { __testPeers?: RTCPeerConnection[] }).__testPeers
        ?.length ?? 0,
  );
}

async function expectDirectCandidates(page: Page, expectedConnectedPeers = 1) {
  await expect
    .poll(async () =>
      page.evaluate(async (expected) => {
        const peers =
          (window as Window & { __testPeers?: RTCPeerConnection[] })
            .__testPeers ?? [];
        const connected = peers.filter(
          (peer) => peer.connectionState === "connected",
        );
        if (connected.length !== expected) return false;
        for (const peer of connected) {
          const report = await peer.getStats();
          const pairs = [...report.values()].filter(
            (entry) =>
              entry.type === "candidate-pair" &&
              (entry.selected ||
                (entry.nominated && entry.state === "succeeded")),
          );
          let direct = false;
          for (const pair of pairs) {
            const remote = report.get(pair.remoteCandidateId);
            if (/^(host|srflx|prflx)$/.test(remote?.candidateType ?? "")) {
              direct = true;
              break;
            }
          }
          if (!direct) return false;
        }
        return true;
      }, expectedConnectedPeers),
    )
    .toBe(true);
}

function isLiveKitConnection(url: string) {
  const configuredURL = process.env.LIVEKIT_URL ?? "ws://localhost:7880";
  return (
    url.startsWith(configuredURL) ||
    /\/livekit(?:\/|\?|$)|\/rtc(?:\/|\?|$)|:7880(?:\/|\?|$)/.test(url)
  );
}

function observeConnections(page: Page, urls: string[]) {
  page.on("request", (request) => urls.push(request.url()));
  page.on("websocket", (socket) => urls.push(socket.url()));
}

function observeBrowserErrors(page: Page, label: string, errors: string[]) {
  page.on("pageerror", (error) => errors.push(`${label}: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`${label}: ${message.text()}`);
  });
}

test("реальный SFU: публикация, перезапуск в той же комнате, качество и завершение", async ({
  browser,
  page,
}) => {
  test.setTimeout(360_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") {
      console.log("host:", m.text());
      errors.push(m.text());
    }
  });
  // Only the OS capture source is substituted. API, JWT, WebSocket, ICE,
  // encoding, SFU forwarding, and decoding all use the real Docker stack.
  await page.addInitScript(() => {
    navigator.mediaDevices.getDisplayMedia = async (options) => {
      (
        window as Window & {
          __displayMediaOptions?: DisplayMediaStreamOptions;
        }
      ).__displayMediaOptions = options;
      const canvas = document.createElement("canvas");
      canvas.width = 1280;
      canvas.height = 720;
      const ctx = canvas.getContext("2d")!;
      const draw = () => {
        ctx.fillStyle = "#30442a";
        ctx.fillRect(0, 0, 1280, 720);
        ctx.fillStyle = "#b7f36b";
        ctx.font = "60px sans-serif";
        ctx.fillText("Broadcast · " + Date.now(), 60, 360);
        requestAnimationFrame(draw);
      };
      draw();
      const stream = canvas.captureStream(60);
      (
        window as Window & { __captureVideoTrack?: MediaStreamTrack }
      ).__captureVideoTrack = stream.getVideoTracks()[0];
      const audio = new AudioContext();
      const osc = audio.createOscillator();
      const out = audio.createMediaStreamDestination();
      osc.connect(out);
      osc.start();
      stream.addTrack(out.stream.getAudioTracks()[0]);
      await audio.resume();
      return stream;
    };
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Ваш экран. Общий момент." }),
  ).toBeVisible();
  await page.screenshot({ path: "test-results/home.png", fullPage: true });
  await page
    .getByRole("button", { name: "Создать комнату", exact: true })
    .click();
  await expect(page).toHaveURL(/\/studio\//);
  await expect(page.getByRole("radio", { name: "Через сервер" })).toBeChecked();
  await expect(page.getByLabel("Лимит зрителей")).toHaveValue("10");
  await page.getByLabel("Лимит зрителей").fill("10");
  const viewerURL = await page.getByLabel("Ссылка для зрителей").inputValue();
  await page.screenshot({ path: "test-results/studio.png", fullPage: true });
  await expect(page.getByLabel("Кодек")).toHaveValue("vp8");
  await page.getByLabel("Кодек").selectOption("vp9");
  await page.getByLabel("Разрешение").fill("4");
  await page.getByLabel("Частота кадров").fill("30");
  await page.getByLabel("Видеобитрейт").fill("20");
  await page.getByLabel("Аудиобитрейт").fill("192");
  await page.getByLabel("Баланс качества").fill("65");
  await expect(page.getByText("Баланс", { exact: true })).toBeVisible();
  await expect(page.getByText("65% · Движение", { exact: true })).toBeVisible();
  await page.getByLabel("Кодек").selectOption("vp8");
  const viewerContext = await browser.newContext();
  const viewer = await viewerContext.newPage();
  viewer.on("pageerror", (e) => errors.push(e.message));
  await viewer.goto(viewerURL);
  for (let attempt = 0; attempt < 3; attempt++) {
    await viewer
      .getByRole("button", { name: "Смотреть эфир", exact: true })
      .click();
    try {
      await expect(viewer.getByText("Ведущий готовится к эфиру")).toBeVisible({
        timeout: 10000,
      });
      break;
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    await page
      .getByRole("button", { name: "Выбрать источник", exact: true })
      .click();
    try {
      await expect(page.getByText(/^В прямом эфире ·/)).toBeVisible({
        timeout: 10000,
      });
      break;
    } catch (error) {
      if (attempt === 4) throw error;
    }
  }
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as Window & {
              __displayMediaOptions?: DisplayMediaStreamOptions & {
                systemAudio?: string;
                windowAudio?: string;
              };
            }
          ).__displayMediaOptions,
      ),
    )
    .toMatchObject({
      systemAudio: "include",
      windowAudio: "window",
    });
  await expect(page.getByLabel("Кодек")).toBeDisabled();
  await expect(
    page.getByRole("heading", { name: "Диагностика отправки" }),
  ).toBeVisible();
  await expect(
    page.getByText("Пакеты отправлены", { exact: true }),
  ).toBeVisible();
  const diagnostics = page
    .getByRole("heading", { name: "Диагностика отправки" })
    .locator("..");
  const liveVideoBitrate = page.getByLabel("Видеобитрейт");
  await liveVideoBitrate.fill("24");
  await liveVideoBitrate.dispatchEvent("pointerup");
  await expect(
    diagnostics.getByText("24 Мбит/с", { exact: true }),
  ).toBeVisible();
  await expect(liveVideoBitrate).toHaveValue("24");
  await expect(
    page.getByRole("button", { name: "Остановить трансляцию", exact: true }),
  ).toBeEnabled();
  await expect
    .poll(
      () =>
        viewer
          .locator("video")
          .evaluate((el: HTMLVideoElement) => el.videoWidth),
      { timeout: 60000 },
    )
    .toBeGreaterThan(0);
  await expect(viewer.getByText("Видео и звук", { exact: true })).toBeVisible();
  await page.evaluate(() =>
    (
      window as Window & { __captureVideoTrack?: MediaStreamTrack }
    ).__captureVideoTrack?.dispatchEvent(new Event("ended")),
  );
  await expect(
    viewer.getByText("Ведущий готовится к эфиру", { exact: true }),
  ).toBeVisible({ timeout: 15000 });
  await page
    .getByRole("button", { name: "Запустить снова", exact: true })
    .click();
  await expect(page.getByText(/^В прямом эфире ·/)).toBeVisible({
    timeout: 30000,
  });
  await expect
    .poll(
      () =>
        viewer
          .locator("video")
          .evaluate((el: HTMLVideoElement) => el.videoWidth),
      { timeout: 60000 },
    )
    .toBeGreaterThan(0);
  await expect(viewer.getByLabel("Буфер воспроизведения")).toBeEnabled();
  await viewer.getByLabel("Буфер воспроизведения").fill("10");
  await expect(viewer.getByText("1.0 с", { exact: true })).toBeVisible();
  await expect(
    viewer.getByRole("heading", { name: "Диагностика приёма" }),
  ).toBeVisible();
  await expect(
    viewer.getByText("Пакеты получены", { exact: true }),
  ).toBeVisible();
  await viewer.getByLabel("Громкость").fill("0.35");
  await expect
    .poll(() =>
      viewer.locator("audio").evaluate((el: HTMLAudioElement) => el.volume),
    )
    .toBe(0.35);
  await viewer
    .getByRole("button", { name: "Выключить звук", exact: true })
    .click();
  await expect
    .poll(() =>
      viewer.locator("audio").evaluate((el: HTMLAudioElement) => el.muted),
    )
    .toBe(true);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await viewer.screenshot({ path: "test-results/viewer.png", fullPage: true });
  const extraContexts = [];
  for (let i = 0; i < 9; i++) {
    const context = await browser.newContext();
    extraContexts.push(context);
    const extra = await context.newPage();
    await extra.goto(viewerURL);
    await extra
      .getByRole("button", { name: "Смотреть эфир", exact: true })
      .click();
    // The synthetic source draws with requestAnimationFrame; keep its tab active
    // so browser background throttling does not freeze the test fixture.
    await page.bringToFront();
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await expect
          .poll(
            () =>
              extra
                .locator("video")
                .evaluate((el: HTMLVideoElement) => el.videoWidth),
            { timeout: 30000 },
          )
          .toBeGreaterThan(0);
        break;
      } catch (error) {
        if (attempt === 2) throw error;
        await extra.reload();
        await extra
          .getByRole("button", { name: "Смотреть эфир", exact: true })
          .click();
        await page.bringToFront();
      }
    }
  }
  await expect(page.getByTitle("10 / 10 зрителей")).toBeVisible({
    timeout: 10000,
  });
  const roomId = viewerURL.split("/").pop();
  const overflow = await page.request.post(`/api/rooms/${roomId}/join`, {
    data: { session: "" },
  });
  expect(overflow.status()).toBe(409);
  for (const context of extraContexts) await context.close();
  await page
    .getByRole("button", { name: "Остановить трансляцию", exact: true })
    .click();
  await expect(
    viewer.getByText("Ведущий готовится к эфиру", { exact: true }),
  ).toBeVisible({ timeout: 15000 });
  await expect(
    viewer.getByRole("button", { name: "Смотреть эфир", exact: true }),
  ).toHaveCount(0);
  await page.getByLabel("Частота кадров").fill("25");
  await page.getByLabel("Видеобитрейт").fill("12");
  await page
    .getByRole("button", { name: "Запустить снова", exact: true })
    .click();
  await expect(page.getByText(/^В прямом эфире ·/)).toBeVisible({
    timeout: 30000,
  });
  await expect
    .poll(
      () =>
        viewer
          .locator("video")
          .evaluate((el: HTMLVideoElement) => el.videoWidth),
      { timeout: 60000 },
    )
    .toBeGreaterThan(0);
  await expect(viewer.getByText("Видео и звук", { exact: true })).toBeVisible();
  await expect(
    diagnostics.getByText("12 Мбит/с", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Закрыть комнату", exact: true })
    .click();
  await expect(
    viewer.getByText("Этот эфир завершён", { exact: true }),
  ).toBeVisible({ timeout: 15000 });
  expect(errors).toEqual([]);
  await viewerContext.close();
});

test("прямой P2P, лимит, смена режима и строгая ошибка ICE", async ({
  browser,
  page,
}) => {
  test.setTimeout(180_000);
  const browserErrors: string[] = [];
  const p2pConnections: string[] = [];
  observeBrowserErrors(page, "host", browserErrors);
  observeConnections(page, p2pConnections);
  await installCanvasCapture(page);
  await observeNativePeers(page.context());
  await observeControlSockets(page.context());
  await page.goto("/");
  await page.getByRole("button", { name: "Создать комнату" }).click();
  const viewerURL = await page.getByLabel("Ссылка для зрителей").inputValue();
  const roomId = new URL(viewerURL).pathname.split("/").pop();
  await expect(page.getByRole("radio", { name: "Через сервер" })).toBeChecked();
  await expect(page.getByLabel("Лимит зрителей")).toHaveValue("10");
  await page.getByRole("radio", { name: "P2P — напрямую" }).check();
  await page.getByLabel("Лимит зрителей").fill("2");

  const viewers: { context: BrowserContext; page: Page }[] = [];
  try {
    for (let index = 0; index < 2; index++) {
      const context = await browser.newContext();
      await observeNativePeers(context);
      await observeControlSockets(context);
      const viewer = await context.newPage();
      observeBrowserErrors(viewer, `viewer ${index + 1}`, browserErrors);
      observeConnections(viewer, p2pConnections);
      await viewer.goto(viewerURL);
      await viewer.getByRole("button", { name: "Смотреть эфир" }).click();
      viewers.push({ context, page: viewer });
    }
    await page.getByRole("button", { name: "Выбрать источник" }).click();
    await expect(page.getByText(/^В прямом эфире ·/)).toBeVisible();
    await expect(page.getByTitle("2 / 2 зрителей")).toBeVisible();
    for (const { page: viewer } of viewers) {
      await expect
        .poll(
          () =>
            viewer
              .locator("video")
              .evaluate((el: HTMLVideoElement) => el.videoWidth),
          { timeout: 60000 },
        )
        .toBeGreaterThan(0);
      await expectDirectCandidates(viewer);
    }
    await expectDirectCandidates(page, 2);
    expect(p2pConnections.filter(isLiveKitConnection)).toEqual([]);
    expect(browserErrors).toEqual([]);

    const viewerReconnectPeers = await nativePeerCount(viewers[0].page);
    await dropLatestControlSocket(viewers[0].page);
    await expect
      .poll(() => nativePeerCount(viewers[0].page), { timeout: 30_000 })
      .toBeGreaterThan(viewerReconnectPeers);
    await expectDirectCandidates(viewers[0].page);
    await expectDirectCandidates(page, 2);

    const hostReconnectPeers = await Promise.all(
      viewers.map(({ page: viewer }) => nativePeerCount(viewer)),
    );
    await dropLatestControlSocket(page);
    for (const [index, { page: viewer }] of viewers.entries()) {
      await expect
        .poll(() => nativePeerCount(viewer), { timeout: 30_000 })
        .toBeGreaterThan(hostReconnectPeers[index]);
      await expectDirectCandidates(viewer);
    }
    await expectDirectCandidates(page, 2);
    const p2pTracks = await Promise.all(
      viewers.map(({ page: viewer }) =>
        viewer
          .locator("video")
          .evaluate(
            (element: HTMLVideoElement) =>
              (element.srcObject as MediaStream | null)?.getVideoTracks()[0]
                ?.id,
          ),
      ),
    );
    const p2pRoom = await (
      await page.request.get(`/api/rooms/${roomId}`)
    ).json();
    expect(p2pRoom).toMatchObject({ transport: "p2p", viewerLimit: "2" });
    const overflow = await page.request.post(`/api/rooms/${roomId}/join`, {
      data: { session: "" },
    });
    expect(overflow.status()).toBe(409);

    await dropLatestControlSocket(viewers[0].page);
    await page.getByRole("button", { name: "Остановить трансляцию" }).click();
    await expect(
      viewers[0].page.getByText("Ведущий готовится к эфиру", { exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      viewers[0].page.getByRole("button", { name: "Смотреть эфир" }),
    ).toHaveCount(0);
    for (const peerPage of [
      page,
      ...viewers.map(({ page: viewer }) => viewer),
    ]) {
      await expect
        .poll(() =>
          peerPage.evaluate(() =>
            (
              (window as Window & { __testPeers?: RTCPeerConnection[] })
                .__testPeers ?? []
            ).every((peer) => peer.connectionState === "closed"),
          ),
        )
        .toBe(true);
    }
    await page.getByRole("radio", { name: "Через сервер" }).check();
    await page.getByRole("button", { name: "Запустить снова" }).click();
    await expect(page.getByText(/^В прямом эфире ·/)).toBeVisible({
      timeout: 30000,
    });
    const serverRoom = await (
      await page.request.get(`/api/rooms/${roomId}`)
    ).json();
    expect(serverRoom).toMatchObject({
      transport: "server",
      generation: p2pRoom.generation + 1,
      viewerLimit: "2",
    });
    for (const [index, { page: viewer }] of viewers.entries()) {
      await expect
        .poll(
          () =>
            viewer
              .locator("video")
              .evaluate((el: HTMLVideoElement) => el.videoWidth),
          { timeout: 60000 },
        )
        .toBeGreaterThan(0);
      await expect
        .poll(() =>
          viewer
            .locator("video")
            .evaluate(
              (el: HTMLVideoElement) =>
                (el.srcObject as MediaStream | null)?.getVideoTracks()[0]?.id,
            ),
        )
        .not.toBe(p2pTracks[index]);
      await expect
        .poll(() =>
          viewer
            .locator("video")
            .evaluate((el: HTMLVideoElement) => el.currentTime),
        )
        .toBeGreaterThan(0.2);
      await expect(
        viewer.getByRole("button", { name: "Смотреть эфир" }),
      ).toHaveCount(0);
    }

    // A relay-only native peer cannot use this room's STUN-only ICE servers.
    await page.getByRole("button", { name: "Остановить трансляцию" }).click();
    await page.getByRole("radio", { name: "P2P — напрямую" }).check();
    await page.getByLabel("Лимит зрителей").fill("3");
    const failedContext = await browser.newContext();
    await observeNativePeers(failedContext, true);
    const failedViewer = await failedContext.newPage();
    viewers.push({ context: failedContext, page: failedViewer });
    observeBrowserErrors(failedViewer, "relay-only viewer", browserErrors);
    const requests: string[] = [];
    observeConnections(page, requests);
    observeConnections(failedViewer, requests);
    await failedViewer.goto(viewerURL);
    await failedViewer.clock.install();
    await page.getByRole("button", { name: "Запустить снова" }).click();
    await expect(page.getByTitle("2 / 3 зрителей")).toBeVisible();
    await failedViewer.getByRole("button", { name: "Смотреть эфир" }).click();
    await expect.poll(() => nativePeerCount(failedViewer)).toBeGreaterThan(0);
    await failedViewer.clock.runFor(20_100);
    await expect(
      failedViewer.getByText(/Сеть, NAT или firewall/),
    ).toBeVisible();
    expect(requests.filter(isLiveKitConnection)).toEqual([]);
    expect(browserErrors).toEqual([]);
  } finally {
    for (const { context } of viewers) await context.close();
  }
});

test("мобильная вёрстка и отсутствующая комната", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Создать комнату", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({ path: "test-results/mobile.png", fullPage: true });
  await page.goto("/watch/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  await expect(page.getByRole("alert")).toContainText("Комната не найдена");
});
