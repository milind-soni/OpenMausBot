import { useContext, useEffect, useLayoutEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import { X } from "lucide-react";
import { t } from "@/lib/i18n";
import { emptyPane, paneIds, placePane, MAIN_PANE, replacePane, type PaneEdge, type PaneLayout } from "@/state/pane-layout";
import { useStore } from "@/state/store";
import { PanelChat } from "./ForkPanel";

import { workspaceLayout } from "@/state/fork-panel";
import { TiledPaneTitle, WorkspaceChatContext } from "@/state/workspace-chat-context";
import { draggedThread } from "@/lib/workspace-pane-drag";

type Placement = PaneEdge | "fill";
const previewArea: Record<Placement, string> = { left: "inset-y-0 left-0 w-1/2", right: "inset-y-0 right-0 w-1/2",
  top: "inset-x-0 top-0 h-1/2", bottom: "inset-x-0 bottom-0 h-1/2", fill: "inset-0" };

function nearestEdge(event: DragEvent): PaneEdge {
  const box = event.currentTarget.getBoundingClientRect();
  const x = (event.clientX - box.left) / box.width, y = (event.clientY - box.top) / box.height;
  return Math.min(x, 1 - x) < Math.min(y, 1 - y) ? x < 0.5 ? "left" : "right" : y < 0.5 ? "top" : "bottom";
}

interface Box { x: number; y: number; w: number; h: number }

export function WorkspacePanes({ primary, title, children }: { primary: string; title: string; children: ReactNode }) {
  const { state, dispatch } = useStore();
  const panes = state.workspacePanes;
  const desktop = Boolean(useContext(WorkspaceChatContext));
  const layoutTree = workspaceLayout(state);
  const ids = paneIds(layoutTree);
  const [preview, setPreview] = useState<{ target: string; edge: Placement } | null>(null);
  useEffect(() => {
    const clear = () => setPreview(null);
    window.addEventListener("dragend", clear);
    return () => window.removeEventListener("dragend", clear);
  }, []);
  const handleDrag = (event: DragEvent, target: string, drop: boolean) => {
    const thread = draggedThread(event);
    if (!thread || !desktop) return;
    const owner = state.groups.find(g => g.id === thread.ownerId) ?? state.bots.find(b => b.id === thread.ownerId);
    if (!owner || (owner.threadId !== thread.threadId && !owner.tasks?.some(task => task.threadId === thread.threadId))) return;
    const source = thread.threadId === primary ? MAIN_PANE : thread.threadId;
    const edge = emptyPane(target) ? "fill" : nearestEdge(event);
    if (!placePane(layoutTree, source, target, edge)) { setPreview(null); return; }
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    if (!drop) {
      setPreview(old => old?.target === target && old.edge === edge ? old : { target, edge });
      return;
    }
    setPreview(null);
    if (ids.includes(source)) dispatch({ type: "movePane", source, target, edge });
    else dispatch({ type: "openForkPanel", kind: state.groups.some(g => g.id === owner.id) ? "group" : "bot",
      ...thread, target, edge, focusComposer: true });
  };
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
      const vacant = emptyPane(layout);
      const name = vacant ? t("chat.slot", { number: ids.indexOf(layout) + 1 }) : panel ? owner?.tasks?.find((task) => task.threadId === layout)?.title ?? owner?.name : title;
      const activate = () => { if (panes && focused !== layout) dispatch({ type: "focusPane", id: layout }); };
      const close = () => {
        if (!panes) return;
        const remaining = replacePane(panes.layout, MAIN_PANE, null);
        const promote = layout === MAIN_PANE && remaining ? paneIds(remaining).find(id => !emptyPane(id)) : undefined;
        if (layout === MAIN_PANE && !promote) { dispatch({ type: "closeWorkspacePanes" }); return; }
        const next = promote && panes.panels[promote];
        dispatch({ type: "closePane", id: layout, promote });
        if (next) {
          dispatch({ type: "select", id: next.ownerId });
          dispatch(next.kind === "bot" ? { type: "switchTask", botId: next.ownerId, threadId: next.threadId }
            : { type: "switchGroupTask", groupId: next.ownerId, threadId: next.threadId });
        }
      };
      leaves.push(<section key={layout} tabIndex={-1} aria-label={name} data-pane-id={layout}
        data-empty-pane={vacant ? "" : undefined}
        data-workspace-thread={panes && !vacant ? panel?.threadId ?? primary : undefined}
        data-pane-focused={panes && focused === layout ? "" : undefined}
        onDragOver={event => handleDrag(event, layout, false)} onDrop={event => handleDrag(event, layout, true)}
        onDragLeave={event => { if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) setPreview(null); }}
        onPointerDownCapture={activate} onFocusCapture={activate}
        style={{ left: box.x + "%", top: box.y + "%", width: box.w + "%", height: box.h + "%" }}
        className={desktop ? "absolute flex min-h-0 min-w-0 flex-col overflow-hidden outline-none [container:workspace-pane/size]" : "contents"}>
        {panes && (layout !== MAIN_PANE || ids.some(id => id !== MAIN_PANE && !emptyPane(id))) &&
          <button type="button" aria-label={t("chat.closePane", { title: name ?? "" })} onClick={close}
            className="absolute end-2 top-3 z-30 flex size-7 items-center justify-center rounded-full text-ink-secondary hover:bg-raised focus-visible:ring-2 focus-visible:ring-focus"><X size={16} /></button>}
        {vacant ? <button type="button" onClick={activate} className="flex flex-1 flex-col items-center justify-center gap-1 text-sm text-ink-secondary focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-focus">
          <span className="text-xs font-medium">{name}</span>
          {t("chat.dropThread")}
        </button> : <div className={panes ? "relative flex min-h-0 min-w-0 flex-1" : "contents"}>
          <TiledPaneTitle value={panes ? name ?? title : null}>
            {panel ? <PanelChat panel={panel} /> : children}
          </TiledPaneTitle>
        </div>}
        {preview?.target === layout && <div aria-hidden="true" data-drop-preview={preview.edge}
          className={`pointer-events-none absolute z-20 rounded-lg border-2 border-focus bg-accent/15 ${previewArea[preview.edge]}`} />}
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
  return <div ref={root} className={desktop ? "relative min-h-0 min-w-0 flex-1" : "contents"}>{leaves}{dividers}</div>;
}
