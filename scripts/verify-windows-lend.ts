// What a person sees when their own Cloud can't use their PC: the taskbar icon's menu as the real module builds it, the
// card a Cloud's bot raises in the real chat, and the PC's own screen-control status in the real panel.
// Run: node --experimental-strip-types scripts/verify-windows-lend.ts --shots <dir>
// It photographs each view in a light and a dark look with a headless Chrome in a throwaway profile (OMB_CDP_CHROME,
// else the installed Google Chrome), then exits. Nothing here touches this computer's lending or the person's app.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { mountPreview, type MountedPreview } from "./testing/preview-fixture.ts";
import { createLendingIndicator } from "../electron/lending-indicator.mjs";

const at = process.argv.indexOf("--shots");
if (at === -1) throw new Error("--shots <dir> is required");
const shots = resolve(process.argv[at + 1] ?? "");
const CHROME = process.env.OMB_CDP_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ICON = `data:image/png;base64,${readFileSync(new URL("../electron/resources/app-icon.png", import.meta.url)).toString("base64")}`;

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
    async shoot(url: string, ready: string, file: string, { width = 1100, height = 760, dark = false } = {}) {
      await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: false });
      await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] });
      await send("Page.navigate", { url });
      const end = Date.now() + 60_000;
      while (!(await evaluate(`Boolean(document.querySelector(${JSON.stringify(ready)}))`).catch(() => false))) {
        if (Date.now() > end) throw new Error(`${url.slice(0, 80)}: ${ready} never showed`);
        await delay(250);
      }
      await delay(900);
      const { data } = await send("Page.captureScreenshot", { format: "png" });
      writeFileSync(file, Buffer.from(data, "base64"));
    },
    close() { socket.close(); chrome.kill(); },
  };
}

const escape = (value: string) => value.replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]!);

