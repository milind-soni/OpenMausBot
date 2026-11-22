// A person's theme in a real browser against a real server (temporary home): it paints the window live, Settings lists
// it, the reset keys and ?safe-look both get back to the default look; a picture and an animation on the chat's backdrop
// paint under the messages. Runs where a Chromium and playwright-core are named:
//   OMB_UI_CHROMIUM=<chrome or headless shell> OMB_UI_PLAYWRIGHT_CORE=<playwright-core dir> OMB_UI_DIST=<vite build dir>
//   [OMB_UI_SHOTS=<folder for screenshots>] vitest run server/themes.ui.e2e.test.ts
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { WELCOME_VERSION } from "../electron/onboarding-record.mjs";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

const { OMB_UI_CHROMIUM: chromiumPath, OMB_UI_PLAYWRIGHT_CORE: playwrightPath, OMB_UI_DIST: dist, OMB_UI_SHOTS: shots } = process.env;
const ready = Boolean(chromiumPath && playwrightPath && dist);

let fixture: Awaited<ReturnType<typeof launchVerificationServer>>;
let browser: any;

beforeAll(async () => {
  if (!ready) return;
  vi.spyOn(console, "log").mockImplementation(() => {});
  fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true }, [], undefined, dist);
  const { chromium } = createRequire(join(playwrightPath!, "package.json"))("playwright-core");
  browser = await chromium.launch({ executablePath: chromiumPath, headless: true, args: ["--use-mock-keychain", "--password-store=basic"] });
  if (shots) mkdirSync(shots, { recursive: true });
}, 90_000);

afterAll(async () => {
  await browser?.close();
  await fixture?.close();
  vi.restoreAllMocks();
});

