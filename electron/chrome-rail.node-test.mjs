import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import { CHROME_RAIL_PATH, CHROME_RAIL_WIDTH, RAIL_OFFER_GRACE_MS, createChromeRail } from "./chrome-rail.mjs";
import { TRAFFIC_LIGHTS } from "./window-chrome.mjs";

const RAIL = "http://127.0.0.1:8799/rail";

/** The app's window: its page (what it is told, and the rail's state once it asked) and the views laid over it. */
function appWindow() {
  const page = Object.assign(new EventEmitter(), { mainFrame: { id: "page-frame" }, told: [], states: [], destroyed: false,
    send(channel, value) { if (channel === "rail:beside") this.told.push(value); if (channel === "rail:state") this.states.push(value); }, isDestroyed() { return this.destroyed; } });
  const children = [];
  const win = Object.assign(new EventEmitter(), { webContents: page, size: [1440, 900], destroyed: false, lights: [],
    getContentSize() { return this.size; }, isDestroyed() { return this.destroyed; }, setWindowButtonPosition(point) { this.lights.push(point); },
    contentView: { addChildView: (view) => children.push(view), removeChildView: (view) => children.splice(children.indexOf(view), 1) } });
  return { win, page, children };
}

function viewMaker() {
  const made = [];
  const createView = (options) => {
    const contents = Object.assign(new EventEmitter(), { mainFrame: { id: "rail-frame" }, loaded: [], sent: [], focused: 0, closed: false, opener: null,
      loadURL(url) { this.loaded.push(url); return Promise.resolve(); }, setWindowOpenHandler(handler) { this.opener = handler; },
      send(channel, ...values) { this.sent.push([channel, ...values]); }, focus() { this.focused++; }, isDestroyed() { return this.closed; }, close() { this.closed = true; } });
    const view = { options, webContents: contents, bounds: null, background: null, setBounds(bounds) { this.bounds = bounds; }, setBackgroundColor(color) { this.background = color; } };
    made.push(view);
    return view;
  };
  return { made, createView };
}

function world({ wanted = true, hidden = false, frame = true } = {}) {
  const { win, page, children } = appWindow();
  const { made, createView } = viewMaker();
  const state = { wanted, hidden, changes: 0 };
  const prefs = { railHidden: () => state.hidden, setRailHidden: (value) => { state.hidden = value; }, windowFrame: () => frame };
  const rail = createChromeRail({ createView, preload: "/app/preload.cjs", args: () => ["--omb-local-origin=http://127.0.0.1:8799", "--omb-company-desktop=1"], url: () => RAIL,
    wanted: () => state.wanted, prefs: () => prefs, changed: () => { state.changes++; } });
  const handlers = new Map();
  rail.install({ handle: (channel, handler) => handlers.set(channel, handler) });
  /** The page beside the rail asks, from its main frame. */
  const ask = (channel, ...values) => handlers.get(channel)({ sender: page, senderFrame: page.mainFrame }, ...values);
  return { rail, win, page, children, made, state, handlers, ask, settle: () => new Promise((resolve) => setImmediate(resolve)) };
}

test("two places or more: the rail's own page in a view at the window's left edge, and the page beside it moves over", async () => {
  const w = world();
  w.rail.attach(w.win);
  await w.settle();
  assert.equal(w.made.length, 1);
  const [view] = w.made;
  assert.deepEqual(w.children, [view]);
  assert.deepEqual(view.bounds, { x: 0, y: 0, width: CHROME_RAIL_WIDTH, height: 900 });
  assert.equal(view.background, "#00000000", "transparent where the rail draws nothing");
  assert.deepEqual(view.webContents.loaded, [RAIL]);
  assert.deepEqual(view.options.webPreferences, { contextIsolation: true, sandbox: true, nodeIntegration: false, preload: "/app/preload.cjs",
    additionalArguments: ["--omb-local-origin=http://127.0.0.1:8799", "--omb-company-desktop=1"] });
  assert.deepEqual(w.page.told, [CHROME_RAIL_WIDTH], "the page beside it is told how wide the rail is");
  w.win.size = [1000, 700];
  w.win.emit("resize");
  assert.deepEqual(view.bounds, { x: 0, y: 0, width: CHROME_RAIL_WIDTH, height: 700 }, "the rail follows the window's height");
  assert.equal(w.rail.shown(), true);
});

