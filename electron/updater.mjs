// macOS auto-update requires a signed app, so this runs only when packaged. electron-updater is vendored
// because the packaged app ships no node_modules.
import { app, clipboard, ipcMain } from "electron";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import {
  HAND_OFF_PACKAGE_TYPES,
  linuxPackageType,
  packageInstallCommand,
  stagedInstallFile,
} from "./package-install-command.mjs";
import { openBlankTerminal } from "./terminal-launch.mjs";
import { UPDATE_TEXT } from "./update-errors.mjs";
import { createUpdaterCoordinator } from "./updater-coordinator.mjs";

const require = createRequire(import.meta.url);

let autoUpdater = null;
let win = null;
let state = { status: "idle" };
let updaterCoordinator = null;
let pageAllowed = () => false;

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

function setState(patch) {
  const { messageCode: _stale, ...kept } = state;
  state = { ...(Object.hasOwn(patch, "message") ? kept : state), ...patch };
  try {
    const contents = win?.webContents;
    if (contents && pageAllowed({ sender: contents, senderFrame: contents.mainFrame })) contents.send("update:state", state);
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
  ipcMain.handle("update:get-state", guarded("update:get-state", () => state));
  ipcMain.handle("update:check", guarded("update:check", () => updaterCoordinator?.check(true)));
  ipcMain.handle("update:install", guarded("update:install", () => updaterCoordinator?.install()));
}

// macOS keeps the process (and updater) alive after its window closes, so each new window is retargeted here.
export function attachUpdaterWindow(mainWindow) {
  win = mainWindow;
}

export function startUpdater() {
  if (!app.isPackaged) {
    updaterCoordinator = null;
    setState({ status: "idle" });
    return;
  }
  try {
    ({ autoUpdater } = require("./vendor/electron-updater.cjs"));
  } catch {
    updaterCoordinator = null;
    setState({ status: "error", message: UPDATE_TEXT.unavailable, messageCode: "unavailable" });
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
  setState({ installMode: handOff ? "handoff" : "restart" });
  updaterCoordinator = createUpdaterCoordinator(autoUpdater, setState, {
    handOffInstall: handOff ? handOffDownloadedPackage(packageType) : null,
    nativeStaging: process.platform === "darwin",
  });

  setTimeout(() => void updaterCoordinator?.check(), 15_000).unref?.();
  setInterval(() => void updaterCoordinator?.check(), 60 * 60 * 1000).unref?.();
}
