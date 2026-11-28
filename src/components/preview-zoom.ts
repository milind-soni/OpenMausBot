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

const BUTTON_STEP = 200 * Math.log(1.5);

export function zoomByStep(zoom: PreviewZoom, direction: 1 | -1, pointFromImageOrigin: { x: number; y: number }): PreviewZoom {
  return zoomAtPoint(zoom, -direction * BUTTON_STEP, pointFromImageOrigin);
}

export function panBy(zoom: PreviewZoom, dx: number, dy: number): PreviewZoom {
  return zoom.scale === 1 ? zoom : { ...zoom, x: zoom.x + dx, y: zoom.y + dy };
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

  const zoomed = zoom.scale !== 1;
  useEffect(() => {
    const picture = image.current;
    if (!picture || !zoomed) return;
    let last: { x: number; y: number } | null = null;
    const onDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      event.preventDefault();
      last = { x: event.clientX, y: event.clientY };
      picture.setPointerCapture(event.pointerId);
    };
    const onMove = (event: PointerEvent) => {
      if (!last) return;
      const dx = event.clientX - last.x;
      const dy = event.clientY - last.y;
      last = { x: event.clientX, y: event.clientY };
      setZoom((current) => panBy(current, dx, dy));
    };
    const onUp = () => { last = null; };
    picture.addEventListener("pointerdown", onDown);
    picture.addEventListener("pointermove", onMove);
    picture.addEventListener("pointerup", onUp);
    picture.addEventListener("pointercancel", onUp);
    return () => {
      picture.removeEventListener("pointerdown", onDown);
      picture.removeEventListener("pointermove", onMove);
      picture.removeEventListener("pointerup", onUp);
      picture.removeEventListener("pointercancel", onUp);
    };
  }, [zoomed]);

  const step = useCallback((direction: 1 | -1) => {
    const area = stage.current;
    const picture = image.current;
    if (!area || !picture) return;
    const center = { x: area.clientWidth / 2 - picture.offsetLeft, y: area.clientHeight / 2 - picture.offsetTop };
    setZoom((current) => zoomByStep(current, direction, center));
  }, []);

  const style: CSSProperties | undefined = zoom.scale === 1 ? undefined
    : { transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`, transformOrigin: "0 0", cursor: "grab" };
  const reset = useCallback(() => setZoom(FITTED), []);
  return { overlay, stage, image, style, reset, step, scale: zoom.scale };
}
