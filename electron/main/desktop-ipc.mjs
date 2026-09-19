// Extracted from electron/main.mjs: the desktop-surface IPC family, verbatim
// — the local-control screen preview, the engine terminal launch, folder
// picking, the diagnostics export, bot file saves, skins and caption
// controls, the desktop viewer and Local VM workspace panes, the macOS
// permission checks, and the speech family. The ipcMain.handle
// registrations run at module-evaluation time (the company-backup.mjs
// precedent), so this module imports its guard and helpers directly and
// never imports main.mjs. The one main.mjs-local free name in the family,
// nativeActions, crosses through wireDesktopIpc — main.mjs calls it at the
// exact former block position, and still reads the table on its own quit
// path. The source-slice test electron/app-permissions.node-test.mjs reads
// THIS file now for the desktop:open-external entry point.
import { app, BrowserWindow, clipboard, desktopCapturer, dialog, ipcMain, shell, systemPreferences } from "electron";
import fs from "node:fs";
import os from "node:os";
import { externalWebUrl } from "../app-permissions.mjs";
import { diagnosticsFileName } from "../diagnostics.mjs";
import { defaultSaveName, withSavableFile } from "../save-file.mjs";
import { isKnownSkin, skinChrome } from "../skin-overlay.cjs";
import { finishSpeech, startSpeech, stopSpeech } from "../speech.mjs";
import { openBlankTerminal } from "../terminal-launch.mjs";
import { gatherDiagnostics } from "./diagnostics.mjs";
import { desktopViewerContextId, desktopViewerWindow, openDesktopViewer } from "./desktop-viewer.mjs";
import { desktopWorkspaceForEvent } from "./desktop-workspace.mjs";
import { localOnly } from "./ipc-guards.mjs";
import { mainWindow } from "./main-window.mjs";

let nativeActions = null;

// main.mjs owns the platform dispatch table and reads it on its own quit
// path, so it hands the binding over here once at module load, through the
// same wiring boundary server-boot.mjs established (wireServerBootDeps).
// Handlers only read nativeActions when invoked, long after the wiring.
export function wireDesktopIpc({ nativeActions: boundNativeActions }) {
  nativeActions = boundNativeActions;
}

// Local-control screen preview — served from the main process so the Screen
// Recording permission prompt attributes to the app, never the server
ipcMain.handle("screen:frame", localOnly("screen:frame", async () => {
  if (process.platform !== "darwin") return null;
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: 1280, height: 800 },
  });
  return sources[0]?.thumbnail.toDataURL() ?? null;
}));

// Onboarding permission checks. Status reads are free; the mic request
// pops the real TCC prompt attributed to the app.
//
// Screen Recording deliberately has NO request path here. On macOS 15+
// every pre-grant mechanism is broken: getMediaAccessStatus("screen")
// wraps CGPreflightScreenCaptureAccess, which caches per-process (stays
// "denied" for the whole session after the user grants); a helper child
// binary gets TCC-attributed to ITSELF on macOS 26, not the app, and
// plain executables no longer appear in the Settings pane at all; and
// Sequoia+ re-prompts periodically regardless, so a pre-grant expires.
// The one reliable path is the first real in-process capture
// (screen:frame above / getDisplayMedia via the handler below) — macOS
// prompts then, attributed correctly, at the moment of actual use. The
// perm:open-settings deep link stays as the repair path for denials.
// Copy the engine command, then open a blank terminal. Renderer-controlled
// text must never become a process argument: the user reviews and pastes it.
// Returns false when the renderer should show the clipboard fallback.
ipcMain.handle("engine:open-terminal", localOnly("engine:open-terminal", async (_event, command) => {
  if (typeof command !== "string" || !command.trim()) return false;
  clipboard.writeText(command);
  return openBlankTerminal();
}));

// OAuth/connect links are returned asynchronously, after Chromium's direct
// click gesture has ended. Opening them through window.open can therefore be
// rejected as a popup before setWindowOpenHandler ever sees the URL. Keep the
// renderer sandboxed and let the main process open only ordinary web links.
// A bot's working folder: the native picker, so the path is real and the
// user never types one. Returns null when they cancel.
ipcMain.handle("desktop:pick-folder", localOnly("desktop:pick-folder", async (event, current) => {
  const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
  const result = await dialog.showOpenDialog(win, {
    title: "Choose a working folder",
    properties: ["openDirectory", "createDirectory"],
    ...(typeof current === "string" && current ? { defaultPath: current } : {}),
  });
  return result.canceled ? null : (result.filePaths[0] ?? null);
}));