test("a sheet of the rail's covers the whole window until it closes; only the rail's page may ask", async () => {
  const w = world();
  const handlers = w.handlers;
  w.rail.attach(w.win);
  const [view] = w.made;
  const fromRail = { sender: view.webContents, senderFrame: view.webContents.mainFrame };
  handlers.get("rail:expand")(fromRail, true);
  assert.deepEqual(view.bounds, { x: 0, y: 0, width: 1440, height: 900 });
  assert.equal(view.webContents.focused, 1, "the sheet takes the keyboard");
  handlers.get("rail:expand")(fromRail, false);
  assert.deepEqual(view.bounds, { x: 0, y: 0, width: CHROME_RAIL_WIDTH, height: 900 });
  for (const event of [{ sender: w.page, senderFrame: w.page.mainFrame }, { sender: view.webContents, senderFrame: { id: "an-iframe" } }, {}]) {
    assert.throws(() => handlers.get("rail:expand")(event, true), /only available to the window's rail/);
  }
  assert.equal(w.rail.owns(fromRail), true);
  assert.equal(w.rail.owns({ sender: w.page, senderFrame: w.page.mainFrame }), false, "a place's page is never the rail");
});

test("each new document beside the rail is told again; with fewer than two places the rail goes and the page has the window", async () => {
  const w = world();
  w.rail.attach(w.win);
  w.page.emit("dom-ready");
  assert.deepEqual(w.page.told, [CHROME_RAIL_WIDTH, CHROME_RAIL_WIDTH], "the next server's page moves over too");
  w.state.wanted = false;
  w.rail.refresh();
  assert.deepEqual(w.children, []);
  assert.deepEqual(w.page.told.at(-1), 0, "the room is given back");
  w.page.emit("dom-ready");
  assert.equal(w.page.told.length, 3, "a page with no rail beside it is told nothing more");
  w.rail.expand(true);
  assert.equal(w.rail.expanded(), false, "nothing to cover while there is no rail");
  w.state.wanted = true;
  w.rail.refresh();
  assert.equal(w.made.length, 1, "the same page comes back");
  assert.deepEqual(w.children, [w.made[0]]);
});

test("the rail's page stays this app's rail: no other page, no new window; the window closing closes it", async () => {
  const w = world();
  w.rail.attach(w.win);
  const contents = w.made[0].webContents;
  for (const [target, kept] of [[RAIL, true], ["https://evil.example.test/", false], ["http://127.0.0.1:8799/", false]]) {
    let prevented = false;
    contents.emit("will-navigate", { preventDefault: () => { prevented = true; } }, target);
    assert.equal(prevented, !kept, target);
  }
  assert.deepEqual(contents.opener({ url: "https://evil.example.test/" }), { action: "deny" });
  w.win.emit("closed");
  assert.equal(contents.closed, true);
  assert.equal(w.rail.shown(), false);
});

test("nothing to show: no view is made at all", () => {
  const w = world({ wanted: false });
  w.rail.attach(w.win);
  assert.deepEqual([w.made.length, w.children.length, w.page.told.length], [0, 0, 0]);
});

test("the page beside the rail offers the button: hiding gives the page the whole window, and this desktop keeps the choice", () => {
  const w = world();
  w.rail.attach(w.win);
  const [view] = w.made;
  assert.deepEqual(w.ask("rail:offer"), { available: true, hidden: false }, "whether there is a rail to hide, never its places");
  assert.deepEqual(w.ask("rail:hide", true), { available: true, hidden: true });
  assert.equal(w.state.hidden, true, "kept with this desktop's own preferences");
  assert.deepEqual([w.children, w.page.told.at(-1), w.rail.shown(), w.state.changes], [[], 0, false, 2], "the page has the whole window, and pages hear the rail went");
  assert.deepEqual(w.ask("rail:hide", "yes"), { available: true, hidden: false }, "only true hides it");
  assert.deepEqual([w.children, w.page.told.at(-1), w.made.length], [[view], CHROME_RAIL_WIDTH, 1], "the same page comes back beside it");
  w.ask("rail:hide", true);
  w.state.wanted = false;
  w.rail.refresh();
  assert.deepEqual(w.page.states, [{ available: false, hidden: true }], "told when there is no rail to show any more, and never what it was just answered");
});

test("only the page beside the rail, in its main frame, offers the button: never the rail's own page, a frame inside the page or another window", () => {
  const w = world();
  w.rail.attach(w.win);
  const [view] = w.made, other = appWindow().page;
  for (const event of [{ sender: view.webContents, senderFrame: view.webContents.mainFrame }, { sender: w.page, senderFrame: { id: "an-iframe" } },
    { sender: other, senderFrame: other.mainFrame }, {}]) {
    assert.throws(() => w.handlers.get("rail:offer")(event), /only available to the page beside the window's rail/);
    assert.throws(() => w.handlers.get("rail:hide")(event, true), /only available to the page beside the window's rail/);
  }
  assert.deepEqual([w.state.hidden, w.rail.shown()], [false, true], "nothing hidden, nothing kept");
});

test("after the page moves on, a hidden rail waits a few seconds for the new page's button: this app's page keeps it hidden, an older one gets it back", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const w = world({ hidden: true });
  w.rail.attach(w.win);
  assert.deepEqual([w.rail.shown(), w.made.length], [false, 0], "hidden while the window's first page loads");
  w.page.emit("did-navigate");
  t.mock.timers.tick(RAIL_OFFER_GRACE_MS - 1);
  w.ask("rail:offer");
  t.mock.timers.tick(RAIL_OFFER_GRACE_MS);
  assert.deepEqual([w.rail.shown(), w.made.length, w.page.told], [false, 0, []], "the page offered its button in time: no flicker");
  w.page.emit("did-navigate");
  t.mock.timers.tick(RAIL_OFFER_GRACE_MS - 1);
  assert.equal(w.rail.shown(), false, "still time for the next page");
  t.mock.timers.tick(1);
  assert.deepEqual([w.rail.shown(), w.page.told.at(-1)], [true, CHROME_RAIL_WIDTH], "an older server's page with no button: the rail comes back");
  assert.equal(w.state.hidden, true, "and the choice is kept");
  w.page.emit("did-navigate");
  t.mock.timers.tick(RAIL_OFFER_GRACE_MS);
  assert.equal(w.rail.shown(), true, "a rail back beside a page with no button stays while the next one loads");
  w.ask("rail:offer");
  assert.deepEqual([w.rail.shown(), w.page.told.at(-1)], [false, 0], "until that one offers its button");
});

test("the traffic lights sit in the frame's top bar beside a page that draws it, and go back where an older release left room for them", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const w = world();
  w.rail.attach(w.win);
  const framed = () => w.made[0].webContents.sent.filter(([channel]) => channel === "rail:framed").map(([, value]) => value);
  t.mock.timers.tick(RAIL_OFFER_GRACE_MS - 1);
  w.ask("rail:draws-frame");
  t.mock.timers.tick(RAIL_OFFER_GRACE_MS);
  assert.deepEqual([w.rail.framed(), w.win.lights, framed()], [true, [], []], "this app's page draws the frame in time: the window stays as it opened");
  w.page.emit("did-navigate");
  t.mock.timers.tick(RAIL_OFFER_GRACE_MS - 1);
  assert.equal(w.rail.framed(), true, "still time for the next page");
  t.mock.timers.tick(1);
  assert.deepEqual([w.rail.framed(), w.win.lights, framed()], [false, [TRAFFIC_LIGHTS.unframed], [false]],
    "an older Cloud's page, which never says so: the lights go back to its row, and the rail's places under them");
  w.made[0].webContents.emit("did-finish-load");
  assert.deepEqual(framed(), [false, false], "the rail's page, loaded again, hears it too");
  w.page.emit("did-navigate");
  w.ask("rail:draws-frame");
  assert.deepEqual([w.rail.framed(), w.win.lights.at(-1), framed().at(-1)], [true, TRAFFIC_LIGHTS.framed, true], "the next page draws it: back in the bar at once");
  const [view] = w.made;
  for (const event of [{ sender: view.webContents, senderFrame: view.webContents.mainFrame }, { sender: w.page, senderFrame: { id: "an-iframe" } }, {}]) {
    assert.throws(() => w.handlers.get("rail:draws-frame")(event), /only available to the page beside the window's rail/);
  }
});

test("a page with the frame turned off says it draws none: the traffic lights go back at once, and the window opens that way next time", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const w = world();
  w.rail.attach(w.win);
  w.ask("rail:draws-frame", true);
  w.ask("rail:draws-frame", false);
  assert.deepEqual([w.rail.framed(), w.win.lights], [false, [TRAFFIC_LIGHTS.unframed]], "no grace to wait out: the page said so");
  w.ask("rail:draws-frame", true);
  assert.deepEqual([w.rail.framed(), w.win.lights.at(-1)], [true, TRAFFIC_LIGHTS.framed], "and back in the bar when it is turned on again");
  const off = world({ frame: false });
  off.rail.attach(off.win);
  t.mock.timers.tick(RAIL_OFFER_GRACE_MS);
  assert.deepEqual([off.rail.framed(), off.win.lights], [false, []], "a window made with the frame off opened its lights where they stay (windowChromeOptions)");
});

test("a page that stops responding, crashes or gives way to an error page gets the rail back", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const w = world({ hidden: true });
  w.rail.attach(w.win);
  w.ask("rail:offer");
  w.page.emit("unresponsive");
  assert.equal(w.rail.shown(), true, "a hung page can't bring it back");
  w.page.emit("responsive");
  assert.equal(w.rail.shown(), false, "hidden again once it answers");
  w.page.emit("render-process-gone");
  t.mock.timers.tick(RAIL_OFFER_GRACE_MS);
  assert.equal(w.rail.shown(), true, "its page crashed, and nothing offered the button since");
  w.ask("rail:offer");
  w.page.emit("did-fail-load", {}, -3, "ERR_ABORTED", "https://cloud.example.test/", true);
  w.page.emit("did-fail-load", {}, -105, "ERR_NAME_NOT_RESOLVED", "https://cdn.example.test/", false);
  t.mock.timers.tick(RAIL_OFFER_GRACE_MS);
  assert.equal(w.rail.shown(), false, "a load cut short by another, or a frame inside the page that failed, leaves the page as it was");
  w.page.emit("did-fail-load", {}, -105, "ERR_NAME_NOT_RESOLVED", "https://cloud.example.test/", true);
  t.mock.timers.tick(RAIL_OFFER_GRACE_MS);
  assert.equal(w.rail.shown(), true, "an error page in its place has no button");
  w.win.emit("closed");
  t.mock.timers.tick(RAIL_OFFER_GRACE_MS);
});

