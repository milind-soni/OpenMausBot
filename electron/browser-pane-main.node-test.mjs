import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createBrowserPanes } from "./browser-pane-main.mjs";
import { paneUserAgent } from "./browser-pane-wire.mjs";

const PARTITION = "persist:omb-pane-0123456789abcdef01234567";
const MSG = "openmausbot:browser-pane";
const tick = () => new Promise((resolve) => setImmediate(resolve));

function fakeElectron() {
  const views = [];
  const sessions = new Map();
  const window = {
    webContents: new EventEmitter(),
    destroyed: false,
    children: [],
    isDestroyed() { return this.destroyed; },
    getContentSize: () => [1400, 900],
    contentView: {
      addChildView(view) { window.children = window.children.filter((child) => child !== view).concat(view); },
      removeChildView(view) { window.children = window.children.filter((child) => child !== view); },
    },
  };
  const createView = (options) => {
    const debuggerEvents = new EventEmitter();
    const sent = [];
    const contents = Object.assign(options.webContents ?? new EventEmitter(), {
      url: "about:blank",
      loaded: [],
      closed: false,
      openHandler: null,
      webrtc: null,
      setWebRTCIPHandlingPolicy(policy) { this.webrtc = policy; },
      getURL() { return this.url; },
      getTitle: () => "",
      loadURL(url) { this.loaded.push(url); return Promise.resolve(); },
      setWindowOpenHandler(handler) { this.openHandler = handler; },
      isDestroyed() { return this.closed; },
      close() { this.closed = true; },
    });
    let attached = false;
    contents.debugger = Object.assign(debuggerEvents, {
      sent,
      attach(version) { assert.equal(version, "1.3"); attached = true; },
      detach() { attached = false; },
      isAttached: () => attached,
      async sendCommand(method, params, sessionId) {
        sent.push({ method, params, sessionId });
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: `FRAME${views.length}` } } };
        if (method === "DOM.fail") throw Object.assign(new Error("No node with given id found"), { code: -32000 });
        if (method === "Page.captureScreenshot") return { data: "x", visibleDuring: view.visible };
        return {};
      },
    });
    const view = { options, webContents: contents, bounds: null, visible: null, setBounds(bounds) { this.bounds = bounds; }, setVisible(visible) { this.visible = visible; } };
    views.push(view);
    return view;
  };
  const fromPartition = (name) => {
    if (!sessions.has(name)) {
      sessions.set(name, {
        agent: "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) OpenMausBot/0.1.175 Chrome/146.0.7680.0 Electron/43.7.9 Safari/537.36",
        erased: 0,
        getUserAgent() { return this.agent; },
        setUserAgent(agent) { this.agent = agent; },
        setPermissionRequestHandler(handler) { this.request = handler; },
        setPermissionCheckHandler(handler) { this.check = handler; },
        async clearStorageData() { this.erased++; },
        async clearCache() {},
        async setProxy(config) { this.proxy = config; },
        webRequest: { onBeforeSendHeaders(handler) { sessions.get(name).headers = handler; } },
      });
    }
    return sessions.get(name);
  };
  return { views, sessions, window, createView, fromPartition };
}

function setup() {
  const electron = fakeElectron();
  let clock = 0;
  const panes = createBrowserPanes({ createView: electron.createView, fromPartition: electron.fromPartition, owner: () => electron.window, chromeVersion: "146.0.7680.0", now: () => clock });
  const posted = [];
  const server = { postMessage: (message) => posted.push(message) };
  panes.attach(server);
  const send = (message) => panes.receive(server, { type: MSG, ...message });
  const last = (op) => posted.filter((message) => message.op === op).at(-1);
  return { electron, panes, server, posted, send, last, advance: (ms) => { clock += ms; } };
}

