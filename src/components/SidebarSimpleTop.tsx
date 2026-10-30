import { ChevronLeft, ChevronRight, Search, X } from "lucide-react";
import { useEffect, useState, type CSSProperties, type Ref, type RefObject } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { ELEVATED_CONTROL, ELEVATED_HOVER, ELEVATED_TINT } from "./elevated";

/** Keyboard focus on a Simple row or tile: the focus ring drawn inside its edge. */
export const SIMPLE_ROW_FOCUS = "focus-visible:outline-2 focus-visible:-outline-offset-2! focus-visible:outline-focus";

const SIMPLE_TOP = "flex size-9 shrink-0 items-center justify-center rounded-full text-ink/90";
const SIMPLE_TOP_FOCUS = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";
export const SIMPLE_TOP_BUTTON = `${SIMPLE_TOP} ${ELEVATED_CONTROL} ${ELEVATED_HOVER} ${SIMPLE_TOP_FOCUS}`;
/** The same round control for the button of the window's rail, which is shown most of the time: its aria-expanded never
 * wears the tint of an open menu. */
export const SIMPLE_TOP_TOGGLE = `${SIMPLE_TOP} ${ELEVATED_CONTROL} ${ELEVATED_TINT} ${SIMPLE_TOP_FOCUS}`;

/** The round control at either end of the phone bot list's top row. */
export const PHONE_TOP_BUTTON = "flex size-10 shrink-0 items-center justify-center rounded-full border border-hairline bg-card text-ink hover:bg-raised focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

export const SIMPLE_RAIL_BUTTON = "flex size-9 shrink-0 items-center justify-center rounded-xl text-ink-secondary hover:bg-raised/60 hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

/** The small bump on the sidebar's right edge that collapses it to the rail and back (Simple mode).
 * It sits level with the top row, beside the + button; the Simple rail is 92px wide so the bump stays clear of the macOS
 * traffic-light zone, which swallows clicks before 88px.
 * Once mounted it is portaled to the end of <body> and pinned to the sidebar's edge: Electron applies -webkit-app-region
 * rects in document order, so the chat header's drag region (which comes after the sidebar) would otherwise swallow it. */
export function SidebarEdgeToggle({ collapsed, onToggle, style, anchorRef, shown = true, onHover }: {
  collapsed: boolean;
  onToggle: () => void;
  style?: CSSProperties;
  anchorRef?: RefObject<HTMLElement | null>;
  shown?: boolean;
  onHover?: (inside: boolean) => void;
}) {
  const [edge, setEdge] = useState<{ left: number; top: number } | null>(null);
  // A passive effect, not a layout one: React attaches the parent <aside>'s ref after its children's layout effects run.
  // Its top too: a strip above the app (an update, My Cloud asleep, things arriving on My Cloud) moves the sidebar down,
  // and the bump with it, so it never sits on the strip's words.
  useEffect(() => {
    const anchor = anchorRef?.current;
    if (!anchor) return;
    const measure = () => { const rect = anchor.getBoundingClientRect(); setEdge({ left: Math.round(rect.right), top: Math.round(rect.top) }); };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(anchor);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [anchorRef]);
  const Arrow = collapsed ? ChevronRight : ChevronLeft;
  const pinned = edge !== null;
  const button = (
    <button
      type="button"
      data-sidebar-edge-toggle
      onClick={onToggle}
      aria-label={t(collapsed ? "sidebar.density.expand" : "sidebar.density.collapseAria")}
      aria-expanded={!collapsed}
      title={t(collapsed ? "sidebar.density.expand" : "sidebar.density.collapse")}
      style={pinned ? { ...style, left: edge.left, top: edge.top + 14 } : style}
      onPointerEnter={() => onHover?.(true)}
      onPointerLeave={() => onHover?.(false)}
      className={cn(
        pinned ? "fixed" : "absolute -right-[14px]",
        shown ? "opacity-100" : "pointer-events-none opacity-0 focus-visible:pointer-events-auto focus-visible:opacity-100 touch:pointer-events-auto touch:opacity-100",
        "transition-opacity duration-150",
        "top-[14px] z-30 hidden h-8 w-[14px] items-center justify-center rounded-r-[4px] border border-l-0 border-hairline/50 bg-panel text-ink-tertiary shadow-[1px_0_2px_rgb(0_0_0/0.06)] hover:bg-raised hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus md:flex",
      )}
    >
      <Arrow size={12} strokeWidth={2.25} aria-hidden="true" />
    </button>
  );
  return pinned ? createPortal(button, document.body) : button;
}

export function SidebarSearchToggle({ open, onToggle, ref }: { open: boolean; onToggle: () => void; ref?: Ref<HTMLButtonElement> }) {
  return (
    <button
      ref={ref}
      type="button"
      data-sidebar-search-toggle
      onClick={onToggle}
      aria-label={t("sidebar.searchAria")}
      aria-expanded={open}
      title={t("sidebar.searchAria")}
      className={SIMPLE_TOP_BUTTON}
    >
      <Search size={18} strokeWidth={1.5} aria-hidden="true" />
    </button>
  );
}

export function SidebarSearchPill({ query, onQuery, onClose }: { query: string; onQuery: (query: string) => void; onClose: () => void }) {
  return (
    <div data-sidebar-search-pill className="px-3 pb-2 pt-0.5">
      <div className={cn("flex h-[34px] items-center gap-2 rounded-full pl-3 pr-1.5 text-ink-secondary focus-within:ring-focus", ELEVATED_CONTROL)}>
        <Search size={15} aria-hidden="true" className="shrink-0" />
        <input
          autoFocus
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            onClose();
          }}
          placeholder={t("sidebar.searchAria")}
          aria-label={t("sidebar.searchAria")}
          className="min-w-0 flex-1 bg-transparent text-[13px] text-ink placeholder:text-ink-tertiary focus:outline-none"
        />
        <button
          type="button"
          onClick={onClose}
          aria-label={t("sidebar.searchClose")}
          title={t("sidebar.searchClose")}
          className="flex size-6 shrink-0 items-center justify-center rounded-full text-ink-tertiary hover:bg-raised hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
