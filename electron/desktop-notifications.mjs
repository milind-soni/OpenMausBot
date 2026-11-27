// A bot's notification on the desktop app, shown by main. A page's own `new Notification` dies with the page: Electron 43
// hands its click to the page that made it, so a banner clicked after a reload, an update or a move to another place does
// nothing, and `window.focus()` from a page never raises a window (shell/browser/api/electron_api_browser_window.cc,
// OnActivateContents). Main knows which page asked, so the click comes back to that place whatever is on screen by then.

const ID = /^[\w-]{1,128}$/;
const TEXT_LIMIT = 1024;
/** A click waits this long for its place to open (a Cloud may have to wake), and no longer: opening that place hours later
 * must not jump to an old banner's thread. */
const PLACE_WAIT_MS = 2 * 60_000;
const ICON_WAIT_MS = 1_500;

const text = (value) => (typeof value === "string" ? value.slice(0, TEXT_LIMIT) : "");
const originOf = (url) => { try { return new URL(url).origin; } catch { return null; } };

/**
 * @param {{ ipcMain: { handle(channel: string, handler: (event: any, note: any) => unknown): void },
 *   Notification: { new(options: object): any, isSupported(): boolean },
 *   nativeImage: { createFromBuffer(buffer: Buffer): { isEmpty(): boolean } },
 *   fetch: (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean, arrayBuffer(): Promise<ArrayBuffer> }>,
 *   window: () => any,
 *   mayNotify: (contents: unknown, url: string) => boolean,
 *   reveal: () => void,
 *   openPlace: (origin: string) => unknown,
 *   now?: () => number }} deps
 * `window`: the main window, if any. `mayNotify`: the same rule that lets its page use `new Notification`. `reveal`: raises
 * the window. `openPlace`: main's own switch to the place at an origin.
 */
export function installDesktopNotifications({ ipcMain, Notification, nativeImage, fetch, window, mayNotify, reveal, openPlace, now = Date.now }) {
  // Electron drops a notification's handlers once nothing holds it, so each is held until it is replaced or dismissed.
  const live = new Map();
  let waiting = null;

  const page = () => { const win = window(); return win && !win.isDestroyed() ? win.webContents : null; };
  /** The origin of the page on screen, null while one is loading. */
  const shownOrigin = () => { const contents = page(); return contents && !contents.isLoadingMainFrame() ? originOf(contents.getURL()) : null; };
  /** The window's own page may ask, in its main frame: never the rail, a viewer or a frame inside a page. */
  const askingOrigin = (event) => {
    const contents = page(), frame = event.senderFrame;
    return contents && event.sender === contents && frame === contents.mainFrame && mayNotify(contents, frame.url) ? originOf(frame.url) : null;
  };
  const open = (target) => page()?.send("desktop-notifications:open", target);

  const bring = (origin, target) => {
    reveal();
    const shown = shownOrigin();
    if (shown === origin) { waiting = null; open(target); return; }
    waiting = { origin, target, at: now(), asked: shown !== null };
    if (waiting.asked) void openPlace(origin);
  };

  const pictureOf = async (origin, raw) => {
    if (typeof raw !== "string" || !raw) return null;
    try {
      const url = new URL(raw, origin);
      if (url.origin !== origin) return null;
      const answer = await fetch(url.href, { signal: AbortSignal.timeout(ICON_WAIT_MS) });
      if (!answer.ok) return null;
      const image = nativeImage.createFromBuffer(Buffer.from(await answer.arrayBuffer()));
      return image.isEmpty() ? null : image;
    } catch { return null; }
  };

  ipcMain.handle("desktop-notifications:show", async (event, note) => {
    const origin = askingOrigin(event);
    if (!origin || !Notification.isSupported() || !note || typeof note !== "object") return false;
    const { title, body, tag, silent, picture, botId, threadId } = note;
    if (!text(title) || !ID.test(String(botId)) || !ID.test(String(threadId))) return false;
    const key = `${origin}\n${text(tag) || threadId}`;
    const image = await pictureOf(origin, picture);
    const shown = new Notification({ title: text(title), body: text(body), silent: silent === true, ...(image ? { icon: image } : {}) });
    const replaced = live.get(key);
    live.set(key, shown);
    replaced?.close();
    shown.on("close", () => { if (live.get(key) === shown) live.delete(key); });
    shown.on("click", () => { if (live.get(key) === shown) live.delete(key); bring(origin, { botId, threadId }); });
    shown.show();
    return true;
  });

  return {
    /** The window finished loading a page: a click that was waiting for this place lands now. */
    arrived() {
      if (!waiting) return;
      if (now() - waiting.at > PLACE_WAIT_MS) { waiting = null; return; }
      if (shownOrigin() !== waiting.origin) {
        if (!waiting.asked) { waiting.asked = true; void openPlace(waiting.origin); }
        return;
      }
      const { target } = waiting;
      waiting = null;
      open(target);
    },
  };
}
