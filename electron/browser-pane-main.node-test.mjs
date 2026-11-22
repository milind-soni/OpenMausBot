import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import test from "node:test";

import { createBrowserPanes, fromAppWindow } from "./browser-pane-main.mjs";

const PARTITION = "persist:omb-pane-0123456789abcdef01234567";
const MSG = "openmausbot:browser-pane";
const DOWNLOADS = "/tmp/omb-pane-downloads";
const tick = () => new Promise((resolve) => setImmediate(resolve));

function fakeElectron(hints = null) {
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
      // A guest Electron made for a popup loads its own document.
      loaded: options.webContents ? ["(popup)"] : [],
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
      devtoolsClosed: 0,
      closeDevTools() { this.devtoolsClosed++; },
      agent: null,
      setUserAgent(agent) { this.agent = agent; },
      captured: 0,
      async capturePage() { this.captured++; return { isEmpty: () => false, getSize: () => ({ width: 2, height: 2 }), toPNG: () => Buffer.from("parked"), toJPEG: () => Buffer.from("parked") }; },
    });
    let attached = false;
    contents.debugger = Object.assign(debuggerEvents, {
      sent,
      attach(version) { assert.equal(version, "1.3"); attached = true; },
      detach() { attached = false; },
      isAttached: () => attached,
      async sendCommand(method, params, sessionId) {
        sent.push({ method, params, sessionId });
        // Electron 43: a webContents that never loaded a document answers no debugger command.
        if (!contents.loaded.length) return new Promise(() => {});
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: `FRAME${views.length}` } } };
        if (method === "Runtime.evaluate" && hints) return { result: { value: hints } };
        if (method === "DOM.fail") throw Object.assign(new Error("No node with given id found"), { code: -32000 });
        if (method === "Page.captureScreenshot") return contents.neverDraws ? new Promise(() => {}) : { data: "x", visibleDuring: view.visible };
        return {};
      },
    });
    const view = { options, webContents: contents, bounds: null, visible: null, setBounds(bounds) { this.bounds = bounds; }, setVisible(visible) { this.visible = visible; } };
    views.push(view);
    return view;
  };
  const fromPartition = (name) => {
    if (!sessions.has(name)) {
      sessions.set(name, Object.assign(new EventEmitter(), {
        agent: "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) OpenMausBot/0.1.175 Chrome/146.0.7680.0 Electron/43.7.9 Safari/537.36",
        erased: 0,
        getUserAgent() { return this.agent; },
        setUserAgent(agent) { this.agent = agent; },
        setPermissionRequestHandler(handler) { this.request = handler; },
        setPermissionCheckHandler(handler) { this.check = handler; },
        async clearStorageData() { this.erased++; },
        async clearCache() {},
        async setProxy(config) { this.proxy = config; },
        written: [],
        cookies: { async set(details) { if (details.name === "refuse") throw new Error(`Failed to set cookie ${details.value}`); sessions.get(name).written.push(details); } },
        webRequest: { onBeforeSendHeaders(handler) { sessions.get(name).headers = handler; } },
      }));
    }
    return sessions.get(name);
  };
  const popups = [];
  const createPopup = (options) => {
    const contents = options.webContents ?? new EventEmitter();
    const popup = Object.assign(new EventEmitter(), {
      options, focused: 0, destroyed: false, title: "",
      focus() { this.focused++; }, isDestroyed() { return this.destroyed; }, close() { this.destroyed = true; this.emit("closed"); }, setTitle(title) { this.title = title; },
    });
    // The window's contents get the same fake surface a view's would.
    popup.webContents = createView({ webContents: contents, webPreferences: options.webPreferences }).webContents;
    views.pop();
    popups.push(popup);
    return popup;
  };
  return { views, sessions, window, createView, createPopup, popups, fromPartition };
}

function fakeWindow() {
  const window = {
    destroyed: false,
    children: [],
    isDestroyed() { return this.destroyed; },
    destroy() { this.destroyed = true; },
    contentView: {
      addChildView(view) { window.children = window.children.filter((child) => child !== view).concat(view); },
      removeChildView(view) { window.children = window.children.filter((child) => child !== view); },
    },
  };
  return window;
}

