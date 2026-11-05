import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

import { installDesktopNotifications } from "./desktop-notifications.mjs";

const CLOUD = "https://studio.example.com", COMPUTER = "http://127.0.0.1:8799";
const NOTE = { title: "Scout resumed", body: "Results in", tag: "openmausbot:scout", botId: "scout", threadId: "work-thread" };

function world({ shown = CLOUD, supported = true, mayNotify = true, picture = async () => null } = {}) {
  const banners = [], log = [];
  class Banner extends EventEmitter {
    closed = false;
    constructor(options) { super(); this.options = options; banners.push(this); }
    show() { log.push("show"); }
    close() { this.closed = true; this.emit("close"); }
    static isSupported() { return supported; }
  }
  const at = { shown, now: 1_000 };
  const mainFrame = { url: `${shown}/` };
  const webContents = {
    mainFrame, isLoadingMainFrame: () => at.shown === null, getURL: () => `${at.shown}/somewhere`,
    send: (channel, target) => { assert.equal(channel, "desktop-notifications:open"); log.push(`open ${target.botId}/${target.threadId}`); },
  };
  let handler = null;
  const asked = [];
  const installed = installDesktopNotifications({
    ipcMain: { handle: (channel, run) => { assert.equal(channel, "desktop-notifications:show"); handler = run; } },
    Notification: Banner,
    nativeImage: { createFromBuffer: (buffer) => ({ isEmpty: () => buffer.length === 0, bytes: buffer.length }) },
    fetch: async (url) => { asked.push(url); const body = await picture(url); return { ok: body !== null, arrayBuffer: async () => new TextEncoder().encode(body ?? "").buffer }; },
    window: () => ({ isDestroyed: () => false, webContents }), mayNotify: () => mayNotify,
    reveal: () => log.push("reveal"), openPlace: (origin) => log.push(`place ${origin}`), now: () => at.now,
  });
  const fromPage = { sender: webContents, senderFrame: mainFrame };
  return { ...installed, at, banners, log, asked, fromPage, webContents, show: (note = NOTE, event = fromPage) => handler(event, note) };
}

test("a click with the place on screen raises the window and opens the thread", async () => {
  const w = world();
  assert.equal(await w.show(), true);
  w.banners[0].emit("click");
  assert.deepEqual(w.log, ["show", "reveal", "open scout/work-thread"]);
});

test("a click after the page reloaded still lands: main holds the banner, not the page that asked", async () => {
  const w = world();
  await w.show();
  w.at.shown = null;
  w.banners[0].emit("click");
  assert.deepEqual(w.log, ["show", "reveal"], "still loading: nothing is sent to a page on its way out, and the load is left alone");
  w.at.shown = CLOUD;
  w.arrived();
  assert.deepEqual(w.log, ["show", "reveal", "open scout/work-thread"]);
});

test("a click while another place loads asks for the banner's place once that page is up", async () => {
  const w = world();
  await w.show();
  w.at.shown = null;
  w.banners[0].emit("click");
  w.at.shown = COMPUTER;
  w.arrived();
  w.arrived();
  assert.deepEqual(w.log, ["show", "reveal", `place ${CLOUD}`]);
  w.at.shown = CLOUD;
  w.arrived();
  assert.equal(w.log.at(-1), "open scout/work-thread");
});

test("a click with another place on screen opens that place, then the thread there, and never tells the other page", async () => {
  const w = world();
  await w.show();
  w.at.shown = COMPUTER;
  w.banners[0].emit("click");
  assert.deepEqual(w.log, ["show", "reveal", `place ${CLOUD}`]);
  w.arrived();
  assert.equal(w.log.includes("open scout/work-thread"), false, "this computer's page has no such thread");
  w.at.shown = CLOUD;
  w.arrived();
  assert.equal(w.log.at(-1), "open scout/work-thread");
  w.arrived();
  assert.equal(w.log.filter((line) => line === "open scout/work-thread").length, 1, "once");
});

test("a place that took too long does not jump to an old banner's thread when opened later", async () => {
  const w = world();
  await w.show();
  w.at.shown = COMPUTER;
  w.banners[0].emit("click");
  w.at.now += 2 * 60_000 + 1;
  w.at.shown = CLOUD;
  w.arrived();
  assert.equal(w.log.some((line) => line.startsWith("open ")), false);
});

test("a later click replaces the one still waiting for its place", async () => {
  const w = world();
  await w.show();
  await w.show({ ...NOTE, tag: "openmausbot:atlas", botId: "atlas", threadId: "atlas-thread" });
  w.at.shown = COMPUTER;
  w.banners[0].emit("click");
  w.banners[1].emit("click");
  w.at.shown = CLOUD;
  w.arrived();
  assert.deepEqual(w.log.filter((line) => line.startsWith("open ")), ["open atlas/atlas-thread"]);
});

