import { useEffect, useState } from "react";

type Rect = { top: number; left: number; width: number; height: number };

const PAD = 6;

function findTarget(name: string): HTMLElement | null {
  const nodes = document.querySelectorAll<HTMLElement>(`[data-tour="${name}"]`);
  for (const node of nodes) {
    if (node.getClientRects().length > 0) return node;
  }
  return null;
}

function sameRect(a: Rect | null, b: Rect | null) {
  return a === b || (!!a && !!b && a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height);
}

/**
 * Dims the workspace and rings the element the current tour step is about.
 * The element is found by its `data-tour` marker and followed every frame so
 * the ring stays put while panels open, resize, or scroll.
 */
export function TourSpotlight({ target }: { target: string }) {
  const [rect, setRect] = useState<Rect | null>(null);

  useEffect(() => {
    let frame = 0;
    let current: Rect | null = null;
    findTarget(target)?.scrollIntoView({ block: "nearest", inline: "nearest" });
    const measure = () => {
      const node = findTarget(target);
      const box = node?.getBoundingClientRect();
      const next = box && box.width > 0 && box.height > 0
        ? {
            top: Math.round(box.top - PAD),
            left: Math.round(box.left - PAD),
            width: Math.round(box.width + PAD * 2),
            height: Math.round(box.height + PAD * 2),
          }
        : null;
      if (!sameRect(current, next)) {
        current = next;
        setRect(next);
      }
      frame = requestAnimationFrame(measure);
    };
    measure();
    return () => cancelAnimationFrame(frame);
  }, [target]);

  if (!rect) return null;
  return (
    <div
      aria-hidden="true"
      data-testid="tour-spotlight"
      className="gbs-tour-spotlight pointer-events-none fixed z-[39] rounded-xl"
      style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height }}
    />
  );
}
