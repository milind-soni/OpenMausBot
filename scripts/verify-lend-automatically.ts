// This computer working for each Cloud of the person's own, with nothing to set: the menu-bar item's states and its
// activity window drawn from the real modules, and Settings → MausBot Cloud on this computer's page and on My Cloud's
// own page in the real app, against a disposable fake-engine server.
// Run: node --experimental-strip-types scripts/verify-lend-automatically.ts --shots <dir>
// It photographs each view in a light and a dark look with a headless Chrome in a throwaway profile (OMB_CDP_CHROME,
// else the installed Google Chrome), then exits. Nothing here touches this computer's own lending or the person's app.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";
import { mountPreview, type MountedPreview } from "./testing/preview-fixture.ts";
import { activityPage } from "../electron/lending-activity-window.mjs";
import { createLendingIndicator } from "../electron/lending-indicator.mjs";

const at = process.argv.indexOf("--shots");
const shots = resolve(at === -1 ? "" : process.argv[at + 1] ?? "");
if (at === -1) throw new Error("--shots <dir> is required");
const CHROME = process.env.OMB_CDP_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ICON = `data:image/png;base64,${readFileSync(new URL("../electron/resources/app-icon.png", import.meta.url)).toString("base64")}`;

/** One page of a headless Chrome over the DevTools protocol: navigate, wait for a selector, photograph. */
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
    evaluate,
    async shoot(url: string, ready: string, file: string, { width = 1280, height = 800, dark = false } = {}) {
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

/** The menu-bar item as the real module builds it for `view`: its title beside the icon and its menu, open. */
function menuBar(view: { clouds: string[]; using: string[]; paused: boolean }): string {
  const trays: Array<{ title: string; menu: Array<{ label?: string; type?: string; enabled?: boolean }> }> = [];
  class Tray {
    title = ""; tip = ""; menu: Array<{ label?: string; type?: string; enabled?: boolean }> = [];
    constructor() { trays.push(this); }
    on() {} setToolTip(value: string) { this.tip = value; } setTitle(value: string) { this.title = value; }
    setContextMenu(menu: Array<{ label?: string; type?: string; enabled?: boolean }>) { this.menu = menu; } isDestroyed() { return false; } destroy() {}
  }
  createLendingIndicator({ Tray, Menu: { buildFromTemplate: (items: unknown) => items }, nativeImage: { createFromPath: () => ({ resize: () => ({}) }) }, iconPath: "",
    onPause: () => {}, onResume: () => {}, onActivity: () => {}, device: "Mac" }).update(view);
  const tray = trays.at(-1)!;
  const items = tray.menu.map((item) => item.type === "separator" ? '<hr>' : `<div class="item${item.enabled === false ? " quiet" : ""}">${escape(item.label ?? "")}</div>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
:root { color-scheme: light dark; --bar: rgba(246,246,246,.92); --ink: #1d1d1f; --quiet: #8e8e93; --menu: rgba(236,236,236,.97); --line: rgba(0,0,0,.12); --desk: linear-gradient(160deg,#c9d6ff,#e2e2e2); }
@media (prefers-color-scheme: dark) { :root { --bar: rgba(30,30,32,.92); --ink: #f5f5f7; --quiet: #8e8e93; --menu: rgba(44,44,46,.97); --line: rgba(255,255,255,.14); --desk: linear-gradient(160deg,#1f2937,#111827); } }
body { margin: 0; height: 100vh; background: var(--desk); font: 13px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; color: var(--ink); }
.bar { height: 26px; background: var(--bar); display: flex; justify-content: flex-end; align-items: center; gap: 14px; padding: 0 14px; backdrop-filter: blur(20px); }
.tray { display: flex; align-items: center; gap: 5px; padding: 1px 7px; border-radius: 5px; background: var(--line); }
.tray img { width: 16px; height: 16px; } .clock { color: var(--ink); }
.menu { position: absolute; right: 74px; top: 30px; min-width: 250px; padding: 5px; border-radius: 9px; background: var(--menu); box-shadow: 0 10px 30px rgba(0,0,0,.25); border: 1px solid var(--line); }
.item { padding: 4px 10px; border-radius: 5px; } .item:not(.quiet):nth-of-type(2) { background: #0a84ff; color: white; } .quiet { color: var(--quiet); }
hr { border: 0; border-top: 1px solid var(--line); margin: 5px 8px; }
</style></head><body><div class="bar"><div class="tray" data-tray><img src="${ICON}" alt="">${tray.title ? `<span>${escape(tray.title)}</span>` : ""}</div><span class="clock">Wed 29 Oct 10:42</span></div><div class="menu">${items}</div></body></html>`;
}

const ENTRIES = [
  { at: Date.UTC(2026, 9, 29, 9, 41), server: "Client A", origin: "https://omb-c-client-a.fly.dev", action: "write_file", detail: "me/Documents/Proposal.md", ok: true },
  { at: Date.UTC(2026, 9, 29, 9, 40), server: "Client A", origin: "https://omb-c-client-a.fly.dev", action: "read_file", detail: "me/Documents/Brief.md", ok: true },
  { at: Date.UTC(2026, 9, 29, 9, 31), server: "My Cloud", origin: "https://omb-u-fixture.fly.dev", action: "internet", detail: "www.instagram.com", ok: true },
  { at: Date.UTC(2026, 9, 29, 9, 30), server: "My Cloud", origin: "https://omb-u-fixture.fly.dev", action: "read_file", detail: "me/.ssh/id_ed25519", ok: false, error: "Desktop credentials and sharing settings cannot be accessed through a shared folder" },
  { at: Date.UTC(2026, 9, 29, 9, 12), server: "My Cloud", origin: "https://omb-u-fixture.fly.dev", action: "computer_call", detail: "click", ok: true },
  { at: Date.UTC(2026, 9, 29, 9, 11), server: "My Cloud", origin: "https://omb-u-fixture.fly.dev", action: "chrome", detail: "", ok: true },
];
const data = (html: string) => `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
const MENU_BAR = [
  { name: "menubar-idle", view: { clouds: ["My Cloud", "Client A"], using: [], paused: false } },
  { name: "menubar-in-use", view: { clouds: ["My Cloud", "Client A"], using: ["Client A"], paused: false } },
  { name: "menubar-paused", view: { clouds: ["My Cloud", "Client A"], using: [], paused: true } },
];
const SETTINGS = [
  { name: "settings-this-computer", query: "page=local", ready: '[data-cloud-home="ready"]' },
  { name: "settings-my-cloud", query: "page=cloud", ready: '[data-cloud-plan="paid"]' },
];
const SKINS = [{ id: "daylight", look: "light", dark: false }, { id: "midnight", look: "dark", dark: true }];

mkdirSync(shots, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), "omb-lend-auto-chrome-"));
const chrome = await openChrome(profile);
const fixture = await launchVerificationServer();
let ui: MountedPreview | undefined;
try {
  for (const skin of SKINS) {
    for (const { name, view } of MENU_BAR) {
      const file = join(shots, `${name}-${skin.look}.png`);
      await chrome.shoot(data(menuBar(view)), "[data-tray]", file, { width: 560, height: 220, dark: skin.dark });
      console.log(file);
    }
    const file = join(shots, `activity-${skin.look}.png`);
    await chrome.shoot(data(activityPage(ENTRIES, "en")), "ul", file, { width: 560, height: 520, dark: skin.dark });
    console.log(file);
  }
  for (const name of ["Chief of Staff", "Research"]) await runControlOmb(["new-bot", "--name", name, "--url", fixture.info.url]);
  ui = await mountPreview(fixture, { entry: "/scripts/testing/lend-automatically-preview.tsx", route: "/__lend-automatically.html", title: "Isolated lending settings", logLevel: "warn" });
  for (const view of SETTINGS) for (const skin of SKINS) {
    const file = join(shots, `${view.name}-${skin.look}.png`);
    await chrome.shoot(`${ui.previewUrl}?skin=${skin.id}&${view.query}`, view.ready, file, { height: 900, dark: skin.dark });
    const lending = await chrome.evaluate(`[...document.querySelectorAll("[data-cloud-lending], [data-lending-for], [data-lend-this-computer], [data-lent-computers]")].length + (/Let my bots use this|Which Cloud|Computers shared with the Cloud/.test(document.body.innerText) ? 1 : 0)`);
    if (lending !== 0) throw new Error(`${view.name}: a lending card is on screen`);
    console.log(file);
  }
} finally {
  chrome.close();
  await ui?.close();
  await fixture.close();
  await delay(500);
  rmSync(profile, { recursive: true, force: true });
}
