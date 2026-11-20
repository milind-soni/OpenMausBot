import { useCallback, useEffect, useRef, useState, type MouseEvent, type PointerEvent } from "react";
import type { PreviewImage } from "./AttachmentPreview";

export function nextImageIndex(index: number, step: -1 | 1, count: number): number {
  if (count <= 0) return 0;
  return Math.max(0, Math.min(count - 1, index + step));
}

export type PreviewKeyAction = "close" | "previous" | "next" | null;

export function previewKeyAction(key: string, count: number): PreviewKeyAction {
  if (key === "Escape") return "close";
  if (count > 1 && key === "ArrowLeft") return "previous";
  if (count > 1 && key === "ArrowRight") return "next";
  return null;
}

const transcriptImages = new WeakMap<Element, PreviewImage[]>();

export function registerPreviewThumbnail(element: HTMLElement | null, images: PreviewImage[]) {
  if (element) transcriptImages.set(element, images);
}

export function conversationImages(trigger: HTMLElement, localImages: PreviewImage[]): PreviewImage[] {
  const transcript = trigger.closest('[role="log"]');
  if (!transcript) return localImages;
  const groups = new Set<PreviewImage[]>();
  const images = new Map<string, PreviewImage>();
  for (const thumbnail of transcript.querySelectorAll("[data-preview-thumbnail]")) {
    if (thumbnail.closest('[role="log"]') !== transcript) continue;
    const group = transcriptImages.get(thumbnail);
    if (!group || groups.has(group)) continue;
    groups.add(group);
    for (const image of group) {
      if (!images.has(image.src)) images.set(image.src, image);
    }
  }
  return [...images.values()];
}

type Point = { x: number; y: number };
type Zoom = Point & { scale: number };
const FIT: Zoom = { x: 0, y: 0, scale: 1 };
const TAP_DELAY_MS = 280;

function pinchBetween([first, second]: Point[]) {
  return {
    x: (first.x + second.x) / 2,
    y: (first.y + second.y) / 2,
    distance: Math.hypot(second.x - first.x, second.y - first.y),
  };
}

function boundedZoom(view: HTMLDivElement, zoom: Zoom): Zoom {
  const image = view.querySelector<HTMLImageElement>("[data-preview-active-image]");
  const limitX = Math.max(0, ((image?.offsetWidth || view.clientWidth) * zoom.scale - view.clientWidth) / 2);
  const limitY = Math.max(0, ((image?.offsetHeight || view.clientHeight) * zoom.scale - view.clientHeight) / 2);
  return {
    scale: zoom.scale,
    x: Math.max(-limitX, Math.min(limitX, zoom.x)),
    y: Math.max(-limitY, Math.min(limitY, zoom.y)),
  };
}

function zoomAt(view: HTMLDivElement, base: Zoom, from: Point, to: Point, scale: number): Zoom {
  const bounds = view.getBoundingClientRect();
  const centerX = bounds.left + bounds.width / 2;
  const centerY = bounds.top + bounds.height / 2;
  return boundedZoom(view, {
    scale,
    x: to.x - centerX - (from.x - centerX - base.x) * scale / base.scale,
    y: to.y - centerY - (from.y - centerY - base.y) * scale / base.scale,
  });
}

