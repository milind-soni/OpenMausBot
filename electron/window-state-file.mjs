// The main window's size and place across launches: window-state.json under userData (window-state.cjs reads it).
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { parseWindowState } = require("./window-state.cjs");

/** `file()`: where it is kept; `log`: main's log line. */
export function createWindowStateFile({ file, log = () => {} }) {
  function read() {
    try {
      return parseWindowState(fs.readFileSync(file(), "utf8"));
    } catch {
      return null;
    }
  }
  function write(win) {
    if (!win || win.isDestroyed()) return;
    const target = file();
    const temporary = `${target}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(temporary, JSON.stringify({ bounds: win.getNormalBounds(), maximized: win.isMaximized() }), { mode: 0o600 });
      fs.renameSync(temporary, target);
    } catch (error) {
      try { fs.rmSync(temporary, { force: true }); } catch {}
      log(`window state save failed: ${error?.message ?? error}`);
    }
  }
  /** Saves the window a quarter second after it moves or resizes, and as it closes; tells its page when it is maximized. */
  function install(win) {
    let timer = null;
    const flush = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      write(win);
    };
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, 250);
      timer.unref?.();
    };
    win.on("resize", schedule);
    win.on("move", schedule);
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
  return { read, write, install };
}