test("main's own wiring: the choice is this desktop's, and the pages hear the rail come and go", () => {
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const start = main.indexOf("const chromeRail = createChromeRail("), end = main.indexOf("chromeRail.install(ipcMain);", start);
  assert.ok(start >= 0 && end > start, "main makes the window's rail");
  const { made, createView } = viewMaker();
  const kept = { hidden: false }, signals = [], handlers = new Map();
  const context = vm.createContext({ createChromeRail, CHROME_RAIL_PATH, WebContentsView: function WebContentsView(options) { return createView(options); },
    path: { join: (...parts) => parts.join("/") }, __dirname: "/app", slog: () => {}, desktopCompanionRendererArguments: () => [],
    app: { isPackaged: true, getVersion: () => "0.1.133" }, desktopRemoteAccess: null, rendererOrigin: () => "http://127.0.0.1:8799", serverReady: true,
    railList: () => [{ id: "local" }, { id: "home" }], desktopPrefs: { railHidden: () => kept.hidden, setRailHidden: (hidden) => { kept.hidden = hidden; } },
    rail: { changed: () => signals.push("changed") }, ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } });
  const chromeRail = vm.runInContext(`${main.slice(start, end)}chromeRail.install(ipcMain); chromeRail`, context);
  const { win, page } = appWindow();
  chromeRail.attach(win);
  assert.deepEqual(made.map((view) => view.webContents.loaded), [["http://127.0.0.1:8799/rail"]]);
  handlers.get("rail:hide")({ sender: page, senderFrame: page.mainFrame }, true);
  assert.deepEqual([kept.hidden, chromeRail.shown(), signals], [true, false, ["changed", "changed"]]);
});

