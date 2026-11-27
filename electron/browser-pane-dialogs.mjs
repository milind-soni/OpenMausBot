// A pane page's alert, confirm and prompt: never a native box. Chromium reports each dialog over CDP
// (Page.javascriptDialogOpening) and takes the answer there (Page.handleJavaScriptDialog), from the bot's dialog tool or
// the panel's dialog card; Electron would also draw its own message box, which stays after CDP answered.
//
// Adapted from anomalyco/opencode@5ca87b9 packages/gui-plugins/src/browser/page-prompts.ts (takeDialogs,
// RESTORE_PROMPT), MIT License, Copyright (c) 2025 opencode (full text in third_party/opencode/LICENSE). Modified: the
// open state comes from the pane's own CDP events.

/** How long a dialog CDP never reported may hold the page before it is dismissed, as a dismissed box would be. */
export const UNREPORTED_DIALOG_MS = 2_000;

/**
 * Gives a top-level document Chromium's own `prompt` back. Electron replaces it in every main frame with one that throws
 * ("prompt() is not supported", Electron 43); a frame Electron does not set up keeps the original, and calling it for
 * this window opens this window's dialog, which CDP reports like alert and confirm. It runs in the page's own world:
 * the one script the pane adds there, so a page's prompt works as in Chrome.
 */
export const RESTORE_PROMPT = `(() => {
  if (window !== window.top) return
  let native
  const prompt = function prompt(message, value) {
    if (!native) {
      const root = document.body ?? document.documentElement
      if (!root) return null
      const frame = document.createElement("iframe")
      frame.hidden = true
      root.append(frame)
      native = frame.contentWindow.prompt
      frame.remove()
    }
    return Reflect.apply(native, window, arguments)
  }
  Object.defineProperty(window, "prompt", { value: prompt, writable: true, configurable: true, enumerable: true })
})()`;

/**
 * Takes Electron's `-run-dialog` (its message box) on `contents`, an Electron internal (lib/browser/api/web-contents.ts,
 * `(info, callback)`): the page's dialog then waits only for CDP's answer. `opened()` says whether CDP reported it.
 */
export function takeDialogs(contents, { opened, warn = () => {}, delayMs = UNREPORTED_DIALOG_MS, setTimer = setTimeout }) {
  const events = contents;
  const held = new Set();
  if (events.listenerCount("-run-dialog") === 0) warn("Electron has no -run-dialog listener on a pane; its own dialog box may still show.");
  const run = (info, last) => {
    const callback = [last, info].find((value) => typeof value === "function");
    if (!callback) {
      warn("Electron's -run-dialog passed no callback; the dialog is left to CDP.");
      return;
    }
    held.add(callback);
    // The page never waits on a dialog nobody can see: one CDP never reported is dismissed.
    setTimer(() => {
      if (held.has(callback) && !opened()) {
        held.delete(callback);
        callback(false, "");
      }
    }, delayMs);
  };
  const release = () => {
    for (const callback of held) callback(false, "");
    held.clear();
  };
  events.removeAllListeners("-run-dialog");
  events.on("-run-dialog", run);
  events.on("-cancel-dialogs", release);
  return {
    /** CDP reported the dialog closed: whoever answered it, its callback is spent. */
    closed: () => held.clear(),
    /** Whether a page waits on a dialog here. */
    get waiting() {
      return held.size > 0;
    },
    /** Dismisses every dialog a page waits on, as a dismissed box would be. */
    dismiss: release,
    dispose: () => {
      release();
      if (contents.isDestroyed?.()) return;
      events.off("-run-dialog", run);
      events.off("-cancel-dialogs", release);
    },
  };
}
