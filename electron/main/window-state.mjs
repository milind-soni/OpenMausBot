// Extracted from electron/main.mjs: persistence for the main window's bounds
// and maximize state (window-state.json in userData), flushed on a debounced
// resize/move and on close.
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { slog } from "./crash-log.mjs";

const require = createRequire(import.meta.url);
const { parseWindowState } = require("../window-state.cjs");

function windowStateFile() {
  return path.join(app.getPath("userData"), "window-state.json");
}

export function readWindowState() {
  try {
    return parseWindowState(fs.readFileSync(windowStateFile(), "utf8"));
  } catch {
    return null;
  }
}

function writeWindowState(win) {
  if (!win || win.isDestroyed()) return;
  const file = windowStateFile();
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      temporary,
      JSON.stringify({ bounds: win.getNormalBounds(), maximized: win.isMaximized() }),
      { mode: 0o600 },
    );
    fs.renameSync(temporary, file);
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {}
    slog(`window state save failed: ${error?.message ?? error}`);
  }
}

export function installWindowStatePersistence(win) {
  let timer = null;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    writeWindowState(win);
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, 250);
    timer.unref?.();
  };
  win.on("resize", schedule);
  win.on("move", schedule);
  // The renderer's caption buttons track the native maximize state (the
  // restore/maximize glyph flips); a lost push just leaves a stale glyph
  // until the next toggle, so a send failure is not fatal.
  const pushMaximized = () => {
    try {
      if (!win.isDestroyed()) win.webContents.send("window:maximized-changed", win.isMaximized());
    } catch {}
  };
  win.on("maximize", pushMaximized);
  win.on("unmaximize", pushMaximized);
  win.on("maximize", schedule);
  win.on("unmaximize", schedule);
  win.on("close", flush);
}