/** The app's preload in a page of the window, with what the room needs of the page: its document, size and zoom. */
function pageWithPreload(origin = "https://bots.example.test", pathname = "/", answer = () => undefined) {
  const listeners = new Map(), handlers = new Map(), invoked = [];
  const head = { children: [], append(node) { this.children.push(node); node.isConnected = true; } };
  const document = { documentElement: { style: { zoom: "" } }, head, createElement: () => ({ textContent: "", isConnected: false, remove() { head.children.splice(head.children.indexOf(this), 1); this.isConnected = false; } }) };
  const frame = { zoom: 1 }, navigator = { userActivation: { isActive: false } };
  let bridge = null;
  vm.runInNewContext(readFileSync(new URL("./preload.cjs", import.meta.url), "utf8"), {
    process: { platform: "darwin", argv: ["--omb-local-origin=http://127.0.0.1:8799", "--omb-company-desktop=1"] },
    location: { origin, pathname }, navigator, TextEncoder, localStorage: { getItem: () => null }, queueMicrotask, document,
    window: { addEventListener: (type, listener) => listeners.set(type, listener) },
    require: () => ({ webUtils: {}, webFrame: { getZoomFactor: () => frame.zoom }, contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
      ipcRenderer: { on: (channel, handler) => handlers.set(channel, handler), removeListener: (channel, handler) => { if (handlers.get(channel) === handler) handlers.delete(channel); },
        send() {}, sendSync: () => null, invoke: (channel, ...values) => { invoked.push([channel, ...values]); return Promise.resolve(answer(channel, ...values)); } } }),
  });
  return { head, frame, root: document.documentElement, bridge, invoked, navigator, tell: (width) => handlers.get("rail:beside")({}, width), resize: () => listeners.get("resize")(),
    hear: (channel, ...values) => handlers.get(channel)?.({}, ...values) };
}

