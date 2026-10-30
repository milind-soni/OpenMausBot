import RFB from "@novnc/novnc";
import { DESKTOP_VIEWER_TARGET } from "../../shared/desktop-viewer";

export interface DesktopConnectionEvents {
  connected(): void;
  disconnected(): void;
  clipboard?(text: string): void;
}

/** The connection never came up: the link was wrong, the desktop is gone, or it did not answer in time. */
export class DesktopUnreachable extends Error {
  readonly invalid: boolean;
  constructor(invalid = false) {
    super(invalid ? "invalid desktop link" : "desktop unreachable");
    this.invalid = invalid;
  }
}

/** Security: only desktop pixels and input cross the VM boundary. The app's own noVNC client talks RFB through the
 * desktop proxy; the VM never supplies page code. A VPS opens its tunnel first; a Local VM's viewer runs with it. */
export async function connectDesktop(screen: HTMLElement, target: string, options: {
  threadId?: string | null;
  signal: AbortSignal;
  events: DesktopConnectionEvents;
}): Promise<RFB> {
  if (!DESKTOP_VIEWER_TARGET.test(target)) throw new DesktopUnreachable(true);
  const { signal: cancelled, events } = options;
  const signal = AbortSignal.any([cancelled, AbortSignal.timeout(30_000)]);
  if (target.startsWith("vps/")) {
    const query = options.threadId ? `?${new URLSearchParams({ threadId: options.threadId })}` : "";
    const joined = await fetch(`/api/bots/${target.slice(4)}/computer/join${query}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal,
    });
    if (!joined.ok) throw new DesktopUnreachable();
  }
  const path = `/api/desktop-viewer/${target}`;
  const response = await fetch(path, { signal, credentials: "same-origin", cache: "no-store" });
  if (!response.ok) throw new DesktopUnreachable();
  const config = await response.json();
  cancelled.throwIfAborted();
  const websocket = new URL(`${path}/websockify`, location.href);
  websocket.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const client = new RFB(screen, websocket.href, {
    credentials: { password: config.password ?? "", username: "", target: "" },
  });
  client.scaleViewport = true;
  client.background = "var(--color-inset)";
  let ended = false;
  const deadline = setTimeout(() => { client.disconnect(); end(); }, 15_000);
  function end() {
    clearTimeout(deadline);
    if (ended || cancelled.aborted) return;
    ended = true;
    events.disconnected();
  }
  cancelled.addEventListener("abort", () => clearTimeout(deadline), { once: true });
  client.addEventListener("connect", () => {
    clearTimeout(deadline);
    if (!cancelled.aborted) events.connected();
  });
  client.addEventListener("disconnect", end);
  client.addEventListener("clipboard", (event) => {
    if (!cancelled.aborted) events.clipboard?.(event.detail.text);
  });
  return client;
}

/** Explicit text entry works with phone keyboards without reading the clipboard; non-Latin text uses Unicode keysyms. */
export function typeOnDesktop(client: RFB, text: string): void {
  for (const char of text) {
    const code = char.codePointAt(0)!;
    client.sendKey(code === 10 ? 0xff0d : code === 9 ? 0xff09 : code <= 255 ? code : 0x01000000 | code, null);
  }
}
