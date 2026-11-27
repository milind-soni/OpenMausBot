// Renders the talk box (electron/talk-panel.mjs) in headless Chrome for every state, light and dark, into
// docs/verification/evidence/talk-shortcut/. The viewport is the box's own window: 400 px wide and as tall as the card,
// 56 to 240 px, at 2x. Each skin is rendered with macOS's appearance emulated the other way round, so the pictures show
// the box following the app's skin. Reduced motion is on, so the listening ring is still.
//
//   node scripts/talk-box-evidence.mjs [path to Chrome]
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { replyPreview, TALK_PANEL, talkPanelHtml } from "../electron/talk-panel.mjs";
import { TALK_TEXT } from "../electron/talk-session.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = join(root, "docs/verification/evidence/talk-shortcut");
const chrome = process.argv[2] ?? process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const asked = "what's on my calendar today";
const STATES = [
  ["listening", { state: "listening", text: "" }],
  ["listening-words", { state: "listening", text: asked }],
  ["sending", { state: "sending", text: asked }],
  ["thinking", { state: "thinking", text: asked }],
  ["reply", { state: "reply", text: "Standup at 10, then lunch with Sam at 1. Nothing after 4." }],
  ["reply-long", { state: "reply", text: "Here is a fairly long answer so the card grows. ".repeat(12) }],
  ["reply-wide", { state: "reply", text: "今日の予定は十時のスタンドアップと一時のランチです。".repeat(20) }],
  ["needs-you", { state: "needs-you", text: "Approve the file write to ~/Desktop/report.md" }],
  ["still-working", { state: "still-working", text: "" }],
  ["error", { state: "error", text: TALK_TEXT.moved }],
];
const BACKDROP = { light: { r: 222, g: 222, b: 222, a: 1 }, dark: { r: 40, g: 40, b: 40, a: 1 } };

const scratch = mkdtempSync(join(tmpdir(), "talk-box-evidence-"));
/** The mascot at the 56 px the app inlines (talk-panel.mjs resizes it with nativeImage; here macOS's sips does). */
function mascot() {
  const icon = join(root, "electron/resources/app-icon.png"), small = join(scratch, "mascot.png");
  try {
    execFileSync("sips", ["-z", "56", "56", icon, "--out", small], { stdio: "ignore" });
    return readFileSync(small).toString("base64");
  } catch {
    return readFileSync(icon).toString("base64");
  }
}

async function devtools(profile) {
  for (let i = 0; i < 200; i += 1) {
    try {
      const [port] = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n");
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = pages.find((target) => target.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("Chrome did not open its DevTools port");
}

function session(url) {
  const socket = new WebSocket(url);
  const waiting = new Map(), events = new Map();
  let next = 0;
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.id && waiting.has(message.id)) {
      const { resolve, reject } = waiting.get(message.id);
      waiting.delete(message.id);
      if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
    } else events.get(message.method)?.();
  });
  return {
    opened: new Promise((resolve, reject) => { socket.addEventListener("open", resolve); socket.addEventListener("error", reject); }),
    send: (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++next;
      waiting.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    }),
    once: (method) => new Promise((resolve) => events.set(method, () => { events.delete(method); resolve(); })),
    close: () => socket.close(),
  };
}

const profile = join(scratch, "profile");
const browser = spawn(chrome, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
try {
  const cdp = session(await devtools(profile));
  await cdp.opened;
  await cdp.send("Page.enable");
  const page = `data:text/html;charset=utf-8,${encodeURIComponent(talkPanelHtml(mascot()))}`;
  for (const theme of ["light", "dark"]) {
    await cdp.send("Emulation.setEmulatedMedia", { features: [
      { name: "prefers-color-scheme", value: theme === "light" ? "dark" : "light" },
      { name: "prefers-reduced-motion", value: "reduce" },
    ] });
    await cdp.send("Emulation.setDefaultBackgroundColorOverride", { color: BACKDROP[theme] });
    for (const [name, view] of STATES) {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: TALK_PANEL.width, height: TALK_PANEL.maxHeight, deviceScaleFactor: 2, mobile: false });
      const loaded = cdp.once("Page.loadEventFired");
      await cdp.send("Page.navigate", { url: page });
      await loaded;
      const { result } = await cdp.send("Runtime.evaluate", { expression: `render(${JSON.stringify({ ...view, text: replyPreview(view.text), theme })})`, returnByValue: true });
      const height = Math.min(TALK_PANEL.maxHeight, Math.max(TALK_PANEL.minHeight, result.value));
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: TALK_PANEL.width, height, deviceScaleFactor: 2, mobile: false });
      const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
      writeFileSync(join(out, `${theme}-${name}.png`), Buffer.from(data, "base64"));
      console.log(`${theme}-${name}.png  card ${result.value} px, box ${height} px`);
    }
  }
  cdp.close();
} finally {
  if (browser.exitCode === null) {
    const exited = new Promise((resolve) => browser.once("exit", resolve));
    browser.kill();
    await exited;
  }
  rmSync(scratch, { recursive: true, force: true });
}
