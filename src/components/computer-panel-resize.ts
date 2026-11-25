import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

const PANEL_WIDTH_KEY = "omb-computer-panel-width";
export const PANEL_MIN_WIDTH = 360;
/** The widest the panel gets when there is no chat beside it to measure. */
export const PANEL_MAX_WIDTH = 960;
/** The chat beside the panel never gets narrower than this. */
export const CHAT_MIN_WIDTH = 360;
const PANEL_DEFAULT_WIDTH = 400;
const PANEL_RESIZE_STEP = 40;

function readPanelWidth(key: string, fallback: number): number {
  try {
    const stored = Number(localStorage.getItem(key));
    if (Number.isFinite(stored) && stored >= PANEL_MIN_WIDTH) return stored;
  } catch {
  }
  return fallback;
}

/** The panel and the chat beside it share the room in the window's row, so the
 * panel can take everything but the chat's minimum width. */
function measureMaxWidth(panel: HTMLElement, chat: HTMLElement | null): number {
  if (!chat) return PANEL_MAX_WIDTH;
  return Math.max(PANEL_MIN_WIDTH, panel.offsetWidth + chat.offsetWidth - CHAT_MIN_WIDTH);
}

/** The computer panel's drag edge: a pointer drag or the arrow keys resize the
 * panel up to the room the chat leaves, and the width is remembered across opens
 * (under `key`, for a panel that keeps its own). */
export function useComputerPanelResize({ key = PANEL_WIDTH_KEY, defaultWidth = PANEL_DEFAULT_WIDTH }: { key?: string; defaultWidth?: number } = {}) {
  const [chosenWidth, setChosenWidth] = useState(() => readPanelWidth(key, defaultWidth));
  const [maxWidth, setMaxWidth] = useState(PANEL_MAX_WIDTH);
  const panelWidth = Math.min(chosenWidth, maxWidth);
  const clamp = (width: number) => Math.min(maxWidth, Math.max(PANEL_MIN_WIDTH, width));
  const resizeFrom = useRef<{ x: number; width: number } | null>(null);
  const persistPanelWidth = (width: number) => {
    try {
      localStorage.setItem(key, String(width));
    } catch {
    }
  };
  const onResizeStart = (event: PointerEvent<HTMLDivElement>) => {
    resizeFrom.current = { x: event.clientX, width: panelWidth };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onResizeMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!resizeFrom.current) return;
    setChosenWidth(clamp(resizeFrom.current.width + (resizeFrom.current.x - event.clientX)));
  };
  const onResizeEnd = (event: PointerEvent<HTMLDivElement>) => {
    if (!resizeFrom.current) return;
    resizeFrom.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    persistPanelWidth(chosenWidth);
  };
  const onResizeBy = (delta: number) => {
    const next = clamp(panelWidth + delta);
    setChosenWidth(next);
    persistPanelWidth(next);
  };
  const separatorRef = useRef<HTMLDivElement>(null);
  const [separatorWidth, setSeparatorWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const panel = separatorRef.current?.closest("aside");
    const row = panel?.parentElement;
    if (!panel || !row) return;
    let chat: HTMLElement | null = null;
    const read = () => {
      const current = row.querySelector<HTMLElement>(":scope > main");
      if (current !== chat) {
        if (chat) resizes.unobserve(chat);
        if (current) resizes.observe(current);
        chat = current;
      }
      setSeparatorWidth(panel.offsetWidth);
      if (panel.offsetWidth > 0) setMaxWidth(measureMaxWidth(panel, chat));
    };
    const resizes = new ResizeObserver(read);
    resizes.observe(panel);
    // A view change swaps the chat <main> beside the panel for a new element.
    const swaps = new MutationObserver(read);
    swaps.observe(row, { childList: true });
    read();
    return () => {
      resizes.disconnect();
      swaps.disconnect();
    };
  }, []);
  const onSeparatorKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const widen = event.key === "ArrowLeft" ? PANEL_RESIZE_STEP : event.key === "ArrowRight" ? -PANEL_RESIZE_STEP : null;
    if (widen === null || separatorWidth === null) return;
    event.preventDefault();
    onResizeBy(widen);
  };
  return { panelWidth, maxWidth, separatorRef, separatorWidth, onSeparatorKeyDown, onResizeStart, onResizeMove, onResizeEnd };
}