// One-click bug-report bundle. Secrets are never read; the report is
// redacted again on the way out (diagnostics.mjs). null means the user
// cancelled the save dialog.
ipcMain.handle("desktop:export-diagnostics", localOnly("desktop:export-diagnostics", async (event) => {
  const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
  const report = await gatherDiagnostics();
  const result = await dialog.showSaveDialog(owner, {
    title: "Export diagnostics",
    defaultPath: diagnosticsFileName(),
    filters: [{ name: "Text", extensions: ["txt"] }],
  });
  if (result.canceled || !result.filePath) return null;
  if (process.platform === "win32") {
    fs.writeFileSync(result.filePath, report, { mode: 0o600 });
  } else {
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW;
    const handle = fs.openSync(result.filePath, flags, 0o600);
    try {
      fs.fchmodSync(handle, 0o600);
      fs.writeFileSync(handle, report, "utf8");
    } finally {
      fs.closeSync(handle);
    }
  }
  return result.filePath;
}));

// Bots hand users files as markdown links to paths inside the OpenMausBot
// home (workspaces, attachments). As plain anchors those resolved against the
// page origin, so the click opened http://127.0.0.1:8799<path> in the default
// browser and the server's SPA fallback answered with index.html — a second
// copy of the chat UI instead of the file. Ask where to put it and copy it
// there instead: a save dialog tells the user the file landed somewhere and
// where, which a silent copy into ~/Downloads does not. The path is
// renderer-controlled, so it must resolve inside ~/.openmausbot and be a
// regular file — never a symlink escape or directory.
ipcMain.handle("desktop:save-file", localOnly("desktop:save-file", async (event, rawPath) => {
  return withSavableFile(rawPath, { home: os.homedir() }, async ({ defaultName, copyTo }) => {
    const parent = BrowserWindow.fromWebContents(event.sender);
    const defaultPath = await defaultSaveName(app.getPath("downloads"), defaultName);
    const choice = await dialog.showSaveDialog(parent ?? undefined, {
      title: "Where do you want to save it?",
      message: "Where do you want to save it?",
      defaultPath,
      buttonLabel: "Save",
      properties: ["createDirectory", "showOverwriteConfirmation"],
    });
    // Cancelling is a decision, not a failure — the bubble stays quiet.
    if (choice.canceled || !choice.filePath) return null;
    await copyTo(choice.filePath);
    shell.showItemInFolder(choice.filePath);
    return choice.filePath;
  });
}));

// The renderer owns the skin, including the Windows caption buttons it draws
// itself (titleBarStyle hidden, no native overlay). Keep syncing the window
// background so a light skin never flashes the Midnight-black cold start.
ipcMain.handle("desktop:skin", (event, skin) => {
  if (!isKnownSkin(skin)) return false;
  try {
    const { color } = skinChrome(skin);
    const win = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
    if (win && !win.isDestroyed()) {
      try { win.setBackgroundColor(color); } catch {}
    }
  } catch {}
  return true;
});

// Caption controls for the overlay-less frameless window. The renderer's
// buttons are the only way to act on the window, so the channels stay
// open for the local page; a remote server's page never has them.
for (const [channel, act] of [
  ["window:minimize", (win) => win.minimize()],
  ["window:toggle-maximize", (win) => (win.isMaximized() ? win.unmaximize() : win.maximize())],
  ["window:close", (win) => win.close()],
]) {
  ipcMain.handle(channel, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
    if (!win || win.isDestroyed()) return false;
    act(win);
    return true;
  });
}
ipcMain.handle("window:state", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
  return { maximized: Boolean(win && !win.isDestroyed() && win.isMaximized()) };
});

ipcMain.handle("desktop:open-external", localOnly("desktop:open-external", async (_event, rawUrl) => {
  await shell.openExternal(externalWebUrl(rawUrl));
  return true;
}));

