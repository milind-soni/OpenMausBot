import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/** Injected Electron surfaces keep close/quit policy testable without launching an app. */
export function createBackgroundMode({ app, ipcMain, Tray, Menu, nativeImage, iconPath, getWindows, openWindow, platform = process.platform }) {
  const directory = app.getPath("userData"), file = join(directory, "background.json");
  let enabled = false, quitting = false, tray = null;
  try { enabled = JSON.parse(readFileSync(file, "utf8")).enabled === true; } catch { /* opt-in only */ }
  const open = () => { const win = getWindows().find(w => !w.isDestroyed()); if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } else openWindow(); };
  const ensureTray = () => {
    if (tray) return;
    const icon = nativeImage.createFromPath(iconPath).resize({ width: platform === "darwin" ? 16 : 24, height: platform === "darwin" ? 16 : 24 });
    tray = new Tray(icon);
    tray.setToolTip("Gerer Build Studio — schedules are running");
    tray.setContextMenu(Menu.buildFromTemplate([{ label: "Open Gerer Build Studio", click: open }, { type: "separator" }, { label: "Quit Gerer Build Studio", click: () => app.quit() }]));
    tray.on("click", open);
  };
  if (enabled) { try { ensureTray(); } catch { enabled = false; } }
  ipcMain.handle("background:get", () => enabled);
  ipcMain.handle("background:set", (_event, value) => {
    if (typeof value !== "boolean") throw new Error("Choose whether the app should keep running.");
    if (value) ensureTray();
    mkdirSync(directory, { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    try { writeFileSync(temp, JSON.stringify({ enabled: value }), { mode: 0o600 }); renameSync(temp, file); }
    catch (error) { try { unlinkSync(temp); } catch {} if (!enabled && tray) { tray.destroy(); tray = null; } throw error; }
    enabled = value;
    if (!enabled && tray) { open(); tray.destroy(); tray = null; }
    return enabled;
  });
  app.on("before-quit", () => { quitting = true; });
  return {
    attach(win) { win.on("close", event => { if (enabled && !quitting && tray) { event.preventDefault(); win.hide(); } }); },
    open,
    enabled: () => enabled,
  };
}
