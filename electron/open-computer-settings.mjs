// "Switch to This computer" from a Cloud's settings: This computer opens, with Settings on the same page.
// Kept out of main.mjs, which is at its size limit; main.mjs passes what this needs from its own state.

/**
 * @param {{ window: () => import("electron").BrowserWindow | null, onLocal: (window: import("electron").BrowserWindow) => boolean, showLocal: () => Promise<unknown> }} deps
 * `showLocal()`: the rail's own click on This computer, settled once its page has loaded or the switch could not happen.
 * @param {string | undefined} page the Settings page to open, if any
 */
export async function openComputerSettings(deps, page) {
  await deps.showLocal();
  const window = deps.window();
  if (page && window && !window.isDestroyed() && deps.onLocal(window)) window.webContents.send("app:open-settings", page);
}
