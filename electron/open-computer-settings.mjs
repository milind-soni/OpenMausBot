// "Switch to This computer" from a Cloud's settings: This computer opens, with Settings on the same page.
// Kept out of main.mjs, which is at its size limit; main.mjs passes what this needs from its own state.

/**
 * @param {{ window: () => import("electron").BrowserWindow | null, onLocal: (window: import("electron").BrowserWindow) => boolean, showLocal: () => void, navigate: (url: string) => unknown, origin: () => string }} deps
 * @param {string | undefined} page the Settings page to open, if any
 */
export function openComputerSettings(deps, page) {
  const window = deps.window();
  if (!window || window.isDestroyed()) return;
  if (deps.onLocal(window)) {
    if (page) window.webContents.send("app:open-settings", page);
    return;
  }
  deps.showLocal();
  deps.navigate(`${deps.origin()}${page ? `/?desktop-settings=${encodeURIComponent(page)}` : "/"}`);
}
