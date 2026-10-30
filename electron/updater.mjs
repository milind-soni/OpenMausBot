// macOS auto-update requires a signed app, so this runs only when packaged. electron-updater is vendored
// because the packaged app ships no node_modules.
import { app, clipboard, ipcMain } from "electron";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import {
  HAND_OFF_PACKAGE_TYPES,
  linuxPackageType,
  packageInstallCommand,
  stagedInstallFile,
} from "./package-install-command.mjs";
import { canInstallElevated, installPackageElevated } from "./elevated-install.mjs";
import { releaseSingleInstanceLock } from "./single-instance.mjs";
import { openBlankTerminal } from "./terminal-launch.mjs";
import { createUpdaterCoordinator } from "./updater-coordinator.mjs";
import { createQuietInstall, installFailed, launchAfter, LOOK_EVERY_MS, updateSeen } from "./update-when-quiet.mjs";

export { quietSignals } from "./update-when-quiet-main.mjs";

const require = createRequire(import.meta.url);

let autoUpdater = null;
let win = null;
let state = { status: "idle" };
let updaterCoordinator = null;
let pageAllowed = () => false;
let quiet = null;
let launch = null;
/** Where these updaters install without asking anything: Squirrel.Mac, and the per-user NSIS installer run silently. */
const QUIET_PLATFORMS = new Set(["darwin", "win32"]);

function quietRecord() {
  const file = join(app.getPath("userData"), "update-when-quiet.json");
  return {
    read: () => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } },
    write: (value) => {
      try {
        writeFileSync(`${file}.tmp`, JSON.stringify(value ?? null), { mode: 0o600 });
        renameSync(`${file}.tmp`, file);
      } catch {
      }
    },
  };
}

function launched() {
  launch ??= app.isPackaged && QUIET_PLATFORMS.has(process.platform)
    ? launchAfter(quietRecord(), { version: app.getVersion() })
    : { hidden: false, updated: null };
  return launch;
}

/** This launch is a quiet install's reopening while the window was closed: it stays closed. macOS activates the app it
 * reopens, so the app hands the focus back at once. */
export function reopenedOutOfSight() {
  const { hidden } = launched();
  if (hidden && process.platform === "darwin") app.hide();
  return hidden;
}

function view() {
  return {
    ...state,
    ...(quiet && state.status === "downloaded" ? { installsByItself: quiet.promises(state.version) } : {}),
    ...(launch?.updated ? { updated: launch.updated } : {}),
  };
}

function updaterLogger() {
  const directory = app.getPath("logs");
  const file = join(directory, "updater.log");
  const write = (level, values) => {
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const message = values
        .map((value) => (value instanceof Error ? value.stack ?? value.message : String(value)))
        .join(" ");
      appendFileSync(file, `[${new Date().toISOString()}] [${level}] ${message}\n`, { mode: 0o600 });
    } catch {
    }
  };
  return Object.fromEntries(["debug", "info", "warn", "error"].map((level) => [level, (...values) => write(level, values)]));
}

// electron-updater would install a .deb through a polkit root prompt and `dpkg -i` (no dependency resolution) over the running app.
// A .deb is installed by elevated-install.mjs when a password prompt can be shown; every system package otherwise gets the hand-off below.
const HAND_OFF_TYPES = new Set(HAND_OFF_PACKAGE_TYPES);

// The command is never executed for the person, so nothing here becomes a process argument.
export function handOffDownloadedPackage(packageType) {
  return async (files) => {
    const target = stagedInstallFile(files);
    const command = packageInstallCommand(packageType, target);
    clipboard.writeText(command);
    return { command, terminalOpened: await openBlankTerminal() };
  };
}

export function installDownloadedPackage(files, { sha512 } = {}) {
  return installPackageElevated({ file: stagedInstallFile(files), sha512 });
}

// The install replaced the files under this process, so reopen at once; the lock goes first or the new copy exits (see main.mjs).
function relaunchAfterInstall() {
  releaseSingleInstanceLock(app);
  app.relaunch();
  app.quit();
}

function setState(patch) {
  state = { ...state, ...patch };
  if (quiet && patch.status === "error") installFailed(quietRecord());
  try {
    const contents = win?.webContents;
    if (contents && pageAllowed({ sender: contents, senderFrame: contents.mainFrame })) contents.send("update:state", view());
  } catch {
  }
}

export function sendUpdaterState() {
  setState({});
}

export function registerUpdaterIpc({ pageAllowed: allowed }) {
  pageAllowed = allowed;
  const guarded = (channel, handler) => (event) => {
    if (!pageAllowed(event)) throw new Error(`${channel} is only available in this app's window`);
    return handler();
  };
  ipcMain.handle("update:get-state", guarded("update:get-state", view));
  ipcMain.handle("update:check", guarded("update:check", () => updaterCoordinator?.check(true)));
  ipcMain.handle("update:install", guarded("update:install", () => updaterCoordinator?.install()));
  ipcMain.handle("update:seen", guarded("update:seen", () => {
    if (!launch?.updated) return;
    updateSeen(quietRecord());
    launch = { ...launch, updated: null };
    setState({});
  }));
}

// macOS keeps the process (and updater) alive after its window closes, so each new window is retargeted here.
export function attachUpdaterWindow(mainWindow) {
  win = mainWindow;
}

/** `signals` (quietSignals): what tells a quiet moment; without them a downloaded update installs only on Restart or quit. */
export function startUpdater(signals = null) {
  if (!app.isPackaged) {
    updaterCoordinator = null;
    setState({ status: "idle" });
    return;
  }
  try {
    ({ autoUpdater } = require("./vendor/electron-updater.cjs"));
  } catch {
    updaterCoordinator = null;
    setState({ status: "error", message: "updater unavailable" });
    return;
  }
  // The coordinator starts each download itself, so it owns macOS staging and quiet failures.
  autoUpdater.autoDownload = false;
  autoUpdater.logger = updaterLogger();

  // Broadcast the install flavour before the first check so the banner never offers a restart it cannot deliver.
  const packageType = linuxPackageType({ readMarker: (file) => (existsSync(file) ? readFileSync(file, "utf8") : null) });
  const handOff = HAND_OFF_TYPES.has(packageType);
  // On macOS this also starts Squirrel.Mac's native staging at once; a system package is never installed on quit.
  autoUpdater.autoInstallOnAppQuit = !handOff;
  const elevated = packageType === "deb" && canInstallElevated();
  setState({ installMode: handOff && !elevated ? "handoff" : "restart" });
  updaterCoordinator = createUpdaterCoordinator(autoUpdater, setState, {
    handOffInstall: handOff ? handOffDownloadedPackage(packageType) : null,
    elevatedInstall: elevated ? installDownloadedPackage : null,
    relaunch: elevated ? relaunchAfterInstall : null,
    nativeStaging: process.platform === "darwin",
  });
  if (signals && QUIET_PLATFORMS.has(process.platform)) {
    launched();
    quiet = createQuietInstall({ updater: updaterCoordinator, signals, record: quietRecord(), version: app.getVersion(),
      log: (line) => autoUpdater.logger?.info?.(line) });
    setInterval(() => void quiet?.look(), LOOK_EVERY_MS).unref?.();
    signals.watch(() => quiet?.look());
    setState({});
  }

  setTimeout(() => void updaterCoordinator?.check(), 15_000).unref?.();
  setInterval(() => void updaterCoordinator?.check(), 60 * 60 * 1000).unref?.();
}
