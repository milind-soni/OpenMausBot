// Adapted from pingdotgg/t3code@00cdceb1 apps/web/src/browser/ServerBrowserSurface.tsx, MIT License, Copyright (c)
// 2026 T3 Tools Inc. (full text in third_party/t3-code/LICENSE); modified: OpenMausBot's UI, the panel picks the
// transport (the v2 stream, or the v1 view as a fallback), page input goes through the panel's control rules so the
// first press takes the browser, Shift+Escape returns to the address bar, a larger frame cap is sent in place rather
// than by reconnecting, so the person keeps the browser they hold, and the page's dropdown lists, cursor shape and HTTP
// sign-in are drawn here.
import { Download, FileUp, Loader2, X } from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent,
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

import {
  createPreviewFramePainter,
  previewStreamHostSetupMessage,
  previewStreamModifiers,
  uploadPreviewStreamFiles,
  type PreviewStreamClient,
  type PreviewStreamControl,
  type PreviewStreamDownload,
  type PreviewStreamEvents,
  type PreviewStreamFileChooser,
  type PreviewStreamHostSetup,
  type PreviewStreamInput,
  type PreviewStreamMouseButton,
  type PreviewStreamPointer,
  type PreviewStreamViewport,
} from "@/lib/browser-stream-client";
import { copyText } from "@/lib/copy-text";
import { AgentCursor } from "./AgentCursor";
import { AuthPrompt } from "./AuthPrompt";
import { SelectPopup, type SelectPopupOption } from "./SelectPopup";

export interface StreamSurfaceHandle {
  /** The canvas once it shows a frame, to seed picture in picture. */
  readonly canvas: () => HTMLCanvasElement | null;
  readonly focusPage: () => void;
}

/** Opens the transport for this surface: its frame cap in device px and its size in CSS px. */
export type SurfaceConnect = (
  target: { maxWidth: number; maxHeight: number; width: number; height: number },
  events: PreviewStreamEvents,
) => PreviewStreamClient;

const RESIZE_THROTTLE_MS = 150;
// A recent probe answer near a new tap stands in for that tap's own answer, which on a slow link arrives after the tap ends.
const PROBE_REUSE_PX = 24;
const PROBE_REUSE_MS = 10_000;
// Kept in the input so soft keyboards have something to delete: Android reports Backspace only as a deletion of
// text, not as a key.
const INPUT_SENTINEL = "​";
const BACKSPACE = { key: "Backspace", code: "Backspace", keyCode: 8 } as const;
const DELETE = { key: "Delete", code: "Delete", keyCode: 46 } as const;
const TAP_SLOP_PX = 8;
const MULTI_CLICK_MS = 500;
const MULTI_CLICK_SLOP_PX = 4;
const WHEEL_LINE_PX = 16;
const NOTICE_LIMIT = 3;

type MouseInput = Extract<PreviewStreamInput, { type: "mouse" }>;
type WheelInput = Extract<PreviewStreamInput, { type: "wheel" }>;

interface PagePoint {
  readonly x: number;
  readonly y: number;
  /** Page CSS px per client px. */
  readonly scale: number;
}

interface TouchGesture {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  lastX: number;
  lastY: number;
  panning: boolean;
}

/** Whether the page point under a touch takes text; null until the server answers. */
interface TouchProbe {
  readonly x: number;
  readonly y: number;
  editable: boolean | null;
  /** True only for this tap's own reply, never for a cached answer. */
  answered: boolean;
  /** The tap ended before the answer arrived. */
  tapped: boolean;
}

interface SelectState {
  id: string;
  options: SelectPopupOption[];
  selectedIndex: number;
  rect: { x: number; y: number; width: number; height: number };
}

type NoticeInput =
  | { kind: "download"; download: PreviewStreamDownload }
  | { kind: "clipboard"; text: string }
  | { kind: "error"; message: string };
type Notice = NoticeInput & { id: number };

const buttonOf = (button: number): PreviewStreamMouseButton =>
  button === 0 ? "left" : button === 1 ? "middle" : button === 2 ? "right" : "none";

const pressedButtonOf = (buttons: number): PreviewStreamMouseButton =>
  buttons & 1 ? "left" : buttons & 2 ? "right" : buttons & 4 ? "middle" : "none";

/** A viewer that may act, unless another viewer holds the browser; its first press takes it. */
export const operable = (control: PreviewStreamControl | null): boolean =>
  control !== null && control.canOperate && control.controller !== "another-viewer";