export function usePreviewGestures(
  index: number,
  count: number,
  navigate: (step: -1 | 1) => void,
  dismiss: () => void,
  cancelPress: () => void,
) {
  const points = useRef(new Map<number, Point>());
  const start = useRef<Point | null>(null);
  const mode = useRef<"horizontal" | "vertical" | "pan" | "pinch" | null>(null);
  const origin = useRef(FIT);
  const pinch = useRef<ReturnType<typeof pinchBetween> | null>(null);
  const ignoreClick = useRef(false);
  const tap = useRef<ReturnType<typeof setTimeout> | null>(null);
  const zoomRef = useRef(FIT);
  const [zoom, setZoom] = useState(FIT);
  const [animateZoom, setAnimateZoom] = useState(false);
  const trackRef = useRef<HTMLDivElement>(null);
  function setDrag(offset: Point | null) {
    const track = trackRef.current;
    if (!track) return;
    track.toggleAttribute("data-preview-dragging", offset !== null);
    if (offset) {
      track.style.setProperty("--preview-drag-x", `${offset.x}px`);
      track.style.setProperty("--preview-drag-y", `${offset.y}px`);
    } else {
      track.style.removeProperty("--preview-drag-x");
      track.style.removeProperty("--preview-drag-y");
    }
  }
  const updateZoom = useCallback((next: Zoom, animate = false) => {
    zoomRef.current = next;
    setZoom(next);
    setAnimateZoom(animate);
  }, []);
  const clearTap = useCallback(() => {
    if (tap.current !== null) clearTimeout(tap.current);
    tap.current = null;
  }, []);

  useEffect(() => clearTap, [clearTap]);
  useEffect(() => { clearTap(); updateZoom(FIT); }, [index, clearTap, updateZoom]);

  const finish = (event: PointerEvent<HTMLDivElement>, cancelled = false) => {
    if (!points.current.delete(event.pointerId) || points.current.size > 0) return;
    const initial = start.current;
    const gesture = mode.current;
    start.current = null;
    mode.current = null;
    pinch.current = null;
    cancelPress();
    if (!cancelled && initial && gesture === "vertical" && event.clientY - initial.y >= 96) {
      dismiss();
      return;
    }
    setDrag(null);
    if (!cancelled && initial && gesture === "horizontal") {
      const dx = event.clientX - initial.x;
      if (Math.abs(dx) >= 48) navigate(dx < 0 ? 1 : -1);
    }
  };

  const handlers = {
    onPointerDown(event: PointerEvent<HTMLDivElement>) {
      if (event.button !== 0 || (event.target instanceof Element && event.target.closest("button, a, [role=group]"))) return;
      const point = { x: event.clientX, y: event.clientY };
      points.current.set(event.pointerId, point);
      if (points.current.size === 1) {
        ignoreClick.current = false;
        start.current = point;
        origin.current = zoomRef.current;
      } else if (points.current.size === 2) {
        ignoreClick.current = true;
        clearTap();
        cancelPress();
        setDrag(null);
        mode.current = "pinch";
        pinch.current = pinchBetween([...points.current.values()]);
        origin.current = zoomRef.current;
        for (const id of points.current.keys()) event.currentTarget.setPointerCapture(id);
      }
    },
    onPointerMove(event: PointerEvent<HTMLDivElement>) {
      if (!points.current.has(event.pointerId)) return;
      const point = { x: event.clientX, y: event.clientY };
      points.current.set(event.pointerId, point);
      const initial = start.current;
      if (!initial) return;
      if (mode.current === "pinch") {
        if (points.current.size === 2 && pinch.current) {
          const next = pinchBetween([...points.current.values()]);
          const scale = Math.min(4, Math.max(1, origin.current.scale * next.distance / Math.max(1, pinch.current.distance)));
          updateZoom(zoomAt(event.currentTarget, origin.current, pinch.current, next, scale));
        }
        return;
      }
      const dx = point.x - initial.x;
      const dy = point.y - initial.y;
      if (!mode.current) {
        if (Math.hypot(dx, dy) <= 10) return;
        mode.current = origin.current.scale > 1 ? "pan" : Math.abs(dx) > Math.abs(dy) ? "horizontal" : "vertical";
        ignoreClick.current = true;
        clearTap();
        cancelPress();
        event.currentTarget.setPointerCapture(event.pointerId);
      }
      if (mode.current === "pan") {
        updateZoom(boundedZoom(event.currentTarget, { scale: origin.current.scale, x: origin.current.x + dx, y: origin.current.y + dy }));
      } else if (mode.current === "horizontal") {
        const atEdge = dx > 0 ? index === 0 : index === count - 1;
        setDrag({ x: atEdge ? dx * 0.2 : dx, y: 0 });
      } else {
        setDrag({ x: 0, y: Math.max(0, dy) });
      }
    },
    onPointerUp: (event: PointerEvent<HTMLDivElement>) => finish(event),
    onPointerCancel: (event: PointerEvent<HTMLDivElement>) => finish(event, true),
    onPointerLeave(event: PointerEvent<HTMLDivElement>) {
      if (!mode.current) finish(event, true);
    },
    onLostPointerCapture(event: PointerEvent<HTMLDivElement>) {
      if (event.target === event.currentTarget) finish(event, true);
    },
    onClickCapture(event: MouseEvent<HTMLDivElement>) {
      if (!ignoreClick.current || event.detail === 0) return;
      ignoreClick.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
  };

  function tapSurface(event: MouseEvent<HTMLDivElement>) {
    if (event.target instanceof Element && event.target.closest("button, a, [role=group]")) return;
    if (event.detail === 0) { clearTap(); dismiss(); return; }
    if (tap.current !== null) {
      clearTap();
      const point = { x: event.clientX, y: event.clientY };
      updateZoom(zoomRef.current.scale > 1 ? FIT : zoomAt(event.currentTarget, FIT, point, point, 2.5), true);
      return;
    }
    tap.current = setTimeout(() => { tap.current = null; dismiss(); }, TAP_DELAY_MS);
  }

  return { trackRef, zoom, animateZoom, handlers, tapSurface, clearTap };
}
