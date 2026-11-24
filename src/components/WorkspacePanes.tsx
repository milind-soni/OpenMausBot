import { useLayoutEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { t } from "@/lib/i18n";
import { firstPane, MAIN_PANE, replacePane, type PaneLayout } from "@/state/pane-layout";
import { useStore } from "@/state/store";
import { PanelChat } from "./ForkPanel";

interface Box { x: number; y: number; w: number; h: number }

export function WorkspacePanes({ primary, title, children }: { primary: string; title: string; children: ReactNode }) {
  const { state, dispatch } = useStore();
  const panes = state.workspacePanes;
  const root = useRef<HTMLDivElement>(null);
  const move = useRef<{ start: number; ratio: number; size: number } | null>(null);
  const focused = panes?.focused;
  const loading = focused && panes?.panels[focused]?.loading;
  const previouslySplit = useRef(false);
  useLayoutEffect(() => {
    const restore = previouslySplit.current;
    previouslySplit.current = Boolean(focused);
    if (!focused && !restore) return;
    const pane = root.current?.querySelector<HTMLElement>(`[data-pane-id="${CSS.escape(focused ?? MAIN_PANE)}"]`);
    if (!pane || pane.contains(document.activeElement) && pane !== document.activeElement) return;
    (pane.querySelector<HTMLElement>('[data-tour="composer"] textarea:not(:disabled)') ?? pane).focus({ preventScroll: true });
  }, [focused, loading]);

  const leaves: ReactNode[] = [];
  const dividers: ReactNode[] = [];
  function draw(layout: PaneLayout, box: Box, path: string) {
    if (typeof layout === "string") {
      const panel = panes?.panels[layout];
      const owner = panel && (panel.kind === "bot" ? state.bots : state.groups).find((item) => item.id === panel.ownerId);
      const name = panel ? owner?.tasks?.find((task) => task.threadId === layout)?.title ?? owner?.name : title;
      const activate = () => { if (panes && focused !== layout) dispatch({ type: "focusPane", id: layout }); };
      const close = () => {
        if (!panes) return;
        const remaining = replacePane(panes.layout, MAIN_PANE, null);
        const promote = layout === MAIN_PANE && remaining ? firstPane(remaining) : undefined;
        const next = promote && panes.panels[promote];
        dispatch({ type: "closePane", id: layout, promote });
        if (next) {
          dispatch({ type: "select", id: next.ownerId });
          dispatch(next.kind === "bot" ? { type: "switchTask", botId: next.ownerId, threadId: next.threadId }
            : { type: "switchGroupTask", groupId: next.ownerId, threadId: next.threadId });
        }
      };
      leaves.push(<section key={layout} tabIndex={-1} aria-label={name} data-pane-id={layout}
        data-workspace-thread={panes ? panel?.threadId ?? primary : undefined}
        onPointerDownCapture={activate} onFocusCapture={activate}
        style={{ left: box.x + "%", top: box.y + "%", width: box.w + "%", height: box.h + "%" }}
        className={panes ? "absolute flex min-h-0 min-w-0 flex-col overflow-hidden outline-none" : "contents"}>
        {panes && <div className={'flex h-8 shrink-0 items-center justify-between border-b border-hairline px-3 text-xs font-medium ' +
          (focused === layout ? "bg-raised text-ink" : "bg-app text-ink-secondary")}>
          <span className="truncate">{name}</span>
          <button type="button" aria-label={t("chat.closePane", { title: name ?? "" })} onClick={close}
            className="rounded p-1 hover:bg-menu-hover focus-visible:ring-1 focus-visible:ring-accent"><X size={14} /></button>
        </div>}
        <div className={panes ? "relative flex min-h-0 min-w-0 flex-1" : "contents"}>{panel ? <PanelChat panel={panel} /> : children}</div>
      </section>);
      return;
    }
    const beside = layout.direction === "beside";
    const first = { ...box }, second = { ...box };
    if (beside) {
      first.w *= layout.ratio; second.x += first.w; second.w -= first.w;
    } else {
      first.h *= layout.ratio; second.y += first.h; second.h -= first.h;
    }
    const resize = (ratio: number) => dispatch({ type: "resizePane", divider: path, ratio });
    dividers.push(<div key={path} role="separator" tabIndex={0} aria-label={t("chat.resizePane")}
      aria-orientation={beside ? "vertical" : "horizontal"} aria-valuenow={Math.round(layout.ratio * 100)} aria-valuemin={20} aria-valuemax={80}
      style={beside ? { left: second.x + "%", top: box.y + "%", height: box.h + "%" }
        : { top: second.y + "%", left: box.x + "%", width: box.w + "%" }}
      className={'absolute z-10 flex touch-none items-center justify-center outline-none hover:bg-accent/20 focus-visible:bg-accent/30 ' +
        (beside ? 'w-2 -translate-x-1/2 cursor-col-resize' : 'h-2 -translate-y-1/2 cursor-row-resize')}
      onPointerDown={(event) => {
        if (event.button !== 0 || !root.current) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        move.current = { start: beside ? event.clientX : event.clientY, ratio: layout.ratio,
          size: beside ? root.current.clientWidth * box.w / 100 : root.current.clientHeight * box.h / 100 };
      }}
      onPointerMove={(event) => {
        if (move.current && event.currentTarget.hasPointerCapture(event.pointerId)) {
          resize(move.current.ratio + ((beside ? event.clientX : event.clientY) - move.current.start) / move.current.size);
        }
      }}
      onLostPointerCapture={() => { move.current = null; }}
      onKeyDown={(event) => {
        const delta = event.key === (beside ? "ArrowRight" : "ArrowDown") ? .05 : event.key === (beside ? "ArrowLeft" : "ArrowUp") ? -.05 : 0;
        if (delta) { event.preventDefault(); resize(layout.ratio + delta); }
      }}><span className={beside ? "h-full w-px bg-hairline" : "h-px w-full bg-hairline"} /></div>);
    draw(layout.first, first, path + "0");
    draw(layout.second, second, path + "1");
  }
  draw(panes?.layout ?? MAIN_PANE, { x: 0, y: 0, w: 100, h: 100 }, "");
  return <div ref={root} className={panes ? "relative min-w-0 flex-1" : "contents"}>{leaves}{dividers}</div>;
}
