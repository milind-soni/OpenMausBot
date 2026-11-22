// A pane's commands while its page has a JavaScript dialog open. The page's renderer waits on the dialog, so anything it
// must answer (a script, a DOM or accessibility read, input, a screenshot, the screencast) would wait until the dialog
// closes, and the bot's next call would queue behind it (measured on Electron 43: a turn's preview tick under an open
// alert held the bot's navigate until the link's timeout). Nothing a pane forwards may sit unanswered in front of the
// dialog's dismissal: each command is answered by the browser, settled at once, or settled after a short grace.

export const DIALOG_HOLDS = "A JavaScript dialog is open on the page; it holds this until it is answered.";
/** How long a command of no known kind may wait under an open dialog before it is settled with DIALOG_HOLDS. */
export const DIALOG_GRACE_MS = 1_000;

/** Answered by the browser itself, so a dialog never holds them; a navigation dismisses the dialog first. */
const BROWSER = /^(?:Page\.(?:handleJavaScriptDialog|getNavigationHistory|navigate|reload|navigateToHistoryEntry|close|bringToFront)$|Fetch\.|Target\.|Browser\.)/;
/** Answered by the page's renderer, which the dialog holds. */
const PAGE = /^(?:Input\.|Runtime\.(?:evaluate|callFunctionOn|awaitPromise|getProperties)$|DOM\.(?!enable$|disable$)|Accessibility\.(?:getFullAXTree|getPartialAXTree|queryAXTree)$|Page\.(?:getLayoutMetrics|captureScreenshot)$)/;
const SCREENCAST = /^Page\.(?:startScreencast|stopScreencast|screencastFrameAck)$/;

/** Which kind of command `method` is under an open dialog. */
export function underDialogKind(method) {
  if (BROWSER.test(method)) return "browser";
  if (SCREENCAST.test(method)) return "screencast";
  if (PAGE.test(method)) return method.startsWith("Input.") ? "input" : "page";
  return "other";
}

/**
 * One pane's gate. `run(method, params, send)` answers a command: `send()` sends it to the page. `opened()` and
 * `closed()` follow CDP's dialog events. A screencast started or stopped under the dialog is answered at once and
 * applied once it closes, through `apply(method, params)`.
 */
export function createDialogGate({ apply, graceMs = DIALOG_GRACE_MS, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let open = false;
  /** The screencast state wanted while the dialog was open: start parameters, null to stop, undefined for none. */
  let cast;
  const pending = new Set();
  return {
    get open() {
      return open;
    },
    opened() {
      open = true;
      for (const item of pending) item.underDialog();
    },
    closed() {
      open = false;
      for (const item of pending) clearTimer(item.timer);
      if (cast === undefined) return;
      const wanted = cast;
      cast = undefined;
      void Promise.resolve(wanted ? apply("Page.startScreencast", wanted) : apply("Page.stopScreencast", {})).catch(() => undefined);
    },
    run(method, params, send) {
      const kind = underDialogKind(method);
      if (open) {
        if (kind === "screencast") {
          if (method !== "Page.screencastFrameAck") cast = method === "Page.startScreencast" ? params ?? {} : null;
          return Promise.resolve({});
        }
        if (kind === "page" || kind === "input") return Promise.reject(new Error(DIALOG_HOLDS));
      }
      const sent = send();
      if (kind === "browser") return sent;
      sent.catch(() => undefined);
      return new Promise((resolve, reject) => {
        const item = {
          timer: undefined,
          underDialog() {
            // Input was delivered and the screencast is the browser's own to restart; a read waits on the dialog.
            if (kind === "input" || kind === "screencast") resolve({});
            else if (kind === "page") reject(new Error(DIALOG_HOLDS));
            else item.timer = setTimer(() => reject(new Error(DIALOG_HOLDS)), graceMs);
          },
        };
        pending.add(item);
        if (open) item.underDialog();
        sent.then(resolve, reject).finally(() => {
          pending.delete(item);
          clearTimer(item.timer);
        });
      });
    },
  };
}
