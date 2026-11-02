// Departments in the sidebar of the real app, against a disposable fake-engine server: dragging a bot to reorder it,
// onto another bot to start a department named in place, into and out of a department, and a bot's menu.
// Run: node --experimental-strip-types scripts/verify-sidebar-groups.ts [--shots <dir> [--only <view,view>]]
// With --shots it photographs each view with a headless Chrome in a throwaway profile (OMB_CDP_CHROME, else the
// installed Google Chrome) at twice 1280x800 and exits; without, it prints the preview's address and waits. Drags are
// the page's own DragEvents with a DataTransfer, so a view can stop mid-drag to show where the bot would land.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";
import { fixtureApi, mountPreview, parkUntilSignal, type MountedPreview } from "./testing/preview-fixture.ts";

const at = process.argv.indexOf("--shots");
const shots = at === -1 ? null : resolve(process.argv[at + 1] ?? "");
const onlyAt = process.argv.indexOf("--only");
const only = onlyAt === -1 ? null : new Set((process.argv[onlyAt + 1] ?? "").split(",").filter(Boolean));
const CHROME = process.env.OMB_CDP_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const [WIDTH, HEIGHT, CLIP] = [1280, 800, 640];
const BOTS: Record<string, string> = { Research: "pink", Inbox: "teal", Writer: "yellow", Travel: "blue", Recipes: "coral" };
const NAMES = Object.keys(BOTS);

type Setup = "plain" | "departments" | "full";
/** Each view: the server's state, the mode, a script run in the page once a bot row shows, and what must show after. */
const VIEWS: Array<{ name: string; setup: Setup; mode: "simple" | "advanced"; act?: string; ready?: string; skins?: string[]; wide?: true }> = [
  { name: "rest-simple", setup: "plain", mode: "simple", skins: ["daylight", "midnight"] },
  { name: "departments-simple", setup: "departments", mode: "simple", skins: ["daylight", "midnight"] },
  { name: "departments-advanced", setup: "departments", mode: "advanced" },
  { name: "menu-simple", setup: "departments", mode: "simple", act: "menu('Inbox')", ready: "[data-bot-menu]" },
  { name: "menu-move-simple", setup: "departments", mode: "simple", act: "menu('Inbox'); await pause(300); document.querySelector('[data-bot-menu-move]').click()", ready: "[data-bot-menu-flyout='move']", skins: ["daylight", "midnight"] },
  { name: "menu-move-member-simple", setup: "departments", mode: "simple", act: "menu('Writer'); await pause(300); document.querySelector('[data-bot-menu-move]').click()", ready: "[data-bot-menu-flyout='move']" },
  { name: "drag-line-simple", setup: "plain", mode: "simple", act: "start('Inbox'); over(row('Travel'), 0.15)", ready: "[data-bot-drop='before']", skins: ["daylight", "midnight"] },
  { name: "drag-group-simple", setup: "plain", mode: "simple", act: "start('Inbox'); over(row('Writer'), 0.5)", ready: "[data-bot-drop='group']", skins: ["daylight", "midnight"] },
  { name: "naming-simple", setup: "plain", mode: "simple", act: "start('Inbox'); over(row('Writer'), 0.5); drop(row('Writer'), 0.5)", ready: "[data-section-name-field]", skins: ["daylight", "midnight"] },
  { name: "named-simple", setup: "plain", mode: "simple", act: "start('Inbox'); over(row('Writer'), 0.5); drop(row('Writer'), 0.5); await pause(300); type('Writing'); enter()", ready: "[data-section='Writing']" },
  { name: "drag-into-simple", setup: "departments", mode: "simple", act: "start('Inbox'); over(header('Work'), 0.5)", ready: "[data-section-drop]", skins: ["daylight", "midnight"] },
  { name: "drag-out-simple", setup: "departments", mode: "simple", act: "start('Travel'); over(row('Inbox'), 0.85)", ready: "[data-bot-drop='after']" },
  { name: "drag-slot-simple", setup: "full", mode: "simple", act: "start('Travel'); await pause(300); over(document.querySelector('[data-bot-drop-slot]'), 0.5)", ready: "[data-bot-drop-slot][class*='border-accent']" },
  { name: "drag-line-advanced", setup: "departments", mode: "advanced", act: "start('Inbox'); over(row('Writer'), 0.85)", ready: "[data-bot-drop='after']", skins: ["midnight"] },
  { name: "rename-simple", setup: "departments", mode: "simple", act: "teamMenu('Work'); await pause(300); item('Rename department').click()", ready: "[data-section-name-field]" },
  { name: "delete-simple", setup: "departments", mode: "simple", act: "teamMenu('Work'); await pause(300); item('Delete department').click()", ready: "[role='dialog'], [role='alertdialog']", wide: true },
];

