import RFB from "@novnc/novnc";
import { DESKTOP_VIEWER_TARGET } from "../../shared/desktop-viewer";
import { isMacPlatform } from "./keyboard-shortcuts";
import { serverFetch } from "./relay-server";

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
    const joined = await serverFetch(`/api/bots/${target.slice(4)}/computer/join${query}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal,
    });
    if (!joined.ok) throw new DesktopUnreachable();
  }
  const path = `/api/desktop-viewer/${target}`;
  const response = await serverFetch(path, { signal, credentials: "same-origin", cache: "no-store" });
  if (!response.ok) throw new DesktopUnreachable();
  const config = await response.json();
  cancelled.throwIfAborted();
  return openDesktop(screen, socketUrl(`${path}/websockify`), { password: config.password ?? "", signal: cancelled, events });
}

/** A same-origin WebSocket address for `path`. */
export function socketUrl(path: string): string {
  const websocket = new URL(path, location.href);
  websocket.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return websocket.href;
}

/** The app's noVNC client on an RFB WebSocket the server proxies, scaled into `screen`, with the local paste shortcut
 * carried over. A bot's computer and a bot's browser window on a Cloud both show through it. */
export function openDesktop(screen: HTMLElement, socket: string | WebSocket, { password = "", signal: cancelled, events }: {
  password?: string;
  signal: AbortSignal;
  events: DesktopConnectionEvents;
}): RFB {
  const client = new RFB(screen, socket, {
    credentials: { password, username: "", target: "" },
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
  forwardPaste(screen, client, cancelled);
  return client;
}

const XK_CONTROL_L = 0xffe3;
const XK_CONTROL_R = 0xffe4;
const XK_V = 0x76;
// noVNC sends a Mac's ⌘ keys to the desktop as Alt_L (left) and Super_L (right).
const MAC_COMMAND_KEYSYMS: Record<string, number> = { MetaLeft: 0xffe9, MetaRight: 0xffeb };

/** The local paste shortcut (⌘V on a Mac, Ctrl+V elsewhere) puts the local clipboard's text on the desktop's
 * clipboard and presses Ctrl+V there. noVNC would send the shortcut on as raw keys and stop the browser pasting, so
 * the screen takes it first and lets the browser's paste event bring the text, with no clipboard permission prompt. */
function forwardPaste(screen: HTMLElement, client: RFB, signal: AbortSignal): void {
  const mac = isMacPlatform();
  const pasteModifier = mac ? /^Meta(Left|Right)$/ : /^Control(Left|Right)$/;
  // The paste modifier the person is holding down, which noVNC has already sent on.
  let held: string | null = null;
  screen.addEventListener("keydown", (event) => {
    if (pasteModifier.test(event.code)) held = event.code;
    const modifier = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
    if (client.viewOnly || !modifier || event.altKey || event.shiftKey || !isPasteKey(event)) return;
    event.stopPropagation();
  }, { capture: true, signal });
  screen.addEventListener("keyup", (event) => { if (event.code === held) held = null; }, { capture: true, signal });
  screen.addEventListener("focusout", () => { held = null; }, { signal });
  screen.addEventListener("paste", (event) => {
    event.preventDefault();
    pasteOnDesktop(client, event.clipboardData?.getData("text/plain") ?? "", held);
  }, { signal });
}

/** V, or the physical V key on a layout whose letter there isn't Latin (Russian "м"), as the browser itself pastes on. */
function isPasteKey(event: KeyboardEvent): boolean {
  const key = event.key.toLowerCase();
  return key === "v" || (event.code === "KeyV" && !/^[a-z]$/.test(key));
}

/** `held` is the modifier the person holds that noVNC already sent down: Ctrl stays down for their own release; a Mac's
 * ⌘ is let go once Ctrl is down, so the desktop sees Ctrl+V and not a lone ⌘ tap. */
function pasteOnDesktop(client: RFB, text: string, held: string | null): void {
  if (client.viewOnly) return;
  if (text) client.clipboardPasteFrom(text);
  const ctrl = held?.startsWith("Control") ? held : "ControlLeft";
  client.sendKey(ctrl === "ControlRight" ? XK_CONTROL_R : XK_CONTROL_L, ctrl, true);
  if (held && held in MAC_COMMAND_KEYSYMS) client.sendKey(MAC_COMMAND_KEYSYMS[held]!, held, false);
  client.sendKey(XK_V, "KeyV");
  if (ctrl !== held) client.sendKey(XK_CONTROL_L, ctrl, false);
}

/** Explicit text entry works with phone keyboards without reading the clipboard; non-Latin text uses Unicode keysyms. */
export function typeOnDesktop(client: RFB, text: string): void {
  for (const char of text) {
    const code = char.codePointAt(0)!;
    client.sendKey(code === 10 ? 0xff0d : code === 9 ? 0xff09 : code <= 255 ? code : 0x01000000 | code, null);
  }
}
