import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Brain, ChevronDown, EyeOff, Pencil, SquarePen, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { nextRename } from "@/lib/rename";
import { localizedTaskTitle } from "@/lib/task-title";
import { neighbourTab, threadTabsModel, type TabThread, type ThreadTab, type ThreadTabsModel } from "@/lib/thread-tabs";
import { setThreadTabOpened, useOpenedThreadTabs } from "@/lib/thread-tab-preferences";
import { usePopoverDismiss } from "@/hooks/use-popover-dismiss";
import type { Bot } from "@/state/store";
import { useStoreDispatch } from "@/state/store-select";
import { MENU_ITEM, MENU_SHEET } from "./menu-recipe";
import { useHeldMenuMotion } from "./MenuMotion";
import { SidebarPopoverMenu, type SidebarMenuItem } from "./SidebarPopoverMenu";

type TabsBot = Pick<Bot, "id" | "name" | "threadId" | "switchingTo" | "tasks">;

/** The factory titles a thread starts with, before its first message names it. */
const UNTITLED = new Set(["New thread", "New task", ""]);

export function useThreadTabs(bot: TabsBot): ThreadTabsModel {
  const opened = useOpenedThreadTabs();
  return useMemo(() => threadTabsModel(bot, opened), [bot.threadId, bot.switchingTo, bot.tasks, opened]);
}

function tabLabel(tab: Pick<ThreadTab, "main" | "title">): string {
  if (tab.main) return t("threadTabs.main");
  return UNTITLED.has(tab.title) ? t("task.newShort") : localizedTaskTitle(tab.title);
}

function threadLabel(task: TabThread, mainId: string): string {
  return tabLabel({ main: task.threadId === mainId, title: task.title });
}

export function NewThreadHeaderButton({ botId }: { botId: string }) {
  const dispatch = useStoreDispatch();
  return (
    <button
      type="button"
      data-new-thread
      onClick={() => dispatch({ type: "newTask", botId })}
      aria-label={t("task.newShort")}
      title={t("task.newShort")}
      className="flex size-9 shrink-0 items-center justify-center rounded-full text-ink-secondary transition-colors duration-[120ms] hover:bg-ink/[0.06] hover:text-ink active:bg-ink/[0.08] motion-reduce:transition-none"
    >
      <SquarePen size={16} aria-hidden="true" />
    </button>
  );
}

type Toast = { text: string; undo: () => void };
type Menu = { threadId: string; left: number; top: number };

const LABEL_YIELDS = "group-hover/tab:[mask-image:linear-gradient(to_left,transparent_30px,black_46px)] group-focus-within/tab:[mask-image:linear-gradient(to_left,transparent_30px,black_46px)] rtl:group-hover/tab:[mask-image:linear-gradient(to_right,transparent_30px,black_46px)] rtl:group-focus-within/tab:[mask-image:linear-gradient(to_right,transparent_30px,black_46px)]";
const TAB = "group/tab relative flex h-9 shrink-0 items-center rounded-xl text-[13px] leading-[18px] transition-colors duration-[120ms] motion-reduce:transition-none";

