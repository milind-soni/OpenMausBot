import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";

export const PREVIEW_ZOOM_MAX = 16;

export interface PreviewZoom { scale: number; x: number; y: number }

const FITTED: PreviewZoom = { scale: 1, x: 0, y: 0 };

export function zoomAtPoint(zoom: PreviewZoom, deltaY: number, pointFromImageOrigin: { x: number; y: number }): PreviewZoom {
  const scale = Math.min(PREVIEW_ZOOM_MAX, zoom.scale * Math.exp(-deltaY / 200));
  if (scale <= 1) return FITTED;
  const ratio = scale / zoom.scale;
  const { x, y } = pointFromImageOrigin;
  return { scale, x: x - (x - zoom.x) * ratio, y: y - (y - zoom.y) * ratio };
}

export function wheelPixels(event: Pick<WheelEvent, "deltaY" | "deltaMode">, pageHeight: number): number {
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) return event.deltaY * 16;
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) return event.deltaY * pageHeight;
  return event.deltaY;
}

export function usePreviewZoom() {
  const overlay = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const [zoom, setZoom] = useState(FITTED);

  useEffect(() => {
    const element = overlay.current;
    if (!element) return;
    // React 19 attaches onWheel as a passive listener, where preventDefault cannot stop the browser's own scroll or pinch zoom.
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const area = stage.current;
      const picture = image.current;
      if (!area || !picture || !area.contains(event.target as Node)) return;
      const deltaY = wheelPixels(event, area.clientHeight);
      if (deltaY === 0 || (deltaY < 0 && event.target !== picture)) return;
      const box = area.getBoundingClientRect();
      const point = { x: event.clientX - box.left - picture.offsetLeft, y: event.clientY - box.top - picture.offsetTop };
      setZoom((current) => zoomAtPoint(current, deltaY, point));
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, []);

  const style: CSSProperties | undefined = zoom.scale === 1 ? undefined
    : { transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`, transformOrigin: "0 0" };
  const reset = useCallback(() => setZoom(FITTED), []);
  return { overlay, stage, image, style, reset };
}
