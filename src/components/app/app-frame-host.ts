import type { AppDocument } from "../../../shared/app";
import { APP_FRAME_LIMITS, createAppBridge, type AppBridgeAdapter, type AppHostContext } from "../../../shared/app-frame/bridge";

/** Exactly these two tokens: never allow-same-origin, allow-popups or allow-top-navigation, and no `allow`
 * attribute. */
export const APP_FRAME_SANDBOX = "allow-scripts allow-forms";

/** Focus that entered the frame within this long after a Tab press came
 * from the keyboard. */
const TAB_ENTRY_MS = 1_000;
/** How close to the frame the host last saw the pointer, for a frame in a
 * process of its own (px). */
const NEAR_PX = 40;

export interface AppEngagement {
  /** The person is interacting with this frame now: focus entered it while
   * the pointer was over it (or by Tab), has not left it, and the window
   * has focus. */
  engaged(): boolean;
  dispose(): void;
}

/** Focus moving into a frame is seen from outside as the window's `blur` (or the iframe element's own
 * `focus`) with the iframe as the active element; the pointer must be over it then, so a frame cannot focus
 * itself into being engaged. A frame Chromium puts in a process of its own (Chrome isolates sandboxed
 * frames) gives the page no pointer events once the pointer is inside it, so the page keeps where it last
 * saw the pointer: on its way in, that is at the frame's edge. */
export function trackAppEngagement(iframe: HTMLIFrameElement): AppEngagement {
  const doc = iframe.ownerDocument;
  const win = doc.defaultView;
  let over = false;
  /** Where this page last saw the pointer, in viewport coordinates; null
   * once it left the window. */
  let last: { x: number; y: number } | null = null;
  let tabAt = -Infinity;
  let entered = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const now = () => Date.now();
  const check = () => {
    timer = undefined;
    if (doc.activeElement !== iframe) return;
    if (entered) return;
    entered = over || near() || now() - tabAt <= TAB_ENTRY_MS;
  };
  const near = () => {
    if (!last) return false;
    const box = iframe.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return false;
    return last.x >= box.left - NEAR_PX && last.x <= box.right + NEAR_PX && last.y >= box.top - NEAR_PX && last.y <= box.bottom + NEAR_PX;
  };
  // The active element settles after the event: look on the next turn.
  const soon = () => {
    if (timer === undefined) timer = setTimeout(check, 0);
  };
  const onEnter = () => { over = true; };
  const onLeave = () => { over = false; };
  const onKey = (event: KeyboardEvent) => { if (event.key === "Tab") tabAt = now(); };
  const onMove = (event: PointerEvent) => { last = { x: event.clientX, y: event.clientY }; };
  const onGone = () => { last = null; };
  const onLeft = () => { entered = false; };
  iframe.addEventListener("pointerenter", onEnter);
  iframe.addEventListener("pointerleave", onLeave);
  iframe.addEventListener("focus", soon);
  iframe.addEventListener("blur", onLeft);
  doc.addEventListener("keydown", onKey, true);
  doc.addEventListener("pointermove", onMove, { capture: true, passive: true });
  doc.documentElement.addEventListener("mouseleave", onGone);
  win?.addEventListener("blur", soon);
  win?.addEventListener("focus", onLeft);
  return {
    engaged: () => {
      if (doc.activeElement !== iframe) entered = false;
      return entered && doc.activeElement === iframe && doc.hasFocus();
    },
    dispose() {
      if (timer !== undefined) clearTimeout(timer);
      iframe.removeEventListener("pointerenter", onEnter);
      iframe.removeEventListener("pointerleave", onLeave);
      iframe.removeEventListener("focus", soon);
      iframe.removeEventListener("blur", onLeft);
      doc.removeEventListener("keydown", onKey, true);
      doc.removeEventListener("pointermove", onMove, { capture: true });
      doc.documentElement.removeEventListener("mouseleave", onGone);
      win?.removeEventListener("blur", soon);
      win?.removeEventListener("focus", onLeft);
    },
  };
}

export type AppFrameAdapter = Omit<AppBridgeAdapter, "post" | "engaged" | "now">;

export interface AppFrameHostOptions {
  container: HTMLElement;
  doc: AppDocument;
  title: string;
  height: number;
  hostContext: AppHostContext;
  hostVersion: string;
  adapter: AppFrameAdapter;
  log?(params: unknown): void;
}

export interface AppFrameHost {
  readonly iframe: HTMLIFrameElement;
  engaged(): boolean;
  contextChanged(partial: AppHostContext): void;
  /** ui/resource-teardown (at most a second), then the frame is removed. */
  teardown(): Promise<void>;
  /** The frame moves, running, to a hidden place to be torn down; a browser that cannot move a frame without
   * reloading it removes it at once. */
  retire(): void;
  /** Remove now, without asking the View. */
  destroy(): void;
}