type MenuItem = { label?: string; type?: string; enabled?: boolean };
/** The taskbar icon as the real module builds it for a PC whose screen control isn't running, its menu open. */
function taskbar(screen: { ready: boolean; lent: boolean; reason: string; fix: string | null }): string {
  const trays: Array<{ tip: string; menu: MenuItem[] }> = [];
  class Tray {
    tip = ""; menu: MenuItem[] = [];
    constructor() { trays.push(this); }
    on() {} setToolTip(value: string) { this.tip = value; } setTitle() {}
    setContextMenu(menu: MenuItem[]) { this.menu = menu; } isDestroyed() { return false; } destroy() {}
  }
  createLendingIndicator({ Tray, Menu: { buildFromTemplate: (items: unknown) => items }, nativeImage: { createFromPath: () => ({ resize: () => ({}) }) }, iconPath: "",
    onPause: () => {}, onResume: () => {}, onActivity: () => {}, onTerminal: () => {}, onStartScreen: () => {}, device: "PC" }).update({ clouds: ["My Cloud"], using: [], paused: false, screen });
  const tray = trays.at(-1)!;
  const items = tray.menu.map((item) => item.type === "separator" ? "<hr>" : item.type === "checkbox"
    ? `<div class="item"><span class="box"></span>${escape(item.label ?? "")}</div>`
    : `<div class="item${item.enabled === false ? " quiet" : ""}${/^(Start|Turn on|Allow) screen control/.test(item.label ?? "") ? " fix" : ""}">${escape(item.label ?? "")}</div>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
:root { color-scheme: light dark; --bar: rgba(243,243,243,.94); --ink: #1b1b1b; --quiet: #6b6b6b; --menu: #f9f9f9; --line: rgba(0,0,0,.1); --desk: linear-gradient(160deg,#b9d3ee,#e7ecf3); --accent: #005fb8; }
@media (prefers-color-scheme: dark) { :root { --bar: rgba(32,32,32,.94); --ink: #f3f3f3; --quiet: #a6a6a6; --menu: #2c2c2c; --line: rgba(255,255,255,.12); --desk: linear-gradient(160deg,#1c2b3a,#101418); --accent: #60cdff; } }
body { margin: 0; height: 100vh; background: var(--desk); font: 14px "Segoe UI", system-ui, -apple-system, sans-serif; color: var(--ink); }
.bar { position: absolute; bottom: 0; left: 0; right: 0; height: 48px; background: var(--bar); display: flex; justify-content: flex-end; align-items: center; gap: 14px; padding: 0 16px; border-top: 1px solid var(--line); }
.tray { display: flex; align-items: center; padding: 6px; border-radius: 6px; background: var(--line); } .tray img { width: 20px; height: 20px; }
.clock { text-align: right; font-size: 12px; line-height: 16px; }
.menu { position: absolute; right: 96px; bottom: 56px; min-width: 360px; padding: 4px; border-radius: 8px; background: var(--menu); box-shadow: 0 8px 28px rgba(0,0,0,.28); border: 1px solid var(--line); }
.item { padding: 8px 12px; border-radius: 4px; } .quiet { color: var(--quiet); } .fix { color: var(--accent); font-weight: 600; background: var(--line); }
.box { display: inline-block; width: 12px; height: 12px; border: 1px solid var(--quiet); border-radius: 3px; margin-right: 8px; vertical-align: -1px; }
hr { border: 0; border-top: 1px solid var(--line); margin: 4px 8px; }
.tip { position: absolute; right: 60px; bottom: 56px; display: none; }
</style></head><body><div class="menu" data-menu>${items}</div><div class="bar"><div class="tray" title="${escape(tray.tip)}"><img src="${ICON}" alt=""></div><div class="clock">10:42<br>31-10-2026</div></div></body></html>`;
}

const data = (html: string) => `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
const SKINS = [{ id: "daylight", look: "light", dark: false }, { id: "midnight", look: "dark", dark: true }];
const MENUS = [
  { name: "taskbar-not-running", screen: { ready: false, lent: false, reason: "not-running", fix: "start" } },
  { name: "taskbar-blocked", screen: { ready: false, lent: false, reason: "blocked", fix: "start" } },
];
const VIEWS = [
  { name: "card-asking", query: "view=asking", ready: "[data-ask-card]" },
  { name: "card-closed", query: "view=closed", ready: "[data-ask-card]" },
  { name: "card-failed", query: "view=failed", ready: "[data-ask-card]" },
  { name: "card-on", query: "view=on", ready: "[data-computer-ask='on']" },
  { name: "pc-status", query: "view=pc", ready: "[data-windows-local-control]", width: 560, height: 360 },
];

mkdirSync(shots, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), "omb-windows-lend-chrome-"));
const chrome = await openChrome(profile);
let ui: MountedPreview | undefined;
try {
  for (const skin of SKINS) {
    for (const { name, screen } of MENUS) {
      const file = join(shots, `${name}-${skin.look}.png`);
      await chrome.shoot(data(taskbar(screen)), "[data-menu]", file, { width: 640, height: 360, dark: skin.dark });
      console.log(file);
    }
  }
  // The page asks no server for anything: its store is fixed and every /api call is answered in the page.
  ui = await mountPreview({ info: { url: "http://127.0.0.1:9" } }, { entry: "/src/computer-ask-preview.tsx", route: "/__computer-ask.html", title: "Turn on your computer", logLevel: "warn" });
  for (const view of VIEWS) for (const skin of SKINS) {
    const file = join(shots, `${view.name}-${skin.look}.png`);
    await chrome.shoot(`${ui.previewUrl}?skin=${skin.id}&${view.query}`, view.ready, file, { dark: skin.dark, ...(view.width ? { width: view.width, height: view.height } : {}) });
    console.log(file);
  }
} finally {
  chrome.close();
  await ui?.close();
  await delay(500);
  rmSync(profile, { recursive: true, force: true });
}
