export function activateExistingWindow(windows) {
  const alive = windows.filter((win) => win && !win.isDestroyed());
  if (alive.length === 0) return false;
  const target = alive.findLast((win) => win.isFocused()) ?? alive[0];
  if (target.isMinimized()) target.restore();
  target.show();
  target.focus();
  return true;
}

// Idempotent: both Electron and electron-updater can emit before-quit-for-update for the same install.
export function releaseSingleInstanceLock(app) {
  if (!app.hasSingleInstanceLock()) return false;
  app.releaseSingleInstanceLock();
  return true;
}
