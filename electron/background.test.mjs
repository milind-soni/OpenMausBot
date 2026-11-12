import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBackgroundMode } from "./background.mjs";
let folder;
afterEach(() => { if (folder) rmSync(folder, { recursive: true, force: true }); });
describe("background opt-in", () => {
  it.each(["darwin", "win32", "linux"])("keeps a %s window recoverable, preserves explicit Quit, and saves the choice", platform => {
    folder = mkdtempSync(join(tmpdir(), "gbs-background-"));
    const app = new EventEmitter(); app.getPath = () => folder; app.quit = vi.fn();
    const handlers = new Map(), ipcMain = { handle: (name, fn) => handlers.set(name, fn) };
    const win = new EventEmitter(); Object.assign(win, { hide: vi.fn(), show: vi.fn(), focus: vi.fn(), isDestroyed: () => false, isMinimized: () => false });
    const menus = []; class Tray extends EventEmitter { setToolTip() {} setContextMenu(menu) { menus.push(menu); } destroy() {} }
    const setup = () => createBackgroundMode({ app, ipcMain, Tray, Menu: { buildFromTemplate: x => x }, nativeImage: { createFromPath: () => ({ resize: () => ({}) }) }, iconPath: "icon.png", getWindows: () => [win], openWindow: vi.fn(), platform });
    const controller = setup(); controller.attach(win);
    expect(handlers.get("background:get")()).toBe(false);
    const event = { preventDefault: vi.fn() }; win.emit("close", event); expect(event.preventDefault).not.toHaveBeenCalled();
    handlers.get("background:set")(null, true); win.emit("close", event); expect(win.hide).toHaveBeenCalled();
    menus[0][0].click(); expect(win.show).toHaveBeenCalled();
    expect(setup().enabled()).toBe(true);
    app.emit("before-quit"); const quitting = { preventDefault: vi.fn() }; win.emit("close", quitting); expect(quitting.preventDefault).not.toHaveBeenCalled();
    expect(() => handlers.get("background:set")(null, "true")).toThrow();
    handlers.get("background:set")(null, false); expect(handlers.get("background:get")()).toBe(false);
  });
});
