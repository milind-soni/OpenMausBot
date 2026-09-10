import { useEffect, useLayoutEffect, useMemo, useRef } from "react";

export interface BrowserFrame {
  seq: number; data: string; format?: "jpeg" | "png";
  metadata?: { deviceWidth: number; deviceHeight: number };
}
export type BrowserInput = (body: Record<string, unknown>) => void;
const modifiers = (e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) =>
  Number(e.altKey) + Number(e.ctrlKey) * 2 + Number(e.metaKey) * 4 + Number(e.shiftKey) * 8;

/** Map only the contained image, not its letterboxing, into the frame's CSS
 * coordinate space. Status events can describe a newer viewport than these pixels. */
export function browserViewportPoint(rect: { left: number; top: number; width: number; height: number },
  imageWidth: number, imageHeight: number, width: number, height: number,
  clientX: number, clientY: number, captured = false) {
  if (![rect.width, rect.height, imageWidth, imageHeight, width, height].every((n) => Number.isFinite(n) && n > 0)) return null;
  if (![clientX, clientY].every(Number.isFinite)) return null;
  const scale = Math.min(rect.width / imageWidth, rect.height / imageHeight);
  const visibleWidth = imageWidth * scale, visibleHeight = imageHeight * scale;
  const x = clientX - rect.left - (rect.width - visibleWidth) / 2;
  const y = clientY - rect.top - (rect.height - visibleHeight) / 2;
  if (!captured && (x < 0 || y < 0 || x >= visibleWidth || y >= visibleHeight)) return null;
  return { x: Math.max(0, Math.min(width - 1, x * width / visibleWidth)), y: Math.max(0, Math.min(height - 1, y * height / visibleHeight)) };
}

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
  const frameWidth = frame.metadata?.deviceWidth ?? width;
  const frameHeight = frame.metadata?.deviceHeight ?? height;
  const src = `data:image/${frame.format === "png" ? "png" : "jpeg"};base64,${frame.data}`;
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
    if (screen.current?.complete && screen.current.naturalWidth > 0 && screen.current.currentSrc === src) {
      acknowledge(frame.seq);
    }
  };
  // The engine can emit a new sequence with identical pixels. React then
  // keeps the same src, so there is no load event to ACK that next frame.
  useEffect(() => { const tick = requestAnimationFrame(rendered); return () => cancelAnimationFrame(tick); }, [frame]);
  const point = (clientX: number, clientY: number, captured = false) => {
    const image = screen.current;
    // While a new src is decoding the old picture can still be painted. Do
    // not aim input using new metadata until that exact image is available.
    if (!image?.complete || image.currentSrc !== src) return null;
    return browserViewportPoint(image.getBoundingClientRect(), image.naturalWidth, image.naturalHeight,
      frameWidth, frameHeight, clientX, clientY, captured);
  };
  useEffect(() => {
    const image = screen.current;
    if (!image || !driving) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const at = point(e.clientX, e.clientY);
      if (!at) return;
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? frameHeight : 1;
      const delta = (value: number) => Math.max(-10_000, Math.min(10_000, value * unit));
      input({ type: "input_mouse", eventType: "mouseWheel", ...at, deltaX: delta(e.deltaX), deltaY: delta(e.deltaY), modifiers: modifiers(e) });
    };
    image.addEventListener("wheel", wheel, { passive: false });
    return () => image.removeEventListener("wheel", wheel);
  }, [driving, input, frameWidth, frameHeight, src]);
  return <>
    <img ref={screen} src={src} alt="Live bot browser" draggable={false} tabIndex={driving ? 0 : -1}
      title={driving ? "Shift+Escape returns to the browser address bar." : undefined}
      aria-description={driving ? "Keyboard input goes to the remote page. Press Shift+Escape to return to the browser address bar." : undefined}
      aria-keyshortcuts={driving ? "Shift+Escape" : undefined}
      className={`block h-full w-full object-contain select-none outline-none focus:ring-2 focus:ring-inset focus:ring-accent ${driving ? "cursor-default touch-none" : "cursor-not-allowed"}`}
      onLoad={rendered} onError={onDecodeError}
      onBlur={pressed.release}
      onContextMenu={(e) => { if (driving) e.preventDefault(); }}
      onPointerDown={(e) => {
        if (!driving) return;
        const at = point(e.clientX, e.clientY);
        if (!at) return;
        e.preventDefault(); e.currentTarget.focus(); e.currentTarget.setPointerCapture(e.pointerId);
        input({ type: "input_mouse", eventType: "mousePressed", ...at, button: e.button === 2 ? "right" : e.button === 1 ? "middle" : "left", clickCount: Math.min(3, e.detail || 1), modifiers: modifiers(e) });
      }}
      onPointerUp={(e) => {
        if (!driving) return;
        e.preventDefault();
        const at = point(e.clientX, e.clientY, e.currentTarget.hasPointerCapture(e.pointerId));
        if (!at) { pressed.release(); return; }
        input({ type: "input_mouse", eventType: "mouseReleased", ...at, button: e.button === 2 ? "right" : e.button === 1 ? "middle" : "left", clickCount: Math.min(3, e.detail || 1), modifiers: modifiers(e) });
      }}
      onPointerCancel={pressed.release}
      onPointerMove={(e) => {
        if (!driving) return;
        const at = point(e.clientX, e.clientY, e.currentTarget.hasPointerCapture(e.pointerId));
        if (at) input({ type: "input_mouse", eventType: "mouseMoved", ...at, button: e.buttons & 1 ? "left" : e.buttons & 2 ? "right" : e.buttons & 4 ? "middle" : "none", modifiers: modifiers(e) });
      }}
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
