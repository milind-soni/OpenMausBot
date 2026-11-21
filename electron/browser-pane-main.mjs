// The bots' browsers as native views in the app window: one WebContentsView per tab on the profile's own partition,
// its debugger relayed to the app's own server, shown over the Browser panel's rectangle when the panel asks.
// Security: views are created and their debuggers attached only here, never for a webContents the renderer names;
// the renderer only says which bot's panel shows where.
import { randomUUID } from "node:crypto";
import path from "node:path";

import desktopWorkspace from "./desktop-workspace.cjs";
import { paneBaseUserAgent, paneIdentityMode, paneRequestUserAgent, paneTabUserAgent } from "./browser-pane-identity.mjs";
import { PANE_MESSAGE, PANE_PARTITION, PANE_TABS_PER_BROWSER, paneMessageToMain } from "./browser-pane-wire.mjs";
import { RESTORE_PROMPT, takeDialogs } from "./browser-pane-dialogs.mjs";
import { createEchoes } from "./browser-pane-input.mjs";
import { createDialogGate } from "./browser-pane-under-dialog.mjs";
import { captureUndrawn, windowDraws } from "./browser-pane-capture.mjs";

const { normalizeDesktopWorkspaceBounds } = desktopWorkspace;
const PERSON_INPUT = new Set(["mouseDown", "keyDown", "rawKeyDown", "char", "mouseWheel", "gestureScrollBegin", "touchStart"]);
const PING_MS = 250;
const RESOLVE_MS = 5_000;
/** A window.open this soon after the person's own press or key, with Chromium's user gesture, is the person's. */
const GESTURE_MS = 1_000;
const POPUP_SIZE = { width: 520, height: 680 };
/** Commands that leave the page: an open dialog would hold them for good, as the page cannot unload under it. */
const LEAVING = new Set(["Page.navigate", "Page.reload", "Page.navigateToHistoryEntry", "Page.close"]);
const CAPTURE_MS = 10_000;
const HIDDEN_SIZE = { width: 1280, height: 800 };
/** Granted as a normal profile has them; everything else is refused without a prompt. */
const GRANTED = new Set(["clipboard-sanitized-write", "fullscreen", "pointerLock"]);
const BOT = /^[\w.-]{1,128}$/;
const PROFILE = /^[\w.:-]{1,128}$/;

const originOf = (url) => { try { return new URL(url).origin; } catch { return ""; } };
const isObject = (value) => Object.prototype.toString.call(value) === "[object Object]";
/**
 * Security: a sign-in import reads the person's own browsers, so only the app window's own top page may ask for one:
 * not another window, and not a frame inside it. This holds while the app frames a bot's pages only from another origin
 * or sandboxed (published apps and web panels refuse the app's own origin): a same-origin frame could call the top
 * page's bridge.
 */
export function fromAppWindow(event, window) {
  if (!window || window.isDestroyed() || event?.sender !== window.webContents || event.senderFrame !== event.sender.mainFrame) {
    throw new Error("Sign-in import belongs to the main app window");
  }
}

const NO_PANEL = Object.freeze({ botId: null, threadId: null, profile: null, wanted: false, bounds: null, browser: null });
const samePanel = (a, b) => a.botId === b.botId && a.threadId === b.threadId && a.profile === b.profile;

/**
 * `createView(options)`: a WebContentsView. `createPopup(options)`: a BrowserWindow, for a sign-in popup the person
 * opened. `createParking()`: a BrowserWindow never shown, which holds the panes while the app window is closed, so a
 * bot's pages, sign-ins and its one cookie jar live on; only while `keepsRunning()`, as a window that stays would keep
 * the app from quitting when its last window closes, and never once `quitting()`, as a window made then cancels the quit.
 * `fromPartition(name)`: Electron's session. `owner()`: the app window
 * or null. `chromeVersion`: process.versions.chrome.
 */