test("says hello to the server it starts, again when that server asks, and ignores any other process", () => {
  const { panes, posted, send } = setup();
  assert.deepEqual(posted[0], { type: MSG, op: "hello" });
  send({ op: "hello" });
  assert.deepEqual(posted[1], { type: MSG, op: "hello" });
  posted.length = 1;
  assert.equal(panes.receive({ postMessage() {} }, { type: MSG, op: "open", browser: "bot:a", partition: PARTITION }), true);
  assert.equal(posted.length, 1);
  assert.equal(panes.receive({}, { type: "something-else" }), false);
});

test("opens a profile on its partition, behind its egress gate, with Electron's and the app's tokens out of the user agent", async () => {
  const { send, last, electron } = setup();
  send({ op: "open", browser: "bot:a", partition: PARTITION, egress: 41000 });
  await tick();
  const opened = last("opened");
  assert.equal(opened.version, "146.0.7680.0");
  assert.equal(opened.userAgent, "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.7680.0 Safari/537.36");
  const session = electron.sessions.get(PARTITION);
  assert.deepEqual(session.proxy, { proxyRules: "socks5://127.0.0.1:41000", proxyBypassRules: "<-loopback>" });
  let granted = null;
  session.request(null, "geolocation", (value) => { granted = value; });
  assert.equal(granted, false);
  assert.equal(session.check(null, "fullscreen"), true);
  assert.equal(session.check(null, "notifications"), false);
  let sent = null;
  session.headers({ url: "https://accounts.example/", requestHeaders: { "User-Agent": opened.userAgent, Accept: "*/*" } }, (answer) => { sent = answer; });
  assert.deepEqual(sent.requestHeaders, { "User-Agent": opened.userAgent, Accept: "*/*" });
});

test("can give one host Electron's own user agent, and every other the stripped one", () => {
  const electronAgent = "Mozilla/5.0 Chrome/146.0.7680.0 Electron/43.7.9 OpenMausBot/0.1.175 Safari/537.36";
  const hosts = new Map([["accounts.example", "electron"]]);
  assert.equal(paneUserAgent(electronAgent, "Accounts.Example", hosts), electronAgent);
  assert.equal(paneUserAgent(electronAgent, "example.com", hosts), "Mozilla/5.0 Chrome/146.0.7680.0 Safari/537.36");
  assert.equal(paneUserAgent(electronAgent), "Mozilla/5.0 Chrome/146.0.7680.0 Safari/537.36");
});

test("refuses a partition outside the pane pattern, and a profile without an egress gate", async () => {
  const { send, posted, electron } = setup();
  send({ op: "open", browser: "bot:a", partition: "persist:openmausbot-app", egress: 41000 });
  send({ op: "open", browser: "bot:a", partition: PARTITION });
  await tick();
  assert.equal(posted.length, 1);
  assert.equal(electron.sessions.size, 0);
});

test("creates a sandboxed view per tab, attaches its debugger and relays its CDP both ways", async () => {
  const { send, last, electron, posted } = setup();
  send({ op: "open", browser: "bot:a", partition: PARTITION, egress: 41000 });
  await tick();
  send({ op: "create", browser: "bot:a", req: 1, url: "https://example.com/" });
  await tick();
  const created = last("created");
  assert.deepEqual({ tab: created.tab, target: created.target, req: created.req }, { tab: "p1", target: "FRAME1", req: 1 });
  const [view] = electron.views;
  assert.equal(view.options.webPreferences.partition, PARTITION);
  assert.equal(view.options.webPreferences.sandbox, true);
  assert.equal(view.options.webPreferences.nodeIntegration, false);
  assert.equal(view.options.webPreferences.devTools, false);
  assert.deepEqual(view.webContents.loaded, ["https://example.com/"]);
  assert.equal(view.webContents.webrtc, "disable_non_proxied_udp");
  assert.deepEqual(view.bounds, { x: 0, y: 0, width: 1280, height: 800 });
  assert.equal(view.visible, false);

  send({ op: "cdp", browser: "bot:a", req: 2, tab: "p1", method: "Runtime.evaluate", params: { expression: "1" }, session: "CHILD1" });
  await tick();
  assert.deepEqual(view.webContents.debugger.sent.at(-1), { method: "Runtime.evaluate", params: { expression: "1" }, sessionId: "CHILD1" });
  assert.deepEqual(last("answer"), { type: MSG, op: "answer", browser: "bot:a", req: 2, result: {} });
  send({ op: "cdp", browser: "bot:a", req: 3, tab: "p1", method: "DOM.fail", params: {} });
  await tick();
  assert.deepEqual(last("answer").error, { message: "No node with given id found", code: -32000 });
  send({ op: "cdp", browser: "bot:a", req: 4, tab: "p9", method: "Page.enable", params: {} });
  await tick();
  assert.deepEqual(last("answer").error, { message: "Target closed" });

  view.webContents.debugger.emit("message", {}, "Page.loadEventFired", { timestamp: 1 }, "");
  view.webContents.debugger.emit("message", {}, "Page.frameNavigated", { frame: {} }, "CHILD1");
  const events = posted.filter((message) => message.op === "event");
  assert.deepEqual(events.map(({ method, session }) => [method, session]), [["Page.loadEventFired", undefined], ["Page.frameNavigated", "CHILD1"]]);
});