function setup({ captureMs, keepsRunning = false, hints = null, quitting = () => false } = {}) {
  const electron = fakeElectron(hints);
  let clock = 0;
  const logged = [];
  const parkings = [];
  const createParking = () => { const window = fakeWindow(); parkings.push(window); return window; };
  electron.windowsMade = () => parkings.length + electron.popups.length + electron.views.length;
  const panes = createBrowserPanes({ createView: electron.createView, createPopup: electron.createPopup, createParking, keepsRunning: () => keepsRunning, quitting, fromPartition: electron.fromPartition, owner: () => (electron.window.destroyed ? null : electron.window), chromeVersion: "146.0.7680.0", now: () => clock, log: (line) => logged.push(line), ...(captureMs ? { captureMs } : {}) });
  electron.parkings = parkings;
  const posted = [];
  const server = { postMessage: (message) => posted.push(message) };
  panes.attach(server);
  const send = (message) => panes.receive(server, { type: MSG, ...message });
  const last = (op) => posted.filter((message) => message.op === op).at(-1);
  return { electron, panes, server, posted, send, last, logged, advance: (ms) => { clock += ms; } };
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

test("opens a profile on its partition, behind its egress gate, as Electron's own Chromium without the app's token", async () => {
  const { send, last, electron } = setup();
  send({ op: "open", browser: "bot:a", partition: PARTITION, egress: 41000, downloads: DOWNLOADS, identity: "native" });
  await tick();
  const opened = last("opened");
  assert.equal(opened.version, "146.0.7680.0");
  assert.equal(opened.userAgent, "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.7680.0 Electron/43.7.9 Safari/537.36");
  const session = electron.sessions.get(PARTITION);
  assert.deepEqual(session.proxy, { proxyRules: "socks5://127.0.0.1:41000", proxyBypassRules: "<-loopback>" });
  let granted = null;
  session.request(null, "geolocation", (value) => { granted = value; });
  assert.equal(granted, false);
  assert.equal(session.check(null, "fullscreen"), true);
  assert.equal(session.check(null, "notifications"), false);
  const headers = (url, requestHeaders) => {
    let sent = null;
    session.headers({ url, referrer: "", resourceType: "mainFrame", requestHeaders }, (answer) => { sent = answer; });
    return sent.requestHeaders;
  };
  const hints = { "sec-ch-ua": '"Chromium";v="146", "Not-A.Brand";v="24"', "sec-ch-ua-platform": '"macOS"' };
  assert.deepEqual(headers("https://example.com/", { "User-Agent": opened.userAgent, ...hints }), { "User-Agent": opened.userAgent, ...hints });
  // Teams' request header alone drops Electron's token; Chromium's client hints are never touched.
  assert.deepEqual(headers("https://teams.microsoft.com/v2/", { "user-agent": opened.userAgent, ...hints }), {
    "user-agent": "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.7680.0 Safari/537.36", ...hints,
  });
});

test("cleaned identity on request: Electron's token off everywhere but Google's sign-in, which keeps Electron's own UA", async () => {
  const { send, last, electron } = setup();
  send({ op: "open", browser: "bot:a", partition: PARTITION, egress: 41000, downloads: DOWNLOADS, identity: "cleaned" });
  await tick();
  assert.equal(last("opened").userAgent, "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.7680.0 Safari/537.36");
  const session = electron.sessions.get(PARTITION);
  let sent = null;
  session.headers({ url: "https://accounts.google.com/v3/signin/identifier", referrer: "", resourceType: "mainFrame", requestHeaders: { "User-Agent": last("opened").userAgent } }, (answer) => { sent = answer; });
  assert.equal(sent.requestHeaders["User-Agent"], "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.7680.0 Electron/43.7.9 Safari/537.36");
  // Opened again as native, the same partition goes back to Electron's token.
  send({ op: "close", browser: "bot:a" });
  send({ op: "open", browser: "bot:a", partition: PARTITION, egress: 41000, downloads: DOWNLOADS, identity: "native" });
  await tick();
  assert.match(last("opened").userAgent, / Electron\/43\.7\.9 /);
});

test("refuses a partition outside the pane pattern, and a profile without an egress gate", async () => {
  const { send, posted, electron } = setup();
  send({ op: "open", browser: "bot:a", partition: "persist:openmausbot-app", egress: 41000, downloads: DOWNLOADS, identity: "native" });
  send({ op: "open", browser: "bot:a", partition: PARTITION });
  await tick();
  assert.equal(posted.length, 1);
  assert.equal(electron.sessions.size, 0);
});

test("creates a sandboxed view per tab, attaches its debugger and relays its CDP both ways", async () => {
  const { send, last, electron, posted } = setup();
  send({ op: "open", browser: "bot:a", partition: PARTITION, egress: 41000, downloads: DOWNLOADS, identity: "native" });
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
  assert.deepEqual(view.webContents.loaded, ["about:blank", "https://example.com/"]);
  const order = view.webContents.debugger.sent.map((command) => command.method);
  assert.deepEqual(order.slice(0, 3), ["Page.addScriptToEvaluateOnNewDocument", "Runtime.evaluate", "Page.getFrameTree"]);
  assert.equal(view.webContents.debugger.sent[0].params.worldName, undefined);
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
  send({ op: "open", browser: "bot:a", partition: PARTITION, egress: 41000, downloads: DOWNLOADS, identity: "native" });
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
  send({ op: "open", browser: "bot:a", partition: PARTITION, egress: 41000, downloads: DOWNLOADS, identity: "native" });
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
  send({ op: "open", browser: "bot:a", partition: PARTITION, egress: 41000, downloads: DOWNLOADS, identity: "native" });
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
  send({ op: "open", browser: "bot:a", partition: PARTITION, egress: 41000, downloads: DOWNLOADS, identity: "native" });
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
  send({ op: "open", browser: "bot:a", partition: PARTITION, egress: 41000, downloads: DOWNLOADS, identity: "native" });
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

  send({ op: "open", browser: "bot:b", partition: PARTITION, egress: 41000, downloads: DOWNLOADS, identity: "native" });
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
  send({ op: "open", browser: "bot:a", partition: PARTITION, egress: 41000, downloads: DOWNLOADS, identity: "native" });
  await tick();
  send({ op: "create", browser: "bot:a", req: 1, url: "about:blank" });
  await tick();
  electron.views[0].webContents.emit("render-process-gone", {}, { reason: "crashed" });
  assert.deepEqual(last("tab-gone"), { type: MSG, op: "tab-gone", browser: "bot:a", tab: "p1", crashed: true });
});

test("hides the shown pane when the app's page reloads or its renderer crashes", async () => {
  const { send, panes, posted, electron } = setup();
  send({ op: "open", browser: "bot:a", partition: PARTITION, egress: 41000, downloads: DOWNLOADS, identity: "native" });
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

async function opened(options) {
  const context = setup(options);
  context.send({ op: "open", browser: "bot:a", partition: PARTITION, egress: 41000, downloads: DOWNLOADS, identity: "native" });
  await tick();
  context.send({ op: "create", browser: "bot:a", req: 1, url: "about:blank" });
  await tick();
  return context;
}

test("says no window can host a pane while the app window is closed", async () => {
  const { send, last, electron } = setup();
  electron.window.destroyed = true;
  send({ op: "open", browser: "bot:a", partition: PARTITION, egress: 41000, downloads: DOWNLOADS, identity: "native" });
  await tick();
  assert.deepEqual(last("failed"), { type: MSG, op: "failed", browser: "bot:a", error: "The app window is closed.", reason: "no-window" });
  assert.equal(electron.sessions.size, 0);
});

test("keeps a browser to eight tabs, popups included, and says why", async () => {
  const { send, last, electron } = await opened();
  for (let req = 2; req <= 8; req++) send({ op: "create", browser: "bot:a", req, url: "about:blank" });
  await tick();
  assert.equal(electron.views.length, 8);
  send({ op: "create", browser: "bot:a", req: 9, url: "about:blank" });
  await tick();
  assert.match(last("answer").error.message, /already has 8 tabs open/);
  assert.deepEqual(electron.views[0].webContents.openHandler({ url: "https://x.example/" }), { action: "deny" });
});

test("saves every download into the profile's folder without a dialog, reports it, and cancels on request", async () => {
  const { send, posted, electron } = await opened();
  const contents = electron.views[0].webContents;
  const item = Object.assign(new EventEmitter(), {
    savePath: null, cancelled: false,
    setSavePath(file) { this.savePath = file; }, cancel() { this.cancelled = true; },
    getURL: () => "https://example.com/a.csv", getFilename: () => "a.csv", getReceivedBytes: () => 3, getTotalBytes: () => 3,
  });
  electron.sessions.get(PARTITION).emit("will-download", {}, item, contents);
  assert.equal(path.dirname(item.savePath), path.join(DOWNLOADS));
  item.emit("updated", {}, "progressing");
  item.emit("done", {}, "completed");
  const downloads = posted.filter((message) => message.op === "download");
  assert.deepEqual(downloads.map(({ state }) => state), ["begin", "inProgress", "completed"]);
  assert.equal(downloads[0].name, "a.csv");
  assert.equal(downloads[2].path, item.savePath);

  const second = Object.assign(new EventEmitter(), { ...item, savePath: null, cancelled: false, setSavePath(file) { this.savePath = file; }, cancel() { this.cancelled = true; } });
  electron.sessions.get(PARTITION).emit("will-download", {}, second, contents);
  send({ op: "cancel-download", browser: "bot:a", guid: posted.filter((message) => message.op === "download").at(-1).guid });
  assert.equal(second.cancelled, true);

  const stray = Object.assign(new EventEmitter(), { ...item, cancelled: false, setSavePath() { throw new Error("never asked"); }, cancel() { this.cancelled = true; } });
  electron.sessions.get(PARTITION).emit("will-download", {}, stray, new EventEmitter());
  assert.equal(stray.cancelled, true);
});

test("does not count the bot's own input as the person's, should Electron report it", async () => {
  const { send, posted, electron, advance } = await opened();
  const contents = electron.views[0].webContents;
  const debug = contents.debugger;
  let finish;
  debug.sendCommand = (method) => (method === "Input.dispatchMouseEvent" ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve({}));
  send({ op: "cdp", browser: "bot:a", req: 2, tab: "p1", method: "Input.dispatchMouseEvent", params: { type: "mousePressed", x: 1, y: 1 } });
  contents.emit("input-event", {}, { type: "mouseDown" });
  finish({});
  await tick();
  contents.emit("input-event", {}, { type: "mouseDown" });
  advance(200);
  contents.emit("input-event", {}, { type: "mouseDown" });
  assert.equal(posted.filter((message) => message.op === "input").length, 1);
});

test("answers a screenshot of a page that never draws with an error instead of waiting for good", async () => {
  const { send, last, electron } = await opened({ captureMs: 20 });
  electron.views[0].webContents.neverDraws = true;
  send({ op: "cdp", browser: "bot:a", req: 2, tab: "p1", method: "Page.captureScreenshot", params: {} });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.match(last("answer").error.message, /did not draw/);
  assert.equal(electron.views[0].visible, false);
});

test("asks again which browser a panel shows: after no answer, when a browser opens, and when the bot's profile changes", async () => {
  const { send, panes, posted } = setup();
  const whiches = () => posted.filter((message) => message.op === "which");
  const area = { x: 0, y: 0, width: 800, height: 600 };
  const first = panes.show({ botId: "a", threadId: null, profile: null, bounds: area, visible: true });
  send({ op: "resolved", req: whiches().at(-1).req, browser: null });
  assert.deepEqual(await first, { shown: false });
  const again = panes.show({ botId: "a", threadId: null, profile: null, bounds: area, visible: true });
  assert.equal(whiches().length, 2);
  send({ op: "resolved", req: whiches().at(-1).req, browser: "bot:a" });
  await again;
  send({ op: "open", browser: "bot:a", partition: PARTITION, egress: 41000, downloads: DOWNLOADS, identity: "native" });
  await tick();
  assert.equal(whiches().length, 3);
  send({ op: "resolved", req: whiches().at(-1).req, browser: "bot:a" });
  send({ op: "create", browser: "bot:a", req: 1, url: "about:blank" });
  await tick();
  const changed = panes.show({ botId: "a", threadId: null, profile: "work", bounds: area, visible: true });
  assert.equal(whiches().length, 4);
  send({ op: "resolved", req: whiches().at(-1).req, browser: "shared:work" });
  assert.deepEqual(await changed, { shown: false });
});

test("closes every pane when the app window closes", async () => {
  const { panes, last, electron } = await opened();
  panes.closeAll();
  assert.equal(electron.views[0].webContents.closed, true);
  assert.equal(last("closed").browser, "bot:a");
});

test("a tab on a site with a page-level rule reports that site's UA in the page too, and its own UA again after", async () => {
  const { electron } = await opened();
  const contents = electron.views[0].webContents;
  contents.emit("did-start-navigation", {}, "https://www.chase.com/", false, true);
  assert.equal(contents.agent, "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.7680.0 Safari/537.36");
  contents.emit("did-start-navigation", {}, "https://example.com/", false, true);
  assert.equal(contents.agent, "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.7680.0 Electron/43.7.9 Safari/537.36");
});

test("a sign-in popup the person opened is a real child window on the pane's session, its opener kept, one per opener", async () => {
  const { posted, electron, advance } = await opened();
  advance(5_000);
  const opener = electron.views[0].webContents;
  opener.emit("input-event", {}, { type: "mouseDown" });
  opener.debugger.emit("message", {}, "Page.windowOpen", { url: "https://accounts.example/o/oauth2", windowName: "", windowFeatures: [], userGesture: true }, "");
  const answer = opener.openHandler({ url: "https://accounts.example/o/oauth2", disposition: "new-window" });
  assert.equal(answer.action, "allow");
  const guest = new EventEmitter();
  // Electron makes the guest the opener's child before createWindow: adopting it is what keeps window.opener.
  assert.equal(answer.createWindow({ webContents: guest, webPreferences: {} }), guest);
  const [popup] = electron.popups;
  assert.equal(popup.options.parent, electron.window);
  assert.equal(popup.options.webContents, guest);
  assert.equal(popup.options.webPreferences.partition, PARTITION);
  assert.equal(popup.options.webPreferences.sandbox, true);
  await tick();
  const tab = posted.filter((message) => message.op === "tab").at(-1);
  assert.deepEqual({ tab: tab.tab, opener: tab.opener }, { tab: "p2", opener: "p1" });
  assert.equal(electron.window.children.includes(popup), false);
  guest.url = "https://accounts.example/o/oauth2";
  popup.emit("page-title-updated", { preventDefault() {} }, "Sign in");
  assert.equal(popup.title, "https://accounts.example");

  opener.debugger.emit("message", {}, "Page.windowOpen", { url: "https://accounts.example/again", userGesture: true }, "");
  assert.deepEqual(opener.openHandler({ url: "https://accounts.example/again" }), { action: "deny" });
  assert.equal(popup.focused, 1);
  popup.close();
  assert.equal(posted.filter((message) => message.op === "tab-gone").at(-1).tab, "p2");
});

test("a popup the bot's click opened stays a tab, its opener kept", async () => {
  const { send, posted, electron, advance } = await opened();
  advance(5_000);
  const opener = electron.views[0].webContents;
  let finish;
  opener.debugger.sendCommand = (method) => (method === "Input.dispatchMouseEvent" ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve({ frameTree: { frame: { id: "FRAME9" } } }));
  send({ op: "cdp", browser: "bot:a", req: 2, tab: "p1", method: "Input.dispatchMouseEvent", params: { type: "mousePressed", x: 1, y: 1 } });
  opener.debugger.emit("message", {}, "Page.windowOpen", { url: "https://accounts.example/o/oauth2", userGesture: true }, "");
  const answer = opener.openHandler({ url: "https://accounts.example/o/oauth2" });
  const guest = new EventEmitter();
  answer.createWindow({ webContents: guest });
  finish({});
  await tick();
  assert.equal(electron.popups.length, 0);
  assert.equal(electron.views.at(-1).options.webContents, guest);
  assert.equal(posted.filter((message) => message.op === "tab").at(-1).opener, "p1");
});

test("writes an import's cookies into the pane partition and counts what Chromium refused, naming none", async () => {
  const { send, last, electron, logged, posted } = setup();
  const cookie = { url: "https://github.com/", name: "user_session", value: "fixture-value", domain: ".github.com", path: "/", secure: true, httpOnly: true, sameSite: "lax", expirationDate: 2_000_000_000 };
  send({ op: "set-cookies", req: 7, partition: PARTITION, cookies: [cookie, { ...cookie, name: "refuse", value: "never-logged" }] });
  await tick();
  assert.deepEqual(last("cookies-set"), { type: MSG, op: "cookies-set", req: 7, written: 1, refused: 1 });
  assert.deepEqual(electron.sessions.get(PARTITION).written, [cookie]);
  // A cookie Chromium would not hold, or another partition, never reaches cookies.set.
  send({ op: "set-cookies", req: 8, partition: "persist:someone-else", cookies: [cookie] });
  send({ op: "set-cookies", req: 9, partition: PARTITION, cookies: [{ ...cookie, value: "x".repeat(5000) }] });
  await tick();
  assert.equal(last("cookies-set").req, 7);
  const said = JSON.stringify([logged, posted.filter((message) => message.op !== "set-cookies")]);
  assert.ok(!said.includes("fixture-value") && !said.includes("never-logged"));
  assert.ok(logged.length > 0);
});

test("relays the person's import requests to the server and brings back counts only", async () => {
  const { panes, send, posted } = setup();
  const sources = panes.cookieSources();
  const asked = posted.at(-1);
  assert.equal(asked.op, "cookie-sources");
  send({ op: "cookie-sources-result", req: asked.req, sources: [{ id: "chrome", name: "Google Chrome", engine: "chromium", profiles: [{ id: "Default", name: "Person" }] }] });
  assert.deepEqual(await sources, [{ id: "chrome", name: "Google Chrome", engine: "chromium", profiles: [{ id: "Default", name: "Person" }] }]);
  const imported = panes.importCookies({ botId: "a", threadId: null, site: "github.com", source: "chrome", profile: "Default" });
  const request = posted.at(-1);
  assert.deepEqual({ op: request.op, botId: request.botId, site: request.site, source: request.source, profile: request.profile }, { op: "cookie-import", botId: "a", site: "github.com", source: "chrome", profile: "Default" });
  send({ op: "cookie-import-result", req: request.req, result: { ok: true, site: "github.com", imported: 3, sessionOnly: 0, skipped: {} } });
  assert.deepEqual(await imported, { ok: true, site: "github.com", imported: 3, sessionOnly: 0, skipped: {} });
  const offered = panes.cookieOffer({ botId: "a", threadId: null, site: "google.com" });
  send({ op: "cookie-offer-result", req: posted.at(-1).req, offered: false, reason: "google" });
  assert.deepEqual(await offered, { offered: false, reason: "google" });
  await assert.rejects(panes.importCookies({ botId: "a", site: "x.com", source: "../chrome", profile: "Default" }), /invalid/);
  await assert.rejects(panes.cookieOffer({ botId: "../a", site: "x.com" }), /invalid/);
});

test("takes an import request only from the app window's own top page", () => {
  const mainFrame = {};
  const window = { webContents: { mainFrame }, isDestroyed: () => false };
  fromAppWindow({ sender: window.webContents, senderFrame: mainFrame }, window);
  assert.throws(() => fromAppWindow({ sender: window.webContents, senderFrame: {} }, window), /main app window/);
  assert.throws(() => fromAppWindow({ sender: { mainFrame }, senderFrame: mainFrame }, window), /main app window/);
  assert.throws(() => fromAppWindow({ sender: window.webContents, senderFrame: mainFrame }, null), /main app window/);
});

async function openedWith(options) {
  const context = setup(options);
  context.send({ op: "open", browser: "bot:a", partition: PARTITION, egress: 41000, downloads: DOWNLOADS, identity: "native" });
  await tick();
  context.send({ op: "create", browser: "bot:a", req: 1, url: "about:blank" });
  await tick();
  await tick();
  return context;
}

test("gives each pane its user agent with Chromium's own client hints, so navigations and fetches carry the same", async () => {
  const hints = { brands: [{ brand: "Not;A=Brand", version: "8" }, { brand: "Chromium", version: "150" }], mobile: false, platform: "macOS", platformVersion: "15.6.0", architecture: "arm", bitness: "64", model: "", wow64: false, fullVersionList: [{ brand: "Chromium", version: "150.0.7871.250" }] };
  const { electron } = await openedWith({ hints });
  const contents = electron.views[0].webContents;
  const override = contents.debugger.sent.find((command) => command.method === "Emulation.setUserAgentOverride");
  assert.equal(override.params.userAgent, "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.7680.0 Electron/43.7.9 Safari/537.36");
  assert.deepEqual(override.params.userAgentMetadata.brands, hints.brands);
  assert.equal(override.params.userAgentMetadata.platformVersion, "15.6.0");
  // A site with a whole-tab rule gets its user agent with the same hints.
  contents.emit("did-start-navigation", {}, "https://www.chase.com/", false, true);
  await tick();
  const overrides = contents.debugger.sent.filter((command) => command.method === "Emulation.setUserAgentOverride");
  assert.equal(overrides.length, 2);
  assert.equal(overrides[1].params.userAgent, "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.7680.0 Safari/537.36");
  assert.deepEqual(overrides[1].params.userAgentMetadata, overrides[0].params.userAgentMetadata);
});

test("keeps the panes running in a window never shown while the app window is closed, where the app keeps running", async () => {
  const { electron, panes, posted } = await openedWith({ keepsRunning: true });
  const [view] = electron.views;
  electron.window.destroyed = true;
  panes.windowClosed(electron.window);
  assert.equal(electron.parkings.length, 1);
  assert.equal(electron.parkings[0].children[0], view);
  assert.equal(view.webContents.closed, false);
  assert.equal(posted.some((message) => message.op === "closed"), false);
});

test("closes the panes with the window where the app quits with its last window", async () => {
  const { electron, panes, last } = await openedWith({ keepsRunning: false });
  electron.window.destroyed = true;
  panes.windowClosed(electron.window);
  assert.equal(electron.parkings.length, 0);
  assert.equal(electron.views[0].webContents.closed, true);
  assert.equal(last("closed").browser, "bot:a");
});

test("a person's key right after the bot's click is the person's; the bot's own echo is not", async () => {
  const { send, posted, electron, advance } = await openedWith();
  advance(5_000);
  const contents = electron.views[0].webContents;
  let finish;
  contents.debugger.sendCommand = (method) => (method === "Input.dispatchMouseEvent" ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve({}));
  send({ op: "cdp", browser: "bot:a", req: 2, tab: "p1", method: "Input.dispatchMouseEvent", params: { type: "mousePressed", x: 10, y: 20 } });
  contents.emit("input-event", {}, { type: "mouseDown", x: 10, y: 20 });
  finish({});
  await tick();
  advance(22);
  contents.emit("input-event", {}, { type: "keyDown" });
  const pings = posted.filter((message) => message.op === "input");
  assert.equal(pings.length, 1);
});

test("asks the server to hold the tab the panel shows, and lets every hold go when the window closes", async () => {
  const { electron, panes, send, posted } = await openedWith({ keepsRunning: true });
  // No panel shows this bot: there is no tab to hold.
  assert.deepEqual(await panes.hold({ botId: "a", threadId: null, held: true }), { held: false });
  const showing = panes.show({ botId: "a", threadId: null, bounds: { x: 0, y: 0, width: 800, height: 600 }, visible: true });
  send({ op: "resolved", req: posted.find((message) => message.op === "which").req, browser: "bot:a" });
  await showing;
  const held = panes.hold({ botId: "a", threadId: null, held: true });
  const asked = posted.at(-1);
  assert.deepEqual({ op: asked.op, botId: asked.botId, threadId: asked.threadId, browser: asked.browser, tab: asked.tab, held: asked.held }, { op: "hold", botId: "a", threadId: null, browser: "bot:a", tab: "p1", held: true });
  send({ op: "hold-result", req: asked.req, held: true });
  assert.deepEqual(await held, { held: true });
  await assert.rejects(panes.hold({ botId: "a", threadId: null, held: "yes" }), /invalid/);
  electron.window.destroyed = true;
  panes.windowClosed(electron.window);
  assert.equal(posted.some((message) => message.op === "let-go"), true);
});

test("quits with the pane setting off: no pane was ever opened, so closing the window makes no window", () => {
  let quitting = false;
  const { electron, panes } = setup({ keepsRunning: true, quitting: () => quitting });
  electron.window.destroyed = true;
  panes.windowClosed(electron.window);
  quitting = true;
  panes.closeAll();
  panes.windowClosed(electron.window);
  assert.equal(electron.windowsMade(), 0);
});

test("quits with panes open: the panes close with the window and nothing is parked", async () => {
  let quitting = false;
  const { electron, panes, last } = await openedWith({ keepsRunning: true, quitting: () => quitting });
  quitting = true;
  panes.closeAll();
  electron.window.destroyed = true;
  panes.windowClosed(electron.window);
  assert.equal(electron.parkings.length, 0);
  assert.equal(electron.views[0].webContents.closed, true);
  assert.equal(last("closed").browser, "bot:a");
});

test("quits with panes parked: the parking window is destroyed with them", async () => {
  let quitting = false;
  const { electron, panes } = await openedWith({ keepsRunning: true, quitting: () => quitting });
  electron.window.destroyed = true;
  panes.windowClosed(electron.window);
  assert.equal(electron.parkings.length, 1);
  quitting = true;
  panes.closeAll();
  assert.equal(electron.parkings[0].destroyed, true);
  assert.equal(electron.views[0].webContents.closed, true);
  assert.equal(electron.parkings.length, 1);
});

test("a window closed as the app quits never parks: the quit is not cancelled by a new window", async () => {
  let quitting = false;
  const { electron, panes } = await openedWith({ keepsRunning: true, quitting: () => quitting });
  quitting = true;
  electron.window.destroyed = true;
  panes.windowClosed(electron.window);
  assert.equal(electron.parkings.length, 0);
  assert.equal(electron.views[0].webContents.closed, true);
});

test("a bot's scroll never reads as the person's", async () => {
  const { send, posted, electron, advance } = await openedWith();
  advance(5_000);
  const contents = electron.views[0].webContents;
  let finish;
  contents.debugger.sendCommand = (method) => (method === "Input.dispatchMouseEvent" ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve({}));
  for (let scroll = 0; scroll < 25; scroll++) {
    send({ op: "cdp", browser: "bot:a", req: 10 + scroll, tab: "p1", method: "Input.dispatchMouseEvent", params: { type: "mouseWheel", x: 200, y: 300, deltaX: 0, deltaY: 400 } });
    for (const type of ["mouseWheel", "mouseWheel", "gestureScrollBegin", "gestureScrollUpdate"]) contents.emit("input-event", {}, { type, x: 200, y: 300 });
    finish({});
    await tick();
    // Measured: every echo at most 1 ms after the answer.
    advance(1);
    contents.emit("input-event", {}, { type: "gestureScrollEnd", x: 200, y: 300 });
    advance(1_000);
  }
  assert.equal(posted.filter((message) => message.op === "input").length, 0);
  contents.emit("input-event", {}, { type: "mouseWheel", x: 20, y: 30 });
  assert.equal(posted.filter((message) => message.op === "input").length, 1);
});

test("takes a parked pane's screenshot although its window never draws", async () => {
  const { electron, panes, send, last } = await openedWith({ keepsRunning: true });
  const contents = electron.views[0].webContents;
  contents.neverDraws = true;
  electron.window.destroyed = true;
  panes.windowClosed(electron.window);
  send({ op: "cdp", browser: "bot:a", req: 7, tab: "p1", method: "Page.captureScreenshot", params: { format: "png" } });
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.deepEqual(last("answer").result, { data: Buffer.from("parked").toString("base64") });
  // One capture to make the page draw, one of the fresh frame.
  assert.equal(contents.captured, 2);
  // Nothing was shown for it.
  assert.notEqual(electron.views[0].visible, true);
});

test("the bot leaving a page dismisses the alert it left open first, so the navigation is never held", async () => {
  const { electron, send, last } = await openedWith();
  const contents = electron.views[0].webContents;
  const answers = [];
  contents.emit("-run-dialog", { dialogType: "alert", messageText: "Hi" }, (ok) => answers.push(ok));
  contents.debugger.emit("message", {}, "Page.javascriptDialogOpening", { type: "alert", message: "Hi" });
  contents.debugger.sent.length = 0;
  send({ op: "cdp", browser: "bot:a", req: 9, tab: "p1", method: "Page.navigate", params: { url: "https://example.com/next" } });
  await tick();
  await tick();
  assert.deepEqual(contents.debugger.sent.map((command) => command.method), ["Page.handleJavaScriptDialog", "Page.navigate"]);
  assert.deepEqual(contents.debugger.sent[0].params, { accept: false });
  assert.equal(last("answer").req, 9);
  // CDP closed it, and Electron's own callback is spent with it.
  contents.debugger.emit("message", {}, "Page.javascriptDialogClosed", {});
  assert.deepEqual(answers, []);
  // One CDP never reported is let go as a dismissed box.
  contents.emit("-run-dialog", { dialogType: "alert", messageText: "Again" }, (ok) => answers.push(ok));
  contents.debugger.sent.length = 0;
  send({ op: "cdp", browser: "bot:a", req: 10, tab: "p1", method: "Page.reload", params: {} });
  await tick();
  await tick();
  assert.deepEqual(answers, [false]);
  assert.deepEqual(contents.debugger.sent.map((command) => command.method), ["Page.reload"]);
});

test("a dialog that opens under the bot's click and its page read never holds them: both are answered at once", async () => {
  const { electron, send, posted } = await openedWith();
  const contents = electron.views[0].webContents;
  const original = contents.debugger.sendCommand.bind(contents.debugger);
  // Electron holds input and scripts while the page's alert is up; the answer to the dialog goes through.
  contents.debugger.sendCommand = (method, params, session) => (/^(?:Input\.|Runtime\.)/.test(method) ? new Promise(() => {}) : original(method, params, session));
  const answer = (req) => posted.find((message) => message.op === "answer" && message.req === req);
  // The order seen live: the click's release, the driver's read of the page, then the alert opening.
  send({ op: "cdp", browser: "bot:a", req: 20, tab: "p1", method: "Input.dispatchMouseEvent", params: { type: "mouseReleased", x: 10, y: 10, button: "left", clickCount: 1 } });
  send({ op: "cdp", browser: "bot:a", req: 21, tab: "p1", method: "Runtime.callFunctionOn", params: { functionDeclaration: "function () { return document.title; }", objectId: "o" } });
  await tick();
  assert.equal(answer(20), undefined);
  assert.equal(answer(21), undefined);
  contents.debugger.emit("message", {}, "Page.javascriptDialogOpening", { type: "alert", message: "hello alert" });
  await tick();
  assert.deepEqual(answer(20).result, {});
  assert.match(answer(21).error.message, /dialog is open/);
  // A read sent while it is open is answered at once too, and the dialog's own answer is never held.
  send({ op: "cdp", browser: "bot:a", req: 22, tab: "p1", method: "Runtime.evaluate", params: { expression: "1" } });
  send({ op: "cdp", browser: "bot:a", req: 23, tab: "p1", method: "Page.handleJavaScriptDialog", params: { accept: false } });
  await tick();
  await tick();
  assert.match(answer(22).error.message, /dialog is open/);
  assert.deepEqual(answer(23).result, {});
  // The driver's other reads of the page are answered too, not held for the link's timeout.
  for (const [req, method] of [[24, "DOM.getBoxModel"], [25, "Accessibility.getFullAXTree"], [26, "Page.getLayoutMetrics"]]) {
    send({ op: "cdp", browser: "bot:a", req, tab: "p1", method, params: {} });
    await tick();
    assert.match(answer(req).error.message, /dialog is open/, method);
  }
  // Leaving the page clears it, should the close event go missing.
  contents.emit("did-start-navigation", {}, "https://example.com/next", false, true);
  contents.debugger.sendCommand = original;
  send({ op: "cdp", browser: "bot:a", req: 27, tab: "p1", method: "Runtime.evaluate", params: { expression: "1" } });
  await tick();
  await tick();
  assert.deepEqual(answer(27).result, {});
});

test("takes a screenshot of a pane whose app window is minimised or hidden as it does a parked one", async () => {
  const { electron, send, last } = await openedWith();
  const contents = electron.views[0].webContents;
  contents.neverDraws = true;
  for (const [state, req] of [[{ isMinimized: () => true, isVisible: () => true }, 30], [{ isMinimized: () => false, isVisible: () => false }, 31]]) {
    Object.assign(electron.window, state);
    contents.captured = 0;
    send({ op: "cdp", browser: "bot:a", req, tab: "p1", method: "Page.captureScreenshot", params: { format: "png" } });
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.deepEqual(last("answer").result, { data: Buffer.from("parked").toString("base64") });
    assert.equal(contents.captured, 2);
  }
});

test("a turn's preview tick under an open alert never holds the bot's navigate: the live wire's order", async () => {
  const { electron, send, posted } = await openedWith();
  const contents = electron.views[0].webContents;
  const original = contents.debugger.sendCommand.bind(contents.debugger);
  let open = false;
  // Under the alert the page answers no screencast change, script, read or capture.
  contents.debugger.sendCommand = (method, params, session) => {
    if (method === "Page.handleJavaScriptDialog") open = false;
    return open && !/^(?:Page\.(?:handleJavaScriptDialog|navigate)|Page\.getNavigationHistory)/.test(method) ? new Promise(() => {}) : original(method, params, session);
  };
  const answer = (req) => posted.find((message) => message.op === "answer" && message.req === req);
  send({ op: "cdp", browser: "bot:a", req: 40, tab: "p1", method: "Input.dispatchMouseEvent", params: { type: "mouseReleased", x: 44, y: 97, button: "left", clickCount: 1 } });
  open = true;
  contents.debugger.emit("message", {}, "Page.javascriptDialogOpening", { type: "alert", message: "hello alert" });
  // The preview tick: pause the panel's screencast, capture, resume.
  send({ op: "cdp", browser: "bot:a", req: 41, tab: "p1", method: "Page.stopScreencast", params: {} });
  send({ op: "cdp", browser: "bot:a", req: 42, tab: "p1", method: "Page.getLayoutMetrics", params: {} });
  send({ op: "cdp", browser: "bot:a", req: 43, tab: "p1", method: "Page.captureScreenshot", params: { format: "jpeg" } });
  send({ op: "cdp", browser: "bot:a", req: 44, tab: "p1", method: "Page.stopScreencast", params: {} });
  send({ op: "cdp", browser: "bot:a", req: 45, tab: "p1", method: "Page.startScreencast", params: { format: "jpeg", quality: 70, maxWidth: 730, maxHeight: 1156 } });
  await tick();
  await tick();
  assert.deepEqual(answer(40).result, {});
  assert.deepEqual(answer(41).result, {});
  assert.match(answer(42).error.message, /dialog is open/);
  assert.match(answer(43).error.message, /dialog is open/);
  assert.deepEqual(answer(44).result, {});
  assert.deepEqual(answer(45).result, {});
  // Then the bot navigates: the alert is dismissed, the page leaves, and the screencast the panel wanted starts again.
  contents.debugger.sent.length = 0;
  send({ op: "cdp", browser: "bot:a", req: 46, tab: "p1", method: "Page.navigate", params: { url: "https://example.com/next" } });
  await tick();
  contents.debugger.emit("message", {}, "Page.javascriptDialogClosed", { result: false });
  await tick();
  await tick();
  assert.ok(answer(46).result);
  const methods = contents.debugger.sent.map((command) => command.method);
  assert.deepEqual(methods.slice(0, 2), ["Page.handleJavaScriptDialog", "Page.navigate"]);
  assert.ok(methods.includes("Page.startScreencast"));
});
