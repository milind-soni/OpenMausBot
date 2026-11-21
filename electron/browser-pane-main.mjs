// The bots' browsers as native views in the app window: one WebContentsView per tab on the profile's own partition,
// its debugger relayed to the app's own server, shown over the Browser panel's rectangle when the panel asks.
// Security: views are created and their debuggers attached only here, never for a webContents the renderer names;
// the renderer only says which bot's panel shows where.
import { randomUUID } from "node:crypto";
import path from "node:path";

import desktopWorkspace from "./desktop-workspace.cjs";
import { PANE_MESSAGE, PANE_PARTITION, PANE_TABS_PER_BROWSER, paneMessageToMain, paneUserAgent } from "./browser-pane-wire.mjs";

const { normalizeDesktopWorkspaceBounds } = desktopWorkspace;
const PERSON_INPUT = new Set(["mouseDown", "keyDown", "rawKeyDown", "char", "mouseWheel", "gestureScrollBegin", "touchStart"]);
const PING_MS = 250;
/** Input events this soon after the bot's own input count as the bot's, should Electron report debugger input too. */
const BOT_INPUT_ECHO_MS = 150;
const RESOLVE_MS = 5_000;
const CAPTURE_MS = 10_000;
const HIDDEN_SIZE = { width: 1280, height: 800 };
/** Granted as a normal profile has them; everything else is refused without a prompt. */
const GRANTED = new Set(["clipboard-sanitized-write", "fullscreen", "pointerLock"]);
const BOT = /^[\w.-]{1,128}$/;
const PROFILE = /^[\w.:-]{1,128}$/;

const hostOf = (url) => { try { return new URL(url).hostname; } catch { return ""; } };
const isObject = (value) => Object.prototype.toString.call(value) === "[object Object]";
const NO_PANEL = Object.freeze({ botId: null, threadId: null, profile: null, wanted: false, bounds: null, browser: null });
const samePanel = (a, b) => a.botId === b.botId && a.threadId === b.threadId && a.profile === b.profile;

/**
 * `createView(options)`: a WebContentsView. `fromPartition(name)`: Electron's session. `owner()`: the app window or null.
 * `chromeVersion`: process.versions.chrome.
 */
