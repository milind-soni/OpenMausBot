import { createContext, useContext, useLayoutEffect, useRef, type HTMLAttributes, type ReactNode } from "react";

import { cn } from "@/lib/cn";

type GlassEdge = "top" | "bottom";

const EDGES: readonly GlassEdge[] = ["top", "bottom"];

function frameBars(frame: HTMLElement): Partial<Record<GlassEdge, HTMLElement>> {
  const bars: Partial<Record<GlassEdge, HTMLElement>> = {};
  for (const child of Array.from(frame.children)) {
    const edge = (child as HTMLElement).dataset?.glassBar;
    if (edge === "top" || edge === "bottom") bars[edge] = child as HTMLElement;
  }
  return bars;
}

export function publishGlassInsets(frame: HTMLElement): void {
  const bars = frameBars(frame);
  for (const edge of EDGES) {
    const bar = bars[edge];
    frame.style.setProperty(`--glass-${edge}`, `${bar ? Math.ceil(bar.getBoundingClientRect().height) : 0}px`);
  }
}

export type ScrollFade = "start" | "end" | "both";

/** Which edges of a scrolling list have more of it past them. */
export function scrollFadeOf({ scrollTop, scrollHeight, clientHeight }: Pick<HTMLElement, "scrollTop" | "scrollHeight" | "clientHeight">): ScrollFade | null {
  const start = scrollTop > 1;
  const end = scrollTop < scrollHeight - clientHeight - 1;
  return start && end ? "both" : start ? "start" : end ? "end" : null;
}

export function watchScrollFade(list: HTMLElement, frame: HTMLElement): () => void {
  const update = () => {
    const fade = scrollFadeOf(list);
    if (fade) frame.setAttribute("data-scroll-fade", fade);
    else frame.removeAttribute("data-scroll-fade");
  };
  update();
  list.addEventListener("scroll", update, { passive: true });
  const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
  resize?.observe(list);
  for (const child of Array.from(list.children)) resize?.observe(child);
  return () => {
    list.removeEventListener("scroll", update);
    resize?.disconnect();
    frame.removeAttribute("data-scroll-fade");
  };
}

const FadeFrame = createContext(false);

const FADE_BAND = "pointer-events-none absolute inset-x-0 z-10 h-6 bg-[var(--scroll-fade-surface,var(--color-panel))] opacity-0 transition-opacity duration-150 ease-out";

/** `fade` stacks the bars above and below the scroller instead of floating them over it as glass, and marks
 * the list's edges with a band of the surface colour that shows only while more of the list lies past that edge. */
export function GlassScrollFrame({ className, children, fade = false, ...rest }: HTMLAttributes<HTMLDivElement> & { children: ReactNode; fade?: boolean }) {
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
    const children = new MutationObserver(watch);
    children.observe(frame, { childList: true });
    return () => {
      resize.disconnect();
      children.disconnect();
    };
  }, []);
  return (
    <FadeFrame.Provider value={fade}>
      <div ref={ref} data-glass-frame="" className={cn("relative min-h-0", fade && "flex flex-col", className)} {...rest}>
        {children}
      </div>
    </FadeFrame.Provider>
  );
}

/** `fade` trades the glass for a plain fade into the canvas: what scrolls under the bar melts away towards the edge. */
export function GlassBar({ edge, fade, className, children, ...rest }: HTMLAttributes<HTMLDivElement> & { edge: GlassEdge; fade?: boolean; children: ReactNode }) {
  const stacked = useContext(FadeFrame);
  return (
    <div
      data-glass-bar={edge}
      data-glass-fade={fade ? "" : undefined}
      className={cn(stacked ? "relative z-10 shrink-0" : cn("glass-bar absolute inset-x-0 z-10", edge === "top" ? "top-0" : "bottom-0"), className)}
      {...rest}
    >
      {children}
    </div>
  );
}

export function GlassScroller({ className, children, ...rest }: HTMLAttributes<HTMLDivElement> & { children: ReactNode }) {
  const fade = useContext(FadeFrame);
  const frame = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!fade || !frame.current || !list.current) return;
    return watchScrollFade(list.current, frame.current);
  }, [fade]);
  if (!fade) {
    return (
      <div className={cn("glass-scroller h-full overflow-y-auto", className)} {...rest}>
        <div className="glass-scroller-content">{children}</div>
      </div>
    );
  }
  return (
    <div ref={frame} data-scroll-fade-frame="" className="group/fade relative min-h-0 flex-1">
      <div ref={list} className={cn("h-full overflow-y-auto", className)} {...rest}>
        <div>{children}</div>
      </div>
      <div aria-hidden="true" data-scroll-fade-edge="top"
        className={cn(FADE_BAND, "top-0 [mask-image:linear-gradient(to_bottom,black,transparent)] group-data-[scroll-fade=start]/fade:opacity-100 group-data-[scroll-fade=both]/fade:opacity-100")} />
      <div aria-hidden="true" data-scroll-fade-edge="bottom"
        className={cn(FADE_BAND, "bottom-0 [mask-image:linear-gradient(to_top,black,transparent)] group-data-[scroll-fade=end]/fade:opacity-100 group-data-[scroll-fade=both]/fade:opacity-100")} />
    </div>
  );
}
