import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { t } from "@/lib/i18n";

const HEIGHT_KEY = "openmausbot.sidebarPinnedHeight";
const MIN_HEIGHT = 64;
const LIST_SPACE = 96;
const scrollArea = "shrink-0 overflow-y-auto px-2 pb-2";

function readHeight() {
  try {
    const value = Number(localStorage.getItem(HEIGHT_KEY));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch { return null; }
}

function rememberHeight(height: number) {
  try { localStorage.setItem(HEIGHT_KEY, String(height)); } catch { /* Storage may be unavailable. */ }
}

export function SidebarPinnedArea({ resizable, children }: { resizable: boolean; children: ReactNode }) {
  if (!resizable) return <div data-sidebar-universal-pins="" className={`${scrollArea} max-h-[min(40vh,280px)] border-b border-hairline/40`}>{children}</div>;
  return <ResizablePinnedArea>{children}</ResizablePinnedArea>;
}

function ResizablePinnedArea({ children }: { children: ReactNode }) {
  const id = useId();
  const pane = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointer: number; y: number; height: number; latest?: number } | null>(null);
  const [height, setHeight] = useState(readHeight);
  const [bounds, setBounds] = useState({ max: 280, actual: 0 });
  useLayoutEffect(() => {
    const el = pane.current!;
    const header = el.closest<HTMLElement>("[data-glass-bar]");
    const frame = header?.parentElement;
    if (!header || !frame) return;
    const footer = frame.querySelector<HTMLElement>(':scope > [data-glass-bar="bottom"]');
    const measure = () => {
      const actual = el.offsetHeight;
      const max = Math.max(0, frame.clientHeight - (header.offsetHeight - actual) - (footer?.offsetHeight ?? 0) - LIST_SPACE);
      setBounds(prev => prev.max === max && prev.actual === actual ? prev : { max, actual });
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    for (const node of [frame, header, footer, el]) if (node) observer?.observe(node);
    return () => observer?.disconnect();
  }, []);
  const minimum = Math.min(MIN_HEIGHT, bounds.max);
  const resize = (wanted: number) => {
    const next = Math.max(minimum, Math.min(bounds.max, Math.round(wanted)));
    setHeight(next);
    return next;
  };
  return <>
    <div ref={pane} id={id} data-sidebar-universal-pins="" className={scrollArea}
      style={{ height: height ?? undefined, maxHeight: height === null ? `min(40vh, 280px, ${bounds.max}px)` : bounds.max }}>{children}</div>
    <div role="separator" aria-label={t("sidebar.section.pinned")} title={t("computer.resizeAria")} aria-orientation="horizontal"
      aria-controls={id} aria-valuemin={Math.min(minimum, bounds.actual)} aria-valuemax={bounds.max} aria-valuenow={bounds.actual} tabIndex={0}
      className="group flex h-2 w-full shrink-0 cursor-row-resize touch-none select-none items-center justify-center border-b border-hairline/40 hover:bg-raised focus-visible:bg-raised focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      onPointerDown={event => {
        if (event.button !== 0 || drag.current) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { pointer: event.pointerId, y: event.clientY, height: pane.current!.offsetHeight };
      }}
      onPointerMove={event => {
        const start = drag.current;
        if (start?.pointer === event.pointerId) start.latest = resize(start.height + event.clientY - start.y);
      }}
      onLostPointerCapture={event => {
        const start = drag.current;
        if (start?.pointer !== event.pointerId) return;
        if (start.latest !== undefined) rememberHeight(start.latest);
        drag.current = null;
      }}
      onKeyDown={event => {
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
        event.preventDefault();
        rememberHeight(resize(pane.current!.offsetHeight + (event.key === "ArrowDown" ? 16 : -16)));
      }}>
      <span aria-hidden="true" className="h-0.5 w-6 rounded-full bg-hairline group-hover:bg-ink-secondary group-focus-visible:bg-ink-secondary" />
    </div>
  </>;
}
