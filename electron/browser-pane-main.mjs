// The bots' browsers as native views in the app window: one WebContentsView per tab on the profile's own partition,
// its debugger relayed to the app's own server, shown over the Browser panel's rectangle when the panel asks.
// Security: views are created and their debuggers attached only here, never for a webContents the renderer names;
// the renderer only says which bot's panel shows where.
import desktopWorkspace from "./desktop-workspace.cjs";
import { PANE_MESSAGE, PANE_PARTITION, paneMessageToMain, paneUserAgent } from "./browser-pane-wire.mjs";

const { normalizeDesktopWorkspaceBounds } = desktopWorkspace;
const PERSON_INPUT = new Set(["mouseDown", "keyDown", "rawKeyDown", "char", "mouseWheel", "gestureScrollBegin", "touchStart"]);
const PING_MS = 250;
const RESOLVE_MS = 5_000;
const MAX_TABS = 32;
const HIDDEN_SIZE = { width: 1280, height: 800 };
/** Granted as a normal profile has them; everything else is refused without a prompt. */
const GRANTED = new Set(["clipboard-sanitized-write", "fullscreen", "pointerLock"]);
const BOT = /^[\w.-]{1,128}$/;

const isObject = (value) => Object.prototype.toString.call(value) === "[object Object]";

/**
 * `createView(options)`: a WebContentsView. `fromPartition(name)`: Electron's session. `owner()`: the app window or null.
 * `chromeVersion`: process.versions.chrome.
 */