test("every page beside the rail, from any server, moves over by the rail's width at any zoom, and back when it goes", () => {
  const page = pageWithPreload();
  page.tell(CHROME_RAIL_WIDTH);
  assert.equal(page.head.children.length, 1);
  assert.match(page.head.children[0].textContent, /padding-left: 36px !important; --rail-beside: 36px;/, "and the page can read how far it moved");
  page.frame.zoom = 1.25;
  page.resize();
  assert.match(page.head.children[0].textContent, /padding-left: 28\.8px !important; --rail-beside: 28\.8px;/, "zoomed in, the same 36 points on screen");
  page.tell("9999");
  assert.match(page.head.children[0].textContent, /padding-left: 160px/, "never more than 200 points, whatever is sent");
  page.tell(0);
  assert.equal(page.head.children.length, 0, "the page has the whole window again");
});

test("the rail's own page keeps its size at any zoom of this app's page (Chromium shares a host's zoom); no other page is touched", () => {
  const rail = pageWithPreload("http://127.0.0.1:8799", "/rail");
  rail.frame.zoom = 1.25;
  rail.resize();
  assert.equal(rail.root.style.zoom, "0.8", "zoomed in, the rail takes the zoom back out");
  rail.frame.zoom = 1;
  rail.resize();
  assert.equal(rail.root.style.zoom, "");
  for (const [origin, pathname] of [["http://127.0.0.1:8799", "/"], ["https://bots.example.test", "/rail"]]) {
    const page = pageWithPreload(origin, pathname);
    page.frame.zoom = 1.25;
    page.resize();
    assert.equal(page.root.style.zoom, "", `${origin}${pathname} keeps its zoom`);
  }
});

test("every page beside the rail, from any server, gets the button's bridge, learns only whether there is a rail to hide, and says when it draws the frame; the rail's own channels stay this app's", async () => {
  const remote = pageWithPreload("https://bots.example.test", "/", (channel) => (channel === "rail:offer" ? { available: "yes", hidden: 1, places: [{ id: "home" }] } : { available: true, hidden: true }));
  assert.deepEqual(Object.keys(remote.bridge.rail), ["state", "drawsFrame", "setHidden", "onState"]);
  /** A value made in the page's own context, as this one sees it. */
  const plain = (value) => JSON.parse(JSON.stringify(value));
  assert.deepEqual(plain(await remote.bridge.rail.state()), { available: false, hidden: false }, "two plain answers, nothing else main might send");
  await assert.rejects(remote.bridge.rail.setHidden(true), /Choose to hide or show/, "a server's page hides it only from the person's click");
  remote.navigator.userActivation.isActive = true;
  assert.deepEqual(plain(await remote.bridge.rail.setHidden(true)), { available: true, hidden: true });
  await remote.bridge.rail.drawsFrame();
  await remote.bridge.rail.drawsFrame(false);
  assert.deepEqual(plain(remote.invoked), [["rail:offer"], ["rail:hide", true], ["rail:draws-frame", true], ["rail:draws-frame", false]]);
  const heard = [];
  const stop = remote.bridge.rail.onState((state) => heard.push(state));
  remote.hear("rail:state", { available: true, hidden: false, places: ["home"] });
  stop();
  remote.hear("rail:state", { available: true, hidden: true });
  assert.deepEqual(plain(heard), [{ available: true, hidden: false }]);
  const local = pageWithPreload("http://127.0.0.1:8799", "/");
  assert.deepEqual(Object.keys(local.bridge.rail), ["state", "drawsFrame", "setHidden", "onState", "expand", "onSkin", "onFramed"]);
  const framed = [];
  const unheard = local.bridge.rail.onFramed((value) => framed.push(value));
  local.hear("rail:framed", false);
  local.hear("rail:framed", "yes");
  unheard();
  local.hear("rail:framed", true);
  assert.deepEqual(framed, [false, false], "only true is framed");
  await local.bridge.rail.setHidden(false);
  assert.deepEqual(plain(local.invoked), [["rail:hide", false]], "this app's own page, as for its other choices");
});