export function createBrowserPanes({ createView, createPopup = null, createParking = null, keepsRunning = () => false, quitting = () => false, fromPartition, owner, chromeVersion, log = () => {}, now = Date.now, captureMs = CAPTURE_MS }) {
  const browsers = new Map();
  const configured = new Set();
  /** Per partition: Electron's own UA, read before this module changed it, and the identity mode in force. */
  const identities = new Map();
  const pings = new Map();
  const resolving = new Map();
  const asking = new Map();
  const watched = new WeakSet();
  let server = null;
  let tabCount = 0;
  let requests = 0;
  let asks = 0;
  let panel = NO_PANEL;
  let parking = null;
  /** Chromium's own client hints of this app's Chromium, read once from a pane. */
  let hints = null;

  /** Where panes live: the app window, or the parking window while there is none. */
  function host() {
    const win = owner();
    if (win && !win.isDestroyed()) return win;
    if (!createParking || !keepsRunning() || quitting()) return null;
    if (!parking || parking.isDestroyed()) {
      try {
        parking = createParking();
      } catch (error) {
        log(`browser pane: could not keep panes without a window: ${error?.message ?? error}`);
        parking = null;
      }
    }
    return parking;
  }

  /** Moves a pane's view into `target`; a view sits in one window at a time. */
  function place(entry, target) {
    if (entry.popup || !target || entry.window === target) return;
    try { if (entry.window && !entry.window.isDestroyed()) entry.window.contentView.removeChildView(entry.view); } catch {}
    target.contentView.addChildView(entry.view);
    entry.window = target;
  }

  const post = (message) => {
    try {
      server?.postMessage({ type: PANE_MESSAGE, ...message });
    } catch (error) {
      log(`browser pane: could not reach the server: ${error?.message ?? error}`);
    }
  };

  function tabOf(contents) {
    for (const [key, browser] of browsers) {
      for (const entry of browser.tabs.values()) if (entry.contents === contents) return { key, browser, entry };
    }
    return null;
  }

  /** Every download is saved into the profile's download folder, never through a Save dialog, and reported. */
  function download(item, contents) {
    const found = tabOf(contents);
    if (!found) {
      item.cancel();
      return;
    }
    const { key, browser, entry } = found;
    const guid = randomUUID();
    const file = path.join(browser.downloads, guid);
    item.setSavePath(file);
    browser.items.set(guid, item);
    post({ op: "download", browser: key, tab: entry.tab, guid, state: "begin", url: item.getURL(), name: item.getFilename() });
    item.on("updated", () => {
      post({ op: "download", browser: key, tab: entry.tab, guid, state: "inProgress", received: item.getReceivedBytes(), total: item.getTotalBytes() });
    });
    item.once("done", (_event, state) => {
      browser.items.delete(guid);
      const completed = state === "completed";
      post({ op: "download", browser: key, tab: entry.tab, guid, state: completed ? "completed" : "canceled", received: item.getReceivedBytes(), total: item.getTotalBytes(), ...(completed ? { path: file } : {}) });
    });
  }

  function configure(partition, mode) {
    const session = fromPartition(partition);
    if (!identities.has(partition)) identities.set(partition, { electron: session.getUserAgent(), mode });
    const identity = identities.get(partition);
    identity.mode = paneIdentityMode(mode);
    session.setUserAgent(paneBaseUserAgent(identity.electron, identity.mode));
    if (configured.has(partition)) return session;
    configured.add(partition);
    // Only the User-Agent header: client hints stay Chromium's own.
    session.webRequest.onBeforeSendHeaders((details, callback) => {
      const wanted = paneRequestUserAgent(identity.electron, identity.mode, details);
      const name = Object.keys(details.requestHeaders).find((header) => header.toLowerCase() === "user-agent") ?? "User-Agent";
      callback({ requestHeaders: details.requestHeaders[name] === wanted ? details.requestHeaders : { ...details.requestHeaders, [name]: wanted } });
    });
    session.setPermissionRequestHandler((_contents, permission, callback) => callback(GRANTED.has(permission)));
    session.setPermissionCheckHandler((_contents, permission) => GRANTED.has(permission));
    session.on("will-download", (_event, item, contents) => download(item, contents));
    return session;
  }

  function size() {
    return panel.bounds ? { width: panel.bounds.width, height: panel.bounds.height } : HIDDEN_SIZE;
  }

  function layout() {
    const win = owner();
    const shownIn = win && !win.isDestroyed() ? win : null;
    for (const [key, browser] of browsers) {
      for (const [tab, entry] of browser.tabs) {
        if (entry.popup) continue;
        const visible = Boolean(shownIn && panel.wanted && panel.bounds && panel.browser === key && browser.active === tab);
        try {
          if (visible) {
            entry.view.setBounds(panel.bounds);
            if (entry.window !== shownIn) place(entry, shownIn);
            else if (!entry.visible) shownIn.contentView.addChildView(entry.view);
          }
          entry.view.setVisible(visible);
        } catch (error) {
          log(`browser pane: could not place ${tab}: ${error?.message ?? error}`);
        }
        entry.visible = visible;
      }
    }
  }

  /**
   * Known open risk: Chromium draws nothing for a view it does not show, and a screenshot of an undrawn page waits for a
   * frame that never comes. A hidden pane is shown for the capture with all but one pixel past the window's corner; one
   * in a window that draws nothing (parked, minimised or hidden) is captured with captureUndrawn instead.
   */
  function paintHold(entry) {
    const win = entry.window;
    if (entry.visible || entry.popup || !win || win.isDestroyed() || win === parking) return () => {};
    const [width, height] = win.getContentSize();
    const page = size();
    entry.view.setBounds({ x: Math.max(0, width - 1), y: Math.max(0, height - 1), ...page });
    entry.view.setVisible(true);
    return () => {
      if (entry.visible) return;
      entry.view.setVisible(false);
      entry.view.setBounds({ x: 0, y: 0, ...page });
    };
  }

  function ping(key, entry) {
    entry.personAt = now();
    const last = pings.get(key);
    if (last !== undefined && last.tab === entry.tab && now() - last.at < PING_MS) return;
    pings.set(key, { tab: entry.tab, at: now() });
    post({ op: "input", browser: key, tab: entry.tab });
  }

  async function targetOf(contents) {
    const { frameTree } = await contents.debugger.sendCommand("Page.getFrameTree");
    return String(frameTree.frame.id);
  }

  /**
   * Chromium leaves the client hints out of a navigation's request once a session's user agent is overridden without
   * them (measured on Electron 43: page fetches had them, the document request had none). So each pane also gets its
   * user agent through CDP with Chromium's own metadata, read once from a pane's about:blank: the brands and versions a
   * page reads, never invented ones.
   */
  async function clientHints(contents) {
    if (hints) return hints;
    const { result } = await contents.debugger.sendCommand("Runtime.evaluate", {
      expression: "navigator.userAgentData.getHighEntropyValues(['architecture','bitness','model','platformVersion','fullVersionList','wow64','formFactors']).then((v) => ({ ...v, brands: navigator.userAgentData.brands, mobile: navigator.userAgentData.mobile, platform: navigator.userAgentData.platform }))",
      awaitPromise: true,
      returnByValue: true,
    });
    const value = result?.value;
    if (!isObject(value) || !Array.isArray(value.brands)) return null;
    hints = {
      brands: value.brands, fullVersionList: value.fullVersionList ?? value.brands, platform: String(value.platform ?? ""), platformVersion: String(value.platformVersion ?? ""),
      architecture: String(value.architecture ?? ""), model: String(value.model ?? ""), mobile: value.mobile === true, bitness: String(value.bitness ?? ""), wow64: value.wow64 === true,
      ...(Array.isArray(value.formFactors) ? { formFactors: value.formFactors } : {}),
    };
    return hints;
  }

  async function presentAs(entry, userAgent) {
    const metadata = await clientHints(entry.contents).catch(() => null);
    if (!metadata) return;
    await entry.contents.debugger.sendCommand("Emulation.setUserAgentOverride", { userAgent, userAgentMetadata: metadata }).catch(() => undefined);
  }

  function tabAgent(browser, url) {
    const identity = identities.get(browser.partition);
    return identity ? paneTabUserAgent(identity.electron, identity.mode, url) : null;
  }

  /** What every pane gets before the server sees it: prompt back, and its identity with Chromium's own hints. */
  async function prepare(browser, entry) {
    await entry.contents.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: RESTORE_PROMPT, runImmediately: true }).catch(() => undefined);
    const agent = tabAgent(browser, entry.contents.getURL());
    entry.agent = agent;
    if (agent) await presentAs(entry, agent);
  }

  function info(key, entry) {
    if (!entry.target) return;
    post({ op: "tab", browser: key, tab: entry.tab, target: entry.target, url: entry.contents.getURL() || "about:blank", title: entry.contents.getTitle(), ...(entry.opener ? { opener: entry.opener } : {}) });
  }

  /** Why no tab can open in this browser now, or null. */
  function tabRefusal(key) {
    const browser = browsers.get(key);
    const win = host();
    if (!browser) return "Target closed";
    if (!win || win.isDestroyed()) return "No app window can hold a browser pane now.";
    if (browser.tabs.size >= PANE_TABS_PER_BROWSER) return `This browser already has ${PANE_TABS_PER_BROWSER} tabs open. Close one before opening another.`;
    return null;
  }

  function webPreferences(browser) {
    // devTools off: DevTools would take the debugger from the bot (one client per webContents), and opening it once lost
    // the passkey fail-fast for good. CDP and debugger.attach still work with it off (measured on Electron 43).
    return { partition: browser.partition, sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, backgroundThrottling: false, safeDialogs: true, devTools: false };
  }

  /** A sign-in popup the person's own click opened: Chromium's user gesture, the person's input, no bot input. */
  function personOpened(entry, url) {
    const report = entry.windowOpen;
    return Boolean(report && report.userGesture && report.url === url && now() - report.at < GESTURE_MS)
      && now() - entry.personAt < GESTURE_MS && !entry.echoes.inFlight && now() - entry.botInputAt >= GESTURE_MS;
  }

  /**
   * A popup the person opened becomes a real child window on the pane's session, the page's own child so its opener
   * stays; one per opener. Anything else (the bot's clicks, a late open) becomes a tab, its opener kept as well.
   */
  function openPopup(key, entry, details) {
    if (tabRefusal(key)) return { action: "deny" };
    if (createPopup && personOpened(entry, details.url)) {
      const open = entry.popupChild && browsers.get(key)?.tabs.get(entry.popupChild);
      if (open && !open.popup.isDestroyed()) {
        open.popup.focus();
        return { action: "deny" };
      }
      return {
        action: "allow",
        createWindow: (options) => {
          const child = createTab(key, { adopt: options?.webContents, opener: entry.tab, windowed: true });
          entry.popupChild = child.tab;
          void prepare(browsers.get(key), child).then(() => targetOf(child.contents)).then((target) => { child.target = target; info(key, child); }, () => removeTab(key, child.tab));
          return child.contents;
        },
      };
    }
    return {
      action: "allow",
      createWindow: (options) => {
        const popup = createTab(key, { adopt: options?.webContents, opener: entry.tab });
        void prepare(browsers.get(key), popup).then(() => targetOf(popup.contents)).then((target) => { popup.target = target; info(key, popup); }, () => removeTab(key, popup.tab));
        return popup.contents;
      },
    };
  }

  function createTab(key, { background = false, adopt, opener, windowed = false } = {}) {
    const refusal = tabRefusal(key);
    if (refusal) throw new Error(refusal);
    const browser = browsers.get(key);
    const win = host();
    let view = null;
    let popup = null;
    if (windowed) {
      popup = createPopup({
        parent: win, modal: false, show: true, autoHideMenuBar: true, ...POPUP_SIZE,
        webPreferences: webPreferences(browser), ...(adopt ? { webContents: adopt } : {}),
      });
    } else {
      view = createView({ webPreferences: webPreferences(browser), ...(adopt ? { webContents: adopt } : {}) });
    }
    const contents = (popup ?? view).webContents;
    contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
    const entry = {
      tab: `p${++tabCount}`, view, popup, contents, window: null, target: null, visible: false, echoes: createEchoes(now), botInputAt: -Infinity,
      personAt: -Infinity, windowOpen: null, agent: null, ...(opener ? { opener } : {}),
      gate: createDialogGate({ apply: (method, params) => contents.debugger.sendCommand(method, params) }),
    };
    entry.dialogs = takeDialogs(contents, { opened: () => entry.gate.open, warn: log });
    contents.debugger.attach("1.3");
    browser.tabs.set(entry.tab, entry);
    contents.debugger.on("message", (_event, method, params, sessionId) => {
      if (method === "Page.windowOpen" && !sessionId && isObject(params)) entry.windowOpen = { url: String(params.url), userGesture: params.userGesture === true, at: now() };
      if (method === "Page.javascriptDialogOpening") entry.gate.opened();
      if (method === "Page.javascriptDialogClosed") {
        entry.gate.closed();
        entry.dialogs.closed();
      }
      post({ op: "event", browser: key, tab: entry.tab, method, params: isObject(params) ? params : {}, ...(sessionId ? { session: sessionId } : {}) });
    });
    // Sites with a rule of their own see it in the page's navigator.userAgent too.
    contents.on("did-start-navigation", (_event, url, isInPlace, isMainFrame) => {
      if (!isMainFrame || isInPlace) return;
      // A page that leaves has no dialog open, should CDP's close event have gone missing.
      if (entry.gate.open) entry.gate.closed();
      const agent = tabAgent(browser, url);
      if (agent && agent !== entry.agent) {
        entry.agent = agent;
        contents.setUserAgent(agent);
        void presentAs(entry, agent);
      }
    });
    contents.debugger.on("detach", () => removeTab(key, entry.tab));
    contents.on("render-process-gone", () => removeTab(key, entry.tab, true));
    contents.on("destroyed", () => removeTab(key, entry.tab));
    for (const event of ["did-navigate", "did-navigate-in-page", "page-title-updated"]) contents.on(event, () => info(key, entry));
    contents.on("input-event", (_event, input) => {
      if (entry.echoes.take(input)) return;
      if (PERSON_INPUT.has(input?.type)) ping(key, entry);
    });
    contents.setWindowOpenHandler((details) => openPopup(key, entry, details));
    if (popup) {
      // The person sees whose page this is, whatever its title says.
      popup.on("page-title-updated", (event) => {
        event.preventDefault();
        popup.setTitle(originOf(contents.getURL()));
      });
      popup.on("closed", () => removeTab(key, entry.tab));
    } else {
      view.setBounds({ x: 0, y: 0, ...size() });
      view.setVisible(false);
      win.contentView.addChildView(view);
      entry.window = win;
      if (!background) browser.active = entry.tab;
    }
    layout();
    return entry;
  }

  function removeTab(key, tab, crashed = false) {
    const browser = browsers.get(key);
    const entry = browser?.tabs.get(tab);
    if (!entry) return;
    browser.tabs.delete(tab);
    if (browser.active === tab) browser.active = [...browser.tabs.keys()].at(-1) ?? null;
    if (entry.popup) {
      try { if (!entry.popup.isDestroyed()) entry.popup.close(); } catch {}
    } else {
      try { entry.view.setVisible(false); } catch {}
      try { if (!entry.window.isDestroyed()) entry.window.contentView.removeChildView(entry.view); } catch {}
    }
    try { entry.dialogs.dispose(); } catch {}
    try { if (entry.contents.debugger.isAttached()) entry.contents.debugger.detach(); } catch {}
    try { if (!entry.contents.isDestroyed()) entry.contents.close({ waitForBeforeUnload: false }); } catch {}
    post({ op: "tab-gone", browser: key, tab, ...(crashed ? { crashed: true } : {}) });
    layout();
  }

  function closeBrowser(key, announce = true) {
    const browser = browsers.get(key);
    if (!browser) return;
    for (const tab of browser.tabs.keys()) removeTab(key, tab);
    for (const item of browser.items.values()) {
      try { item.cancel(); } catch {}
    }
    browsers.delete(key);
    pings.delete(key);
    if (announce) post({ op: "closed", browser: key, reason: "closed by the app" });
  }

  async function open(message) {
    const win = host();
    if (!win || win.isDestroyed()) {
      post({ op: "failed", browser: message.browser, error: "The app window is closed.", reason: "no-window" });
      return;
    }
    try {
      closeBrowser(message.browser, false);
      const session = configure(message.partition, message.identity);
      // Security: the panes reach the network only through the profile's egress gate, as a launched Chrome does.
      await session.setProxy({ proxyRules: `socks5://127.0.0.1:${message.egress}`, proxyBypassRules: "<-loopback>" });
      browsers.set(message.browser, { partition: message.partition, downloads: message.downloads, tabs: new Map(), items: new Map(), active: null });
      post({ op: "opened", browser: message.browser, version: chromeVersion, userAgent: session.getUserAgent() });
      // The profile a panel shows may have just changed.
      if (panel.botId) void ask();
      layout();
    } catch (error) {
      post({ op: "failed", browser: message.browser, error: error?.message ?? String(error) });
    }
  }

  /** A renderer that reloads or crashes never hides what its panel showed. */
  function watchRenderer(win) {
    if (watched.has(win.webContents)) return;
    watched.add(win.webContents);
    const hide = () => {
      panel = NO_PANEL;
      layout();
    };
    win.webContents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => { if (isMainFrame && !isInPlace) hide(); });
    win.webContents.on("render-process-gone", hide);
  }

  async function create(message) {
    try {
      const entry = createTab(message.browser, { background: message.background === true });
      // A webContents that never loaded a document answers no debugger command (Electron 43): load one first.
      await entry.contents.loadURL("about:blank").catch(() => undefined);
      await prepare(browsers.get(message.browser), entry);
      entry.target = await targetOf(entry.contents);
      if (message.url !== "about:blank") void entry.contents.loadURL(message.url).catch(() => undefined);
      post({ op: "created", browser: message.browser, req: message.req, tab: entry.tab, target: entry.target, url: message.url, title: "" });
    } catch (error) {
      post({ op: "answer", browser: message.browser, req: message.req, error: { message: error?.message ?? String(error) } });
    }
  }

  async function command(message) {
    const entry = browsers.get(message.browser)?.tabs.get(message.tab);
    if (!entry) {
      post({ op: "answer", browser: message.browser, req: message.req, error: { message: "Target closed" } });
      return;
    }
    const capture = message.method === "Page.captureScreenshot" && !message.session;
    const input = message.method.startsWith("Input.");
    // A pane in a window that draws nothing (the parking window, a minimised or hidden app window) is captured the way
    // a hidden window's page can be.
    const undrawn = capture && !entry.popup && ((Boolean(parking) && entry.window === parking) || !windowDraws(entry.window));
    const release = capture && !undrawn ? paintHold(entry) : () => {};
    const answered = input ? entry.echoes.expect(message.method, message.params) : null;
    let timer;
    try {
      if (LEAVING.has(message.method) && !message.session) await dismissDialog(entry);
      const sent = entry.gate.run(message.method, message.params, () => (undrawn ? captureUndrawn(entry.contents, message.params) : entry.contents.debugger.sendCommand(message.method, message.params, message.session)));
      // Chromium keeps an undrawn capture pending for good: the bot hears why instead of waiting.
      const result = capture ? await Promise.race([sent, new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`The page did not draw within ${captureMs / 1000} s, so no screenshot was taken.`)), captureMs);
      })]) : await sent;
      post({ op: "answer", browser: message.browser, req: message.req, result: isObject(result) ? result : {} });
    } catch (error) {
      post({ op: "answer", browser: message.browser, req: message.req, error: { message: error?.message ?? String(error), ...(typeof error?.code === "number" ? { code: error.code } : {}) } });
    } finally {
      clearTimeout(timer);
      if (input) {
        answered?.();
        entry.botInputAt = now();
      }
      release();
    }
  }

  /** The bot leaves the page: a dialog it left open is dismissed first, and CDP reports it closed. */
  async function dismissDialog(entry) {
    if (entry.gate.open) await entry.contents.debugger.sendCommand("Page.handleJavaScriptDialog", { accept: false }).catch(() => undefined);
    else if (entry.dialogs.waiting) entry.dialogs.dismiss();
  }

  function handle(message) {
    switch (message.op) {
      case "hello":
        post({ op: "hello" });
        return;
      case "open": return void open(message);
      case "create": return void create(message);
      case "cdp": return void command(message);
      case "front": {
        const browser = browsers.get(message.browser);
        if (browser?.tabs.has(message.tab)) browser.active = message.tab;
        layout();
        return;
      }
      case "close-tab": return removeTab(message.browser, message.tab);
      case "close": return closeBrowser(message.browser);
      case "cancel-download": {
        const item = browsers.get(message.browser)?.items.get(message.guid);
        try { item?.cancel(); } catch {}
        return;
      }
      case "erase": {
        if (!PANE_PARTITION.test(message.partition)) return;
        const session = fromPartition(message.partition);
        void Promise.all([session.clearStorageData(), session.clearCache()]).catch((error) => log(`browser pane: could not erase a profile: ${error?.message ?? error}`));
        return;
      }
      case "resolved": {
        const resolve = resolving.get(message.req);
        resolving.delete(message.req);
        resolve?.(message.browser);
        return;
      }
      case "set-cookies": return void setCookies(message);
      case "cookie-sources-result":
      case "cookie-import-result":
      case "cookie-offer-result":
      case "hold-result": {
        const answer = asking.get(message.req);
        asking.delete(message.req);
        answer?.(message);
        return;
      }
    }
  }

  /** An import's cookies into a pane's partition. Security: a refused cookie is counted, never named or logged. */
  async function setCookies(message) {
    const session = fromPartition(message.partition);
    let written = 0;
    let refused = 0;
    for (const cookie of message.cookies) {
      try {
        await session.cookies.set(cookie);
        written++;
      } catch {
        refused++;
      }
    }
    post({ op: "cookies-set", req: message.req, written, refused });
  }

  /** The person's import requests, to the server and back; `fallback` when it does not answer. */
  function askServer(op, fields, fallback, timeoutMs) {
    if (!server) return Promise.resolve(fallback);
    const req = ++requests;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { asking.delete(req); resolve(fallback); }, timeoutMs);
      asking.set(req, (message) => { clearTimeout(timer); resolve(message); });
      post({ op, req, ...fields });
    });
  }

  function importInput(input) {
    if (!isObject(input) || typeof input.botId !== "string" || !BOT.test(input.botId) || typeof input.site !== "string" || input.site.length > 2048
      || (input.source !== undefined && (typeof input.source !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(input.source)))) {
      throw new Error("Sign-in import input is invalid");
    }
    return { botId: input.botId, threadId: typeof input.threadId === "string" && BOT.test(input.threadId) ? input.threadId : null, site: input.site };
  }

  function resolveBrowser(botId, threadId) {
    if (!server) return Promise.resolve(null);
    const req = ++requests;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { resolving.delete(req); resolve(null); }, RESOLVE_MS);
      resolving.set(req, (browser) => { clearTimeout(timer); resolve(browser); });
      post({ op: "which", req, botId, threadId });
    });
  }

  /** Asks the server which browser the panel shows. No answer is kept as an answer: the next show or open asks again. */
  async function ask() {
    const asked = panel;
    const generation = ++asks;
    const browser = await resolveBrowser(asked.botId, asked.threadId);
    if (!samePanel(asked, panel) || generation !== asks) return;
    panel = { ...panel, browser };
    layout();
  }

  return {
    /** A new server child: the panes the old one drove are gone with it. */
    attach(proc) {
      for (const key of browsers.keys()) closeBrowser(key, false);
      for (const resolve of resolving.values()) resolve(null);
      resolving.clear();
      panel = NO_PANEL;
      server = proc;
      post({ op: "hello" });
    },

    /** True when the message was a pane message from the current server. */
    receive(proc, raw) {
      if (!isObject(raw) || raw.type !== PANE_MESSAGE) return false;
      if (proc !== server) return true;
      const message = paneMessageToMain(raw);
      if (!message) {
        log("browser pane: refused a malformed message from the server");
        return true;
      }
      handle(message);
      return true;
    },

    /** The Browser panel of `botId` (in `threadId`, on browser profile `profile`) is at `bounds`, shown or not. */
    async show(input) {
      if (!isObject(input) || typeof input.botId !== "string" || !BOT.test(input.botId)) throw new Error("Browser pane input is invalid");
      const threadId = typeof input.threadId === "string" && BOT.test(input.threadId) ? input.threadId : null;
      const profile = typeof input.profile === "string" && PROFILE.test(input.profile) ? input.profile : null;
      const win = owner();
      if (win && !win.isDestroyed()) watchRenderer(win);
      const wanted = input.visible === true && Boolean(win) && !win.isDestroyed();
      const bounds = wanted ? normalizeDesktopWorkspaceBounds(input.bounds, win.getContentSize()) : panel.bounds;
      const next = { botId: input.botId, threadId, profile };
      panel = samePanel(next, panel) ? { ...panel, wanted, bounds } : { ...next, wanted, bounds, browser: null };
      layout();
      if (panel.browser === null) await ask();
      return { shown: Boolean(panel.wanted && panel.browser && browsers.get(panel.browser)?.active) };
    },

    /** The browsers and profiles a sign-in can be imported from: names only. */
    async cookieSources() {
      const answer = await askServer("cookie-sources", {}, { sources: [] }, RESOLVE_MS * 2);
      return answer.sources;
    },

    /** Whether a site's sign-in can be imported into a bot's browser, and why not. */
    async cookieOffer(input) {
      const answer = await askServer("cookie-offer", importInput(input), { offered: false, reason: "unreadable" }, RESOLVE_MS * 2);
      return { offered: answer.offered, ...(answer.reason ? { reason: answer.reason } : {}) };
    },

    /** One site's sign-in from the person's own browser into a bot's: counts and a reason code come back, never a cookie. */
    async importCookies(input) {
      const request = importInput(input);
      if (typeof input.source !== "string" || typeof input.profile !== "string" || !input.profile || input.profile.length > 512) throw new Error("Sign-in import input is invalid");
      // The person may sit at a Keychain prompt for a while.
      const answer = await askServer("cookie-import", { ...request, source: input.source, profile: input.profile }, { result: { ok: false, reason: "unreadable" } }, 180_000);
      return answer.result;
    },

    /**
     * The person takes the tab the Browser panel of `botId` shows from the bot (`held`), or hands it back. The server
     * checks the tab is that panel's; the answer says whether the tab is now held.
     */
    async hold(input) {
      if (!isObject(input) || typeof input.botId !== "string" || !BOT.test(input.botId) || typeof input.held !== "boolean") throw new Error("Browser pane input is invalid");
      const threadId = typeof input.threadId === "string" && BOT.test(input.threadId) ? input.threadId : null;
      const browser = samePanel({ botId: input.botId, threadId, profile: panel.profile }, panel) ? panel.browser : null;
      const tab = browser ? browsers.get(browser)?.active : null;
      if (!tab) return { held: false };
      const answer = await askServer("hold", { botId: input.botId, threadId, browser, tab, held: input.held }, { held: false }, RESOLVE_MS * 2);
      return { held: answer.held };
    },

    /** Every pane closes, and the parking window with them: the app is quitting or its server is gone. */
    closeAll() {
      for (const key of browsers.keys()) closeBrowser(key);
      try { if (parking && !parking.isDestroyed()) parking.destroy(); } catch {}
      parking = null;
    },

    /**
     * The app window closed: its panes move to the parking window and keep running, pages, sign-ins and all, so a bot
     * goes on in the same browser. A pane Electron already destroyed with the window is a tab gone, as its own event
     * reports; the profile's partition, and so its sign-ins, stay either way.
     */
    windowClosed(win) {
      panel = NO_PANEL;
      // Nobody is left at the window a hold was taken from: the bot may go on.
      if (server) post({ op: "let-go" });
      if (quitting()) {
        this.closeAll();
        return;
      }
      // No pane in that window: nothing to keep, and so no window to make.
      const kept = [...browsers.values()].some((browser) => [...browser.tabs.values()].some((entry) => !entry.popup && entry.window === win));
      if (!kept) return;
      const target = host();
      if (!target) {
        this.closeAll();
        return;
      }
      for (const browser of browsers.values()) {
        for (const entry of browser.tabs.values()) {
          if (entry.popup || entry.window !== win) continue;
          entry.visible = false;
          if (!target || entry.contents.isDestroyed()) continue;
          try {
            entry.view.setVisible(false);
            target.contentView.addChildView(entry.view);
            entry.window = target;
          } catch (error) {
            log(`browser pane: could not keep a pane without its window: ${error?.message ?? error}`);
          }
        }
      }
    },
  };
}
