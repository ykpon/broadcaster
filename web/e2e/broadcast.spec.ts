import { test, expect } from "@playwright/test";

test("реальный SFU: публикация тестового видео и аудио, громкость, качество, завершение", async ({
  browser,
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning")
      console.log("host:", m.text());
  });
  // Only the OS capture source is substituted. API, JWT, WebSocket, ICE,
  // encoding, SFU forwarding, and decoding all use the real Docker stack.
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
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Ваш экран. Общий момент." }),
  ).toBeVisible();
  await page.screenshot({ path: "test-results/home.png", fullPage: true });
  await page
    .getByRole("button", { name: "Создать комнату", exact: true })
    .click();
  await expect(page).toHaveURL(/\/studio\//);
  const viewerURL = await page.getByLabel("Ссылка для зрителей").inputValue();
  await page.screenshot({ path: "test-results/studio.png", fullPage: true });
  const viewerContext = await browser.newContext();
  const viewer = await viewerContext.newPage();
  viewer.on("pageerror", (e) => errors.push(e.message));
  await viewer.goto(viewerURL);
  await viewer
    .getByRole("button", { name: "Смотреть эфир", exact: true })
    .click();
  await expect(viewer.getByText("Ведущий готовится к эфиру")).toBeVisible({
    timeout: 20000,
  });
  await page
    .getByRole("button", { name: "Выбрать источник", exact: true })
    .click();
  await expect(page.getByText("В прямом эфире", { exact: true })).toBeVisible({
    timeout: 30000,
  });
  await expect
    .poll(
      () =>
        viewer
          .locator("video")
          .evaluate((el: HTMLVideoElement) => el.videoWidth),
      { timeout: 30000 },
    )
    .toBeGreaterThan(0);
  await expect(viewer.getByText("Видео и звук", { exact: true })).toBeVisible();
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
  await page.getByLabel("Разрешение").selectOption("2160");
  await page.getByRole("button", { name: "30 FPS" }).click();
  await expect(page.getByRole("button", { name: "30 FPS" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
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
    await expect
      .poll(
        () =>
          extra
            .locator("video")
            .evaluate((el: HTMLVideoElement) => el.videoWidth),
        { timeout: 20000 },
      )
      .toBeGreaterThan(0);
  }
  await expect(page.getByText("10 / 10 зрителей", { exact: true })).toBeVisible(
    { timeout: 10000 },
  );
  const roomId = viewerURL.split("/").pop();
  const overflow = await page.request.post(
    `/api/rooms/${roomId}/viewer-token`,
    { data: {} },
  );
  expect(overflow.status()).toBe(409);
  await page
    .getByRole("button", { name: "Завершить эфир", exact: true })
    .click();
  await expect(
    viewer.getByText("Этот эфир завершён", { exact: true }),
  ).toBeVisible({ timeout: 15000 });
  expect(errors).toEqual([]);
  for (const context of extraContexts) await context.close();
  await viewerContext.close();
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
