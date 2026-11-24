import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type WheelEvent as ReactWheelEvent } from "react";
import { Pin, Plus, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { nextRename } from "@/lib/rename";
import { localizedTaskTitle } from "@/lib/task-title";
import { useFeature } from "@/lib/use-feature";
import type { Bot } from "@/state/store";
import { useStoreDispatch, useStoreSelector } from "@/state/store-select";
import { BotAvatar } from "./Avatar";
import { reducedMotion } from "./MenuMotion";
import { botShowsTabs, neighbourOf, openTabId, showsTabs, threadTabs, type ThreadTab } from "./thread-tabs";
import { useSlidingIndicator, useTabMotion } from "./thread-tab-motion";
import { UndoToast, useUndoToast } from "./UndoToast";

const TAB = "thread-tab group/tab relative z-[1] flex h-8.5 min-w-24 max-w-42 shrink items-center rounded-t-lg ps-3 pe-1 pb-0.5 text-[13px] leading-[18px] outline-none transition-colors duration-[120ms] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus motion-reduce:transition-none";
const CLOSE = "pointer-events-none ms-1 flex size-5 shrink-0 items-center justify-center rounded-full text-ink-tertiary opacity-0 transition-opacity duration-[120ms] hover:bg-ink/[0.08] hover:text-ink group-hover/tab:pointer-events-auto group-hover/tab:opacity-100 group-focus-within/tab:pointer-events-auto group-focus-within/tab:opacity-100 touch:pointer-events-auto touch:opacity-100 motion-reduce:transition-none";
const FADE = 24;

/** Whether the chat header shows this bot's threads as tabs in place of its pill and New thread, in windows wide enough
 * for them. */
export function useThreadTabsShown(botId: string): boolean {
  const on = useFeature("threadTabs");
  return useBotHasThreads(botId) && on;
}

/** Whether this bot has two threads or more to switch between, its blank New thread chat counted. */
export function useBotHasThreads(botId: string): boolean {
  return useStoreSelector((state) => botShowsTabs(state.bots.find((bot) => bot.id === botId), state.newChat));
}

/** A bot's threads as tabs in the chat header, once Thread tabs is on and the bot has two threads or more. */
export function HeaderThreadTabs({ bot }: { bot: Bot }) {
  const on = useFeature("threadTabs");
  const tabs = useMemo(() => threadTabs(bot), [bot.id, bot.threadId, bot.switchingTo, bot.mainThreadId, bot.tasks, bot.busy]);
  if (!on || !showsTabs(tabs)) return null;
  return <Strip bot={bot} tabs={tabs} />;
}

/** The mask that fades a sideways-scrolling row's edges where more of it is hidden, none when it all fits. */
export function edgeFade(element: HTMLElement, fade = FADE): string | undefined {
  const room = element.scrollWidth - element.clientWidth;
  if (room <= 1) return undefined;
  const rtl = getComputedStyle(element).direction === "rtl";
  const hiddenLeft = rtl ? room + element.scrollLeft : element.scrollLeft;
  const left = hiddenLeft > 1 ? "transparent 0, black " + fade + "px" : "black 0";
  const right = room - hiddenLeft > 1 ? "black calc(100% - " + fade + "px), transparent 100%" : "black 100%";
  return `linear-gradient(to right, ${left}, ${right})`;
}

function Strip({ bot, tabs }: { bot: Bot; tabs: ThreadTab[] }) {
  const dispatch = useStoreDispatch();
  const panelOpen = useStoreSelector((state) => state.settingsOpen);
  const panelBeside = useStoreSelector((state) => state.settingsOpen || state.computerOpen || state.inspectorOpen);
  const scroller = useRef<HTMLDivElement>(null);
  const { shown, entering } = useTabMotion(tabs, scroller);
  const active = openTabId(bot);
  const indicator = useSlidingIndicator(scroller, active);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const finishing = useRef(false);
  const [toast, setToast] = useUndoToast();
  const [fade, setFade] = useState<string | undefined>();
  const canWrite = bot.yourAccess !== "view";
  const behindDraft = useStoreSelector((state) => state.bots.find((each) => each.id === bot.id)?.threadId);

  const measure = useCallback(() => {
    const element = scroller.current;
    if (element) setFade(edgeFade(element));
  }, []);
  useLayoutEffect(measure);
  useEffect(() => {
    const element = scroller.current;
    if (!element || typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [measure]);
  useEffect(() => {
    const element = scroller.current?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(active)}"]`);
    element?.scrollIntoView?.({ block: "nearest", inline: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });
  }, [active]);

  const open = (tab: ThreadTab) => {
    if (tab.threadId !== active) dispatch({ type: "switchTask", botId: bot.id, threadId: tab.threadId });
  };
  const close = (tab: ThreadTab) => {
    if (!tab.closable) return;
    if (tab.draft) {
      if (behindDraft) dispatch({ type: "switchTask", botId: bot.id, threadId: behindDraft });
      return;
    }
    if (tab.threadId === active) {
      const next = neighbourOf(tabs, tab.threadId);
      if (next) dispatch({ type: "switchTask", botId: bot.id, threadId: next });
    }
    dispatch({ type: "updateTask", botId: bot.id, threadId: tab.threadId, patch: { archivedAt: Date.now() } });
    setToast({ text: t("sidebar.threads.hidden"), undo: () => dispatch({ type: "updateTask", botId: bot.id, threadId: tab.threadId, patch: { archivedAt: null } }) });
  };
  const focusTab = (threadId: string) =>
    requestAnimationFrame(() => scroller.current?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(threadId)}"]`)?.focus());
  const startRename = (tab: ThreadTab) => {
    if (!tab.renamable || !canWrite) return;
    finishing.current = false;
    setDraft(tab.title);
    setRenaming(tab.threadId);
  };
  const finishRename = (tab: ThreadTab, save: boolean, refocus: boolean) => {
    if (finishing.current) return;
    finishing.current = true;
    const title = save ? nextRename(tab.title, draft) : null;
    setRenaming(null);
    if (title) dispatch({ type: "renameTask", botId: bot.id, threadId: tab.threadId, title });
    if (refocus) focusTab(tab.threadId);
  };
  const onKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (renaming || event.target instanceof HTMLInputElement) return;
    const at = tabs.findIndex((tab) => tab.threadId === (event.target as HTMLElement).dataset.tabId);
    if (at < 0) return;
    const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
    const step = event.key === "ArrowRight" ? (rtl ? -1 : 1) : event.key === "ArrowLeft" ? (rtl ? 1 : -1) : 0;
    const to = step ? Math.min(Math.max(at + step, 0), tabs.length - 1) : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
    if (to !== null) { event.preventDefault(); focusTab(tabs[to].threadId); return; }
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(tabs[at]); return; }
    if (event.key === "F2") { event.preventDefault(); startRename(tabs[at]); return; }
    if (event.key === "Delete" && canWrite) {
      event.preventDefault();
      const next = neighbourOf(tabs, tabs[at].threadId);
      close(tabs[at]);
      if (next) focusTab(next);
    }
  };
  const scrollSideways = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
    event.currentTarget.scrollLeft += event.deltaY;
  };
  const onAuxClick = (event: ReactMouseEvent, tab: ThreadTab) => {
    if (event.button !== 1 || !canWrite) return;
    event.preventDefault();
    close(tab);
  };

  return (
    <div data-thread-tabs={bot.id} data-panel-beside={panelBeside ? "" : undefined} className="flex h-full min-w-0 flex-1 items-end max-md:hidden">
      <button type="button" data-thread-tabs-bot aria-label={t("chat.openProfileAria", { name: bot.name })} title={t("chat.openBotPanel")} aria-expanded={panelOpen}
        onClick={() => dispatch({ type: "toggleSettings", open: !panelOpen })}
        className="mb-0.5 flex h-8 max-w-40 shrink-0 items-center gap-1.5 rounded-full ps-1.5 pe-2.5 text-[13px] font-medium leading-[18px] text-ink outline-none transition-colors duration-[120ms] hover:bg-ink/[0.06] active:bg-ink/[0.08] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus motion-reduce:transition-none">
        <BotAvatar bot={bot} size={20} />
        <span dir="auto" className="min-w-0 truncate">{bot.name}</span>
      </button>
      <div ref={scroller} role="tablist" aria-label={t("task.namedList", { name: bot.name })} onKeyDown={onKey} onScroll={measure} onWheel={scrollSideways}
        style={{ maskImage: fade, WebkitMaskImage: fade }}
        className="relative flex h-full min-w-0 items-end gap-0.5 overflow-x-auto overflow-y-hidden px-2.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {indicator.box && <span aria-hidden="true" data-tab-indicator data-glide={indicator.glide ? "" : undefined} className="thread-tab-indicator"
          style={{ transform: `translateX(${indicator.box.left}px)`, width: indicator.box.width }} />}
        {shown.map((tab) => {
          const selected = tab.threadId === active && !tab.leaving;
          const title = tab.draft ? t("task.newShort") : localizedTaskTitle(tab.title);
          const closable = tab.closable && canWrite && !tab.leaving;
          return (
            <div key={tab.threadId} role="tab" data-tab-id={tab.threadId} aria-selected={selected} tabIndex={selected ? 0 : -1} title={title}
              data-entering={entering.has(tab.threadId) ? "" : undefined} data-leaving={tab.leaving ? "" : undefined} aria-hidden={tab.leaving || undefined}
              onClick={() => { if (renaming !== tab.threadId) open(tab); }} onDoubleClick={() => startRename(tab)}
              onMouseDown={(event) => { if (event.button === 1) event.preventDefault(); }} onAuxClick={(event) => onAuxClick(event, tab)}
              className={cn(TAB, selected ? "font-medium text-ink" : "cursor-default text-ink-secondary hover:text-ink")}>
              {renaming === tab.threadId ? (
                <input autoFocus dir="auto" value={draft} maxLength={80} aria-label={t("task.renameAria")}
                  onFocus={(event) => event.currentTarget.select()} onChange={(event) => setDraft(event.target.value)}
                  onBlur={() => finishRename(tab, true, false)} onClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); finishRename(tab, true, true); }
                    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); finishRename(tab, false, true); }
                  }}
                  className="-ms-1.5 h-6 w-32 min-w-0 rounded-md border border-focus bg-transparent px-1.5 text-[13px] text-ink outline-none" />
              ) : (
                <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
                  {tab.working ? <span role="img" aria-label={t("chat.activity.working")} className="size-1.5 shrink-0 animate-pulse rounded-full bg-success motion-reduce:animate-none" />
                    : tab.pinned ? <Pin size={10} role="img" aria-label={t("task.pinned")} className="shrink-0 text-ink-tertiary" /> : null}
                  <span data-tab-label className="grid min-w-0">
                    <span dir="auto" className="col-start-1 row-start-1 truncate">{title}</span>
                    <span aria-hidden="true" className="invisible col-start-1 row-start-1 truncate font-medium">{title}</span>
                  </span>
                </span>
              )}
              {renaming === tab.threadId ? null : !closable ? <span aria-hidden="true" className="ms-1 size-5 shrink-0" /> : (
                <button type="button" tabIndex={-1} aria-label={t("sidebar.threads.hide", { title })} title={t("sidebar.threads.hideShort")}
                  onClick={(event) => { event.stopPropagation(); close(tab); }} onDoubleClick={(event) => event.stopPropagation()}
                  className={cn(CLOSE, selected && "pointer-events-auto opacity-100")}>
                  <X size={12} aria-hidden="true" />
                </button>
              )}
            </div>
          );
        })}
      </div>
      {canWrite && (
        <button type="button" data-thread-tabs-new aria-label={t("task.newShort")} title={t("task.newShort")} onClick={() => dispatch({ type: "newTask", botId: bot.id })}
          className="mb-0.5 flex size-8 shrink-0 items-center justify-center rounded-full text-ink-secondary transition-colors duration-[120ms] hover:bg-ink/[0.06] hover:text-ink active:bg-ink/[0.08] motion-reduce:transition-none">
          <Plus size={16} aria-hidden="true" />
        </button>
      )}
      <UndoToast toast={toast} onDone={() => setToast(null)} />
    </div>
  );
}
