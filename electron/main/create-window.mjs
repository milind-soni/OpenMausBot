// Extracted from electron/main.mjs: createWindow, verbatim — the primary
// window's construction with restore/maximize state, the Windows skin-sync
// show handshake, the navigation/subframe guards and input context menu, the
// packaged smoke-test hook, and the initial loadURL choice between remote,
// packaged-local and dev servers. Every sibling-module name the body reads
// imports directly here, so the live bindings (desktopRemoteAccess,
// environmentsState, serverReady, SERVER_PORT, cuaReady,
// displayMediaRequestCount) stay live exactly as before. The two
// main.mjs-local borrows cross through the wiring deps below (the
// server-boot.mjs pattern): __dirname, because preload.cjs sits next to
// main.mjs, and serverStartConflictOnly, a main.mjs let that server-boot.mjs
// also assigns, so it reads through a zero-arg getter. The source-slice test
// electron/app-permissions.node-test.mjs reads THIS file now for the
// setWindowOpenHandler entry point.
import { app, BrowserWindow, dialog, screen, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { attachUpdaterWindow } from "../updater.mjs";
import { externalWebUrl } from "../app-permissions.mjs";
import { windowChromeOptions } from "../window-chrome.mjs";
import { desktopCompanionRendererArguments } from "../desktop-companion-client.mjs";
import { slog } from "./crash-log.mjs";
import { APP_ICON } from "./desktop-viewer.mjs";
import { mainWindow, setMainWindow } from "./main-window.mjs";
import { installWindowStatePersistence, readWindowState } from "./window-state.mjs";
import { SERVER_PORT, serverReady } from "./server-runtime.mjs";
import { buildErrorPage } from "./boot-error-page.mjs";
import { desktopRemoteAccess } from "./company-backup.mjs";
import { applyUnreadBadge, deliverPackageInstall, serverUnavailableWindows } from "./unread-badge.mjs";
import { cuaReady, displayMediaRequestCount } from "./cua-media.mjs";
import {
  DEV_URL,
  LOCAL_ID,
  activeEnvironment,
  allowedOrigins,
  environmentsState,
  offerComputerSharing,
  rendererOrigin,
  showContextMenu,
  switchEnvironment,
  workspaceMenuAction,
  workspaceNavigationAllowed,
} from "./environments.mjs";

const require = createRequire(import.meta.url);
const { STAGE_PREFIX: APPIMAGE_CUA_STAGE_PREFIX } = require("../cua-linux-bundle.cjs");
const { MIN_BOUNDS, resolveWindowState } = require("../window-state.cjs");

// Live reads into main.mjs's module state; wired once by main.mjs right
// before the first createWindow() call. __dirname is a main.mjs const;
// serverStartConflictOnly is a let both main.mjs and server-boot.mjs assign,
// so it crosses as a zero-arg getter (the environments.mjs convention). The
// defaults would only ever apply if a call somehow preceded the wiring.
const deps = {
  __dirname: "",
  serverStartConflictOnly: () => false,
};

export function wireCreateWindowDeps(wiring) {
  Object.assign(deps, wiring);
}

/**
 * Creates and initializes the primary Electron browser window and configures
 * its lifecycle hooks, context menus, and navigation guards.
 *
 * @returns {void}
 */
export function createWindow() {
  const waitsForSkinSync = process.platform === "win32";
  const primary = screen.getPrimaryDisplay();
  const displays = [primary, ...screen.getAllDisplays().filter((display) => display.id !== primary.id)];
  const restored = resolveWindowState(readWindowState(), displays.map((display) => display.workArea));
  const win = new BrowserWindow({
    ...restored.bounds,
    minWidth: MIN_BOUNDS.width,
    minHeight: MIN_BOUNDS.height,
    // The renderer restores its persisted skin before mounting React and
    // mirrors it over desktop:skin. Keep Windows hidden until that handshake
    // recolors the native caption-button overlay, otherwise a saved light
    // skin still flashes the Midnight-black block on every cold start.
    show: !waitsForSkinSync,
    icon: APP_ICON,
    backgroundColor: "#070707",
    autoHideMenuBar: process.platform !== "darwin",
    ...windowChromeOptions(process.platform),
    webPreferences: {
      contextIsolation: true,
      preload: path.join(deps.__dirname, "preload.cjs"),
      // The preload exposes the full bridge only to this origin (see preload.cjs).
      // Companion client mode still serves the bundled UI from its own
      // loopback relay, so it is a trusted local page while also needing the
      // renderer's remote-only feature gates. Keep the two facts independent:
      // upstream's origin boundary must not erase the client-mode marker.
      additionalArguments: [...desktopCompanionRendererArguments(rendererOrigin(), desktopRemoteAccess),
        ...(app.isPackaged && !desktopRemoteAccess ? ["--omb-company-desktop=1"] : [])],
    },
  });
  setMainWindow(win);
  attachUpdaterWindow(win);
  if (waitsForSkinSync) {
    // A broken renderer or preload must not strand the app as an invisible
    // process. Normal startup shows from desktop:skin almost immediately;
    // this is only the bounded recovery path.
    const skinSyncFallback = setTimeout(() => {
      if (!win.isDestroyed() && !win.isVisible()) win.show();
    }, 5_000);
    skinSyncFallback.unref?.();
    const clearSkinSyncFallback = () => clearTimeout(skinSyncFallback);
    win.once("show", clearSkinSyncFallback);
    win.once("closed", clearSkinSyncFallback);
  }
  installWindowStatePersistence(win);
  applyUnreadBadge(win);
  if (restored.maximized) win.maximize();
  win.once("closed", () => {
    if (mainWindow === win) setMainWindow(null);
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      void shell.openExternal(externalWebUrl(url)).catch(() => {
        console.warn("The external web link could not be opened");
      });
    } catch {
      // Reject non-web links and embedded credentials without opening them.
    }
    return { action: "deny" };
  });
  // Only the selected workspace may navigate this window. Switching is a
  // native action, not a redirect/link from a remote page to the local bridge.
  const guardNavigation = (event, url) => {
    let origin = null;
    try {
      origin = new URL(url).origin;
    } catch {}
    if (workspaceNavigationAllowed(url, environmentsState, rendererOrigin())) return;
    event.preventDefault();
    slog(`blocked navigation to ${origin ?? "an invalid address"}`);
  };
  win.webContents.on("will-navigate", guardNavigation);
  win.webContents.on("will-redirect", guardNavigation);
  // Subframes: a page may not embed the local server, or any other saved
  // server, inside this preload-bearing window.
  win.webContents.on("will-frame-navigate", (details) => {
    if (details.isMainFrame) return;
    let target = null;
    let page = null;
    try {
      target = new URL(details.url).origin;
      page = new URL(win.webContents.getURL()).origin;
    } catch {}
    if (!target || !page || target === page) return;
    if (target === rendererOrigin() || allowedOrigins(environmentsState, rendererOrigin()).has(target)) {
      details.preventDefault();
      slog(`blocked subframe navigation to ${details.url}`);
    }
  });
  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return; // -3: aborted by a newer navigation
    const remote = activeEnvironment(environmentsState);
    if (!remote) return;
    let origin = null;
    try {
      origin = new URL(validatedURL).origin;
    } catch {}
    if (origin !== remote.origin) return;
    slog(`remote server unreachable (${errorDescription}); back to Local`);
    void dialog.showMessageBox({
      type: "warning",
      message: `${remote.name} is not reachable`,
      detail: `${errorDescription}. Showing the local server instead; choose it again from the Server menu when it is back.`,
    });
    void workspaceMenuAction(() => switchEnvironment(LOCAL_ID));
  });
  win.webContents.on("did-finish-load", () => deliverPackageInstall(win));
  win.webContents.on("did-finish-load", () => void offerComputerSharing(win));

  // Native context menu for text inputs — without this, right-click does
  // nothing in the Electron window (no Cut/Copy/Paste/Select All).
  win.webContents.on("context-menu", (_event, params) => {
    showContextMenu(win, params);
  });

  // Packaged CI smoke hook. It validates the real renderer/preload bridge and
  // same-origin embedded server, then follows the normal window-close path.
  // No debugging port or sandbox override is needed.
  if (process.env.OMB_SMOKE_TEST === "1") {
    win.webContents.once("did-finish-load", async () => {
      try {
        const result = await win.webContents.executeJavaScript(`
          (async () => {
            if (!window.ogb?.getCapabilities) throw new Error("desktop preload bridge is unavailable");
            let crashPromise = null;
            if (${JSON.stringify(process.env.OMB_SMOKE_CUA === "1")}) {
              crashPromise = new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                  unsubscribe?.();
                  reject(new Error("timed out waiting for CUA crash invalidation"));
                }, 10000);
                const unsubscribe = window.ogb.onCapabilitiesChanged((next) => {
                  if (next.localComputer.reasonCode !== "daemon-exited") return;
                  clearTimeout(timeout);
                  unsubscribe();
                  resolve(next.localComputer.reasonCode);
                });
              });
            }
            const [initialCapabilities, healthResponse, ownerMutationResponse] = await Promise.all([
              window.ogb.getCapabilities(),
              fetch("/api/health"),
              fetch("/api/auth/stream-ticket", { method: "POST" }),
            ]);
            if (!healthResponse.ok) {
              throw new Error(\`health request failed: \${healthResponse.status} \${healthResponse.statusText}\`);
            }
            const health = await healthResponse.json();
            if (!ownerMutationResponse.ok) {
              throw new Error(
                \`desktop mutation capability failed: \${ownerMutationResponse.status} \${ownerMutationResponse.statusText}\`,
              );
            }
            let capabilities = initialCapabilities;
            let cuaCrashReason = null;
            let cuaRetryStatus = null;
            if (crashPromise) {
              if (!initialCapabilities.localComputer.available) {
                throw new Error("CUA was not ready before the simulated crash");
              }
              cuaCrashReason = await crashPromise;
              cuaRetryStatus = await window.ogb.localControl.retry();
              capabilities = await window.ogb.getCapabilities();
            }
            return {
              initialCapabilities,
              capabilities,
              cuaCrashReason,
              cuaRetryStatus,
              health,
              location: window.location.href,
              title: document.title,
            };
          })()
        `);
        const expectedLocation = `http://127.0.0.1:${SERVER_PORT}/`;
        if (result.location !== expectedLocation) {
          throw new Error(
            `unexpected packaged renderer URL: ${result.location} (expected ${expectedLocation})`,
          );
        }
        if (process.env.OMB_SMOKE_BUNDLED_CUA === "1") {
          const connection = await cuaReady;
          const expectedDriver = path.join(
            process.resourcesPath,
            "cua-linux-x64",
            "cua-driver",
          );
          let exactBundledPath = false;
          try {
            exactBundledPath =
              Boolean(connection?.driver?.path) &&
              fs.realpathSync(connection.driver.path) === fs.realpathSync(expectedDriver);
          } catch {}
          result.cuaRuntime = {
            driverSource: connection?.driver?.source,
            exactBundledPath,
            appImagePrivateStage:
              Boolean(process.env.APPIMAGE) &&
              connection?.driver?.path !== expectedDriver &&
              path.basename(path.dirname(connection?.driver?.path ?? "")).startsWith(
                APPIMAGE_CUA_STAGE_PREFIX,
              ),
            driverPath: connection?.driver?.path,
            driverVersion: connection?.driver?.version,
            daemonPid: connection?.daemon?.pid,
            socketPath: connection?.daemon?.socketPath,
            pidFile: connection?.daemon?.socketPath
              ? path.join(path.dirname(connection.daemon.socketPath), "driver.pid")
              : undefined,
            mcpEnv: connection?.mcp?.env,
          };
        }
        result.hardwareAccelerationEnabled = app.isHardwareAccelerationEnabled();
        result.displayMediaRequests = displayMediaRequestCount;
        console.log(`[smoke] renderer-ready ${JSON.stringify(result)}`);
      } catch (error) {
        console.error(`[smoke] renderer-failed ${error?.stack ?? error}`);
      } finally {
        if (process.env.OMB_SMOKE_KEEP_OPEN !== "1") win.close();
      }
    });
  }

  const remote = activeEnvironment(environmentsState);
  if (!serverReady && (desktopRemoteAccess || (app.isPackaged && !remote))) serverUnavailableWindows.add(win);
  if (desktopRemoteAccess) {
    win.loadURL(serverReady ? `http://127.0.0.1:${SERVER_PORT}` : buildErrorPage({ allPortsOccupied: deps.serverStartConflictOnly() }));
  } else if (remote) {
    void win.loadURL(remote.origin).catch(() => {});
  } else if (app.isPackaged) {
    win.loadURL(serverReady ? `http://127.0.0.1:${SERVER_PORT}` : buildErrorPage({ allPortsOccupied: deps.serverStartConflictOnly() }));
  } else {
    win.loadURL(DEV_URL);
  }
  return win;
}