const PARKED_ID = "omb-app-frames-leaving";

function parkingPlace(doc: Document): HTMLElement {
  const existing = doc.getElementById(PARKED_ID);
  if (existing) return existing;
  const place = doc.createElement("div");
  place.id = PARKED_ID;
  place.setAttribute("aria-hidden", "true");
  place.setAttribute("inert", "");
  Object.assign(place.style, { position: "fixed", left: "-100000px", top: "0", width: "0", height: "0", overflow: "hidden", pointerEvents: "none" });
  doc.body.appendChild(place);
  return place;
}

type MovableParent = HTMLElement & { moveBefore?: (node: Node, child: Node | null) => void };

/** The caller sets its srcdoc, verbatim, only once the bridge listens. */
export function createAppIframe(doc: Document, title: string, height: number, theme?: "light" | "dark"): HTMLIFrameElement {
  const iframe = doc.createElement("iframe");
  iframe.setAttribute("sandbox", APP_FRAME_SANDBOX);
  iframe.setAttribute("referrerpolicy", "no-referrer");
  iframe.setAttribute("title", title);
  iframe.setAttribute("data-app-frame", "");
  const style = iframe.style;
  style.display = "block";
  style.width = "100%";
  style.height = `${Math.max(APP_FRAME_LIMITS.minHeight, Math.round(height))}px`;
  style.border = "0";
  style.background = "transparent";
  // The frame's page takes the theme on initialize; matching it here keeps
  // the frame see-through instead of painting the other scheme's canvas.
  if (theme) style.colorScheme = theme;
  return iframe;
}

export function mountAppFrame(options: AppFrameHostOptions): AppFrameHost {
  const { container, doc } = options;
  const ownerDocument = container.ownerDocument;
  const win = ownerDocument.defaultView;
  const iframe = createAppIframe(ownerDocument, options.title, options.height, options.hostContext.theme);
  const engagement = trackAppEngagement(iframe);
  let gone = false;
  let leaving = false;
  const bridge = createAppBridge({
    doc,
    hostContext: options.hostContext,
    hostVersion: options.hostVersion,
    source: () => iframe.contentWindow,
    ...(options.log ? { log: options.log } : {}),
    adapter: {
      ...options.adapter,
      // An opaque origin cannot be named: "*" is the only target there is.
      post: (message) => iframe.contentWindow?.postMessage(message, "*"),
      resize: (height) => {
        iframe.style.height = `${height}px`;
        if (!leaving) options.adapter.resize(height);
      },
      engaged: () => !leaving && engagement.engaged(),
      now: () => Date.now(),
    },
  });
  const onMessage = (event: MessageEvent) => bridge.handleMessage({ source: event.source, data: event.data });
  win?.addEventListener("message", onMessage);
  // The router listens before the frame can speak: it loads on insertion.
  iframe.srcdoc = doc.srcdoc;
  container.appendChild(iframe);

  const destroy = () => {
    if (gone) return;
    gone = true;
    win?.removeEventListener("message", onMessage);
    bridge.dispose();
    engagement.dispose();
    iframe.remove();
  };
  return {
    iframe,
    engaged: () => engagement.engaged(),
    contextChanged: (partial) => {
      if (gone) return;
      // The frame's scheme follows the theme, as at creation: a View that
      // adopts the new theme in a frame still marked with the old one gets an
      // opaque canvas from Chromium instead of the card showing through.
      if (partial.theme) iframe.style.colorScheme = partial.theme;
      bridge.contextChanged(partial);
    },
    async teardown() {
      if (gone) return;
      await bridge.teardown();
      destroy();
    },
    retire() {
      if (gone || leaving) return;
      leaving = true;
      // A row leaving the page takes its element with it, and removing a
      // frame unloads it before the View could answer. Element.moveBefore
      // moves it with its page still running (Chromium 133 on); elsewhere,
      // or before the View is initialized, it goes now.
      const movable = typeof (ownerDocument.body as MovableParent | null)?.moveBefore === "function";
      const place = movable && bridge.initialized && iframe.isConnected ? parkingPlace(ownerDocument) as MovableParent : null;
      if (!place?.moveBefore) {
        void bridge.teardown();
        destroy();
        return;
      }
      try {
        // keep its size, so the View does not reflow while it closes
        iframe.style.width = `${Math.round(iframe.getBoundingClientRect().width) || 0}px`;
        place.moveBefore(iframe, null);
      } catch {
        void bridge.teardown();
        destroy();
        return;
      }
      void bridge.teardown().finally(destroy);
    },
    destroy,
  };
}