// The Box VNC viewer must be a top-level page for its token exchange. A
// sandboxed modal BrowserWindow satisfies that requirement while keeping the
// live desktop inside OpenMausBot instead of sending the person to a browser.
ipcMain.handle("desktop-viewer:open", localOnly("desktop-viewer:open", (event, rawUrl, title, contextId) => {
  const owner = BrowserWindow.fromWebContents(event.sender);
  return openDesktopViewer(owner, rawUrl, title, contextId);
}));

// Two Local VM desktops share the existing app BrowserWindow. The renderer
// supplies only layout and intent; URL validation, sandboxing, session
// isolation and the one-interactive-pane invariant stay in the main process.
ipcMain.handle("desktop-workspace:open", localOnly("desktop-workspace:open", (event, input) =>
  desktopWorkspaceForEvent(event, true).open(input),
));
ipcMain.handle("desktop-workspace:layout", localOnly("desktop-workspace:layout", (event, items) => {
  const manager = desktopWorkspaceForEvent(event);
  if (!manager) return false;
  return manager.layout(items);
}));
ipcMain.handle("desktop-workspace:set-interactive", localOnly("desktop-workspace:set-interactive", (event, contextId) => {
  const manager = desktopWorkspaceForEvent(event);
  if (!manager) return contextId == null;
  return manager.setInteractive(contextId);
}));
ipcMain.handle("desktop-workspace:close", localOnly("desktop-workspace:close", (event, contextId) => {
  const manager = desktopWorkspaceForEvent(event);
  if (!manager) return true;
  return manager.close(contextId);
}));

// Close only when the caller owns the current viewer — otherwise one bot's
// "Hand control back" would close (and release) another bot's viewer.
ipcMain.handle("desktop-viewer:close", localOnly("desktop-viewer:close", (_event, contextId) => {
  const scoped = Object.prototype.toString.call(contextId) === "[object String]" ? contextId : null;
  if (scoped !== desktopViewerContextId) return false;
  if (desktopViewerWindow && !desktopViewerWindow.isDestroyed()) desktopViewerWindow.close();
  return true;
}));

// Lets a (re)mounted panel seed viewer-open state instead of defaulting to false.
ipcMain.handle("desktop-viewer:state-now", localOnly("desktop-viewer:state-now", () => ({
  open: Boolean(desktopViewerWindow && !desktopViewerWindow.isDestroyed()),
  contextId: desktopViewerContextId,
})));

ipcMain.handle("perm:status", () => ({
  mic:
    nativeActions.appleMediaPermissions
      ? systemPreferences.getMediaAccessStatus?.("microphone") ?? "unknown"
      : "unsupported",
}));
ipcMain.handle("perm:request-mic", localOnly("perm:request-mic", async () => {
  if (!nativeActions.appleMediaPermissions) return false;
  try {
    return await systemPreferences.askForMediaAccess("microphone");
  } catch {
    return false;
  }
}));

// macOS never re-prompts a denied permission — the only path is System
// Settings; deep-link straight to the right privacy pane.
ipcMain.handle("perm:open-settings", localOnly("perm:open-settings", (_event, pane) => {
  if (!nativeActions.applePrivacySettings) return false;
  const panes = {
    mic: "Privacy_Microphone",
    screen: "Privacy_ScreenCapture",
    speech: "Privacy_SpeechRecognition",
    accessibility: "Privacy_Accessibility",
  };
  // own-property lookup only — a renderer-supplied "__proto__"/"constructor"
  // would otherwise resolve up the prototype chain to a truthy object
  const anchor = Object.hasOwn(panes, pane) ? panes[pane] : "Privacy";
  return shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${anchor}`);
}));

ipcMain.handle("speech:start", localOnly("speech:start", (event, options) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  if (!nativeActions.appleSpeech) {
    win.webContents.send("speech:end", { code: 2, reason: "unsupported-platform" });
    return;
  }
  startSpeech(win, options);
}));
ipcMain.handle("speech:stop", localOnly("speech:stop", () => {
  if (nativeActions.appleSpeech) stopSpeech();
}));
ipcMain.handle("speech:finish", localOnly("speech:finish", () => {
  if (nativeActions.appleSpeech) finishSpeech();
}));
