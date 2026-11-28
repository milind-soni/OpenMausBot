// The channels behind installing a saved app on this computer (`guard`: this computer's own page only, never a Cloud
// or server page). The page names the app; the installer checks the id and cleans the name itself.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createAppInstaller } from "./installer.mjs";

const MAX_NAME = 512;

export function installAppInstall({ ipcMain, guard, installer }) {
  ipcMain.handle("app-install:install", guard("app-install:install", (_event, input) => {
    const id = typeof input?.id === "string" ? input.id : "";
    const name = typeof input?.name === "string" ? input.name.slice(0, MAX_NAME) : "";
    const iconPng = input?.iconPng instanceof Uint8Array ? input.iconPng : undefined;
    return installer.installApp({ id, name, iconPng, desktopShortcut: input?.desktopShortcut === true });
  }));
  ipcMain.handle("app-install:uninstall", guard("app-install:uninstall", (_event, id) => installer.uninstallApp(typeof id === "string" ? id : "")));
  ipcMain.handle("app-install:add-to-desktop", guard("app-install:add-to-desktop", (_event, id) => installer.addToDesktop(typeof id === "string" ? id : "")));
  ipcMain.handle("app-install:remove-from-desktop", guard("app-install:remove-from-desktop", (_event, id) => installer.removeFromDesktop(typeof id === "string" ? id : "")));
  ipcMain.handle("app-install:list", guard("app-install:list", async () => ({ available: installer.available(), apps: await installer.installedApps() })));
  // `ids`: every saved app's id, from the page that just read the whole list; anything else removes nothing.
  ipcMain.handle("app-install:cleanup", guard("app-install:cleanup", (_event, ids) =>
    (Array.isArray(ids) && ids.length <= 10_000 && ids.every((id) => typeof id === "string") ? installer.cleanup(ids) : [])));
}

/** Main's wiring: the real folders, Electron's shell and image tools, and `execFile` for sips, iconutil and xdg-user-dir. */
export function createDesktopAppInstaller({ app, shell, nativeImage, env, platform, log }) {
  const userData = app.getPath("userData");
  const executable = platform === "linux" ? env.APPIMAGE || process.execPath : process.execPath;
  const installer = createAppInstaller({
    platform,
    path,
    home: app.getPath("home"),
    userData,
    appData: platform === "win32" ? app.getPath("appData") : null,
    desktop: platform === "linux" ? null : desktopFolder(app),
    dataHome: env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : null,
    executable,
    hostBundleId: hostBundleId(platform),
    enabled: app.isPackaged,
    fs: fs.promises,
    shell,
    run: (file, args) => new Promise((resolve) => {
      execFile(file, args, { timeout: 20_000, windowsHide: true }, (error, stdout) => resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout: String(stdout ?? "") }));
    }),
    resizePng: (png, side) => {
      const image = nativeImage.createFromBuffer(Buffer.from(png));
      return image.isEmpty() ? null : image.resize({ width: side, height: side, quality: "best" }).toPNG();
    },
    log,
  });
  if (installer.available()) void installer.refreshTargets().catch(() => {});
  return installer;
}

function desktopFolder(app) {
  try { return app.getPath("desktop"); } catch { return null; }
}

function hostBundleId(platform) {
  if (platform !== "darwin") return undefined;
  try {
    const plist = fs.readFileSync(path.resolve(process.execPath, "..", "..", "Info.plist"), "utf8");
    return /<key>CFBundleIdentifier<\/key>\s*<string>([A-Za-z0-9.-]+)<\/string>/.exec(plist)?.[1];
  } catch {
    return undefined;
  }
}
