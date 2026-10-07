// In-app auto-updater (electron-updater). Updates download by themselves as
// soon as a check finds one (macOS also stages the ZIP at once) and install
// when the app quits, or at once on the person's "Restart to update". Nothing
// restarts by itself in the middle of a call or a turn. One state object is
// broadcast on every transition, to this computer's page and to the person's
// own Cloud page.
//
// Only runs in the packaged, signed+notarized app (mac auto-update requires
// signing). In dev it's a no-op so the browser/dev shell is unaffected.
// electron-updater is vendored (electron/vendor/electron-updater.cjs) because
// the packaged app ships no node_modules.
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
import { createUpdaterCoordinator } from "./updater-coordinator.mjs";

const require = createRequire(import.meta.url);

let autoUpdater = null;
let win = null;
// status: idle | checking | downloading | preparing | downloaded | installing | handed-off | error
let state = { status: "idle" };
let updaterCoordinator = null;
// Which page may read and drive the updater (main.mjs updaterPageAllowed).
// Until main says, none may.
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
      // Logging must never make updating unavailable.
    }
  };
  return Object.fromEntries(["debug", "info", "warn", "error"].map((level) => [level, (...values) => write(level, values)]));
}

// A system package is the distro's to install, not ours. Left to
// electron-updater, a .deb update raises a polkit root prompt out of a chat
// app, runs `dpkg -i` (which resolves no dependencies) and replaces
// /opt/OpenMausBot while this very process is still running.
const HAND_OFF_TYPES = new Set(HAND_OFF_PACKAGE_TYPES);

// Do what this app already does for engine installs: put the exact command on
// the clipboard and open a blank terminal to paste it into. The command is
// never executed for the user, so nothing here becomes a process argument.
export function handOffDownloadedPackage(packageType) {
  return async (files) => {
    const target = stagedInstallFile(files);
    const command = packageInstallCommand(packageType, target);
    clipboard.writeText(command);
    return { command, terminalOpened: await openBlankTerminal() };
  };
}

function setState(patch) {
  state = { ...state, ...patch };
  try {
    const contents = win?.webContents;
    // Only the page the window shows now, and only if it may read the state.
    if (contents && pageAllowed({ sender: contents, senderFrame: contents.mainFrame })) contents.send("update:state", state);
  } catch {
    /* window gone */
  }
}

/** Send the current state to the window's page again, if it may read it now:
 * a page main refused while the Cloud sign-in was being restored hears it
 * once the sign-in lets it (main.mjs, on every Cloud sign-in change). */
export function sendUpdaterState() {
  setState({});
}

/** The updater changes THIS app: `allowed(event)` says which page may read
 * and drive it (this computer's page, and the person's own Cloud page). */
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

// macOS keeps the process (and updater) alive after its window closes.
// Retarget broadcasts on every window creation without adding more timers
// or event listeners to the process-wide updater.
export function attachUpdaterWindow(mainWindow) {
  win = mainWindow;
}

export function startUpdater() {
  // dev / unsigned builds can't auto-update — leave the banner dormant
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
  // The coordinator starts the download itself the moment a check finds an
  // update, so it owns that download (macOS staging, quiet failures).
  autoUpdater.autoDownload = false;
  autoUpdater.logger = updaterLogger();

  // Broadcast the install flavour before the first check so the banner never
  // offers a restart it cannot deliver.
  const packageType = linuxPackageType({ readMarker: (file) => (existsSync(file) ? readFileSync(file, "utf8") : null) });
  const handOff = HAND_OFF_TYPES.has(packageType);
  // A downloaded update installs when the app quits, on every platform:
  // Windows (per-user, one-click: silent, no admin prompt) and AppImage swap
  // it in then. On macOS this also starts Squirrel.Mac's native staging pass
  // at once, so "Restart to update" never has to begin that slow pass and
  // wait. A system package (.deb, .rpm, pacman) is the person's to install
  // in a terminal, never ours on quit.
  autoUpdater.autoInstallOnAppQuit = !handOff;
  setState({ installMode: handOff ? "handoff" : "restart" });
  updaterCoordinator = createUpdaterCoordinator(autoUpdater, setState, {
    handOffInstall: handOff ? handOffDownloadedPackage(packageType) : null,
    nativeStaging: process.platform === "darwin",
  });

  // first check ~15s after launch (let the app settle), then hourly — never
  // the person's own check, hence the arrow: a bare `check` would receive the
  // timer's argument as `manual` and report every passing network failure.
  setTimeout(() => void updaterCoordinator?.check(), 15_000).unref?.();
  setInterval(() => void updaterCoordinator?.check(), 60 * 60 * 1000).unref?.();
}
