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
