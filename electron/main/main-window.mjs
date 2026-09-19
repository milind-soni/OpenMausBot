// Extracted from electron/main.mjs: the main app window binding. Dozens of
// main.mjs sites read the bare mainWindow name — including the textually
// pinned company-backup region, whose sliced source must keep resolving it —
// and createWindow owns the only assignments. ESM forbids assigning another
// module's let, so this module owns the live binding, exports it read-only,
// and performs the same synchronous assignments at the exact former points
// through setMainWindow — the accessor pattern server-runtime.mjs set for
// SERVER_PORT/serverReady. Extracted subsystems that cannot import main.mjs
// read the window through getMainWindow() instead.
export let mainWindow = null;

/** The main app window, or null while it is (re)created or after it closes. */
export function getMainWindow() {
  return mainWindow;
}

/** Assign the main app window (createWindow), or clear it on close. */
export function setMainWindow(win) {
  mainWindow = win;
}
