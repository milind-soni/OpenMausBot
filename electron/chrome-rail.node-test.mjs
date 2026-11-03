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

function world({ wanted = true, hidden = false, frame = true, listable } = {}) {
  const { win, page, children } = appWindow();
  const { made, createView } = viewMaker();
  const state = { wanted, hidden, changes: 0 };
  const prefs = { railHidden: () => state.hidden, setRailHidden: (value) => { state.hidden = value; }, windowFrame: () => frame };
  const rail = createChromeRail({ createView, preload: "/app/preload.cjs", args: () => ["--omb-local-origin=http://127.0.0.1:8799", "--omb-company-desktop=1"], url: () => RAIL,
    wanted: () => state.wanted, ...(listable ? { listable } : {}), prefs: () => prefs, changed: () => { state.changes++; } });
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
  assert.deepEqual(Object.keys(remote.bridge.rail), ["state", "drawsFrame", "setHidden", "onState", "openList"]);
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
  assert.deepEqual(Object.keys(local.bridge.rail), ["state", "drawsFrame", "setHidden", "onState", "openList", "expand", "listAsked", "listClosed", "onOpenList", "onSkin", "onFramed"]);
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

test("the accounts sheet holds the rail's page up, even for someone who hid the rail or has one place, and letting go puts things back", () => {
  const w = world({ wanted: false, hidden: true });
  w.rail.attach(w.win);
  assert.equal(w.rail.shown(), false);
  w.rail.holdOpen(true);
  assert.equal(w.rail.shown(), true);
  w.rail.expand(true);
  assert.equal(w.made[0].bounds.width, 1440, "the sheet has the whole window");
  w.rail.expand(false);
  w.rail.holdOpen(false);
  assert.equal(w.rail.shown(), false);
  w.state.hidden = false; w.state.wanted = true;
  w.rail.refresh();
  w.rail.holdOpen(true); w.rail.holdOpen(false);
  assert.equal(w.rail.shown(), true, "a rail that was there stays");
});

test("a tag on any page opens the list on the rail's own page, only from the person's click, and nothing of the list comes back", async () => {
  const remote = pageWithPreload("https://bots.example.test", "/", (channel) => (channel === "rail:open-list" ? { places: [{ id: "home" }] } : undefined));
  await assert.rejects(remote.bridge.rail.openList(), /Choose where you are/, "a server's page can't open it by itself");
  assert.deepEqual(JSON.parse(JSON.stringify(remote.invoked)), []);
  remote.navigator.userActivation.isActive = true;
  assert.equal(await remote.bridge.rail.openList(), undefined, "whatever main says, the page hears nothing");
  assert.deepEqual(JSON.parse(JSON.stringify(remote.invoked)), [["rail:open-list"]]);
  for (const name of ["listAsked", "listClosed", "onOpenList", "expand"]) assert.equal(remote.bridge.rail[name], undefined, `${name} is the rail's own page's`);
});

/** The rail's own page asks, from its main frame. */
const fromRail = (w) => ({ sender: w.made[0].webContents, senderFrame: w.made[0].webContents.mainFrame });

test("with no rail, or one the person hid, the list brings the rail's page up over a page that keeps the whole window; closing it puts things back", async () => {
  for (const setup of [{ wanted: false }, { hidden: true }]) {
    const w = world(setup);
    w.rail.attach(w.win);
    await w.ask("rail:offer");
    const tellings = w.page.told.length, signals = w.state.changes;
    await w.ask("rail:open-list");
    assert.equal(w.rail.shown(), true, "the rail's page is up for the list");
    assert.equal(w.rail.beside(), false, "the rail itself isn't");
    assert.equal(w.page.told.length, tellings, "the page is never told to move over, so it doesn't jump");
    assert.equal(w.state.changes, signals, "nor told that a rail came");
    assert.deepEqual(w.made[0].webContents.sent.at(-1), ["rail:open-list", false]);
    assert.equal(await w.handlers.get("rail:list-asked")(fromRail(w)), false, "a page that just came up learns it was asked for");
    assert.equal(await w.handlers.get("rail:list-asked")(fromRail(w)), null, "once");
    w.rail.expand(true);
    assert.equal(w.made[0].bounds.width, 1440, "the list has the whole window");
    await w.handlers.get("rail:list-closed")(fromRail(w));
    w.rail.expand(false);
    assert.deepEqual([w.rail.shown(), w.rail.beside(), w.children.length], [false, false, 0]);
    assert.equal(w.page.told.length, tellings);
  }
});

test("beside a rail that stands, the list leaves it standing and the page where it is", async () => {
  const w = world();
  w.rail.attach(w.win);
  await w.ask("rail:open-list");
  assert.deepEqual(w.made[0].webContents.sent.at(-1), ["rail:open-list", true]);
  assert.equal(await w.handlers.get("rail:list-asked")(fromRail(w)), true);
  await w.handlers.get("rail:list-closed")(fromRail(w));
  assert.deepEqual([w.rail.shown(), w.rail.beside(), w.page.told], [true, true, [CHROME_RAIL_WIDTH]]);
});

test("the rail coming while the list holds its page up moves the page over then, and only then", async () => {
  const w = world({ wanted: false });
  w.rail.attach(w.win);
  await w.ask("rail:open-list");
  w.state.wanted = true;
  w.rail.refresh();
  assert.deepEqual([w.rail.beside(), w.page.told], [true, [CHROME_RAIL_WIDTH]]);
  await w.handlers.get("rail:list-closed")(fromRail(w));
  assert.equal(w.rail.shown(), true);
  w.page.emit("dom-ready");
  assert.deepEqual(w.page.told, [CHROME_RAIL_WIDTH, CHROME_RAIL_WIDTH], "each new document is told again");
});

test("only the page beside the rail asks for the list, and only the rail's own page takes it", async () => {
  const w = world({ wanted: false });
  w.rail.attach(w.win);
  const open = w.handlers.get("rail:open-list");
  assert.throws(() => open({ sender: w.page, senderFrame: { id: "a-frame-inside" } }), /only available to the page beside/);
  assert.throws(() => open({ sender: { id: "another-window" }, senderFrame: w.page.mainFrame }), /only available to the page beside/);
  assert.equal(w.made.length, 0, "nothing came up");
  await w.ask("rail:open-list");
  for (const channel of ["rail:list-asked", "rail:list-closed"]) {
    assert.throws(() => w.handlers.get(channel)({ sender: w.page, senderFrame: w.page.mainFrame }), /only available to the window's rail/, channel);
  }
  assert.throws(() => open(fromRail(w)), /only available to the page beside/, "the rail's own page has no business asking");
});

test("while a sheet of the rail's covers the page, the page has no drag regions: Electron would give them the press over the sheet", async () => {
  const w = world();
  const css = [];
  Object.assign(w.page, { insertCSS: async (text) => { css.push(["insert", text]); return "key-1"; }, removeInsertedCSS: async (key) => { css.push(["remove", key]); } });
  w.rail.attach(w.win);
  w.rail.expand(true);
  w.rail.expand(true);
  await w.settle();
  assert.deepEqual(css, [["insert", "* { -webkit-app-region: no-drag !important; }"]], "once");
  w.rail.expand(false);
  await w.settle();
  assert.deepEqual(css.at(-1), ["remove", "key-1"], "and back after");
  w.rail.expand(false);
  await w.settle();
  assert.equal(css.length, 2);
  w.rail.expand(true);
  w.state.wanted = false;
  w.rail.refresh();
  await w.settle();
  assert.equal(css.at(-1)[0], "remove", "the view going takes the sheet with it");
});

test("connected to another computer, or with this app's server down, the tag's click brings nothing up", async () => {
  const w = world({ wanted: false, listable: () => false });
  w.rail.attach(w.win);
  await w.ask("rail:open-list");
  assert.deepEqual([w.rail.shown(), w.made.length], [false, 0]);
});

test("a new document under a sheet of the rail's has no drag regions either", async () => {
  const w = world();
  const css = [];
  Object.assign(w.page, { insertCSS: async (text) => { css.push(text); return `key-${css.length}`; }, removeInsertedCSS: async () => {} });
  w.rail.attach(w.win);
  w.rail.expand(true);
  w.page.emit("dom-ready");
  await w.settle();
  assert.equal(css.length, 2, "main puts it on the new document too");
  w.rail.expand(false);
  w.page.emit("dom-ready");
  await w.settle();
  assert.equal(css.length, 2, "with no sheet open, a new document keeps its own");
});

test("a rail's page that didn't load lets go of the window, so a list that can't come up leaves nothing over the page", async () => {
  const w = world({ wanted: false });
  w.rail.attach(w.win);
  await w.ask("rail:open-list");
  assert.equal(w.rail.shown(), true);
  w.made[0].webContents.emit("did-fail-load", {}, -3, "", "", true);
  assert.equal(w.rail.shown(), true, "a load replaced by another is no failure");
  w.made[0].webContents.emit("did-fail-load", {}, -102, "", "", false);
  assert.equal(w.rail.shown(), true, "nor a frame inside it");
  w.made[0].webContents.emit("did-fail-load", {}, -102, "", "", true);
  assert.deepEqual([w.rail.shown(), w.children.length], [false, 0]);
});

test("a view that comes up late still wears the skin of the page beside it, as its page loads and from before its script listens", () => {
  const w = world({ wanted: false });
  w.rail.attach(w.win);
  w.rail.send("rail:skin", "midnight");
  w.rail.holdOpen(true);
  const contents = w.made[0].webContents;
  contents.emit("did-finish-load");
  assert.deepEqual(contents.sent.find(([channel]) => channel === "rail:skin"), ["rail:skin", "midnight"]);
  const local = pageWithPreload("http://127.0.0.1:8799", "/rail");
  local.hear("rail:skin", "midnight");
  const worn = [];
  const stop = local.bridge.rail.onSkin((skin) => worn.push(skin));
  local.hear("rail:skin", "daylight");
  stop();
  assert.deepEqual(worn, ["midnight", "daylight"]);
  const remote = pageWithPreload("https://bots.example.test", "/");
  remote.hear("rail:skin", "midnight");
  assert.equal(remote.bridge.rail.onSkin, undefined, "the rail's own page's");
});

test("main's own wiring: the list holds the rail's page up through its window, and a page hears of a rail beside it only when it stands", () => {
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert.match(main, /beside: \(\) => chromeRail\.beside\(\)/);
  assert.match(main, /places: railList, list: everyPlace, open: id => workspaceMenuAction\(\(\) => switchEnvironment\(id\)\)/, "one switch, the rail's");
  assert.match(main, /signIn: cloudOffersAllowed\(\) && signInDue\(cloudAccount\?\.state\(\)\)/);
  assert.match(main, /choice === "signIn" \? \(homeWindow\.cloudOrigin\(\) \? homeWindow\.signIn\(\) : openCloudAdd\("app_menu", true\)\)/);
  assert.match(main, /const action = signIn \? "cloud-sign-in" :/);
});
