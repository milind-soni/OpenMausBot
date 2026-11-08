import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

const PANEL_WIDTH_KEY = "omb-computer-panel-width";
export const PANEL_MIN_WIDTH = 360;
export const PANEL_MAX_WIDTH = 960;
const PANEL_DEFAULT_WIDTH = 400;
const PANEL_RESIZE_STEP = 40;

function readPanelWidth(): number {
  try {
    const stored = Number(localStorage.getItem(PANEL_WIDTH_KEY));
    if (Number.isFinite(stored) && stored >= PANEL_MIN_WIDTH && stored <= PANEL_MAX_WIDTH) return stored;
  } catch {
  }
  return PANEL_DEFAULT_WIDTH;
}

function rightwardGrowth(element: Element): number {
  return getComputedStyle(element).direction === "rtl" ? 1 : -1;
}

/** The computer panel's drag edge: a pointer drag or the arrow keys resize the
 * panel, and the width is remembered across opens. */
export function useComputerPanelResize() {
  const [panelWidth, setPanelWidth] = useState(readPanelWidth);
  const resizeFrom = useRef<{ x: number; width: number; growth: number } | null>(null);
  const persistPanelWidth = (width: number) => {
    try {
      localStorage.setItem(PANEL_WIDTH_KEY, String(width));
    } catch {
    }
  };
  const onResizeStart = (event: PointerEvent<HTMLDivElement>) => {
    resizeFrom.current = { x: event.clientX, width: panelWidth, growth: rightwardGrowth(event.currentTarget) };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onResizeMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!resizeFrom.current) return;
    const next = Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, resizeFrom.current.width + (event.clientX - resizeFrom.current.x) * resizeFrom.current.growth));
    setPanelWidth(next);
  };
  const onResizeEnd = (event: PointerEvent<HTMLDivElement>) => {
    if (!resizeFrom.current) return;
    resizeFrom.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    persistPanelWidth(panelWidth);
  };
  const onResizeBy = (delta: number) => {
    setPanelWidth((current) => {
      const next = Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, current + delta));
      persistPanelWidth(next);
      return next;
    });
  };
  const separatorRef = useRef<HTMLDivElement>(null);
  const [separatorWidth, setSeparatorWidth] = useState<number | null>(null);
  useEffect(() => {
    const panel = separatorRef.current?.closest("aside");
    if (!panel) return;
    const read = () => setSeparatorWidth(panel.offsetWidth);
    read();
    const observer = new ResizeObserver(read);
    observer.observe(panel);
    return () => observer.disconnect();
  }, []);
  const onSeparatorKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const step = event.key === "ArrowRight" ? PANEL_RESIZE_STEP : event.key === "ArrowLeft" ? -PANEL_RESIZE_STEP : null;
    if (step === null || separatorWidth === null) return;
    event.preventDefault();
    onResizeBy(step * rightwardGrowth(event.currentTarget));
  };
  return { panelWidth, separatorRef, separatorWidth, onSeparatorKeyDown, onResizeStart, onResizeMove, onResizeEnd };
}