test("shows the bot's tab in front over the panel's rectangle and hides it under an overlay", async () => {
  const { send, panes, posted, electron } = setup();
  send({ op: "open", browser: "bot:a", partition: PARTITION, egress: 41000 });
  await tick();
  send({ op: "create", browser: "bot:a", req: 1, url: "about:blank" });
  send({ op: "create", browser: "bot:a", req: 2, url: "about:blank", background: true });
  await tick();
  const showing = panes.show({ botId: "a", threadId: null, bounds: { x: 300, y: 120, width: 900, height: 700 }, visible: true });
  const which = posted.find((message) => message.op === "which");
  assert.deepEqual({ botId: which.botId, threadId: which.threadId }, { botId: "a", threadId: null });
  send({ op: "resolved", req: which.req, browser: "bot:a" });
  assert.deepEqual(await showing, { shown: true });
  const [front, back] = electron.views;
  assert.equal(front.visible, true);
  assert.deepEqual(front.bounds, { x: 300, y: 120, width: 900, height: 700 });
  assert.equal(back.visible, false);
  assert.equal(electron.window.children.at(-1), front);

  send({ op: "front", browser: "bot:a", tab: "p2" });
  assert.equal(front.visible, false);
  assert.equal(back.visible, true);

  assert.deepEqual(await panes.show({ botId: "a", threadId: null, bounds: { x: 300, y: 120, width: 900, height: 700 }, visible: false }), { shown: false });
  assert.equal(back.visible, false);
  await assert.rejects(panes.show({ botId: "../a", visible: true }), /invalid/);
});

test("makes a page's popup another tab of the same profile, with its opener", async () => {
  const { send, last, electron } = setup();
  send({ op: "open", browser: "bot:a", partition: PARTITION, egress: 41000 });
  await tick();
  send({ op: "create", browser: "bot:a", req: 1, url: "about:blank" });
  await tick();
  const opener = electron.views[0].webContents;
  const answer = opener.openHandler({ url: "https://accounts.example/" });
  assert.equal(answer.action, "allow");
  const guest = new EventEmitter();
  const popup = answer.createWindow({ webContents: guest });
  assert.equal(popup, guest);
  await tick();
  const tab = last("tab");
  assert.deepEqual({ tab: tab.tab, opener: tab.opener, target: tab.target }, { tab: "p2", opener: "p1", target: "FRAME2" });
  assert.equal(electron.views[1].options.webContents, guest);
  assert.equal(electron.views[1].options.webPreferences.partition, PARTITION);
});

