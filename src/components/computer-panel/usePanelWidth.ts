import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

const PANEL_WIDTH_KEY = "omb-computer-panel-width";
const PANEL_MIN_WIDTH = 360;
const PANEL_MAX_WIDTH = 960;
const PANEL_DEFAULT_WIDTH = 400;

function readPanelWidth(): number {
  try {
    const stored = Number(localStorage.getItem(PANEL_WIDTH_KEY));
    if (Number.isFinite(stored) && stored >= PANEL_MIN_WIDTH && stored <= PANEL_MAX_WIDTH) return stored;
  } catch {
    /* storage blocked — default width */
  }
  return PANEL_DEFAULT_WIDTH;
}

/** The panel is a fixed column by default; a drag handle on its left edge
 * makes it wide enough to actually read a page in the Browser tab. */
export function usePanelWidth() {
  const [panelWidth, setPanelWidth] = useState(readPanelWidth);
  const resizeFrom = useRef<{ x: number; width: number } | null>(null);
  const onResizeStart = (event: PointerEvent<HTMLDivElement>) => {
    resizeFrom.current = { x: event.clientX, width: panelWidth };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onResizeMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!resizeFrom.current) return;
    const next = Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, resizeFrom.current.width + (resizeFrom.current.x - event.clientX)));
    setPanelWidth(next);
  };
  const onResizeEnd = (event: PointerEvent<HTMLDivElement>) => {
    if (!resizeFrom.current) return;
    resizeFrom.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    try {
      localStorage.setItem(PANEL_WIDTH_KEY, String(panelWidth));
    } catch {
      /* storage blocked — width lives for this session */
    }
  };
  const onResizeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const next = Math.min(
      PANEL_MAX_WIDTH,
      Math.max(PANEL_MIN_WIDTH, panelWidth + (event.key === "ArrowLeft" ? 10 : -10)),
    );
    setPanelWidth(next);
    try {
      localStorage.setItem(PANEL_WIDTH_KEY, String(next));
    } catch {
      /* storage blocked — width lives for this session */
    }
  };
  return {
    panelWidth,
    panelMinWidth: PANEL_MIN_WIDTH,
    panelMaxWidth: PANEL_MAX_WIDTH,
    onResizeStart,
    onResizeMove,
    onResizeEnd,
    onResizeKeyDown,
  };
}