export function createBrowserPanes({ createView, fromPartition, owner, chromeVersion, log = () => {}, now = Date.now }) {
  const browsers = new Map();
  const configured = new Set();
  const pings = new Map();
  const resolving = new Map();
  let server = null;
  let tabCount = 0;
  let requests = 0;
  let shown = { browser: null, bounds: null, visible: false };
  let panel = { botId: null, threadId: null, browser: Promise.resolve(null) };

  const post = (message) => {
    try {
      server?.postMessage({ type: PANE_MESSAGE, ...message });
    } catch (error) {
      log(`browser pane: could not reach the server: ${error?.message ?? error}`);
    }
  };

  const openTabs = () => [...browsers.values()].reduce((sum, browser) => sum + browser.tabs.size, 0);

  function configure(partition) {
    const session = fromPartition(partition);
    if (configured.has(partition)) return session;
    configured.add(partition);
    session.setUserAgent(paneUserAgent(session.getUserAgent()));
    session.setPermissionRequestHandler((_contents, permission, callback) => callback(GRANTED.has(permission)));
    session.setPermissionCheckHandler((_contents, permission) => GRANTED.has(permission));
    return session;
  }

  function size() {
    return shown.bounds ? { width: shown.bounds.width, height: shown.bounds.height } : HIDDEN_SIZE;
  }

  function layout() {
    const win = owner();
    for (const [key, browser] of browsers) {
      for (const [tab, entry] of browser.tabs) {
        const visible = Boolean(shown.visible && shown.bounds && shown.browser === key && browser.active === tab);
        try {
          if (visible) {
            entry.view.setBounds(shown.bounds);
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

  function ping(key) {
    const last = pings.get(key);
    if (last !== undefined && now() - last < PING_MS) return;
    pings.set(key, now());
    post({ op: "input", browser: key });
  }

  async function targetOf(contents) {
    const { frameTree } = await contents.debugger.sendCommand("Page.getFrameTree");
    return String(frameTree.frame.id);
  }

  function info(key, entry) {
    if (!entry.target) return;
    post({ op: "tab", browser: key, tab: entry.tab, target: entry.target, url: entry.contents.getURL() || "about:blank", title: entry.contents.getTitle(), ...(entry.opener ? { opener: entry.opener } : {}) });
  }

  function createTab(key, { background = false, adopt, opener } = {}) {
    const browser = browsers.get(key);
    const win = owner();
    if (!browser) throw new Error("Target closed");
    if (!win || win.isDestroyed()) throw new Error("The app window is closed.");
    if (openTabs() >= MAX_TABS) throw new Error(`${MAX_TABS} browser tabs are already open in the app.`);
    const view = createView({
      webPreferences: { partition: browser.partition, sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, devTools: false, backgroundThrottling: false, safeDialogs: true },
      ...(adopt ? { webContents: adopt } : {}),
    });
    const contents = view.webContents;
    const entry = { tab: `p${++tabCount}`, view, contents, window: win, target: null, visible: false, ...(opener ? { opener } : {}) };
    contents.debugger.attach("1.3");
    browser.tabs.set(entry.tab, entry);
    contents.debugger.on("message", (_event, method, params, sessionId) => {
      post({ op: "event", browser: key, tab: entry.tab, method, params: isObject(params) ? params : {}, ...(sessionId ? { session: sessionId } : {}) });
    });
    contents.debugger.on("detach", () => removeTab(key, entry.tab));
    contents.on("render-process-gone", () => removeTab(key, entry.tab, true));
    contents.on("destroyed", () => removeTab(key, entry.tab));
    for (const event of ["did-navigate", "did-navigate-in-page", "page-title-updated"]) contents.on(event, () => info(key, entry));
    contents.on("input-event", (_event, input) => { if (PERSON_INPUT.has(input?.type)) ping(key); });
    contents.setWindowOpenHandler(() => ({
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
    browsers.delete(key);
    pings.delete(key);
    if (announce) post({ op: "closed", browser: key, reason: "closed by the app" });
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
    const release = message.method === "Page.captureScreenshot" && !message.session ? paintHold(entry) : () => {};
    try {
      const result = await entry.contents.debugger.sendCommand(message.method, message.params, message.session);
      post({ op: "answer", browser: message.browser, req: message.req, result: isObject(result) ? result : {} });
    } catch (error) {
      post({ op: "answer", browser: message.browser, req: message.req, error: { message: error?.message ?? String(error), ...(typeof error?.code === "number" ? { code: error.code } : {}) } });
    } finally {
      release();
    }
  }

  function handle(message) {
    switch (message.op) {
      case "open":
        try {
          closeBrowser(message.browser, false);
          const session = configure(message.partition);
          browsers.set(message.browser, { partition: message.partition, tabs: new Map(), active: null });
          post({ op: "opened", browser: message.browser, version: chromeVersion, userAgent: session.getUserAgent() });
          layout();
        } catch (error) {
          post({ op: "failed", browser: message.browser, error: error?.message ?? String(error) });
        }
        return;
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

  return {
    /** A new server child: the panes the old one drove are gone with it. */
    attach(proc) {
      for (const key of browsers.keys()) closeBrowser(key, false);
      for (const resolve of resolving.values()) resolve(null);
      resolving.clear();
      panel = { botId: null, threadId: null, browser: Promise.resolve(null) };
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

    /** The Browser panel of `botId` (in `threadId`) is at `bounds`, shown or not. */
    async show(input) {
      if (!isObject(input) || typeof input.botId !== "string" || !BOT.test(input.botId)) throw new Error("Browser pane input is invalid");
      const threadId = typeof input.threadId === "string" && BOT.test(input.threadId) ? input.threadId : null;
      const win = owner();
      const bounds = input.visible === true && win && !win.isDestroyed() ? normalizeDesktopWorkspaceBounds(input.bounds, win.getContentSize()) : shown.bounds;
      if (input.botId !== panel.botId || threadId !== panel.threadId) {
        panel = { botId: input.botId, threadId, browser: resolveBrowser(input.botId, threadId) };
        shown = { ...shown, browser: null, visible: false };
        layout();
      }
      const asked = panel;
      const browser = await asked.browser;
      if (asked !== panel) return { shown: false };
      shown = { browser, bounds, visible: input.visible === true && browser !== null };
      layout();
      return { shown: shown.visible && browsers.has(browser) };
    },

    closeAll() {
      for (const key of browsers.keys()) closeBrowser(key);
    },
  };
}
