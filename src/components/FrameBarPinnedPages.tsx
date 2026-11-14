import { AppWindow, Globe } from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useWebPanels } from "@/lib/web-panel-preferences";
import { useStore } from "@/state/store";
import type { WebPanel } from "@/lib/web-panels";
import { SidebarPopoverMenu, type SidebarMenuItem } from "./SidebarPopoverMenu";
import { useWindowPlace } from "./WindowPlaceTitle";

/** The frame bar's own button recipe, as WindowFrameBar draws its buttons (kept here so this file does not import
 * the bar it is rendered by). */
const BAR_BUTTON = "flex size-[22px] shrink-0 items-center justify-center rounded-md text-ink-secondary transition-colors hover:bg-ink/[0.07] hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus";

/** A page named in the bar: the same height as a bar button, room to read the name, and the accent while it is open. */
const PAGE_CHIP = "flex h-[22px] max-w-[12rem] shrink-0 items-center gap-1 rounded-md px-1.5 text-[12px] text-ink-secondary transition-colors hover:bg-ink/[0.07] hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus";

/** Whether every pinned page's name fits in the bar's left half, which is what stays free beside the place name.
 * `pagesLeft` is where the names start inside the bar, `pagesWidth` what they need; both are measured, not guessed. */
export function pagesFitInBar(barWidth: number, placeWidth: number, pagesLeft: number, pagesWidth: number): boolean {
  if (!(barWidth > 0) || !(pagesWidth > 0)) return false;
  const side = Math.max(0, (barWidth - placeWidth) / 2);
  // 8 px keeps a name from touching the place name at the bar's middle.
  return pagesWidth <= side - pagesLeft - 8;
}

function PageIcon({ panel, size }: { panel: WebPanel; size: number }) {
  return panel.page ? <AppWindow size={size} aria-hidden="true" /> : <Globe size={size} aria-hidden="true" />;
}

/** The pinned pages, one click from the window's top bar: named in a row while the bar has room for every name, and
 * one button listing them (the same order the settings keep) once it does not. Nothing is drawn before a page is
 * pinned, so the bar reads as the official one until the person keeps a page. */
export function FrameBarPinnedPages() {
  const panels = useWebPanels();
  // Main names the place after this page mounts: until it does, the bar has no place name to keep clear of.
  const place = useWindowPlace();
  const { state, dispatch } = useStore();
  const wrapRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [roomy, setRoomy] = useState(false);

  useLayoutEffect(() => {
    if (!panels.length) return;
    const wrap = wrapRef.current, measure = measureRef.current;
    if (!wrap || !measure) return;
    const decide = () => {
      const bar = wrap.closest("[data-window-frame-bar]") as HTMLElement | null;
      if (!bar) return setRoomy(false);
      const barBox = bar.getBoundingClientRect();
      const placeEl = bar.querySelector<HTMLElement>("[data-window-place]");
      const placeWidth = placeEl?.getBoundingClientRect().width ?? 0;
      const left = wrap.getBoundingClientRect().left - barBox.left;
      const needed = measure.getBoundingClientRect().width;
      setRoomy(pagesFitInBar(barBox.width, placeWidth, left, needed));
    };
    decide();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(decide);
    const bar = wrap.closest("[data-window-frame-bar]");
    if (bar) observer.observe(bar);
    const placeEl = bar?.querySelector("[data-window-place]");
    if (placeEl) observer.observe(placeEl);
    observer.observe(measure);
    return () => observer.disconnect();
  }, [panels, place]);

  if (!panels.length) return null;
  const activeId = state.activeView === "web-panel" ? state.webPanelId : undefined;
  const open = (id: string) => dispatch({ type: "showWebPanel", id });
  const items: SidebarMenuItem[] = panels.map((panel) => ({
    key: panel.id,
    label: panel.name,
    icon: <PageIcon panel={panel} size={16} />,
    active: panel.id === activeId,
    onSelect: () => open(panel.id),
  }));

  return (
    <div ref={wrapRef} data-frame-bar-pages className="relative flex min-w-0 items-center gap-0.5">
      {roomy ? panels.map((panel) => (
        <button
          key={panel.id}
          type="button"
          data-frame-bar-page={panel.id}
          aria-label={panel.name}
          title={panel.name}
          onClick={() => open(panel.id)}
          className={cn(PAGE_CHIP, panel.id === activeId && "text-accent")}
        >
          <PageIcon panel={panel} size={14} />
          <span className="min-w-0 truncate">{panel.name}</span>
        </button>
      )) : (
        <SidebarPopoverMenu
          items={items}
          ariaLabel={t("webPanels.bar.label")}
          triggerTitle={t("webPanels.bar.label")}
          triggerClassName={BAR_BUTTON}
          renderTrigger={() => <Globe size={15} strokeWidth={1.75} aria-hidden="true" />}
        />
      )}
      <MeasureRow refEl={measureRef} panels={panels} />
    </div>
  );
}

/** The names at their natural width, invisible and out of the bar's layout: what the bar would need to show them. */
function MeasureRow({ refEl, panels }: { refEl: RefObject<HTMLDivElement | null>; panels: WebPanel[] }): ReactNode {
  // No text is read from it, so it is hidden from assistive tech and from the mouse.
  return <div ref={refEl} aria-hidden="true" data-frame-bar-pages-measure className="pointer-events-none invisible absolute left-0 top-0 flex items-center gap-0.5 whitespace-nowrap">
    {panels.map((panel) => <span key={panel.id} className={PAGE_CHIP}><PageIcon panel={panel} size={14} /><span>{panel.name}</span></span>)}
  </div>;
}