test("tells the server when the person uses a pane, at most four times a second", async () => {
  const { send, posted, electron, advance } = setup();
  send({ op: "open", browser: "bot:a", partition: PARTITION, egress: 41000 });
  await tick();
  send({ op: "create", browser: "bot:a", req: 1, url: "about:blank" });
  await tick();
  const contents = electron.views[0].webContents;
  contents.emit("input-event", {}, { type: "mouseMove" });
  contents.emit("input-event", {}, { type: "mouseDown" });
  contents.emit("input-event", {}, { type: "keyDown" });
  advance(300);
  contents.emit("input-event", {}, { type: "char" });
  const pings = posted.filter((message) => message.op === "input");
  assert.equal(pings.length, 2);
  assert.equal(pings[0].tab, "p1");
});

test("draws a hidden pane for a screenshot, then hides it again", async () => {
  const { send, last, electron } = setup();
  send({ op: "open", browser: "bot:a", partition: PARTITION, egress: 41000 });
  await tick();
  send({ op: "create", browser: "bot:a", req: 1, url: "about:blank" });
  await tick();
  send({ op: "cdp", browser: "bot:a", req: 2, tab: "p1", method: "Page.captureScreenshot", params: {} });
  await tick();
  assert.equal(last("answer").result.visibleDuring, true);
  assert.equal(electron.views[0].visible, false);
  assert.deepEqual(electron.views[0].bounds, { x: 0, y: 0, width: 1280, height: 800 });
});

test("closes a profile's views, detaches their debuggers, erases a partition and drops everything for a new server", async () => {
  const { send, panes, last, electron, posted } = setup();
  send({ op: "open", browser: "bot:a", partition: PARTITION, egress: 41000 });
  await tick();
  send({ op: "create", browser: "bot:a", req: 1, url: "about:blank" });
  await tick();
  const [view] = electron.views;
  send({ op: "close", browser: "bot:a" });
  assert.equal(view.webContents.closed, true);
  assert.equal(view.webContents.debugger.isAttached(), false);
  assert.equal(electron.window.children.length, 0);
  assert.equal(last("tab-gone").tab, "p1");
  assert.equal(last("closed").browser, "bot:a");
  send({ op: "erase", partition: PARTITION });
  await tick();
  assert.equal(electron.sessions.get(PARTITION).erased, 1);

  send({ op: "open", browser: "bot:b", partition: PARTITION, egress: 41000 });
  await tick();
  send({ op: "create", browser: "bot:b", req: 2, url: "about:blank" });
  await tick();
  const next = { postMessage: (message) => posted.push(message) };
  panes.attach(next);
  assert.equal(electron.views[1].webContents.closed, true);
  assert.deepEqual(posted.at(-1), { type: MSG, op: "hello" });
});

test("a crashed page or a detached debugger is a tab gone", async () => {
  const { send, last, electron } = setup();
  send({ op: "open", browser: "bot:a", partition: PARTITION, egress: 41000 });
  await tick();
  send({ op: "create", browser: "bot:a", req: 1, url: "about:blank" });
  await tick();
  electron.views[0].webContents.emit("render-process-gone", {}, { reason: "crashed" });
  assert.deepEqual(last("tab-gone"), { type: MSG, op: "tab-gone", browser: "bot:a", tab: "p1", crashed: true });
});

test("hides the shown pane when the app's page reloads or its renderer crashes", async () => {
  const { send, panes, posted, electron } = setup();
  send({ op: "open", browser: "bot:a", partition: PARTITION, egress: 41000 });
  await tick();
  send({ op: "create", browser: "bot:a", req: 1, url: "about:blank" });
  await tick();
  const showing = panes.show({ botId: "a", threadId: null, bounds: { x: 0, y: 0, width: 800, height: 600 }, visible: true });
  send({ op: "resolved", req: posted.find((message) => message.op === "which").req, browser: "bot:a" });
  await showing;
  assert.equal(electron.views[0].visible, true);
  electron.window.webContents.emit("did-start-navigation", {}, "http://127.0.0.1/", false, true);
  assert.equal(electron.views[0].visible, false);
});
