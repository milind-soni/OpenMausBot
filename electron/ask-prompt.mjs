// This app's own prompt for a bot's ask: shown once nobody has touched the keyboard or mouse for a second, so a key meant
// for something else never answers it, and never while the person is looking at that Cloud in this app, where the card is.
import { askPromptWords } from "./screen-words.mjs";
import { deviceWord } from "./lending-indicator.mjs";
import nativeText from "./native-text.cjs";

/** Waits at most this long for a quiet moment. */
const QUIET_WAIT_MS = 15_000;

/** Electron 43 runs a message box without a window synchronously on macOS, stopping main until it is answered, and
 * `signal` cannot close it there; so on macOS the box is a sheet on `window()`, shown first if hidden, and null without
 * one. */
export function showClosableMessageBox(dialog, options, { window, platform }) {
  if (platform !== "darwin") return dialog.showMessageBox(options);
  const parent = window();
  if (!parent || parent.isDestroyed()) return null;
  if (!parent.isVisible()) parent.show();
  return dialog.showMessageBox(parent, options);
}

/** `window()`: this app's main window, or null. `idleSeconds()`: seconds since the last touch, null when unknown. */
export function createAskPrompt({ dialog, window, idleSeconds = () => null, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), platform = process.platform, t = nativeText.englishText.t }) {
  const open = () => { const win = window(); return win && !win.isDestroyed() ? win : null; };
  const looking = env => {
    const win = open();
    if (!win?.isFocused()) return false;
    try { return new URL(win.webContents.getURL()).origin === env.origin; } catch { return false; }
  };
  return async (env, ask, signal) => {
    if (looking(env)) return null;
    for (let waited = 0; waited < QUIET_WAIT_MS && !signal.aborted; waited += 500) {
      const idle = idleSeconds();
      if (typeof idle !== "number" || idle >= 1) break;
      await wait(500);
    }
    if (signal.aborted || looking(env)) return null;
    const words = askPromptWords(ask, { cloud: env.name, device: deviceWord(platform), t });
    const options = { type: "question", message: words.message, detail: words.detail, buttons: words.buttons, defaultId: 0, cancelId: 1, noLink: true, signal };
    const shown = showClosableMessageBox(dialog, options, { window: open, platform });
    if (!shown) return null;
    const { response } = await shown;
    if (signal.aborted) return null;
    return response === 0 ? "turn-on" : "not-now";
  };
}
