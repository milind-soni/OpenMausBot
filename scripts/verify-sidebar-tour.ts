// The tour of the rail of places in the real app, beside the real rail page, against a disposable fake-engine server
// whose bots have answered once (so the queue reaches the tour). Each view loads the page and photographs every step as
// the tour moves on by itself, in a light and a dark skin.
// Run: node --experimental-strip-types scripts/verify-sidebar-tour.ts [--shots <dir> [--only <view,view>]]
// With --shots it photographs with a headless Chrome in a throwaway profile (OMB_CDP_CHROME, else the installed Google
// Chrome) at twice the window's size, and fails if a step never shows; without, it prints the preview's address and waits.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";
import { mountPreview, parkUntilSignal, type MountedPreview } from "./testing/preview-fixture.ts";

const at = process.argv.indexOf("--shots");
const shots = at === -1 ? null : resolve(process.argv[at + 1] ?? "");
const onlyAt = process.argv.indexOf("--only");
const only = onlyAt === -1 ? null : new Set((process.argv[onlyAt + 1] ?? "").split(",").filter(Boolean));
const CHROME = process.env.OMB_CDP_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const TOUR_NOTICE = "sidebar-tour-2026-11";
/** Each view: its query, the steps it must show in order, and the window's size. */
const VIEWS: Array<{ name: string; query: string; steps: string[]; width?: number; height?: number }> = [
  { name: "advanced", query: "", steps: ["places", "add", "menu", "strip"] },
  { name: "simple", query: "mode=simple", steps: ["places", "add", "menu", "strip"] },
  { name: "computer", query: "place=computer&mode=simple", steps: ["places", "add", "menu", "strip"] },
  { name: "hidden", query: "hidden=1", steps: ["strip"] },
  { name: "narrow", query: "mode=simple", steps: ["places", "add", "menu", "strip"], width: 720, height: 760 },
];
const SKINS = [{ id: "daylight", look: "light" }, { id: "midnight", look: "dark" }];

async function openChrome(profile: string) {
  const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check", "--use-mock-keychain",
    `--user-data-dir=${profile}`, "--remote-debugging-port=0", "about:blank"], { stdio: "ignore" });
  let port = "";
  for (let i = 0; i < 100 && !port; i++) {
    await delay(100);
    try { port = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]!.trim(); } catch {}
  }
  if (!port) { chrome.kill(); throw new Error("Chrome did not start"); }
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
  const socket = new WebSocket(targets.find((target) => target.type === "page")!.webSocketDebuggerUrl);
  await new Promise((done, fail) => { socket.onopen = done; socket.onerror = fail; });
  let next = 0;
  const waiting = new Map<number, { done: (value: any) => void; fail: (error: Error) => void }>();
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    const call = waiting.get(message.id);
    if (!call) return;
    waiting.delete(message.id);
    if (message.error) call.fail(new Error(message.error.message)); else call.done(message.result);
  };
  const send = (method: string, params: object = {}) => new Promise<any>((done, fail) => {
    const id = ++next;
    waiting.set(id, { done, fail });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression: string) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.value;
  return {
    /** Loads the view and photographs each step once its card is up; the tour moves on by itself. */
    async tour(url: string, steps: string[], file: (step: string) => string, width = 1280, height = 800) {
      await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: false });
      await send("Page.navigate", { url });
      for (const step of steps) {
        const end = Date.now() + 60_000;
        while (!(await evaluate(`document.querySelector('[data-sidebar-tour="${step}"]') !== null`).catch(() => false))) {
          if (Date.now() > end) throw new Error(`${url}: the ${step} step never showed`);
          await delay(150);
        }
        await delay(900);
        const { data } = await send("Page.captureScreenshot", { format: "png" });
        writeFileSync(file(step), Buffer.from(data, "base64"));
        console.log(file(step));
      }
    },
    close() { socket.close(); chrome.kill(); },
  };
}

const fixture = await launchVerificationServer();
const api = async (path: string, init?: RequestInit) => {
  const answer = await fetch(`${fixture.info.url}${path}`, { ...init, headers: { "content-type": "application/json", origin: fixture.info.url, ...init?.headers } });
  if (!answer.ok) throw new Error(`${path}: ${answer.status} ${await answer.text()}`);
  return answer.json();
};
/** The tour is once: each view starts with it unseen in the workspace's record. */
const forgetTour = async () => {
  const config = await api("/api/config") as { onboarding?: { hintsSeen?: string[] } };
  const hintsSeen = (config.onboarding?.hintsSeen ?? []).filter((id) => id !== TOUR_NOTICE);
  await api("/api/config", { method: "PUT", body: JSON.stringify({ onboarding: { hintsSeen } }) });
};
let ui: MountedPreview | undefined;
try {
  for (const name of ["Chief of Staff", "Research", "Inbox"]) await runControlOmb(["new-bot", "--name", name, "--url", fixture.info.url]);
  // A bot has answered: no first chat to keep quiet. MausBot has been introduced, so its first-launch card isn't due.
  await runControlOmb(["run", "Inbox", "Say hello", "--url", fixture.info.url, "--timeout", "2m"]);
  const { bots } = await api("/api/bots") as { bots: Array<{ id: string; defaultBot?: unknown }> };
  for (const bot of bots.filter((entry) => entry.defaultBot)) await api(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ welcomed: true }) });
  ui = await mountPreview(fixture, { entry: "/scripts/testing/sidebar-tour-preview.tsx", route: "/__sidebar-tour.html", title: "Isolated tour of the rail", logLevel: "warn" });
  if (!shots) {
    console.log(JSON.stringify({ ...fixture.info, previewUrl: ui.previewUrl }, null, 2));
    await parkUntilSignal();
  } else {
    mkdirSync(shots, { recursive: true });
    const profile = mkdtempSync(join(tmpdir(), "omb-tour-chrome-"));
    const chrome = await openChrome(profile);
    try {
      for (const view of VIEWS.filter((entry) => !only || only.has(entry.name))) for (const skin of SKINS) {
        await forgetTour();
        await chrome.tour(`${ui.previewUrl}?skin=${skin.id}${view.query ? `&${view.query}` : ""}`, view.steps,
          (step) => join(shots, `${view.name}-${step}-${skin.look}.png`), view.width, view.height);
      }
    } finally {
      chrome.close();
      await delay(500);
      rmSync(profile, { recursive: true, force: true });
    }
  }
} finally {
  await ui?.close();
  await fixture.close();
}
