// A saved app in a window of its own: the app's page of the server the asking window shows (/local-app?id=…), with the
// main window's preload and the same guards, and its size remembered per app. Closing it leaves the app running.
import fs from "node:fs";
import path from "node:path";

import { appFrameNavigationAllowed } from "./app-frame-guard.mjs";
import { validAppId } from "./app-link.mjs";
import { chatLinkFrom } from "./chat-link.mjs";

export const APP_WINDOW_SIZE = { width: 1100, height: 760 };
export const APP_WINDOW_MIN = { width: 420, height: 360 };
const SIZES_KEPT = 100;

const appWindowSet = new WeakSet();

/** True for a saved app's own window: it is never the window a link, the Dock or a quit check means. */
export function isLocalAppWindow(win) {
  return Boolean(win) && appWindowSet.has(win);
}

export function appIdFrom(value) {
  return validAppId(value) ? value : null;
}

/** The address of the app's own page on `origin`, or null for anything but an http(s) origin. */
export function appWindowUrl(origin, id) {
  if (!appIdFrom(id) || typeof origin !== "string") return null;
  let parsed;
  try { parsed = new URL(origin); } catch { return null; }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.origin !== origin) return null;
  return `${origin}/local-app?id=${encodeURIComponent(id)}`;
}

/** The size an app's window opens at: the one it last had, within the largest screen, else the default. */
export function appWindowSize(saved, workAreas = []) {
  const widest = workAreas.length ? Math.max(APP_WINDOW_MIN.width, ...workAreas.map((area) => area.width)) : Infinity;
  const tallest = workAreas.length ? Math.max(APP_WINDOW_MIN.height, ...workAreas.map((area) => area.height)) : Infinity;
  const fits = (value, min, max) => Number.isFinite(value) ? Math.round(Math.min(max, Math.max(min, value))) : null;
  const width = fits(saved?.width, APP_WINDOW_MIN.width, widest), height = fits(saved?.height, APP_WINDOW_MIN.height, tallest);
  return width !== null && height !== null ? { width, height } : { width: Math.min(APP_WINDOW_SIZE.width, widest), height: Math.min(APP_WINDOW_SIZE.height, tallest) };
}

/** Each app's last window size by its id, newest last, at most SIZES_KEPT. */
export function createAppWindowSizes({ file, log = () => {} }) {
  const read = () => {
    try {
      const parsed = JSON.parse(fs.readFileSync(file(), "utf8"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  };
  return {
    get: (id) => read()[id] ?? null,
    set(id, size) {
      if (!appIdFrom(id)) return;
      const sizes = read();
      delete sizes[id];
      sizes[id] = { width: Math.round(size.width), height: Math.round(size.height) };
      const kept = Object.fromEntries(Object.entries(sizes).slice(-SIZES_KEPT));
      const target = file(), temporary = `${target}.${process.pid}.tmp`;
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(temporary, JSON.stringify(kept), { mode: 0o600 });
        fs.renameSync(temporary, target);
      } catch (error) {
        try { fs.rmSync(temporary, { force: true }); } catch {}
        log(`app window size save failed: ${error?.message ?? error}`);
      }
    },
  };
}

function originOf(url) {
  try { return new URL(url).origin; } catch { return null; }
}

/**
 * `guard(channel, handler)`: who may open one (this computer's page or My Cloud's own); `senderOrigin(event)`: the
 * server the asking page shows; `webPreferences()`: the main window's; `openChat(link)`: main's chat link queue, which
 * brings the main window up; `openExternal(url)`: the person's browser. `launches` (app-launches.mjs): the apps opened
 * from their launchers, opened on `launchOrigin()` (this computer's server) once `ready()`. `windowDetails(id)`: on
 * Windows, the installed launcher's taskbar details for the app's window, or null.
 */
export function installLocalAppWindows({
  ipcMain, guard, BrowserWindow, senderOrigin, webPreferences, openChat, openExternal, sizes, workAreas = () => [], icon, background = () => undefined, log = () => {},
  launches, ready = () => true, launchOrigin = () => null, windowDetails = async () => null,
}) {
  const open = new Map();

  function openWindow(origin, id) {
    const url = appWindowUrl(origin, id);
    if (!url) return false;
    const key = `${origin}\n${id}`;
    const existing = open.get(key);
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore();
      existing.show();
      existing.focus();
      return true;
    }
    const win = new BrowserWindow({
      ...appWindowSize(sizes.get(id), workAreas()),
      minWidth: APP_WINDOW_MIN.width,
      minHeight: APP_WINDOW_MIN.height,
      show: false,
      ...(icon ? { icon } : {}),
      backgroundColor: background(),
      autoHideMenuBar: true,
      webPreferences: webPreferences(),
    });
    appWindowSet.add(win);
    open.set(key, win);
    const remember = () => {
      if (!win.isDestroyed() && !win.isMaximized() && !win.isFullScreen()) sizes.set(id, win.getNormalBounds?.() ?? win.getBounds());
    };
    win.on("resize", remember);
    win.on("close", remember);
    win.once("closed", () => { if (open.get(key) === win) open.delete(key); });
    win.once("ready-to-show", () => { if (!win.isDestroyed()) { win.show(); win.focus(); } });
    void Promise.resolve().then(() => windowDetails(id)).then((details) => {
      if (details && !win.isDestroyed()) win.setAppDetails?.(details);
    }).catch(() => {});

    win.webContents.setWindowOpenHandler(({ url: target }) => {
      if (/^https?:\/\//i.test(target)) void Promise.resolve(openExternal(target)).catch(() => {});
      return { action: "deny" };
    });
    // The window only ever shows its own app's page: anything else is refused, and a web link goes to the browser.
    const guardNavigation = (event, target) => {
      if (target === url) return;
      event.preventDefault();
      if (/^https?:\/\//i.test(target) && originOf(target) !== origin) void Promise.resolve(openExternal(target)).catch(() => {});
      log(`app window: blocked navigation to ${originOf(target) ?? "an invalid address"}`);
    };
    win.webContents.on("will-navigate", guardNavigation);
    win.webContents.on("will-redirect", guardNavigation);
    // No page may embed the server itself in this preload-bearing window, and an app's frame may only load its own document.
    win.webContents.on("will-frame-navigate", (details) => {
      if (details.isMainFrame) return;
      if (!appFrameNavigationAllowed(details)) return void details.preventDefault();
      if (originOf(details.url) === origin) details.preventDefault();
    });
    void win.loadURL(url).catch((error) => log(`app window failed to load: ${error?.message ?? error}`));
    return true;
  }

  ipcMain.handle("local-apps:open-window", guard("local-apps:open-window", (event, id) => {
    const origin = senderOrigin(event);
    return Boolean(origin && appIdFrom(id)) && openWindow(origin, id);
  }));
  // Only an app's own window asks this, and only for a chat link: the main window comes up on that chat.
  ipcMain.handle("local-apps:open-chat", (event, link) => {
    const sender = [...open.values()].find((win) => !win.isDestroyed() && win.webContents === event?.sender);
    const chat = chatLinkFrom(link);
    if (!sender || !chat || !/^openmausbot:\/\/(?:thread|bot)\//i.test(chat)) return false;
    return Boolean(openChat(chat));
  });

  launches?.attach((id) => {
    const origin = ready() ? launchOrigin() : null;
    return Boolean(origin) && openWindow(origin, id);
  });

  return { openWindow, windows: () => [...open.values()].filter((win) => !win.isDestroyed()) };
}
