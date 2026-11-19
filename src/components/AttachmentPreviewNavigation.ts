import { useRef, type TouchEvent } from "react";
import type { PreviewImage } from "./AttachmentPreview";

export function wrappedImageIndex(index: number, step: -1 | 1, count: number): number {
  if (count <= 0) return 0;
  return (index + step + count) % count;
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

export function usePreviewSwipe(count: number, navigate: (step: -1 | 1) => void) {
  const swipe = useRef<{ x: number; y: number } | null>(null);
  return {
    onTouchStart(event: TouchEvent<HTMLDivElement>) {
      const touch = event.touches[0];
      swipe.current = count > 1 && event.touches.length === 1 ? { x: touch.clientX, y: touch.clientY } : null;
    },
    onTouchCancel() {
      swipe.current = null;
    },
    onTouchEnd(event: TouchEvent<HTMLDivElement>) {
      const start = swipe.current;
      swipe.current = null;
      const end = event.changedTouches[0];
      if (!start || !end) return;
      const dx = end.clientX - start.x;
      if (Math.abs(dx) >= 48 && Math.abs(dx) > Math.abs(end.clientY - start.y)) navigate(dx < 0 ? 1 : -1);
    },
  };
}
