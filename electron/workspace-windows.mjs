import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { BrowserWindow, ipcMain, session, utilityProcess } from "electron";
import auth from "./desktop-server-auth.cjs";
import { waitForChildExit } from "./server-child-launch.mjs";
import { startProfileServer } from "./profile-server.mjs";

const preload = fileURLToPath(new URL("./chat-window-preload.cjs", import.meta.url));
const validId = value => typeof value === "string" && value.length > 0 && value.length <= 256;
const focus = win => { if (win.isMinimized()) win.restore(); win.show(); win.focus(); };

export function installWorkspaceWindows({ primary, canOpenPlace, places, profileDir, prepareProfile, dataDir, runningDir, switching, resourcesPath, userData, environment, bounds, icon, log }) {
  const servers = new Map();
  const views = new Map();
  let quitting = false;

  function closeViews(matches) {
    for (const view of views.values()) if (matches(view)) view.win.destroy();
  }

  function stopIfUnused(context) {
    if (!context?.owner) return;
    for (const view of views.values()) {
      if (view.context === context) return;
    }
    context.owner.controller.abort();
  }

  function server(dir, name, profile) {
    const current = servers.get(dir);
    if (current) return current.ready;
    const controller = new AbortController();
    const owner = { controller, context: null, ready: null, stopped: null };
    const release = () => {
      owner.context?.browser.webRequest.onBeforeSendHeaders(null);
      owner.context = null;
      if (servers.get(dir) === owner) servers.delete(dir);
      closeViews(view => view.context.owner === owner);
    };
    servers.set(dir, owner);
    owner.ready = (async () => {
      const runtime = await startProfileServer({ dir, resourcesPath, userData: userData(), env: environment(),
        fork: (...args) => utilityProcess.fork(...args), prepare: () => prepareProfile(profile),
        onStarted: stopped => { owner.stopped = stopped; }, onExit: release, signal: controller.signal, log });
      controller.signal.throwIfAborted();
      const browser = session.fromPartition(`workspace-${randomUUID()}`);
      browser.setPermissionRequestHandler((_page, _permission, answer) => answer(false));
      browser.setPermissionCheckHandler(() => false);
      runtime.allowSession(browser);
      const context = { dir, name, origin: runtime.origin, browser, owner };
      owner.context = context;
      const websocketOrigin = runtime.origin.replace(/^http:/, "ws:");
      browser.webRequest.onBeforeSendHeaders((request, answer) => {
        const target = new URL(request.url);
        const ours = views.get(request.webContentsId)?.context === context && owner.context === context && !controller.signal.aborted;
        const destination = target.origin === runtime.origin || target.origin === websocketOrigin;
        answer({ requestHeaders: ours && destination ? { ...request.requestHeaders, [auth.DESKTOP_MUTATION_HEADER]: runtime.token } : request.requestHeaders });
      });
      return context;
    })().catch(error => {
      controller.abort();
      if (!owner.stopped) release();
      throw error;
    });
    return owner.ready;
  }

  async function open(context, bot, thread) {
    if (!context || quitting || (context.owner && (context.owner.context !== context || context.owner.controller.signal.aborted))) return false;
    const key = JSON.stringify([context.dir, context.origin, bot, thread]);
    for (const view of views.values()) {
      if (view.key === key) {
        await view.loaded;
        if (view.win.isDestroyed()) return false;
        focus(view.win);
        return true;
      }
    }
    const url = new URL("/", context.origin);
    if (thread) { url.searchParams.set("chatWindow", thread); url.searchParams.set("owner", bot); }
    const win = new BrowserWindow({ width: 1050, height: 760, minWidth: bounds.width, minHeight: bounds.height,
      title: context.name, icon, show: false, autoHideMenuBar: true,
      webPreferences: { session: context.browser ?? session.defaultSession, sandbox: true, contextIsolation: true, nodeIntegration: false, preload } });
    const contents = win.webContents;
    const id = contents.id;
    const view = { win, key, context, thread, loaded: null };
    views.set(id, view);
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    for (const event of ["will-frame-navigate", "will-redirect"]) contents.on(event, details => {
      if (!URL.canParse(details.url) || new URL(details.url).origin !== context.origin) details.preventDefault();
    });
    win.on("page-title-updated", event => { if (!thread) event.preventDefault(); });
    win.setMenu(null);
    win.once("closed", () => {
      views.delete(id);
      stopIfUnused(context);
    });
    view.loaded = win.loadURL(url.href);
    try {
      await view.loaded;
      if (win.isDestroyed()) return false;
      focus(win);
      return true;
    } catch (error) {
      if (!win.isDestroyed()) win.destroy();
      throw error;
    }
  }

  function senderContext(event) {
    if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) return null;
    const context = views.get(event.sender.id)?.context ?? primary(event);
    return context && new URL(event.senderFrame.url).origin === context.origin ? context : null;
  }
  const handle = (channel, action) => ipcMain.handle(channel, async (...args) => {
    try { return !quitting && await action(...args); }
    catch (error) { log(`workspace window: ${error.message}`); return false; }
  });
  handle("workspace-window:thread", (event, bot, thread) => validId(bot) && validId(thread) && open(senderContext(event), bot, thread));
  async function openPlace(event, id) {
    if (quitting || !canOpenPlace(event) || switching()) return false;
    const place = places().find(row => row.id === id && row.kind === "computer" && row.opens);
    if (!place) return false;
    const dir = place.profile ? profileDir(dataDir(), place.profile) : dataDir();
    const previous = servers.get(dir);
    if (previous?.controller.signal.aborted) {
      if (!previous.stopped || !await waitForChildExit(previous.stopped)) return false;
      return openPlace(event, id);
    }
    const context = dir === runningDir() ? primary() : await server(dir, place.name, place.profile);
    try { return await open(context, null, null); }
    finally { stopIfUnused(context); }
  }
  handle("workspace-window:place", openPlace);

  return {
    holds: dir => servers.has(dir),
    focus(dir) {
      const workspace = [...views.values()].filter(entry => entry.context.dir === dir && entry.context.owner);
      const view = workspace.find(entry => !entry.thread) ?? workspace[0];
      if (!view) return false;
      focus(view.win);
      return true;
    },
    closePrimary(dir) { closeViews(view => !view.context.owner && view.context.dir === dir); },
    async shutdown() {
      quitting = true;
      closeViews(() => true);
      const pending = [...servers.values()];
      for (const owner of pending) owner.controller.abort();
      const drained = Promise.allSettled(pending.map(async owner => {
        try { await owner.ready; } finally { await owner.stopped; }
      }));
      if (!await waitForChildExit(drained)) log("A workspace server did not stop before desktop exit. Its lease is retained.");
    },
  };
}
