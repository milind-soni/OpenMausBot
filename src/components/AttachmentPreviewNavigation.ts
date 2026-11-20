import { useRef, useState, type TouchEvent } from "react";
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

export function usePreviewSwipe(index: number, count: number, navigate: (step: -1 | 1) => void) {
  const swipe = useRef<{ x: number; y: number; horizontal?: boolean } | null>(null);
  const [offset, setOffset] = useState<number | null>(null);
  const reset = () => {
    swipe.current = null;
    setOffset(null);
  };
  const handlers = {
    onTouchStart(event: TouchEvent<HTMLDivElement>) {
      reset();
      if (count < 2 || event.touches.length !== 1 || (event.target instanceof Element && event.target.closest("button, a, [role=group]"))) return;
      const touch = event.touches[0];
      swipe.current = { x: touch.clientX, y: touch.clientY };
    },
    onTouchMove(event: TouchEvent<HTMLDivElement>) {
      const start = swipe.current;
      if (!start || event.touches.length !== 1) return;
      const dx = event.touches[0].clientX - start.x;
      const dy = event.touches[0].clientY - start.y;
      if (start.horizontal === undefined && Math.max(Math.abs(dx), Math.abs(dy)) >= 3) {
        start.horizontal = Math.abs(dx) > Math.abs(dy);
      }
      if (!start.horizontal) return;
      const atEdge = (dx > 0 && index === 0) || (dx < 0 && index === count - 1);
      setOffset(atEdge ? dx * 0.2 : dx);
    },
    onTouchCancel: reset,
    onTouchEnd(event: TouchEvent<HTMLDivElement>) {
      const start = swipe.current;
      reset();
      const end = event.changedTouches[0];
      if (!start || start.horizontal === false || !end) return;
      const dx = end.clientX - start.x;
      if (Math.abs(dx) >= 48 && Math.abs(dx) > Math.abs(end.clientY - start.y)) navigate(dx < 0 ? 1 : -1);
    },
  };
  return { offset, handlers };
}
