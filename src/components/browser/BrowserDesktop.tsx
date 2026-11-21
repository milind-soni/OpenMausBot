import { useEffect, useRef, useState, type ReactNode } from "react";
import type RFB from "@novnc/novnc";
import { openDesktop, socketUrl, typeOnDesktop } from "@/lib/desktop-connection";
import { t } from "@/lib/i18n";
import { withBrowserScope } from "@/lib/team-browser";

/** The server's close codes for this view (server/browser/desktop/views.ts): the browser runs without a display, or
 * another person holds it. */
export const DESKTOP_VIEW_CLOSE = { pictures: 4415, heldElsewhere: 4409 } as const;
const RETRY_MS = 2_000;
/** Kept in the hidden text field: a phone keyboard's delete sends no key event, only removes a character the field sees go. */
const SENTINEL = "​";
const XK_BACKSPACE = 0xff08;
const XK_RETURN = 0xff0d;

/**
 * A bot's browser window on its Cloud's private display, drawn over the picture view in the same rectangle. The v2
 * stream beside it keeps the hold, tabs and prompts; this view only shows the window and, while the person holds the
 * browser, carries their pointer and keys and sizes the display to the view. The server drops their input otherwise,
 * so view-only here is a courtesy. A tap from a touch screen opens the device's keyboard on a hidden field whose text
 * goes on as keys, as the computer viewer's does. `children` sit over the picture, as the handoff pill does.
 */
export function BrowserDesktop({ botId, scope, controlling, label, onUnavailable, children }: {
  botId: string;
  scope: Readonly<Record<string, string>>;
  controlling: boolean;
  label: string;
  /** This browser has no desktop view: the picture view stays. */
  onUnavailable: () => void;
  children?: ReactNode;
}) {
  const screen = useRef<HTMLDivElement>(null);
  const keyboard = useRef<HTMLTextAreaElement>(null);
  const rfb = useRef<RFB | null>(null);
  const composing = useRef(false);
  const [attempt, setAttempt] = useState(0);
  const controllingNow = useRef(controlling);
  controllingNow.current = controlling;
  const unavailable = useRef(onUnavailable);
  unavailable.current = onUnavailable;
  const scopeKey = new URLSearchParams(scope).toString();

  useEffect(() => {
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    const socket = new WebSocket(socketUrl(withBrowserScope(`/api/bots/${encodeURIComponent(botId)}/browser/desktop`, Object.fromEntries(new URLSearchParams(scopeKey)))));
    socket.binaryType = "arraybuffer";
    socket.addEventListener("close", (event) => {
      if (controller.signal.aborted) return;
      if (event.code === DESKTOP_VIEW_CLOSE.pictures) unavailable.current();
      else retry = setTimeout(() => setAttempt((value) => value + 1), RETRY_MS);
    });
    const client = openDesktop(screen.current!, socket, { signal: controller.signal, events: { connected: () => {}, disconnected: () => {} } });
    client.viewOnly = !controllingNow.current;
    client.resizeSession = controllingNow.current;
    rfb.current = client;
    return () => {
      controller.abort();
      clearTimeout(retry);
      client.disconnect();
      if (rfb.current === client) rfb.current = null;
    };
  }, [botId, scopeKey, attempt]);

  useEffect(() => {
    const client = rfb.current;
    if (!client) return;
    client.viewOnly = !controlling;
    client.resizeSession = controlling;
    if (controlling) client.focus({ preventScroll: true });
  }, [controlling, attempt]);

  const reset = (field: HTMLTextAreaElement) => {
    field.value = SENTINEL;
    field.setSelectionRange(SENTINEL.length, SENTINEL.length);
  };
  const typed = (field: HTMLTextAreaElement) => {
    const client = rfb.current;
    const value = field.value;
    reset(field);
    if (!client || !controllingNow.current) return;
    if (!value.startsWith(SENTINEL)) {
      client.sendKey(XK_BACKSPACE, "Backspace");
      return;
    }
    const text = value.slice(SENTINEL.length);
    if (!text) return;
    const lines = text.split("\n");
    lines.forEach((line, index) => {
      if (index > 0) client.sendKey(XK_RETURN, "Enter");
      if (line) typeOnDesktop(client, line);
    });
  };

  return (
    <div className="absolute inset-0 overflow-hidden" data-browser-desktop-view>
      <div
        ref={screen}
        data-browser-desktop
        aria-label={label}
        className="absolute inset-0"
        onPointerDown={(event) => {
          if (event.pointerType !== "touch" || !controllingNow.current) return;
          // noVNC focuses its canvas on the tap that follows, which would close the keyboard just opened.
          if (rfb.current) rfb.current.focusOnClick = false;
          keyboard.current?.focus({ preventScroll: true });
        }}
      />
      <textarea
        ref={keyboard}
        aria-label={t("browser.panel.typeTextField")}
        defaultValue={SENTINEL}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
        className="sr-only"
        onFocus={(event) => reset(event.currentTarget)}
        onBlur={() => { if (rfb.current) rfb.current.focusOnClick = true; }}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={(event) => { composing.current = false; typed(event.currentTarget); }}
        onInput={(event) => { if (!composing.current) typed(event.currentTarget); }}
      />
      {children}
    </div>
  );
}