/** A bot's threads as tabs under the chat header. Shown only once the bot has two open threads, or a hidden one. */
export function ThreadTabs({ bot, model }: { bot: TabsBot; model: ThreadTabsModel }) {
  const dispatch = useStoreDispatch();
  const listRef = useRef<HTMLDivElement>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const finishing = useRef(false);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const { tabs, selected, mainId } = model;

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 6000);
    return () => window.clearTimeout(timer);
  }, [toast]);
  useEffect(() => { setRenaming(null); setMenu(null); }, [bot.id]);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const reveal = () => {
      const tab = list.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
      if (!tab) return;
      const box = list.getBoundingClientRect(), at = tab.getBoundingClientRect();
      if (at.left < box.left) list.scrollLeft -= box.left - at.left + 16;
      else if (at.right > box.right) list.scrollLeft += at.right - box.right + 16;
    };
    reveal();
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(reveal);
    resize?.observe(list);
    return () => resize?.disconnect();
  }, [selected, tabs.length]);

  const open = (threadId: string) => {
    if (threadId === selected) return;
    dispatch({ type: "switchTask", botId: bot.id, threadId });
  };
  const focusTab = (threadId: string) => requestAnimationFrame(() =>
    listRef.current?.querySelector<HTMLElement>(`[role="tab"][data-thread-tab="${CSS.escape(threadId)}"]`)?.focus());

  const hide = (tab: ThreadTab) => {
    if (tab.main) return;
    setMenu(null);
    if (tab.threadId === selected) {
      const next = neighbourTab(tabs, tab.threadId);
      if (next) open(next.threadId);
    }
    if (tab.blank) return;
    const label = tabLabel(tab);
    if (tab.auto) setThreadTabOpened(tab.threadId, false);
    else dispatch({ type: "updateTask", botId: bot.id, threadId: tab.threadId, patch: { archivedAt: Date.now() } });
    setToast({
      text: t("threadTabs.hidden", { title: label }),
      undo: () => {
        if (tab.auto) setThreadTabOpened(tab.threadId, true);
        else dispatch({ type: "updateTask", botId: bot.id, threadId: tab.threadId, patch: { archivedAt: null } });
        dispatch({ type: "switchTask", botId: bot.id, threadId: tab.threadId });
      },
    });
  };

  const startRename = (tab: ThreadTab) => {
    if (tab.main || tab.blank) return;
    setMenu(null);
    finishing.current = false;
    setDraft(UNTITLED.has(tab.title) ? "" : tab.title);
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

  const onTabKey = (event: ReactKeyboardEvent, tab: ThreadTab, index: number) => {
    const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
    const step = event.key === "ArrowRight" ? (rtl ? -1 : 1) : event.key === "ArrowLeft" ? (rtl ? 1 : -1) : 0;
    const to = step ? tabs[(index + step + tabs.length) % tabs.length]
      : event.key === "Home" ? tabs[0] : event.key === "End" ? tabs[tabs.length - 1] : undefined;
    if (to) {
      event.preventDefault();
      open(to.threadId);
      focusTab(to.threadId);
    } else if (event.key === "F2") {
      event.preventDefault();
      startRename(tab);
    } else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();
      const at = event.currentTarget.getBoundingClientRect();
      setMenu({ threadId: tab.threadId, left: at.left, top: at.bottom + 4 });
    } else if (event.key === "Delete" && !tab.main) {
      event.preventDefault();
      hide(tab);
    }
  };

  const allItems = useMemo((): SidebarMenuItem[] => {
    const state = (text: string) => <span className="shrink-0 text-[12px] leading-4 text-ink-tertiary">{text}</span>;
    const yours = model.yours.map(({ task, open: isOpen }, index): SidebarMenuItem => ({
      key: task.threadId,
      label: threadLabel(task, mainId),
      heading: index === 0 ? t("threadTabs.yours") : undefined,
      active: task.threadId === selected,
      trailing: state(isOpen ? t("threadTabs.open") : t("threadTabs.hiddenState")),
      onSelect: () => {
        if (task.archivedAt !== undefined) dispatch({ type: "updateTask", botId: bot.id, threadId: task.threadId, patch: { archivedAt: null } });
        open(task.threadId);
      },
    }));
    const auto = model.auto.map((task, index): SidebarMenuItem => ({
      key: task.threadId,
      label: threadLabel(task, mainId),
      heading: index === 0 ? t("threadTabs.onItsOwn") : undefined,
      separatorBefore: index === 0 && yours.length > 0,
      active: task.threadId === selected,
      trailing: task.routineRunId ? state(t("threadTabs.routine")) : task.openedBy && task.openedBy.botId !== bot.id ? state(task.openedBy.name) : undefined,
      onSelect: () => {
        setThreadTabOpened(task.threadId, true);
        if (task.archivedAt !== undefined) dispatch({ type: "updateTask", botId: bot.id, threadId: task.threadId, patch: { archivedAt: null } });
        open(task.threadId);
      },
    }));
    return [...yours, ...auto];
  }, [model, selected, bot.id, dispatch]);

  const menuTab = menu ? tabs.find((tab) => tab.threadId === menu.threadId) : undefined;

  return (
    <div data-thread-tabs className="flex min-w-0 items-center gap-1 border-b border-hairline bg-app px-3 pb-1.5 max-md:px-2">
      <div
        ref={listRef}
        role="tablist"
        aria-label={t("threadTabs.aria", { name: bot.name })}
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overscroll-x-contain pe-4 [mask-image:linear-gradient(to_left,transparent,black_16px)] [scrollbar-width:none] rtl:[mask-image:linear-gradient(to_right,transparent,black_16px)] [&::-webkit-scrollbar]:hidden"
      >
        {tabs.map((tab, index) => {
          const current = tab.threadId === selected;
          const label = tab.blank ? t("task.newShort") : tabLabel(tab);
          const closable = !tab.main;
          return (
            <div
              key={tab.threadId}
              role="presentation"
              className={cn(TAB, current ? "bg-raised font-medium text-ink" : "text-ink-secondary hover:bg-ink/[0.06] hover:text-ink active:bg-ink/[0.08]")}
            >
              {renaming === tab.threadId ? (
                <input
                  autoFocus
                  dir="auto"
                  value={draft}
                  maxLength={80}
                  aria-label={t("threadTabs.renameAria")}
                  placeholder={label}
                  onFocus={(event) => event.currentTarget.select()}
                  onChange={(event) => setDraft(event.target.value)}
                  onBlur={() => finishRename(tab, true, false)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); finishRename(tab, true, true); }
                    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); finishRename(tab, false, true); }
                  }}
                  style={{ width: `calc(${Math.min(Math.max(draft.length, label.length, 8), 30)}ch + 30px)` }}
                  className="h-9 min-w-0 rounded-xl border border-focus bg-transparent px-3.5 text-[13px] leading-[18px] text-ink outline-none"
                />
              ) : (
                <button
                  type="button"
                  role="tab"
                  data-thread-tab={tab.threadId}
                  aria-selected={current}
                  tabIndex={current ? 0 : -1}
                  title={tab.main || tab.blank ? label : `${label}\n${t("threadTabs.renameHint")}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => open(tab.threadId)}
                  onDoubleClick={() => startRename(tab)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    open(tab.threadId);
                    setMenu({ threadId: tab.threadId, left: event.clientX, top: event.currentTarget.getBoundingClientRect().bottom + 4 });
                  }}
                  onKeyDown={(event) => onTabKey(event, tab, index)}
                  className={cn("flex h-9 min-w-0 max-w-[240px] items-center rounded-xl ps-3.5 outline-none focus-visible:ring-2 focus-visible:ring-focus", closable && current ? "pe-8 touch:pe-10" : "pe-3.5")}
                >
                  <span dir="auto" className={cn("grid min-w-0", closable && !current && LABEL_YIELDS)}>
                    {/* Holds the width of the weight-500 label, so selecting a tab never nudges its neighbours. */}
                    <span aria-hidden="true" className="invisible col-start-1 row-start-1 truncate font-medium">{label}</span>
                    <span className="col-start-1 row-start-1 truncate">{label}</span>
                  </span>
                </button>
              )}
              {closable && renaming !== tab.threadId && (
                <button
                  type="button"
                  tabIndex={-1}
                  aria-label={t("threadTabs.hideNamed", { title: label })}
                  title={t("threadTabs.hide")}
                  onClick={() => hide(tab)}
                  className={cn(
                    "absolute end-1.5 flex size-6 items-center justify-center rounded-md text-ink-tertiary transition-opacity duration-[120ms] hover:bg-ink/[0.06] hover:text-ink motion-reduce:transition-none",
                    current ? "opacity-100 touch:size-8" : "pointer-events-none opacity-0 group-hover/tab:pointer-events-auto group-hover/tab:opacity-100 group-focus-within/tab:opacity-100",
                  )}
                >
                  <X size={14} aria-hidden="true" />
                </button>
              )}
            </div>
          );
        })}
      </div>
      <SidebarPopoverMenu
        items={allItems}
        ariaLabel={t("task.switch")}
        align="end"
        triggerClassName="flex h-9 shrink-0 items-center gap-1 rounded-xl ps-3 pe-2.5 text-[13px] text-ink-tertiary transition-colors duration-[120ms] motion-reduce:transition-none hover:bg-ink/[0.06] hover:text-ink active:bg-ink/[0.08] aria-expanded:bg-ink/[0.06] aria-expanded:text-ink"
        renderTrigger={() => <>
          <span className="whitespace-nowrap max-md:sr-only">{t("task.switch")}</span>
          <ChevronDown size={14} aria-hidden="true" />
        </>}
      />
      {menuTab && <TabMenu
        place={menu!}
        tab={menuTab}
        label={tabLabel(menuTab)}
        onClose={(refocus) => { setMenu(null); if (refocus) focusTab(menuTab.threadId); }}
        onRename={() => startRename(menuTab)}
        onHide={() => hide(menuTab)}
        onRemember={() => { setMenu(null); dispatch({ type: "toggleSettings", open: true, section: "memory", botId: bot.id }); }}
      />}
      {toast && createPortal(
        <div role="status" className="fixed bottom-4 start-[calc(var(--rail-beside,0px)_+_1rem)] z-[60] flex max-w-[340px] items-center gap-3 rounded-xl border border-hairline/50 bg-card px-3.5 py-2.5 text-[13px] text-ink shadow-xl animate-fade-in motion-reduce:animate-none">
          <span className="min-w-0 line-clamp-2">{toast.text}</span>
          <button type="button" onClick={() => { toast.undo(); setToast(null); }} className="shrink-0 rounded-md px-1.5 py-0.5 font-medium text-accent-text hover:bg-ink/[0.06]">
            {t("common.undo")}
          </button>
        </div>,
        document.body,
      )}
    </div>
  );
}

function TabMenu({ place, tab, label, onClose, onRename, onHide, onRemember }: {
  place: Menu; tab: ThreadTab; label: string; onClose: (refocus: boolean) => void; onRename: () => void; onHide: () => void; onRemember: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const motion = useHeldMenuMotion(place);
  usePopoverDismiss(true, ref, () => onClose(false));
  const [at, setAt] = useState({ left: place.left, top: place.top });
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    setAt({ left: Math.max(8, Math.min(place.left, window.innerWidth - box.width - 8)), top: Math.max(8, Math.min(place.top, window.innerHeight - box.height - 8)) });
    ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [place.left, place.top]);
  const keys = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
    const now = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "ArrowDown" ? (now + 1) % items.length : event.key === "ArrowUp" ? (now - 1 + items.length) % items.length
      : event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : null;
    if (next !== null) { event.preventDefault(); items[next]?.focus(); }
    else if (event.key === "Escape" && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); onClose(true); }
    else if (event.key === "Tab") { event.preventDefault(); onClose(true); }
  };
  const row = cn(MENU_ITEM, "text-ink hover:bg-menu-hover");
  return createPortal(
    <div ref={ref} role="menu" aria-label={label} onKeyDown={keys} style={{ left: at.left, top: at.top }}
      className={cn("fixed z-[60] min-w-[200px]", MENU_SHEET, motion.className)} {...motion.exitProps}>
      {!tab.main && !tab.blank && <button type="button" role="menuitem" onClick={onRename} className={row}><Pencil size={16} aria-hidden="true" className="text-ink-secondary" />{t("threadTabs.rename")}</button>}
      <button type="button" role="menuitem" onClick={onRemember} className={row}><Brain size={16} aria-hidden="true" className="text-ink-secondary" />{t("threadTabs.remember")}</button>
      {!tab.main && <button type="button" role="menuitem" onClick={onHide} className={row}><EyeOff size={16} aria-hidden="true" className="text-ink-secondary" />{t("threadTabs.hide")}</button>}
    </div>,
    document.body,
  );
}