test("only the window's own page may ask, in its main frame, and only where it may notify", async () => {
  const w = world();
  assert.equal(await w.show(NOTE, { sender: {}, senderFrame: w.webContents.mainFrame }), false, "the rail or a viewer");
  assert.equal(await w.show(NOTE, { sender: w.webContents, senderFrame: { url: `${CLOUD}/frame` } }), false, "a frame inside the page");
  assert.equal(w.banners.length, 0);
  const refused = world({ mayNotify: false });
  assert.equal(await refused.show(), false, "a place the permission rule refuses");
  assert.equal(refused.banners.length, 0);
});

test("with no system support the page is told, and shows its own", async () => {
  const w = world({ supported: false });
  assert.equal(await w.show(), false);
  assert.equal(w.banners.length, 0);
});

test("refuses a note that names no thread to open", async () => {
  const w = world();
  for (const note of [null, "text", { ...NOTE, threadId: "../../etc" }, { ...NOTE, botId: "" }, { ...NOTE, title: "" }]) assert.equal(await w.show(note), false);
  assert.equal(w.banners.length, 0);
});

test("one banner per tag, as a page's tag does; the one replaced no longer opens anything", async () => {
  const w = world();
  await w.show();
  await w.show({ ...NOTE, threadId: "newer-thread" });
  assert.equal(w.banners[0].closed, true);
  assert.equal(w.banners[1].closed, false);
  w.banners[1].emit("click");
  assert.equal(w.log.at(-1), "open scout/newer-thread");
});

test("a bot's picture comes only from the page's own origin, and a failed one still shows the banner", async () => {
  const w = world({ picture: async (url) => { if (url.includes("broken")) throw new Error("nope"); return url.includes("missing") ? null : "png-bytes"; } });
  await w.show({ ...NOTE, picture: "/api/attachments/face.png" });
  assert.equal(w.banners[0].options.icon.bytes, "png-bytes".length);
  assert.deepEqual(w.asked, [`${CLOUD}/api/attachments/face.png`]);
  await w.show({ ...NOTE, tag: "a", picture: "https://elsewhere.example.com/track.png" });
  assert.equal(w.asked.length, 1, "never fetches another origin");
  assert.equal(w.banners[1].options.icon, undefined);
  for (const [tag, picture] of [["b", "/broken.png"], ["c", "/missing.png"]]) {
    assert.equal(await w.show({ ...NOTE, tag, picture }), true);
    assert.equal(w.banners.at(-1).options.icon, undefined);
  }
});

test("main opens a thread only from the window's own load, and a page gets the bridge whatever server it comes from", () => {
  const source = (name) => readFileSync(new URL(name, import.meta.url), "utf8");
  assert.match(source("./main.mjs"), /did-stop-loading", \(\) => \{[^}]*desktopNotifications\.arrived\(\)/);
  assert.match(source("./preload.cjs"), /const REMOTE_SAFE = new Set\(\[[^\]]*"desktopNotifications"/);
});

test("the bridge asks main, and holds a click that comes back before the page has listened", async () => {
  const require = createRequire(import.meta.url);
  const channels = new Map(), invoked = [];
  let api = null;
  const electron = require.resolve("electron");
  const held = require.cache[electron];
  require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: {
    ipcRenderer: { on: (channel, run) => channels.set(channel, run), removeListener: () => undefined, invoke: async (...args) => { invoked.push(args); return true; }, send: () => undefined, sendSync: () => undefined },
    contextBridge: { exposeInMainWorld: (_name, exposed) => { api = exposed; } }, webUtils: { getPathForFile: () => "" },
  } };
  const preload = require.resolve("./preload.cjs");
  delete require.cache[preload];
  try { require(preload); } finally { if (held) require.cache[electron] = held; else delete require.cache[electron]; delete require.cache[preload]; }
  assert.equal(await api.desktopNotifications.show(NOTE), true);
  assert.deepEqual(invoked.at(-1), ["desktop-notifications:show", NOTE]);
  const target = { botId: "scout", threadId: "work-thread" };
  channels.get("desktop-notifications:open")({}, target);
  const heard = [];
  const stop = api.desktopNotifications.onOpen((seen) => heard.push(seen));
  assert.deepEqual(heard, [target]);
  channels.get("desktop-notifications:open")({}, { botId: "atlas", threadId: "next" });
  assert.equal(heard.length, 2);
  stop();
});