/** Page helpers the acts above call; bot ids come from the fixture. */
const helpers = (ids: Record<string, string>) => `
  const ids = ${JSON.stringify(ids)};
  const pause = (ms) => new Promise((done) => setTimeout(done, ms));
  const row = (name) => document.querySelector('[data-sidebar-bot-row="' + ids[name] + '"]');
  const header = (name) => document.querySelector('[data-section="' + name + '"]');
  const item = (label) => [...document.querySelectorAll('[role="menuitem"]')].find((node) => node.textContent.trim() === label);
  let dt = null, source = null;
  const fire = (node, type, fraction) => {
    const box = node.getBoundingClientRect();
    node.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: box.left + box.width / 2, clientY: box.top + box.height * fraction }));
  };
  const start = (name) => { dt = new DataTransfer(); source = row(name); fire(source, "dragstart", 0.5); };
  const over = (node, fraction) => { fire(node, "dragenter", fraction); fire(node, "dragover", fraction); };
  const drop = (node, fraction) => { fire(node, "drop", fraction); fire(source, "dragend", 0.5); };
  const menu = (name) => { const box = row(name).getBoundingClientRect(); row(name).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: box.left + 60, clientY: box.top + box.height / 2 })); };
  const teamMenu = (name) => { const box = header(name).getBoundingClientRect(); header(name).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: box.left + 40, clientY: box.bottom })); };
  const type = (text) => {
    const field = document.activeElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const enter = () => document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
`;

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
    const timer = setTimeout(() => { waiting.delete(id); fail(new Error(`${method} got no answer`)); }, 30_000);
    waiting.set(id, { done: (value) => { clearTimeout(timer); done(value); }, fail: (error) => { clearTimeout(timer); fail(error); } });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression: string) => {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result?.value;
  };
  const until = async (condition: string, what: string) => {
    const end = Date.now() + 60_000;
    while (!(await evaluate(condition).catch(() => false))) {
      if (Date.now() > end) throw new Error(`${what} never showed`);
      await delay(250);
    }
  };
  return {
    async shoot(url: string, file: string, act: string | undefined, ready: string | undefined, ids: Record<string, string>, width = CLIP) {
      await send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 2, mobile: false });
      await send("Page.navigate", { url });
      await until(`Boolean(document.querySelector('[data-sidebar-bot-row="${ids.Inbox}"]'))`, `${url}: the bot rows`);
      await delay(900);
      if (act) await evaluate(`(async () => { ${helpers(ids)}\n${act}; })()`);
      if (ready) await until(`Boolean(document.querySelector(${JSON.stringify(ready)}))`, `${url}: ${ready}`);
      await delay(700);
      const { data } = await send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width, height: HEIGHT, scale: 1 } });
      writeFileSync(file, Buffer.from(data, "base64"));
    },
    close() { socket.close(); chrome.kill(); },
  };
}

const fixture = await launchVerificationServer();
let ui: MountedPreview | undefined;
try {
  const api = fixtureApi(fixture.info.url, { headers: { origin: fixture.info.url } });
  for (const name of NAMES) await runControlOmb(["new-bot", "--name", name, "--url", fixture.info.url]);
  await api("PATCH", "/api/config", { language: "en" });
  const { bots } = await api("GET", "/api/bots?messages=0") as { bots: Array<{ id: string; name: string }> };
  const ids = Object.fromEntries(NAMES.map((name) => [name, bots.find((bot) => bot.name === name)!.id]));
  for (const name of NAMES) await api("PATCH", `/api/bots/${ids[name]}`, { color: BOTS[name] });
  const fleet = bots.map((bot) => bot.id);
  const setUp = async (setup: Setup) => {
    for (const section of (await api("GET", "/api/sidebar-sections")).sections as string[]) {
      await api("DELETE", `/api/sidebar-sections?section=${encodeURIComponent(section)}`);
    }
    await api("PUT", "/api/bots/order", { botIds: fleet });
    if (setup === "plain") return;
    await api("POST", "/api/sidebar-sections", { name: "Work", botIds: [ids.Research, ids.Writer, ...(setup === "full" ? [ids.Inbox] : [])] });
    await api("POST", "/api/sidebar-sections", { name: "Home", botIds: [ids.Travel, ids.Recipes] });
  };
  ui = await mountPreview(fixture, { entry: "/scripts/testing/sidebar-groups-preview.tsx", route: "/__sidebar-groups.html", title: "Isolated sidebar departments", logLevel: "warn" });
  if (!shots) {
    await setUp("departments");
    console.log(JSON.stringify({ ...fixture.info, previewUrl: ui.previewUrl, ids }, null, 2));
    await parkUntilSignal();
  } else {
    mkdirSync(shots, { recursive: true });
    const profile = mkdtempSync(join(tmpdir(), "omb-groups-chrome-"));
    const chrome = await openChrome(profile);
    try {
      for (const view of VIEWS.filter((entry) => !only || only.has(entry.name))) for (const skin of view.skins ?? ["daylight"]) {
        const file = join(shots, `${view.name}-${skin}.png`);
        for (let attempt = 1; ; attempt++) {
          try {
            await setUp(view.setup);
            await chrome.shoot(`${ui.previewUrl}?mode=${view.mode}&skin=${skin}`, file, view.act, view.ready, ids, view.wide ? WIDTH : CLIP);
            break;
          } catch (error) {
            if (attempt === 2) throw error;
            console.error(`retrying ${view.name}-${skin}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        console.log(file);
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
