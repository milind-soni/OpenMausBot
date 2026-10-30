import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import test, { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { TALK_LABELS, TALK_PANEL, createTalkPanel, isTalkPanel, replyPreview, talkPanelBounds, talkPanelHtml } from "./talk-panel.mjs";

const flush = () => new Promise(resolve => setImmediate(resolve));
const pick = (object, keys) => Object.fromEntries(keys.map(key => [key, object[key]]));

const APP_ICON = fileURLToPath(new URL("./resources/app-icon.png", import.meta.url));

function harness({ cursor = { x: 100, y: 100 }, workArea = { x: 0, y: 25, width: 1440, height: 875 }, loadFails = false, boundsFail = false, iconPath = APP_ICON, theme } = {}) {
  const made = [];
  const resized = [];
  const nativeImage = {
    createFromPath: path => ({
      isEmpty: () => !existsSync(path),
      resize: size => { resized.push(size); return { toPNG: () => Buffer.from(`png ${size.width}x${size.height}`) }; },
    }),
  };
  class FakeBrowserWindow {
    constructor(options) {
      const { x, y, width, height } = options;
      Object.assign(this, { options, url: "", bounds: { x, y, width, height }, calls: [], destroyed: false, openHandler: null });
      this.webContents = Object.assign(new EventEmitter(), {
        scripts: [],
        executeJavaScript: async script => {
          this.webContents.scripts.push(script);
          return 96;
        },
        setWindowOpenHandler: handler => { this.openHandler = handler; },
      });
      this.events = new EventEmitter();
      made.push(this);
    }
    on(...args) { this.events.on(...args); }
    setAlwaysOnTop(...args) { this.calls.push(["setAlwaysOnTop", ...args]); }
    setVisibleOnAllWorkspaces(...args) { this.calls.push(["setVisibleOnAllWorkspaces", ...args]); }
    setBounds(bounds) { if (boundsFail) throw new Error("bounds failed"); this.bounds = bounds; this.calls.push(["setBounds", bounds]); }
    getBounds() { return this.bounds; }
    show() { this.calls.push(["show"]); }
    focus() { this.calls.push(["focus"]); }
    showInactive() { this.calls.push(["showInactive"]); }
    loadURL(url) { this.url = url; return loadFails ? Promise.reject(new Error("load failed")) : Promise.resolve(); }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
  }
  const state = { cursor, workArea };
  const screen = { getCursorScreenPoint: () => state.cursor, getDisplayNearestPoint: () => ({ workArea: state.workArea }) };
  const opened = [];
  const dismissed = [];
  const panel = createTalkPanel({ BrowserWindow: FakeBrowserWindow, screen, nativeImage, iconPath, onOpen: () => opened.push(1), onDismiss: () => dismissed.push(1), theme });
  return { panel, made, opened, dismissed, state, resized };
}

test("talkPanelBounds sits the box bottom-centre of the work area, clamped", () => {
  assert.deepEqual(talkPanelBounds({ x: 0, y: 25, width: 1440, height: 875 }, 72), { x: 520, y: 804, width: 400, height: 72 });
  assert.deepEqual(talkPanelBounds({ x: 1440, y: 0, width: 1920, height: 1050 }, 500), { x: 2200, y: 786, width: 400, height: 240 });
  assert.equal(talkPanelBounds({ x: 0, y: 0, width: 800, height: 600 }, 10).height, 56);
});

test("the constants are frozen and carry the spec's values", () => {
  assert.deepEqual(TALK_PANEL, { width: 400, margin: 24, minHeight: 56, maxHeight: 240, fadeMs: 180 });
  assert.ok(Object.isFrozen(TALK_PANEL) && Object.isFrozen(TALK_LABELS));
  assert.equal(TALK_LABELS["needs-you"], "MausBot needs you · Open chat");
  assert.equal(TALK_LABELS["still-working"], "Still working · Open chat");
  assert.equal(TALK_LABELS.error, "");
});

test("the box is a non-activating panel on every Space, shown without focus on the display under the pointer", async () => {
  const { panel, made } = harness({ cursor: { x: 2000, y: 500 }, workArea: { x: 1440, y: 25, width: 1440, height: 875 } });
  panel.render({ state: "listening", text: "" });
  const win = made[0];
  assert.deepEqual(pick(win.options, ["type", "focusable", "transparent", "frame", "skipTaskbar", "hasShadow", "resizable", "show", "acceptFirstMouse", "hiddenInMissionControl"]),
    { type: "panel", focusable: false, transparent: true, frame: false, skipTaskbar: true, hasShadow: false, resizable: false, show: false, acceptFirstMouse: true, hiddenInMissionControl: true });
  assert.deepEqual(win.calls.filter(c => c[0] !== "setBounds"), [["setAlwaysOnTop", true, "screen-saver"], ["setVisibleOnAllWorkspaces", true, { visibleOnFullScreen: true, skipTransformProcessType: true }]]);
  assert.ok(win.url.startsWith("data:text/html"));
  win.webContents.emit("did-finish-load");
  await flush();
  assert.match(win.webContents.scripts[0], /^render\(\{"state":"listening","text":""\}\)$/);
  assert.deepEqual(win.bounds, { x: 1960, y: 780, width: 400, height: 96 });
  assert.deepEqual(win.calls.map(c => c[0]).filter(n => ["show", "focus", "showInactive"].includes(n)), ["showInactive"]);
});

test("later renders resize without showing again, and use only the latest view", async () => {
  const { panel, made } = harness();
  panel.render({ state: "listening", text: "" });
  panel.render({ state: "thinking", text: "" });
  made[0].webContents.emit("did-finish-load");
  await flush();
  assert.equal(made[0].webContents.scripts.length, 1);
  assert.match(made[0].webContents.scripts[0], /"state":"thinking"/);
  panel.render({ state: "reply", text: "**Hi** there" });
  await flush();
  assert.match(made[0].webContents.scripts[1], /^render\(\{"state":"reply","text":"Hi there"\}\)$/);
  assert.deepEqual(made[0].calls.filter(c => c[0] === "showInactive").length, 1);
});

test("the page shows reply text as plain text, never HTML", () => {
  assert.equal(replyPreview("## Today\n\n- **Standup** at 10\n- [Lunch](https://x.test) with `Sam`"), "Today Standup at 10 Lunch with Sam");
  assert.equal(replyPreview("<img src=x onerror=alert(1)>"), "<img src=x onerror=alert(1)>");
  assert.equal(replyPreview("```js\nconst a_b = 1;\n```\nsnake_case and __bold__ and _it_"), "js const a_b = 1; snake_case and bold and it");
  const cut = replyPreview("word ".repeat(120));
  assert.ok(cut.length <= 400 && cut.endsWith("…") && !cut.endsWith(" …") && !cut.includes("wor…"));
  const html = talkPanelHtml("AAAA");
  assert.match(html, /default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"/);
  assert.match(html, /textContent/);
  assert.match(html, /prefers-color-scheme: light/);
  assert.doesNotMatch(html, /innerHTML|insertAdjacentHTML|outerHTML|https?:\/\//);
});

test("the page's bridge is open and dismiss, and they count only from this box", async () => {
  const preload = readFileSync(new URL("./talk-panel-preload.cjs", import.meta.url), "utf8");
  assert.deepEqual([...preload.matchAll(/ipcRenderer\.(\w+)\("([^"]+)"/g)].map(m => [m[1], m[2]]), [["send", "talk-panel:open"], ["send", "talk-panel:dismiss"]]);
  const { panel, made, opened, dismissed } = harness();
  panel.render({ state: "reply", text: "Hi" });
  made[0].webContents.emit("ipc-message", {}, "talk-panel:open");
  made[0].webContents.emit("ipc-message", {}, "talk-panel:other");
  made[0].webContents.emit("ipc-message", {}, "talk-panel:dismiss");
  assert.deepEqual([opened.length, dismissed.length], [1, 1]);
});

test("navigation and new windows are refused", () => {
  const { panel, made } = harness();
  panel.render({ state: "reply", text: "Hi" });
  const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  made[0].webContents.emit("will-navigate", event);
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(made[0].openHandler(), { action: "deny" });
});

test("close fades, then destroys; the next render makes a new box; hovered follows the pointer", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { panel, made, state } = harness({ cursor: { x: 700, y: 850 } });
    assert.equal(panel.hovered(), false);
    panel.render({ state: "reply", text: "Hi" });
    made[0].webContents.emit("did-finish-load");
    await flush();
    assert.deepEqual(made[0].bounds, { x: 520, y: 780, width: 400, height: 96 });
    assert.equal(panel.hovered(), true);
    state.cursor = { x: 10, y: 10 };
    assert.equal(panel.hovered(), false);
    panel.close();
    assert.equal(made[0].webContents.scripts.at(-1), "fadeOut()");
    mock.timers.tick(179);
    assert.equal(made[0].destroyed, false);
    mock.timers.tick(1);
    assert.equal(made[0].destroyed, true);
    assert.equal(panel.hovered(), false);
    panel.render({ state: "listening", text: "" });
    assert.equal(made.length, 2);
  } finally {
    mock.timers.reset();
  }
});

test("close destroys at once when the page never loaded", () => {
  const { panel, made } = harness();
  panel.render({ state: "listening", text: "" });
  panel.close();
  assert.equal(made[0].destroyed, true);
});

test("isTalkPanel tells the box from app windows", () => {
  const { panel, made } = harness();
  panel.render({ state: "listening", text: "" });
  assert.equal(isTalkPanel(made[0]), true);
  assert.equal(isTalkPanel({}), false);
});

test("a rejected page load is swallowed, not an unhandled rejection", async () => {
  const unhandled = [];
  const record = reason => unhandled.push(reason);
  process.on("unhandledRejection", record);
  try {
    const { panel, made } = harness({ loadFails: true });
    panel.render({ state: "listening", text: "" });
    panel.close();
    await flush();
    await flush();
    assert.equal(made.length, 1);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", record);
  }
});

test("an unreadable icon creates no window", () => {
  const { panel, made } = harness({ iconPath: "/nonexistent/icon.png" });
  assert.throws(() => panel.render({ state: "listening", text: "" }));
  assert.equal(made.length, 0);
});

test("the box's security invariants are pinned", () => {
  const { panel, made } = harness();
  panel.render({ state: "listening", text: "" });
  const { webPreferences } = made[0].options;
  assert.deepEqual(pick(webPreferences, ["contextIsolation", "sandbox", "nodeIntegration"]), { contextIsolation: true, sandbox: true, nodeIntegration: false });
  assert.ok(webPreferences.preload.endsWith("talk-panel-preload.cjs"));
  assert.equal(made[0].excludedFromShownWindowsMenu, true);
});

test("a box destroyed outside close() is forgotten, so the next render makes a new one", async () => {
  const { panel, made } = harness();
  panel.render({ state: "listening", text: "" });
  made[0].webContents.emit("did-finish-load");
  await flush();
  made[0].destroyed = true;
  made[0].events.emit("closed");
  assert.equal(panel.hovered(), false);
  panel.render({ state: "thinking", text: "" });
  assert.equal(made.length, 2);
  assert.equal(made[0].webContents.scripts.length, 1);
});

test("a reply of wide characters is cut at whole lines, so the card's bottom edge stays inside the tallest box", () => {
  const html = talkPanelHtml("AAAA");
  assert.match(html, /#text\{[^}]*display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:10;overflow:hidden\}/);
  assert.match(html, /font:13px\/1\.4 /);
  assert.match(html, /padding:14px 40px 14px 14px;border:1px solid/);
  assert.ok(28 + 2 + 2 + 11 * 18.2 <= TALK_PANEL.maxHeight, "label and ten lines of text fit the box");
});

test("replyPreview stays within the limit on pathological input", () => {
  const out = replyPreview("**".repeat(200000) + " tail");
  assert.ok(out.length <= 400);
});

test("the box stays on the display it opened on while it is up; the next box opens under the pointer", async () => {
  const { panel, made, state } = harness();
  panel.render({ state: "listening", text: "" });
  state.cursor = { x: 2000, y: 500 };
  state.workArea = { x: 1440, y: 25, width: 1440, height: 875 };
  made[0].webContents.emit("did-finish-load");
  await flush();
  panel.render({ state: "reply", text: "Hi" });
  await flush();
  assert.deepEqual(made[0].bounds, { x: 520, y: 780, width: 400, height: 96 });
  panel.close();
  panel.render({ state: "listening", text: "" });
  assert.deepEqual(made[1].options.x, 1960);
});

test("the mascot is inlined at 56 px, twice its 28 px size, never the full-size app icon", () => {
  const { panel, made, resized } = harness();
  panel.render({ state: "listening", text: "" });
  assert.deepEqual(resized, [{ width: 56, height: 56, quality: "best" }]);
  const page = decodeURIComponent(made[0].url);
  assert.ok(page.includes(`data:image/png;base64,${Buffer.from("png 56x56").toString("base64")}`));
  assert.ok(!page.includes(readFileSync(APP_ICON).toString("base64").slice(0, 200)));
  panel.close();
  panel.render({ state: "listening", text: "" });
  assert.equal(resized.length, 1, "made once, then reused");
});

test("the box takes the app's skin, light or dark, over macOS's appearance, and repaints when it changes", async () => {
  const { panel, made } = harness({ theme: "light" });
  panel.render({ state: "reply", text: "Hi" });
  made[0].webContents.emit("did-finish-load");
  await flush();
  assert.equal(made[0].webContents.scripts.at(-1), 'render({"state":"reply","text":"Hi","theme":"light"})');
  panel.setTheme("dark");
  await flush();
  assert.equal(made[0].webContents.scripts.at(-1), 'render({"state":"reply","text":"Hi","theme":"dark"})');
  panel.setTheme("dark");
  await flush();
  assert.equal(made[0].webContents.scripts.length, 2, "the same skin again repaints nothing");
  panel.close();
  panel.setTheme("light");
  assert.equal(made[0].webContents.scripts.at(-1), "fadeOut()", "a closed box is not painted");

  const html = talkPanelHtml("AAAA");
  assert.match(html, /body\{color-scheme:dark;--panel:#111111f5;/);
  assert.match(html, /body\.light\{color-scheme:light;--panel:#f7f7f7f5;/);
  assert.match(html, /@media \(prefers-color-scheme: light\)\{body:not\(\.dark\)\{color-scheme:light;--panel:#f7f7f7f5;/);
  assert.match(html, /document\.body\.className=\["on",view\.state,view\.theme\]/);
});

test("a box that fails to place itself is not an unhandled rejection", async () => {
  const unhandled = [];
  const record = reason => unhandled.push(reason);
  process.on("unhandledRejection", record);
  try {
    const { panel, made } = harness({ boundsFail: true });
    panel.render({ state: "listening", text: "" });
    made[0].webContents.emit("did-finish-load");
    await flush();
    panel.render({ state: "thinking", text: "" });
    await flush();
    await flush();
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", record);
  }
});
