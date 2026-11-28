// A person's own app icon: one copied picture in this app's data folder, named by a small JSON file.
// The picture is copied, not linked, so moving or deleting the original changes nothing.
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";

export const APP_ICON_CHOICE_FILE = "app-icon.json";
export const APP_ICON_MAX_BYTES = 8 * 1024 * 1024;
export const APP_ICON_MIN_EDGE = 16;
export const APP_ICON_MAX_EDGE = 4096;
const EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".ico"]);

/** The saved choice, or null when there is none or its file name is not a plain name inside the data folder. */
export function readAppIconChoice(userData) {
  try {
    const value = JSON.parse(readFileSync(join(userData, APP_ICON_CHOICE_FILE), "utf8"));
    if (!value || typeof value !== "object") return null;
    const file = typeof value.file === "string" ? value.file : "";
    if (!/^app-icon\.(?:png|jpe?g|ico)$/i.test(file)) return null;
    const name = typeof value.name === "string" ? value.name.slice(0, 120) : "";
    return { file, ...(name ? { name } : {}) };
  } catch {
    return null;
  }
}

/** The icon to use now: the saved picture when it is still there, else the app's own. */
export function resolveAppIcon({ userData, defaultPath, exists = existsSync }) {
  const choice = readAppIconChoice(userData);
  if (choice) {
    const path = join(userData, choice.file);
    if (exists(path)) return { path, custom: true, ...(choice.name ? { name: choice.name } : {}) };
  }
  return { path: defaultPath, custom: false };
}

/** Why a picture cannot be the app icon, or null when it can. */
export function appIconProblem({ imagePath, nativeImage, stat = statSync }) {
  if (!EXTENSIONS.has(extname(imagePath).toLowerCase())) return "extension";
  let size;
  try {
    size = stat(imagePath).size;
  } catch {
    return "unreadable";
  }
  if (!size || size > APP_ICON_MAX_BYTES) return "size";
  let image;
  try {
    image = nativeImage.createFromPath(imagePath);
  } catch {
    return "unreadable";
  }
  if (!image || image.isEmpty()) return "unreadable";
  const { width, height } = image.getSize();
  if (!width || !height || width < APP_ICON_MIN_EDGE || height < APP_ICON_MIN_EDGE || width > APP_ICON_MAX_EDGE || height > APP_ICON_MAX_EDGE) return "dimensions";
  return null;
}

/**
 * Copy `imagePath` into the data folder and remember it. The copy is written under a temporary
 * name first, so a failed copy never replaces a working icon.
 */
export function saveAppIcon({ userData, imagePath, nativeImage, stat = statSync, rename = renameSync, copy = copyFileSync }) {
  const problem = appIconProblem({ imagePath, nativeImage, stat });
  if (problem) return { ok: false, problem };
  const extension = extname(imagePath).toLowerCase();
  const file = `app-icon${extension}`;
  const previous = readAppIconChoice(userData);
  const temporary = `${join(userData, file)}.tmp`;
  const destination = join(userData, file);
  try {
    mkdirSync(userData, { recursive: true });
    copy(imagePath, temporary);
    rename(temporary, destination);
    const name = basename(imagePath).slice(0, 120);
    const choice = `${JSON.stringify({ file, name }, null, 2)}\n`;
    writeFileSync(`${join(userData, APP_ICON_CHOICE_FILE)}.tmp`, choice, { mode: 0o600 });
    rename(`${join(userData, APP_ICON_CHOICE_FILE)}.tmp`, join(userData, APP_ICON_CHOICE_FILE));
    if (previous && previous.file !== file) removeQuietly(join(userData, previous.file));
    return { ok: true, path: destination, name };
  } catch {
    removeQuietly(temporary);
    removeQuietly(`${join(userData, APP_ICON_CHOICE_FILE)}.tmp`);
    return { ok: false, problem: "write" };
  }
}

/** Forget the saved icon and remove its copy. */
export function clearAppIcon(userData) {
  const choice = readAppIconChoice(userData);
  for (const extension of EXTENSIONS) removeQuietly(join(userData, `app-icon${extension}`));
  if (choice) removeQuietly(join(userData, choice.file));
  removeQuietly(join(userData, APP_ICON_CHOICE_FILE));
}

/** The icon to use at launch: the saved picture when it is there, else the app's own. */
export function savedAppIcon(app, defaultPath) {
  try {
    return resolveAppIcon({ userData: app.getPath("userData"), defaultPath }).path;
  } catch {
    return defaultPath;
  }
}

/** What the settings row shows: the picture in use and a 64 px preview. */
export function appIconState({ userData, defaultPath, nativeImage }) {
  const choice = resolveAppIcon({ userData, defaultPath });
  let preview;
  try {
    const image = nativeImage.createFromPath(choice.path);
    if (!image.isEmpty()) preview = image.resize({ width: 64, height: 64, quality: "best" }).toDataURL();
  } catch {
    preview = undefined;
  }
  return { custom: choice.custom, ...(choice.name ? { name: choice.name } : {}), ...(preview ? { preview } : {}) };
}

/** Put an icon on the surfaces that can change while the app runs. */
export function applyAppIcon(iconPath, { platform, app, nativeImage, windows, trays, activity, log }) {
  if (platform === "darwin") {
    try {
      app.dock?.setIcon(iconPath);
    } catch (error) {
      log?.(`app icon: ${error?.message ?? error}`);
    }
  } else {
    const image = nativeImage.createFromPath(iconPath);
    if (!image.isEmpty()) for (const win of windows) { try { win.setIcon(image); } catch { /* a window closing now needs no icon */ } }
  }
  for (const tray of trays) tray?.setIcon?.(iconPath);
  activity?.setIcon?.(iconPath);
}

/** This computer's app-icon settings routes: read, choose, and reset. */
export function installAppIconHandlers({ ipcMain, localOnly, dialog, BrowserWindow, app, nativeImage, defaultPath, t, apply }) {
  const state = () => appIconState({ userData: app.getPath("userData"), defaultPath, nativeImage });
  ipcMain.handle("desktop:app-icon:state", localOnly("desktop:app-icon:state", state));
  ipcMain.handle("desktop:app-icon:choose", localOnly("desktop:app-icon:choose", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const result = await dialog.showOpenDialog(win, {
      title: t("native.picker.appIcon"),
      properties: ["openFile"],
      filters: [{ name: t("native.picker.imageFilter"), extensions: ["png", "jpg", "jpeg", "ico"] }],
    });
    const imagePath = result.canceled ? undefined : result.filePaths[0];
    if (!imagePath) return { outcome: "canceled" };
    const saved = saveAppIcon({ userData: app.getPath("userData"), imagePath, nativeImage });
    if (!saved.ok) return { outcome: "error", problem: saved.problem };
    apply(saved.path);
    return { outcome: "saved", state: state() };
  }));
  ipcMain.handle("desktop:app-icon:reset", localOnly("desktop:app-icon:reset", () => {
    clearAppIcon(app.getPath("userData"));
    apply(defaultPath);
    return { outcome: "reset", state: state() };
  }));
}

function removeQuietly(path) {
  try {
    rmSync(path, { force: true });
  } catch {
    // The file is already gone or cannot be removed now; the saved choice is the source of truth.
  }
}
