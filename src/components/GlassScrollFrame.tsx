// Liquid-glass bars over a scrolling pane. The pane's content scrolls on
// underneath its top and bottom bars instead of stopping at their edge, and
// each bar blurs whatever passes beneath it, tinted with the surface it sits
// on (--glass-tint). At rest a bar reads as that plain surface; it only turns
// to glass once something scrolls under it.
//
// The frame measures its bars and publishes their heights as --glass-top and
// --glass-bottom. The scroller pads its content by them, so the first and
// last rows rest clear of the glass, and keeps keyboard focus and its
// scrollbar clear too (styles.css, "Glass bars"). The measuring lives here,
// not in the pages that use it, so their own hook order is unchanged.
import { useLayoutEffect, useRef, type HTMLAttributes, type ReactNode } from "react";

import { cn } from "@/lib/cn";

type GlassEdge = "top" | "bottom";

const EDGES: readonly GlassEdge[] = ["top", "bottom"];

/** The bars directly inside a frame, by edge. */
function frameBars(frame: HTMLElement): Partial<Record<GlassEdge, HTMLElement>> {
  const bars: Partial<Record<GlassEdge, HTMLElement>> = {};
  for (const child of Array.from(frame.children)) {
    const edge = (child as HTMLElement).dataset?.glassBar;
    if (edge === "top" || edge === "bottom") bars[edge] = child as HTMLElement;
  }
  return bars;
}

/** Writes each bar's height to the frame as --glass-top / --glass-bottom
 * (0px for an edge with no bar). Exported for tests. */
export function publishGlassInsets(frame: HTMLElement): void {
  const bars = frameBars(frame);
  for (const edge of EDGES) {
    const bar = bars[edge];
    frame.style.setProperty(`--glass-${edge}`, `${bar ? Math.ceil(bar.getBoundingClientRect().height) : 0}px`);
  }
}

/** Holds a scroller and the glass bars over its edges. Bars are direct
 * children (GlassBar); everything else is laid out as usual. */
export function GlassScrollFrame({ className, children, ...rest }: HTMLAttributes<HTMLDivElement> & { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    const apply = () => publishGlassInsets(frame);
    const resize = new ResizeObserver(apply);
    const watch = () => {
      resize.disconnect();
      for (const bar of Object.values(frameBars(frame))) if (bar) resize.observe(bar);
      apply();
    };
    watch();
    // A bar can come and go with what it holds (a page without a footer).
    const children = new MutationObserver(watch);
    children.observe(frame, { childList: true });
    return () => {
      resize.disconnect();
      children.disconnect();
    };
  }, []);
  return (
    <div ref={ref} data-glass-frame="" className={cn("relative min-h-0", className)} {...rest}>
      {children}
    </div>
  );
}

/** A bar pinned over one edge of its frame's scroller. */
export function GlassBar({ edge, className, children, ...rest }: HTMLAttributes<HTMLDivElement> & { edge: GlassEdge; children: ReactNode }) {
  return (
    <div
      data-glass-bar={edge}
      className={cn("glass-bar absolute inset-x-0 z-10", edge === "top" ? "top-0" : "bottom-0", className)}
      {...rest}
    >
      {children}
    </div>
  );
}

/** The scroller under a frame's bars: its content starts below the top bar
 * and ends above the bottom one, and scrolls on beneath both. */
export function GlassScroller({ className, children, ...rest }: HTMLAttributes<HTMLDivElement> & { children: ReactNode }) {
  return (
    <div className={cn("glass-scroller h-full overflow-y-auto", className)} {...rest}>
      <div className="glass-scroller-content">{children}</div>
    </div>
  );
}
