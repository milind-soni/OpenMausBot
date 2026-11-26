import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { cn } from "@/lib/cn";

/** One line that fades over its last 28px when it is cut off (mirrored for right-to-left text); a line that fits is untouched. */
export function FadeLine({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setClipped(element.scrollWidth > element.clientWidth + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [children]);
  return <span ref={ref} dir="auto" className={cn("min-w-0 overflow-hidden whitespace-nowrap", clipped && "fade-end")}>{children}</span>;
}
