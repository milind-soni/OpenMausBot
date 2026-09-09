// Single-instance policy for the desktop shell, kept Electron-free so the
// activation rules stay unit-testable with plain object fakes.

// Surface the existing app when a second launch gets absorbed: restore a
// minimized window, then show and focus. Prefer whatever window currently
// holds focus so a future multi-window layout lands predictably; otherwise
// the first living window wins.
export function activateExistingWindow(windows) {
  const alive = windows.filter((win) => win && !win.isDestroyed());
  if (alive.length === 0) return false;
  const target = alive.findLast((win) => win.isFocused()) ?? alive[0];
  if (target.isMinimized()) target.restore();
  target.show();
  target.focus();
  return true;
}

// Drop this process's single-instance lock. The update-relaunch path needs
// it: Squirrel.Mac can start the new build while the old process is still
// inside its deferred before-quit cleanup, and the new copy exits at the
// lock check unless the old one lets go first. The guard keeps the release
// idempotent because both Electron and electron-updater can emit
// before-quit-for-update for the same install.
export function releaseSingleInstanceLock(app) {
  if (!app.hasSingleInstanceLock()) return false;
  app.releaseSingleInstanceLock();
  return true;
}
