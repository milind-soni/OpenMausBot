import { useEffect, useState, type RefObject } from "react";

/**
 * React hook to observe and return the rendered inline-size (width)
 * of an element using ResizeObserver.
 */
export function useContainerWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState<number>(() => {
    if (typeof window !== "undefined") {
      return window.innerWidth;
    }
    return 1024;
  });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const measure = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0) {
        setWidth(rect.width);
      }
    };

    measure();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const borderBox = entry.borderBoxSize?.[0];
        const w = borderBox ? borderBox.inlineSize : entry.contentRect.width;
        if (w > 0) {
          setWidth(w);
        }
      }
    });

    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, [ref]);

  return width;
}
