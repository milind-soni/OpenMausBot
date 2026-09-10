import { useEffect, useLayoutEffect, useMemo, useRef } from "react";

export interface BrowserFrame { seq: number; data: string; format?: "jpeg" | "png" }
export type BrowserInput = (body: Record<string, unknown>) => void;
const modifiers = (e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) =>
  Number(e.altKey) + Number(e.ctrlKey) * 2 + Number(e.metaKey) * 4 + Number(e.shiftKey) * 8;

/** Focus can move to the toolbar before the matching key/pointer-up arrives.
 * Flush releases only; never replay typed text or a click on hand-back. */
export function createBrowserPressedInputs(input: BrowserInput) {
  const held = new Map<string, Record<string, unknown>>();
  return {
    send(body: Record<string, unknown>) {
      const keyboard = body.type === "input_keyboard";
      const key = keyboard ? `key:${body.code || body.key}` : `mouse:${body.button}`;
      if (body.eventType === "keyDown" || body.eventType === "mousePressed") held.set(key, { ...body });
      if (body.eventType === "keyUp" || body.eventType === "mouseReleased") held.delete(key);
      if (body.eventType === "mouseMoved") for (const value of held.values()) {
        if (value.type === "input_mouse") { value.x = body.x; value.y = body.y; }
      }
      input(body);
    },
    release() {
      const pending = [...held.values()].reverse();
      held.clear();
      for (const { text: _text, ...body } of pending) input({ ...body,
        eventType: body.type === "input_keyboard" ? "keyUp" : "mouseReleased", modifiers: 0,
      });
    },
  };
}

export function BrowserViewport({ frame, width, height, driving, input: sendInput, acknowledge, onDecodeError, onReturnToToolbar }: {
  frame: BrowserFrame; width: number; height: number; driving: boolean;
  input: BrowserInput; acknowledge: (seq: number) => void; onDecodeError: () => void; onReturnToToolbar: () => void;
}) {
  const screen = useRef<HTMLImageElement>(null);
  const pressed = useMemo(() => createBrowserPressedInputs(sendInput), [sendInput]);
  const input = pressed.send;
  useLayoutEffect(() => {
    if (!driving) pressed.release();
    return pressed.release;
  }, [driving, pressed]);
  useEffect(() => {
    window.addEventListener("blur", pressed.release);
    return () => window.removeEventListener("blur", pressed.release);
  }, [pressed]);
  const rendered = () => {
    if (screen.current?.complete && screen.current.naturalWidth > 0) {
      acknowledge(frame.seq);
    }
  };
  // The engine can emit a new sequence with identical pixels. React then
  // keeps the same src, so there is no load event to ACK that next frame.
  useEffect(() => { const tick = requestAnimationFrame(rendered); return () => cancelAnimationFrame(tick); }, [frame]);
  const point = (clientX: number, clientY: number) => {
    const rect = screen.current?.getBoundingClientRect();
    if (!rect?.width || !rect.height) return { x: 0, y: 0 };
    return {
      x: Math.max(0, Math.min(width - 1, (clientX - rect.left) * width / rect.width)),
      y: Math.max(0, Math.min(height - 1, (clientY - rect.top) * height / rect.height)),
    };
  };
  useEffect(() => {
    const image = screen.current;
    if (!image || !driving) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      input({ type: "input_mouse", eventType: "mouseWheel", ...point(e.clientX, e.clientY), deltaX: e.deltaX, deltaY: e.deltaY, modifiers: modifiers(e) });
    };
    image.addEventListener("wheel", wheel, { passive: false });
    return () => image.removeEventListener("wheel", wheel);
  }, [driving, input, width, height]);
  return <>
    <img ref={screen} src={`data:image/${frame.format === "png" ? "png" : "jpeg"};base64,${frame.data}`} alt="Live bot browser" draggable={false} tabIndex={driving ? 0 : -1}
      title={driving ? "Shift+Escape returns to the browser address bar." : undefined}
      aria-description={driving ? "Keyboard input goes to the remote page. Press Shift+Escape to return to the browser address bar." : undefined}
      aria-keyshortcuts={driving ? "Shift+Escape" : undefined}
      className={`block h-auto w-full select-none outline-none focus:ring-2 focus:ring-inset focus:ring-accent ${driving ? "cursor-default touch-none" : "cursor-not-allowed"}`}
      onLoad={rendered} onError={onDecodeError}
      onBlur={pressed.release}
      onContextMenu={(e) => { if (driving) e.preventDefault(); }}
      onPointerDown={(e) => {
        if (!driving) return;
        e.preventDefault(); e.currentTarget.focus(); e.currentTarget.setPointerCapture(e.pointerId);
        input({ type: "input_mouse", eventType: "mousePressed", ...point(e.clientX, e.clientY), button: e.button === 2 ? "right" : e.button === 1 ? "middle" : "left", clickCount: e.detail || 1, modifiers: modifiers(e) });
      }}
      onPointerUp={(e) => {
        if (!driving) return;
        e.preventDefault();
        input({ type: "input_mouse", eventType: "mouseReleased", ...point(e.clientX, e.clientY), button: e.button === 2 ? "right" : e.button === 1 ? "middle" : "left", clickCount: e.detail || 1, modifiers: modifiers(e) });
      }}
      onPointerCancel={pressed.release}
      onPointerMove={(e) => { if (driving) input({ type: "input_mouse", eventType: "mouseMoved", ...point(e.clientX, e.clientY), button: e.buttons & 1 ? "left" : e.buttons & 2 ? "right" : e.buttons & 4 ? "middle" : "none", modifiers: modifiers(e) }); }}
      onKeyDown={(e) => {
        if (!driving || e.nativeEvent.isComposing) return;
        if (e.key === "Escape" && e.shiftKey) {
          e.preventDefault(); e.stopPropagation(); pressed.release(); onReturnToToolbar(); return;
        }
        // Native paste supplies actual clipboard text via onPaste below.
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "v") return;
        e.preventDefault();
        input({ type: "input_keyboard", eventType: "keyDown", key: e.key, code: e.code, windowsVirtualKeyCode: e.keyCode, modifiers: modifiers(e), ...(e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey ? { text: e.key } : {}) });
      }}
      onKeyUp={(e) => {
        if (!driving || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "v")) return;
        if (e.key === "Escape" && e.shiftKey) { e.preventDefault(); e.stopPropagation(); return; }
        e.preventDefault(); input({ type: "input_keyboard", eventType: "keyUp", key: e.key, code: e.code, windowsVirtualKeyCode: e.keyCode, modifiers: modifiers(e) });
      }}
      onPaste={(e) => { if (driving) { e.preventDefault(); input({ type: "input_keyboard", eventType: "char", text: e.clipboardData.getData("text/plain").slice(0, 4096) }); } }}
    />
  </>;
}