/** How a frame of `canvas` px sits in a box of `box` px: scaled to fit and centred, as `object-contain` draws it. */
export function letterbox(box: { width: number; height: number }, canvas: { width: number; height: number }) {
  const fit = Math.min(box.width / canvas.width, box.height / canvas.height);
  const width = canvas.width * fit;
  const height = canvas.height * fit;
  return { width, height, left: (box.width - width) / 2, top: (box.height - height) / 2 };
}

/** A client point in the box as a page point in CSS px, or null outside the picture (unless clamped). */
export function mapToPage(
  rect: { left: number; top: number; width: number; height: number },
  canvas: { width: number; height: number },
  viewport: PreviewStreamViewport,
  clientX: number,
  clientY: number,
  clamp: boolean,
): PagePoint | null {
  const shown = letterbox(rect, canvas);
  if (!(shown.width > 0 && shown.height > 0)) return null;
  const scale = viewport.width / shown.width;
  const x = (clientX - rect.left - shown.left) * scale;
  const y = (clientY - rect.top - shown.top) * (viewport.height / shown.height);
  const inside = x >= 0 && y >= 0 && x <= viewport.width && y <= viewport.height;
  if (!inside && !clamp) return null;
  return { x: Math.min(Math.max(x, 0), viewport.width), y: Math.min(Math.max(y, 0), viewport.height), scale };
}

/** A page rectangle in CSS px as surface px: the inverse of the viewer's own pointer mapping. */
export function mapToSurface(
  rect: { x: number; y: number; width: number; height: number },
  box: { width: number; height: number },
  canvas: { width: number; height: number },
  viewport: PreviewStreamViewport,
) {
  const shown = letterbox(box, canvas);
  const sx = shown.width / viewport.width;
  const sy = shown.height / viewport.height;
  return { left: shown.left + rect.x * sx, top: shown.top + rect.y * sy, width: rect.width * sx, height: rect.height * sy };
}

/** The download happened on the bot's computer; this hands the finished file to this device. */
function save(download: PreviewStreamDownload) {
  const anchor = document.createElement("a");
  anchor.href = download.url;
  anchor.download = download.fileName;
  anchor.rel = "noopener";
  anchor.click();
}