export function createBrowserPanes({ createView, fromPartition, owner, chromeVersion, log = () => {}, now = Date.now, captureMs = CAPTURE_MS }) {
  const browsers = new Map();
  const configured = new Set();
  const pings = new Map();
  const resolving = new Map();
  const watched = new WeakSet();
  let server = null;
  let tabCount = 0;
  let requests = 0;
  let asks = 0;
  let panel = NO_PANEL;

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

  function configure(partition) {
    const session = fromPartition(partition);
    if (configured.has(partition)) return session;
    configured.add(partition);
    const electronAgent = session.getUserAgent();
    const agent = paneUserAgent(electronAgent);
    session.setUserAgent(agent);
    session.webRequest.onBeforeSendHeaders((details, callback) => {
      const host = hostOf(details.url);
      const wanted = host ? paneUserAgent(electronAgent, host) : agent;
      callback({ requestHeaders: wanted === agent ? details.requestHeaders : { ...details.requestHeaders, "User-Agent": wanted } });
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
    for (const [key, browser] of browsers) {
      for (const [tab, entry] of browser.tabs) {
        const visible = Boolean(panel.wanted && panel.bounds && panel.browser === key && browser.active === tab);
        try {
          if (visible) {
            entry.view.setBounds(panel.bounds);
            if (!entry.visible && win && !win.isDestroyed()) win.contentView.addChildView(entry.view);
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
   * frame that never comes. A hidden pane is shown for the capture with all but one pixel past the window's corner.
   */
  function paintHold(entry) {
    const win = owner();
    if (entry.visible || !win || win.isDestroyed()) return () => {};
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
    if (entry.botInputs > 0 || now() - entry.botInputAt < BOT_INPUT_ECHO_MS) return;
    const last = pings.get(key);
    if (last !== undefined && last.tab === entry.tab && now() - last.at < PING_MS) return;
    pings.set(key, { tab: entry.tab, at: now() });
    post({ op: "input", browser: key, tab: entry.tab });
  }

  async function targetOf(contents) {
    const { frameTree } = await contents.debugger.sendCommand("Page.getFrameTree");
    return String(frameTree.frame.id);
  }

  function info(key, entry) {
    if (!entry.target) return;
    post({ op: "tab", browser: key, tab: entry.tab, target: entry.target, url: entry.contents.getURL() || "about:blank", title: entry.contents.getTitle(), ...(entry.opener ? { opener: entry.opener } : {}) });
  }

  /** Why no tab can open in this browser now, or null. */
  function tabRefusal(key) {
    const browser = browsers.get(key);
    const win = owner();
    if (!browser) return "Target closed";
    if (!win || win.isDestroyed()) return "The app window is closed.";
    if (browser.tabs.size >= PANE_TABS_PER_BROWSER) return `This browser already has ${PANE_TABS_PER_BROWSER} tabs open. Close one before opening another.`;
    return null;
  }

  function createTab(key, { background = false, adopt, opener } = {}) {
    const refusal = tabRefusal(key);
    if (refusal) throw new Error(refusal);
    const browser = browsers.get(key);
    const win = owner();
    const view = createView({
      webPreferences: { partition: browser.partition, sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, backgroundThrottling: false, safeDialogs: true },
      ...(adopt ? { webContents: adopt } : {}),
    });
    const contents = view.webContents;
    contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
    // DevTools would take the debugger from the bot: one client per webContents.
    contents.on("devtools-opened", () => contents.closeDevTools());
    const entry = { tab: `p${++tabCount}`, view, contents, window: win, target: null, visible: false, botInputs: 0, botInputAt: -Infinity, ...(opener ? { opener } : {}) };
    contents.debugger.attach("1.3");
    browser.tabs.set(entry.tab, entry);
    contents.debugger.on("message", (_event, method, params, sessionId) => {
      post({ op: "event", browser: key, tab: entry.tab, method, params: isObject(params) ? params : {}, ...(sessionId ? { session: sessionId } : {}) });
    });
    contents.debugger.on("detach", () => removeTab(key, entry.tab));
    contents.on("render-process-gone", () => removeTab(key, entry.tab, true));
    contents.on("destroyed", () => removeTab(key, entry.tab));
    for (const event of ["did-navigate", "did-navigate-in-page", "page-title-updated"]) contents.on(event, () => info(key, entry));
    contents.on("input-event", (_event, input) => { if (PERSON_INPUT.has(input?.type)) ping(key, entry); });
    contents.setWindowOpenHandler(() => (tabRefusal(key) ? { action: "deny" } : {
      action: "allow",
      // OAuth pop-ups answer their opener, so the popup is the page's own child, made a tab here.
      createWindow: (options) => {
        const popup = createTab(key, { adopt: options?.webContents, opener: entry.tab });
        void targetOf(popup.contents).then((target) => { popup.target = target; info(key, popup); }, () => removeTab(key, popup.tab));
        return popup.contents;
      },
    }));
    view.setBounds({ x: 0, y: 0, ...size() });
    view.setVisible(false);
    win.contentView.addChildView(view);
    if (!background) browser.active = entry.tab;
    layout();
    return entry;
  }

  function removeTab(key, tab, crashed = false) {
    const browser = browsers.get(key);
    const entry = browser?.tabs.get(tab);
    if (!entry) return;
    browser.tabs.delete(tab);
    if (browser.active === tab) browser.active = [...browser.tabs.keys()].at(-1) ?? null;
    try { entry.view.setVisible(false); } catch {}
    try { if (!entry.window.isDestroyed()) entry.window.contentView.removeChildView(entry.view); } catch {}
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
    const win = owner();
    if (!win || win.isDestroyed()) {
      post({ op: "failed", browser: message.browser, error: "The app window is closed.", reason: "no-window" });
      return;
    }
    try {
      closeBrowser(message.browser, false);
      const session = configure(message.partition);
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
    const release = capture ? paintHold(entry) : () => {};
    if (input) entry.botInputs++;
    let timer;
    try {
      const sent = entry.contents.debugger.sendCommand(message.method, message.params, message.session);
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
        entry.botInputs--;
        entry.botInputAt = now();
      }
      release();
    }
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
    }
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

    closeAll() {
      for (const key of browsers.keys()) closeBrowser(key);
    },
  };
}