it.skipIf(!ready)("paints a theme live, lists it in Settings, and the reset keys and ?safe-look both get back", async () => {
  const url = fixture.info.url;
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${url}${path}`, { method, headers: { "content-type": "application/json", origin: url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: await res.json().catch(() => ({})) as any };
  };
  await api("PUT", "/api/config", { onboarding: { completedAt: new Date().toISOString(), version: WELCOME_VERSION } });
  await runControlOmb(["new-bot", "--name", "Scout", "--url", url]);
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  const remote: string[] = [];
  page.on("request", (request: any) => { if (!request.url().startsWith(url)) remote.push(request.url()); });
  await page.goto(url);
  await page.getByText("Scout", { exact: true }).first().waitFor();
  const skipTour = page.getByRole("button", { name: "Skip tour" });
  if (await skipTour.isVisible().catch(() => false)) await skipTour.click();

  const css = [
    '[data-look="chat"] { background-image: linear-gradient(120deg, rgb(11, 16, 32), rgb(60, 10, 70)); animation: glow 6s infinite alternate; }',
    '[data-look="composer"] { border-radius: 3px !important; outline: 2px solid rgb(255, 43, 214); }',
    "@keyframes glow { to { filter: hue-rotate(40deg); } }",
  ].join("\n");
  expect((await api("PUT", "/api/themes/leak", { theme: { name: "Leak", css: '[data-look="sidebar"] { background: url(https://example.com/a.png) }' } })).status).toBe(400);
  expect((await api("PUT", "/api/themes/neon", { theme: { name: "Neon", canvas: "#0b1020", accent: "#ff2bd6", css } })).status).toBe(200);
  expect((await api("PUT", "/api/themes/active", { id: "neon" })).status).toBe(200);

  const look = () => page.evaluate(`({
    app: getComputedStyle(document.documentElement).getPropertyValue("--color-app").trim(),
    theme: document.documentElement.dataset.theme ?? null,
    outline: getComputedStyle(document.querySelector('[data-look="composer"]')).outlineColor,
  })`);
  await expect.poll(look, { timeout: 15_000 }).toMatchObject({ app: "#0b1020", theme: "neon", outline: "rgb(255, 43, 214)" });
  if (shots) await page.screenshot({ path: join(shots, "theme-live.png") });

  await page.keyboard.press("Control+Alt+Shift+KeyR");
  await expect.poll(look, { timeout: 10_000 }).toMatchObject({ theme: null });
  await expect.poll(async () => (await api("GET", "/api/themes/active")).body.id, { timeout: 10_000 }).toBeNull();

  expect((await api("PUT", "/api/themes/active", { id: "neon" })).status).toBe(200);
  await expect.poll(look, { timeout: 15_000 }).toMatchObject({ theme: "neon" });
  const safe = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  await safe.goto(`${url}/?safe-look`);
  await safe.getByText("Scout", { exact: true }).first().waitFor();
  expect(await safe.evaluate("document.documentElement.dataset.theme ?? null")).toBeNull();
  await safe.close();

  expect(remote, remote.join("\n")).toEqual([]);
}, 120_000);

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

it.skipIf(!ready)("paints a theme's picture and animation on the chat's backdrop, under the messages and still while they scroll", async () => {
  const url = fixture.info.url;
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${url}${path}`, { method, headers: { "content-type": "application/json", origin: url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: await res.json().catch(() => ({})) as any };
  };
  await api("PUT", "/api/config", { onboarding: { completedAt: new Date().toISOString(), version: WELCOME_VERSION } });
  if (!(await api("GET", "/api/bots")).body.bots.some((one: { name: string }) => one.name === "Scout")) await runControlOmb(["new-bot", "--name", "Scout", "--url", url]);
  const css = [
    '[data-look="chat-backdrop"] { background: linear-gradient(rgb(255 0 0 / 0.5), rgb(255 0 0 / 0.5)), url("/api/theme-assets/sky/sky.png") center / cover no-repeat; }',
    '[data-look="chat-backdrop"]::before { content: ""; position: absolute; inset: -50%; background: conic-gradient(red, blue, red); opacity: 0.2; animation: bg-turn 60s linear infinite; }',
    "@keyframes bg-turn { to { transform: rotate(1turn); } }",
  ].join("\n");
  const imported = await api("POST", "/api/themes/import", { mausbotTheme: 1, id: "sky", theme: { name: "Sky", css }, assets: { "sky.png": `data:image/png;base64,${PNG}` } });
  expect(imported.status).toBeLessThan(300);
  expect((await api("PUT", "/api/themes/active", { id: imported.body.id })).status).toBe(200);
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  const pictures: number[] = [];
  page.on("response", (response: any) => { if (response.url().endsWith("/api/theme-assets/sky/sky.png")) pictures.push(response.status()); });
  await page.goto(url);
  await page.getByText("Scout", { exact: true }).first().waitFor();
  const skipTour = page.getByRole("button", { name: "Skip tour" });
  if (await skipTour.isVisible().catch(() => false)) await skipTour.click();
  for (let n = 0; n < 5 && await page.locator("[data-mausbot-welcome]").isVisible().catch(() => false); n++) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
  }
  const notNow = page.getByRole("button", { name: "Not now" });
  if (await notNow.isVisible().catch(() => false)) await notNow.click();
  await page.locator('[data-look="chat"]').first().waitFor();
  const probe = () => page.evaluate(`(() => {
    const chat = document.querySelector('[data-look="chat"]'), back = document.querySelector('[data-look="chat-backdrop"]');
    const box = chat.getBoundingClientRect(), b = back.getBoundingClientRect();
    // A point in the chat with no message on it: nothing between the pointer and the backdrop paints a background.
    const x = box.right - 40, y = box.top + box.height * 0.45;
    const stack = document.elementsFromPoint(x, y), above = stack.slice(0, stack.indexOf(chat));
    const opaque = above.filter((el) => el !== back && !back.contains(el) && getComputedStyle(el).backgroundColor !== "rgba(0, 0, 0, 0)" && getComputedStyle(el).backgroundColor !== "transparent");
    return { first: chat.firstElementChild === back, box: [b.top - box.top, b.height - box.height, b.width - box.width].map(Math.round), image: getComputedStyle(back).backgroundImage,
      hit: document.elementFromPoint(x, y) === back, opaque: opaque.map((el) => el.tagName), animations: back.getAnimations({ subtree: true }).length };
  })()`);
  await expect.poll(probe, { timeout: 15_000 }).toMatchObject({ first: true, box: [0, 0, 0], image: expect.stringContaining("/api/theme-assets/sky/sky.png"), hit: false, opaque: [], animations: 1 });
  await expect.poll(() => pictures.includes(200), { timeout: 10_000 }).toBe(true);
  if (shots) await page.screenshot({ path: join(shots, "theme-backdrop.png") });
  // Taken off, the backdrop is empty again: the default look has nothing on it.
  expect((await api("PUT", "/api/themes/active", { id: null })).status).toBe(200);
  await expect.poll(probe, { timeout: 10_000 }).toMatchObject({ image: "none", animations: 0 });
  await page.close();
}, 120_000);