export function StreamSurface(props: {
  readonly connect: SurfaceConnect;
  /** Page input and toolbar commands, through the panel's control rules. */
  readonly input: (input: PreviewStreamInput) => void;
  readonly label?: string;
  readonly onClient?: (client: PreviewStreamClient | null) => void;
  readonly onControl?: (control: PreviewStreamControl | null) => void;
  readonly onMessage?: (message: Readonly<Record<string, unknown>>) => void;
  readonly onConnectedChange?: (connected: boolean) => void;
  readonly onFirstFrame?: () => void;
  /** The view was refused before it opened (the route is missing, or the session is not allowed). */
  readonly onUnauthorized?: () => void;
  readonly onGone?: () => void;
  readonly onClose?: (code: number, reason: string) => void;
  /** Shift+Escape: the person leaves the page for the app's own controls. */
  readonly onLeave?: () => void;
  readonly className?: string;
  readonly ref?: Ref<StreamSurfaceHandle>;
}) {
  const { connect, ref } = props;
  const propsRef = useRef(props);
  propsRef.current = props;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const keySentRef = useRef(false);
  const clientRef = useRef<PreviewStreamClient | null>(null);
  const viewportRef = useRef<PreviewStreamViewport | null>(null);
  const sizeRef = useRef<{ width: number; height: number } | null>(null);
  const hasFrameRef = useRef(false);
  const controlRef = useRef<PreviewStreamControl | null>(null);
  const [control, setControl] = useState<PreviewStreamControl | null>(null);
  const [connected, setConnected] = useState(false);
  const [painted, setPainted] = useState(false);
  const [promptText, setPromptText] = useState("");
  const [fileChooser, setFileChooser] = useState<PreviewStreamFileChooser | null>(null);
  const [agentCursor, setAgentCursor] = useState<(ReturnType<typeof mapToSurface> & { phase: PreviewStreamPointer["phase"]; sequence: number }) | null>(null);
  const [select, setSelect] = useState<SelectState | null>(null);
  const [cursor, setCursor] = useState("default");
  const [authPrompt, setAuthPrompt] = useState<{ tabId: string; id: string; origin: string; realm: string } | null>(null);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [hostSetup, setHostSetup] = useState<PreviewStreamHostSetup | null>(null);
  const noticeId = useRef(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pendingMoveRef = useRef<MouseInput | null>(null);
  const pendingWheelRef = useRef<WheelInput | null>(null);
  const inputFrameRef = useRef<number | null>(null);
  const mouseButtonsRef = useRef(0);
  const mouseClicksRef = useRef({ left: 1, middle: 1, right: 1, none: 1 });
  const lastClickRef = useRef<{ button: PreviewStreamMouseButton; time: number; x: number; y: number; count: number } | null>(null);
  const touchRef = useRef<TouchGesture | null>(null);
  const probeRef = useRef<TouchProbe | null>(null);
  const lastProbeRef = useRef<{ x: number; y: number; editable: boolean; at: number } | null>(null);
  // Frame cap in device px. It grows with the surface and never shrinks; the stream opens once the first one is known.
  const capRef = useRef<{ width: number; height: number } | null>(null);
  const [capKnown, setCapKnown] = useState(false);

  const notify = useCallback((notice: NoticeInput) => {
    const id = ++noticeId.current;
    setNotices((current) => [...current.slice(-(NOTICE_LIMIT - 1)), { ...notice, id }]);
  }, []);
  const dismiss = (id: number) => setNotices((current) => current.filter((notice) => notice.id !== id));

  const send = useCallback((message: PreviewStreamInput) => {
    propsRef.current.input(message);
  }, []);

  const clearInput = useCallback(() => {
    if (inputFrameRef.current !== null) cancelAnimationFrame(inputFrameRef.current);
    inputFrameRef.current = null;
    pendingMoveRef.current = pendingWheelRef.current = null;
    mouseButtonsRef.current = 0;
    mouseClicksRef.current = { left: 1, middle: 1, right: 1, none: 1 };
    lastClickRef.current = null;
    touchRef.current = probeRef.current = lastProbeRef.current = null;
    keySentRef.current = false;
    if (inputRef.current) inputRef.current.value = INPUT_SENTINEL;
  }, []);

  const flushInput = useCallback(() => {
    if (inputFrameRef.current !== null) cancelAnimationFrame(inputFrameRef.current);
    inputFrameRef.current = null;
    const move = pendingMoveRef.current;
    const wheel = pendingWheelRef.current;
    pendingMoveRef.current = null;
    pendingWheelRef.current = null;
    if (move) send(move);
    if (wheel) send(wheel);
  }, [send]);

  // Coalesce moves and wheel deltas to one message each per animation frame.
  const scheduleFlush = useCallback(() => {
    inputFrameRef.current ??= requestAnimationFrame(flushInput);
  }, [flushInput]);

  const queueWheel = useCallback((point: PagePoint, deltaX: number, deltaY: number, modifiers: number) => {
    const pending = pendingWheelRef.current;
    pendingWheelRef.current = { type: "wheel", x: point.x, y: point.y, deltaX: (pending?.deltaX ?? 0) + deltaX, deltaY: (pending?.deltaY ?? 0) + deltaY, modifiers };
    scheduleFlush();
  }, [scheduleFlush]);

  const pagePoint = useCallback((clientX: number, clientY: number, clamp: boolean): PagePoint | null => {
    const canvas = canvasRef.current;
    const viewport = viewportRef.current;
    if (!canvas || !viewport || !hasFrameRef.current || !operable(controlRef.current)) return null;
    return mapToPage(canvas.getBoundingClientRect(), canvas, viewport, clientX, clientY, clamp);
  }, []);

  const countClick = (button: PreviewStreamMouseButton, x: number, y: number, time: number) => {
    const last = lastClickRef.current;
    const count = last && last.button === button && time - last.time < MULTI_CLICK_MS && Math.hypot(x - last.x, y - last.y) < MULTI_CLICK_SLOP_PX ? last.count + 1 : 1;
    lastClickRef.current = { button, time, x, y, count };
    return count;
  };

  const focusInput = () => inputRef.current?.focus({ preventScroll: true });

  useImperativeHandle(ref, () => ({
    canvas: () => (hasFrameRef.current ? canvasRef.current : null),
    focusPage: focusInput,
  }), []);

  useEffect(() => {
    const element = canvasRef.current?.parentElement;
    if (!element || typeof ResizeObserver === "undefined") return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let capTimer: ReturnType<typeof setTimeout> | null = null;
    const growCap = () => {
      capTimer = null;
      const size = sizeRef.current;
      if (!size) return;
      const ratio = window.devicePixelRatio || 1;
      const width = Math.round(size.width * ratio);
      const height = Math.round(size.height * ratio);
      const current = capRef.current;
      if (current !== null && current.width >= width && current.height >= height) return;
      const next = { width: Math.max(width, current?.width ?? 0), height: Math.max(height, current?.height ?? 0) };
      capRef.current = next;
      if (current === null) setCapKnown(true);
      else clientRef.current?.send({ type: "frameCap", maxWidth: next.width, maxHeight: next.height });
    };
    const measure = () => {
      timer = null;
      const rect = element.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      const size = { width: Math.round(rect.width), height: Math.round(rect.height) };
      const previous = sizeRef.current;
      if (previous?.width === size.width && previous.height === size.height) return;
      sizeRef.current = size;
      clientRef.current?.send({ type: "resize", ...size });
      // Outgrowing the cap restarts the screencast, so grow it once the size settles rather than on every throttled
      // resize of a drag.
      if (capTimer !== null) clearTimeout(capTimer);
      capTimer = setTimeout(growCap, previous === null ? 0 : RESIZE_THROTTLE_MS * 2);
    };
    const observer = new ResizeObserver(() => {
      // A pending measure reads the latest size when it fires, so a drag resizes the page at most every
      // RESIZE_THROTTLE_MS and still ends on the final size.
      if (timer !== null) return;
      timer = setTimeout(measure, sizeRef.current === null ? 0 : RESIZE_THROTTLE_MS);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      if (timer !== null) clearTimeout(timer);
      if (capTimer !== null) clearTimeout(capTimer);
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const size = sizeRef.current;
    const cap = capRef.current;
    if (hostSetup || !capKnown || !cap || !canvas || !size) return;
    hasFrameRef.current = false;
    setPainted(false);
    const painter = createPreviewFramePainter(canvas, () => {
      if (hasFrameRef.current) return;
      hasFrameRef.current = true;
      setPainted(true);
      propsRef.current.onFirstFrame?.();
    });
    const setControlState = (next: PreviewStreamControl | null) => {
      const previous = controlRef.current;
      controlRef.current = next;
      setControl(next);
      propsRef.current.onControl?.(next);
      if (next?.dialog?.message !== previous?.dialog?.message || next?.dialog?.defaultValue !== previous?.dialog?.defaultValue) setPromptText(next?.dialog?.defaultValue ?? "");
      if (next?.controller !== "you") {
        setSelect(null);
      } else if (previous?.controller !== "you" && sizeRef.current) {
        clientRef.current?.send({ type: "resize", ...sizeRef.current });
      }
      if (!operable(next)) {
        clearInput();
        inputRef.current?.blur();
      }
    };
    const client = connect(
      { maxWidth: cap.width, maxHeight: cap.height, width: size.width, height: size.height },
      {
        onFrame: (jpeg) => painter.paint(jpeg),
        onProbe: (result) => {
          if (controlRef.current?.controller !== "you") return;
          lastProbeRef.current = { ...result, at: performance.now() };
          const probe = probeRef.current;
          if (!probe || probe.x !== result.x || probe.y !== result.y) return;
          probe.editable = result.editable;
          probe.answered = true;
          if (!probe.tapped) return;
          // Late answer: Android still raises the keyboard; iOS waits for the next tap.
          probeRef.current = null;
          if (result.editable) inputRef.current?.focus({ preventScroll: true });
          else inputRef.current?.blur();
        },
        onPointer: (pointer) => {
          const canvasNow = canvasRef.current;
          const viewport = viewportRef.current;
          if (!canvasNow || !viewport || canvasNow.width < 1 || canvasNow.height < 1) return;
          const box = { width: canvasNow.clientWidth, height: canvasNow.clientHeight };
          const placed = mapToSurface({ x: pointer.x, y: pointer.y, width: 0, height: 0 }, box, canvasNow, viewport);
          setAgentCursor({ ...placed, phase: pointer.phase, sequence: pointer.sequence });
        },
        // A device may refuse a write that arrives after the key press; the notice's Copy button is a fresh gesture.
        onClipboard: (text) => {
          void copyText(text).then((result) => { if (result === "failed") notify({ kind: "clipboard", text }); });
        },
        onDownload: (download) => notify({ kind: "download", download }),
        onPopup: () => undefined,
        onFileChooser: setFileChooser,
        onViewport: (viewport) => { viewportRef.current = viewport; },
        onControl: setControlState,
        onMessage: (message) => {
          if (message.type === "selectPopup" && typeof message.id === "string" && Array.isArray(message.options)) {
            const rect = message.rect as SelectState["rect"] | undefined;
            if (rect) setSelect({ id: message.id, options: message.options as SelectPopupOption[], selectedIndex: Number(message.selectedIndex), rect });
          } else if (message.type === "cursor" && typeof message.shape === "string") {
            setCursor(message.shape);
          } else if (message.type === "authPrompt" && typeof message.tabId === "string" && typeof message.id === "string" && typeof message.origin === "string") {
            setAuthPrompt({ tabId: message.tabId, id: message.id, origin: message.origin, realm: typeof message.realm === "string" ? message.realm : "" });
          } else if (message.type === "authPromptClosed") {
            setAuthPrompt((shown) => (shown && shown.id !== message.id ? shown : null));
          } else if (message.type === "notice" && typeof message.message === "string") {
            notify({ kind: "error", message: message.message });
          }
          propsRef.current.onMessage?.(message);
        },
        onConnectedChange: (next) => {
          setConnected(next);
          propsRef.current.onConnectedChange?.(next);
          if (next) return;
          setFileChooser(null);
          setSelect(null);
          setAuthPrompt(null);
          setControlState(null);
        },
        onHostSetup: setHostSetup,
        onUnauthorized: () => propsRef.current.onUnauthorized?.(),
        onGone: () => propsRef.current.onGone?.(),
        onClose: (code, reason) => propsRef.current.onClose?.(code, reason),
      },
    );
    clientRef.current = client;
    propsRef.current.onClient?.(client);
    return () => {
      painter.stop();
      client.stop();
      if (clientRef.current === client) clientRef.current = null;
      propsRef.current.onClient?.(null);
      setControlState(null);
      setConnected(false);
      setAgentCursor(null);
      clearInput();
    };
  }, [capKnown, clearInput, connect, hostSetup, notify]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Registered natively: React's wheel listener is passive and cannot stop the panel scrolling.
    const onWheel = (event: WheelEvent) => {
      const point = pagePoint(event.clientX, event.clientY, false);
      if (!point) return;
      event.preventDefault();
      const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? WHEEL_LINE_PX : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? (viewportRef.current?.height ?? 0) : 1;
      queueWheel(point, event.deltaX * unit, event.deltaY * unit, previewStreamModifiers(event));
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [pagePoint, queueWheel]);

  useEffect(() => () => {
    if (inputFrameRef.current !== null) cancelAnimationFrame(inputFrameRef.current);
  }, []);

  const handlePointer = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!operable(controlRef.current)) return;
    const { type, pointerId, clientX, clientY } = event;
    const cancelled = type === "pointercancel";
    const touch = touchRef.current;
    if (cancelled && touch?.pointerId === pointerId) {
      touchRef.current = probeRef.current = null;
      return;
    }
    if (event.pointerType === "touch" && !cancelled) {
      const point = pagePoint(clientX, clientY, type === "pointermove");
      if (type === "pointerdown") {
        if (!event.isPrimary) return;
        touchRef.current = { pointerId, startX: clientX, startY: clientY, lastX: clientX, lastY: clientY, panning: false };
        const last = lastProbeRef.current;
        const reusable = point && last && performance.now() - last.at < PROBE_REUSE_MS && Math.hypot(point.x - last.x, point.y - last.y) < PROBE_REUSE_PX;
        probeRef.current = point ? { x: point.x, y: point.y, editable: reusable ? last.editable : null, answered: false, tapped: false } : null;
        if (point) send({ type: "probe", x: point.x, y: point.y });
        return;
      }
      if (!touch || touch.pointerId !== pointerId) return;
      if (type === "pointermove") {
        if (!touch.panning && Math.hypot(clientX - touch.startX, clientY - touch.startY) < TAP_SLOP_PX) return;
        touch.panning = true;
        if (point) queueWheel(point, (touch.lastX - clientX) * point.scale, (touch.lastY - clientY) * point.scale, 0);
        touch.lastX = clientX;
        touch.lastY = clientY;
        return;
      }
      touchRef.current = null;
      const probe = probeRef.current;
      if (touch.panning) {
        probeRef.current = null;
        return;
      }
      if (!point) return;
      // iOS requires focus during the tap; late probe replies only raise Android's keyboard.
      if (probe?.editable === true) focusInput();
      else if (probe?.editable === false) inputRef.current?.blur();
      if (probe && !probe.answered) probe.tapped = true;
      else probeRef.current = null;
      flushInput();
      const clickCount = countClick("left", clientX, clientY, event.timeStamp);
      const at = { x: point.x, y: point.y, modifiers: 0 };
      send({ type: "mouse", action: "move", ...at, button: "none", buttons: 0, clickCount: 0 });
      send({ type: "mouse", action: "down", ...at, button: "left", buttons: 1, clickCount });
      send({ type: "mouse", action: "up", ...at, button: "left", buttons: 0, clickCount });
      return;
    }
    const previous = mouseButtonsRef.current;
    if ((cancelled || type === "pointerup") && previous === 0) return;
    if (cancelled || type === "pointerup") mouseButtonsRef.current = cancelled ? 0 : event.buttons & 7;
    const point = pagePoint(clientX, clientY, type !== "pointerdown" && (cancelled || type === "pointerup" || previous !== 0 || event.buttons !== 0));
    if (!point) return;
    const at = { x: point.x, y: point.y, modifiers: previewStreamModifiers(event) };
    const mouse = (action: "down" | "up", button: PreviewStreamMouseButton, buttons: number) => {
      if (action === "down") mouseClicksRef.current[button] = countClick(button, clientX, clientY, event.timeStamp);
      send({ type: "mouse", action, ...at, button, buttons, clickCount: mouseClicksRef.current[button] });
    };
    if (type === "pointerdown") {
      focusInput();
      event.currentTarget.setPointerCapture(pointerId);
      flushInput();
      mouseButtonsRef.current = event.buttons & 7;
      mouse("down", buttonOf(event.button), event.buttons);
    } else if (type === "pointerup") {
      flushInput();
      mouse("up", buttonOf(event.button), event.buttons);
    } else {
      // Chords arrive as pointermove. Cancellation releases every held button.
      const next = cancelled ? 0 : event.buttons & 7;
      const changed = previous ^ next;
      if (previous !== 0 && changed !== 0) {
        flushInput();
        let buttons = previous;
        for (const bit of [1, 2, 4]) {
          if (!(changed & bit)) continue;
          buttons ^= bit;
          mouse(next & bit ? "down" : "up", pressedButtonOf(bit), buttons);
        }
        mouseButtonsRef.current = next;
      }
      if (cancelled) return;
      pendingMoveRef.current = { type: "mouse", action: "move", ...at, button: pressedButtonOf(event.buttons), buttons: event.buttons, clickCount: 0 };
      scheduleFlush();
    }
  };

  const resetInput = (textarea: HTMLTextAreaElement) => {
    keySentRef.current = false;
    textarea.value = INPUT_SENTINEL;
    textarea.setSelectionRange(INPUT_SENTINEL.length, INPUT_SENTINEL.length);
  };

  const sendKeyPress = (key: typeof BACKSPACE | typeof DELETE) => {
    send({ type: "key", action: "down", ...key, modifiers: 0 });
    send({ type: "key", action: "up", ...key, modifiers: 0 });
  };

  const handleKey = (action: "down" | "up", event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!operable(controlRef.current)) return;
    keySentRef.current = false;
    // IME and soft keyboards deliver text through composition and input events.
    if (event.nativeEvent.isComposing || event.keyCode === 229 || event.key === "Process" || event.key === "Unidentified") return;
    // Keep plain Escape and Tab in the page; Shift+Escape returns to the app.
    if (event.key === "Escape" && event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      if (action === "down") {
        event.currentTarget.blur();
        propsRef.current.onLeave?.();
      }
      return;
    }
    const shortcut = event.ctrlKey || event.metaKey;
    // Paste arrives as a paste event carrying this device's clipboard. Copy and cut run in the page, which sends the
    // copied text back. Shift+Insert is the same paste.
    if (shortcut && event.key.toLowerCase() === "v") return;
    if (event.shiftKey && event.key === "Insert") return;
    // Enter carries "\r" like Puppeteer's key table, so forms submit and textareas break lines.
    const text = shortcut ? undefined : [...event.key].length === 1 ? event.key : event.key === "Enter" ? "\r" : undefined;
    send({ type: "key", action, key: event.key, code: event.code, keyCode: event.keyCode, ...(action === "down" && text !== undefined ? { text } : {}), modifiers: previewStreamModifiers(event) });
    // Some Android keyboards edit the textarea even when keydown is prevented.
    keySentRef.current = action === "down" && !shortcut && (text !== undefined || event.key === "Backspace" || event.key === "Delete");
    // Shortcuts stay with the app (copy, paste, keybindings); other keys belong to the page.
    if (shortcut) return;
    event.preventDefault();
    event.stopPropagation();
  };

  const handleInput = (event: FormEvent<HTMLTextAreaElement>) => {
    const native = event.nativeEvent;
    if (native instanceof InputEvent && native.isComposing) return;
    const textarea = event.currentTarget;
    const inputType = native instanceof InputEvent ? native.inputType : "";
    if (keySentRef.current) keySentRef.current = false;
    else if (inputType === "deleteContentBackward") sendKeyPress(BACKSPACE);
    else if (inputType === "deleteContentForward") sendKeyPress(DELETE);
    else {
      const text = textarea.value.replace(/^​/, "");
      if (text) send({ type: "text", text });
    }
    resetInput(textarea);
  };

  const answerFileChooser = (files: ReadonlyArray<File>) => {
    const chooser = fileChooser;
    if (!chooser) return;
    setFileChooser(null);
    void uploadPreviewStreamFiles(chooser, files).catch((cause: unknown) =>
      notify({ kind: "error", message: `Could not send the files to the page: ${cause instanceof Error ? cause.message : String(cause)}` }));
  };

  const direct = (message: PreviewStreamInput) => clientRef.current?.send(message);
  const canvas = canvasRef.current;
  const selectAnchor = select && canvas && viewportRef.current && canvas.width > 0
    ? mapToSurface(select.rect, { width: canvas.clientWidth, height: canvas.clientHeight }, canvas, viewportRef.current)
    : null;
  const you = control?.controller === "you";

  return (
    <div className={`relative flex min-h-0 flex-1 flex-col overflow-hidden ${props.className ?? ""}`} data-browser-surface>
      <div className="relative min-h-0 flex-1">
        <canvas
          ref={canvasRef}
          aria-hidden="true"
          className="block size-full touch-none object-contain"
          style={{ cursor: operable(control) ? (you ? cursor : "default") : "not-allowed" }}
          onPointerDown={handlePointer}
          onPointerMove={handlePointer}
          onPointerUp={handlePointer}
          onPointerCancel={handlePointer}
          // Keeps focus in the page input below and stops native text selection.
          onMouseDown={(event) => event.preventDefault()}
          onContextMenu={(event) => event.preventDefault()}
        />
        {agentCursor && !you ? <AgentCursor {...agentCursor} controller={control?.controller === "agent" ? "agent" : "none"} /> : null}
        {/* Focus target for page keyboard input. Pinned top-left so focusing it never scrolls the surface; 16px keeps
          iOS from zooming the app on focus. */}
        <textarea
          ref={inputRef}
          aria-label={props.label ?? "Browser page"}
          aria-description="Your keys go to the page. Press Shift+Escape to return to the browser address bar."
          aria-keyshortcuts="Shift+Escape"
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          disabled={!operable(control)}
          defaultValue={INPUT_SENTINEL}
          // The caret must sit after the sentinel for a deletion to have something to delete.
          onFocus={(event) => resetInput(event.currentTarget)}
          className="sr-only left-0 top-0 text-base"
          onKeyDown={(event) => handleKey("down", event)}
          onKeyUp={(event) => handleKey("up", event)}
          onInput={handleInput}
          onCompositionEnd={(event) => {
            const text = event.data.replace(/^​/, "");
            if (text) send({ type: "text", text });
            resetInput(event.currentTarget);
          }}
          // Copying the input would put its sentinel on this device's clipboard.
          onCopy={(event) => event.preventDefault()}
          onCut={(event) => event.preventDefault()}
          onPaste={(event) => {
            event.preventDefault();
            const text = event.clipboardData.getData("text/plain");
            if (text) send({ type: "text", text });
          }}
        />
        {connected && !painted && !hostSetup ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-ink-secondary" aria-hidden="true"><Loader2 size={22} className="animate-spin" /></div>
        ) : null}
        {select && selectAnchor && canvas ? (
          <SelectPopup
            key={select.id}
            options={select.options}
            selectedIndex={select.selectedIndex}
            anchor={selectAnchor}
            bounds={{ width: canvas.clientWidth, height: canvas.clientHeight }}
            onChoose={(index) => {
              direct({ type: "selectChoose", id: select.id, index });
              setSelect(null);
              focusInput();
            }}
            onClose={() => {
              setSelect(null);
              focusInput();
            }}
          />
        ) : null}
        {fileChooser && you ? (
          <div className="absolute inset-x-3 top-3 z-20 mx-auto flex max-w-sm flex-col gap-2 rounded-xl border border-hairline/60 bg-card p-3 text-ink shadow-xl" role="dialog" aria-label="Choose files for the page">
            <p className="flex items-center gap-2 text-[13px]"><FileUp size={14} aria-hidden="true" />The page asks for {fileChooser.multiple ? "files" : "a file"}.</p>
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              multiple={fileChooser.multiple}
              accept={fileChooser.accept}
              onChange={(event) => {
                const files = [...(event.currentTarget.files ?? [])];
                event.currentTarget.value = "";
                if (files.length > 0) answerFileChooser(files);
              }}
            />
            <div className="flex justify-end gap-2">
              <button type="button" className="rounded-lg px-3 py-1.5 text-[12px] text-ink-secondary hover:bg-inset" onClick={() => answerFileChooser([])}>Cancel</button>
              <button type="button" className="rounded-lg bg-accent px-3 py-1.5 text-[12px] text-accent-ink" onClick={() => fileInputRef.current?.click()}>Choose {fileChooser.multiple ? "files" : "file"}</button>
            </div>
          </div>
        ) : null}
        {control?.dialog && control.controller !== "another-viewer" ? (
          <div className="absolute inset-x-3 top-3 z-20 mx-auto flex max-w-sm flex-col gap-2 rounded-xl border border-hairline/60 bg-card p-3 text-ink shadow-xl" role="dialog" aria-label="Browser dialog">
            <p className="break-words text-[13px]">{control.dialog.message}</p>
            {you ? (
              <>
                {control.dialog.type === "prompt" ? <input aria-label="Dialog response" value={promptText} onChange={(event) => setPromptText(event.target.value)} className="rounded-lg bg-inset px-3 py-2 text-[13px] outline-none focus:ring-1 focus:ring-accent" /> : null}
                <div className="flex justify-end gap-2">
                  <button type="button" className="rounded-lg px-3 py-1.5 text-[12px] text-ink-secondary hover:bg-inset" onClick={() => direct({ type: "dialog", accept: false })}>Dismiss</button>
                  <button type="button" className="rounded-lg bg-accent px-3 py-1.5 text-[12px] text-accent-ink" onClick={() => direct({ type: "dialog", accept: true, ...(control.dialog?.type === "prompt" ? { promptText } : {}) })}>Accept</button>
                </div>
              </>
            ) : <p className="text-[12px] text-ink-secondary">Take control to respond.</p>}
          </div>
        ) : null}
        {authPrompt && you ? (
          <AuthPrompt
            origin={authPrompt.origin}
            realm={authPrompt.realm}
            onAnswer={(answer) => {
              const shown = { tabId: authPrompt.tabId, id: authPrompt.id };
              direct(answer ? { type: "authAnswer", ...shown, username: answer.username, password: answer.password } : { type: "authAnswer", ...shown });
              setAuthPrompt(null);
            }}
          />
        ) : null}
        {notices.length ? (
          <div className="absolute inset-x-3 bottom-3 z-20 flex flex-col items-center gap-2" role="status">
            {notices.map((notice) => (
              <div key={notice.id} className="flex max-w-full items-center gap-2 rounded-xl border border-hairline/60 bg-card px-3 py-2 text-[12px] text-ink shadow-lg">
                {notice.kind === "download" ? (
                  <>
                    <Download size={13} aria-hidden="true" className="shrink-0" />
                    <span className="min-w-0 truncate">Downloaded {notice.download.fileName}</span>
                    <button type="button" className="shrink-0 rounded-md bg-accent px-2 py-0.5 text-accent-ink" onClick={() => { save(notice.download); dismiss(notice.id); }}>Save</button>
                  </>
                ) : notice.kind === "clipboard" ? (
                  <>
                    <span className="min-w-0 truncate">The page copied text</span>
                    <button type="button" className="shrink-0 rounded-md bg-accent px-2 py-0.5 text-accent-ink" onClick={() => { void copyText(notice.text); dismiss(notice.id); }}>Copy</button>
                  </>
                ) : <span role="alert" className="min-w-0 text-danger">{notice.message}</span>}
                <button type="button" aria-label="Dismiss" className="shrink-0 rounded-md p-0.5 text-ink-secondary hover:bg-inset" onClick={() => dismiss(notice.id)}><X size={12} /></button>
              </div>
            ))}
          </div>
        ) : null}
      </div>
      {hostSetup ? (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-card p-4 text-center">
          <p role="alert" className="max-w-sm text-[13px] text-ink-secondary">{previewStreamHostSetupMessage(hostSetup)}</p>
          <code className="max-w-md select-all break-all rounded-lg bg-inset px-3 py-2 text-left text-[12px] text-ink">{hostSetup.command}</code>
          <button type="button" className="rounded-lg border border-hairline px-3 py-1.5 text-[12px] text-ink hover:bg-inset" onClick={() => setHostSetup(null)}>Try again</button>
        </div>
      ) : null}
    </div>
  );
}
