import { Archive, Check, ChevronRight, Plus, Star, Trash2 } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { isTypeaheadKey, typeaheadMatch, typeaheadText, type Typeahead } from "@/lib/menu-keys";
import { localizedTaskTitle } from "@/lib/task-title";
import { usePopoverDismiss } from "@/hooks/use-popover-dismiss";
import type { Action, Bot, Task } from "@/state/store";
import { botOpensTo } from "@/state/thread-navigation";
import { ConfirmDialog } from "./ConfirmDialog";
import { MENU_GUTTER, MENU_ICON, MENU_META, MENU_ROW, MENU_SEPARATOR, MENU_SHEET } from "./menu-recipe";
import { useHeldMenuMotion } from "./MenuMotion";
import { isArchived, isSnoozed, isWorking, nextSnoozeExpiry, threadRecency, threadRowActions, threadUpdatedLabel, useSnoozeExpiry } from "./SidebarThreadRow";

export const PEEK_LIMIT = 3;
const SHEET_WIDTH = 240;
const EDGE = 8;

type PeekBot = Pick<Bot, "id" | "name" | "threadId" | "switchingTo" | "mainThreadId" | "tasks">;

export function peekThreads(bot: Pick<PeekBot, "threadId" | "mainThreadId" | "tasks">, current?: string): Task[] {
  const main = botOpensTo(bot, false);
  const others = (bot.tasks ?? [])
    .filter((task) => task.threadId !== main && !task.routineRunId && !task.openedBy?.burstId && !task.closedBy && !isArchived(task) && !isSnoozed(task))
    .sort((a, b) => threadRecency(b) - threadRecency(a));
  return [
    ...(bot.tasks ?? []).filter((task) => task.threadId === main),
    ...others.filter((task, index) => index < PEEK_LIMIT || task.threadId === current),
  ];
}

type Place = { left: number; top: number };

export function peekPlace(row: Pick<DOMRect, "left" | "right" | "top">, rows: number, viewport: { width: number; height: number }, rtl: boolean): Place {
  const height = rows * 30 + 24;
  const left = rtl ? row.left - SHEET_WIDTH : row.right;
  return {
    left: Math.max(EDGE, Math.min(left, viewport.width - SHEET_WIDTH - EDGE)),
    top: Math.max(EDGE, Math.min(row.top, viewport.height - height - EDGE)),
  };
}

const SLOT = "pointer-events-none absolute end-[30px] top-1.5 flex size-6 items-center justify-center rounded-lg text-ink-secondary opacity-0 transition-opacity hover:bg-raised hover:text-ink group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 max-md:hidden touch:pointer-events-auto touch:opacity-70 motion-reduce:transition-none";

const ROW_ACTIONS = "pointer-events-none absolute end-2 top-1/2 flex -translate-y-1/2 items-center gap-1 opacity-0 transition-opacity group-hover/peek:pointer-events-auto group-hover/peek:opacity-100 group-focus-within/peek:pointer-events-auto group-focus-within/peek:opacity-100 touch:pointer-events-auto touch:opacity-100 motion-reduce:transition-none";
const ROW_ACTION = "flex size-6 items-center justify-center rounded-md text-ink-secondary hover:bg-ink/[0.06] hover:text-ink focus-visible:bg-ink/[0.06] focus-visible:text-ink active:bg-ink/[0.08] disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-ink-secondary touch:size-10";
const ROW_TIME = "min-w-13 text-end tabular-nums";
const ROW_TIME_YIELDS = "transition-opacity group-hover/peek:opacity-0 group-focus-within/peek:opacity-0 touch:min-w-21 touch:opacity-0 motion-reduce:transition-none";

export function SidebarBotThreadsPeek({ bot, onScreen = false, dispatch }: { bot: PeekBot; onScreen?: boolean; dispatch: Dispatch<Action> }) {
  const main = botOpensTo(bot, false), current = onScreen ? bot.switchingTo ?? bot.threadId : undefined;
  const tasks = bot.tasks ?? [];
  useSnoozeExpiry(tasks);
  // A snooze ends by the clock alone, so the nearest deadline still ahead stands in for it.
  const wake = nextSnoozeExpiry(tasks);
  const threads = useMemo(() => peekThreads(bot, current), [bot.tasks, bot.mainThreadId, bot.threadId, current, wake]);
  const others = threads.filter((task) => task.threadId !== main).length;
  const [place, setPlace] = useState<Place | null>(null);
  const motion = useHeldMenuMotion(place);
  const anchor = useRef<HTMLButtonElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const focusSheet = useRef(false);
  const focusAnchor = useRef(false);
  const typed = useRef<Typeahead | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const deleting = deletingId ? bot.tasks?.find((task) => task.threadId === deletingId) : undefined;
  const labels = useId();
  const has = others > 0;
  const open = place !== null;

  // Opened by a click on the chevron only: resting the pointer on a row opens nothing.
  const close = () => setPlace(null);
  const show = () => {
    const row = anchor.current?.parentElement;
    if (!row) return;
    setPlace(peekPlace(row.getBoundingClientRect(), threads.length + 1, { width: window.innerWidth, height: window.innerHeight }, getComputedStyle(row).direction === "rtl"));
  };

  useEffect(() => {
    if (has) return;
    close();
    if (focusAnchor.current) anchor.current?.focus();
    focusAnchor.current = false;
  }, [has]);
  // Rows are taller on a touch screen, so the sheet's own height decides how far up it has to sit.
  useLayoutEffect(() => {
    const menu = sheet.current;
    if (!place || !menu) return;
    const fit = () => {
      const height = menu.offsetHeight;
      if (!height) return;
      const top = Math.max(EDGE, Math.min(place.top, window.innerHeight - height - EDGE));
      if (top !== place.top) setPlace({ ...place, top });
    };
    fit();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fit);
    observer?.observe(menu);
    return () => observer?.disconnect();
  }, [place, threads.length]);
  useEffect(() => {
    if (!open) return;
    if (focusSheet.current) { focusSheet.current = false; sheet.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus(); }
    const away = (event: Event) => { if (!(event.target instanceof Node) || event.target.contains(anchor.current)) close(); };
    window.addEventListener("resize", close);
    window.addEventListener("scroll", away, true);
    return () => { window.removeEventListener("resize", close); window.removeEventListener("scroll", away, true); };
  }, [open]);
  const root = useRef({ contains: (target: unknown) => target instanceof Node && Boolean(sheet.current?.contains(target) || anchor.current?.contains(target)) });
  usePopoverDismiss(open, root, () => {
    if (sheet.current?.contains(document.activeElement)) anchor.current?.focus();
    close();
  });

  const actions = threadRowActions(bot.id, dispatch);
  const confirm = <ConfirmDialog open={deleting !== undefined} title={t("task.deleteConfirm")} body={t("task.deleteBody", { title: deleting?.title ?? "" })} confirmLabel={t("task.deleteAria")}
    onCancel={() => setDeletingId(null)} onConfirm={() => { if (deleting && !isWorking(deleting)) actions.onDelete(deleting); setDeletingId(null); }} returnFocusRef={anchor} />;
  const slot = cn(SLOT, open && "pointer-events-auto opacity-100");
  if (!has) {
    return <><button ref={anchor} type="button" data-bot-new-thread={bot.id} aria-label={t("task.newShort")} title={t("task.newShort")}
      onClick={() => dispatch({ type: "newTask", botId: bot.id })} className={slot}><Plus size={14} /></button>{confirm}</>;
  }

  const pick = (action: Action) => { close(); dispatch(action); };
  const archive = (task: Task, event: ReactMouseEvent) => {
    if (event.detail === 0) {
      if (others === 1) focusAnchor.current = true;
      else sheet.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    }
    actions.onArchive(task, Date.now());
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(sheet.current?.querySelectorAll<HTMLElement>("[role=menuitem]:not([data-peek-action])") ?? []);
    const focused = document.activeElement as HTMLElement | null;
    const row = focused?.closest("[data-peek-row]");
    const at = items.indexOf(row?.querySelector<HTMLElement>("[data-peek-thread]") ?? focused!);
    if (row && (event.key === "ArrowRight" || event.key === "ArrowLeft")) {
      event.preventDefault();
      const across = Array.from(row.querySelectorAll<HTMLElement>("[role=menuitem]:not(:disabled)"));
      const forward = (event.key === "ArrowRight") !== (getComputedStyle(row).direction === "rtl");
      across[(across.indexOf(focused!) + (forward ? 1 : across.length - 1)) % across.length]?.focus();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      items[(at + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      items[event.key === "Home" ? 0 : items.length - 1]?.focus();
    } else if (event.key === "Tab") {
      anchor.current?.focus();
      close();
    } else if (isTypeaheadKey(event)) {
      typed.current = typeaheadText(typed.current, event.key, event.timeStamp);
      const match = typeaheadMatch(items.map((item) => item.textContent ?? ""), at, typed.current.text);
      if (match !== null) {
        event.preventDefault();
        items[match]?.focus();
      }
    }
  };
  const now = Date.now();
  const shown = motion.value;
  return (
    <>
      <button ref={anchor} type="button" data-bot-threads-peek={bot.id} aria-haspopup="menu" aria-expanded={open}
        aria-label={t("task.expandNamed", { name: bot.name })} title={open ? undefined : t("task.expandNamed", { name: bot.name })}
        onClick={(event) => { if (open) { close(); return; } focusSheet.current = event.detail === 0; show(); }} className={slot}>
        <ChevronRight size={14} className="rtl:-scale-x-100" />
      </button>
      {motion.shown && shown && createPortal(
        <div ref={sheet} role="menu" aria-label={bot.name} data-bot-threads-sheet={bot.id} style={{ left: shown.left, top: shown.top, width: SHEET_WIDTH }}
          onKeyDown={onKeyDown}
          className={cn(MENU_SHEET, "fixed z-[60] gap-0", motion.className)} {...motion.exitProps}>
          <button type="button" role="menuitem" className={MENU_ROW} onClick={() => pick({ type: "newTask", botId: bot.id })}>
            <span className={MENU_GUTTER}><Plus size={14} className={MENU_ICON} /></span>
            <span className="min-w-0 flex-1 truncate">{t("task.newShort")}</span>
          </button>
          <div role="separator" className={MENU_SEPARATOR} />
          {threads.map((task) => {
            const waiting = task.activity === "waiting-on-you";
            const mark = waiting ? t("sidebar.preview.waiting") : task.unread ? t("task.unread") : undefined;
            const isMain = task.threadId === main, isCurrent = task.threadId === current;
            const working = isWorking(task);
            const titleId = `${labels}${task.threadId}`;
            return (
              <div key={task.threadId} role="none" data-peek-row="" className="group/peek relative shrink-0 rounded-md hover:bg-ink/[0.06] focus-within:bg-ink/[0.06]">
                <button type="button" role="menuitem" data-peek-thread={task.threadId} aria-current={isCurrent ? "page" : undefined}
                  className={cn(MENU_ROW, "hover:bg-transparent focus:bg-transparent")} onClick={() => pick({ type: "switchTask", botId: bot.id, threadId: task.threadId })}>
                  <span className={MENU_GUTTER}>
                    {isCurrent ? <Check size={14} className="text-accent" aria-hidden="true" />
                      : mark ? <span role="img" aria-label={mark} title={mark} className={cn("size-1.5 rounded-full", waiting ? "bg-warning" : "bg-accent")} />
                      : isMain && <span role="img" aria-label={t("sidebar.bot.simple.mainThread")} title={t("sidebar.bot.simple.mainThread")}><Star size={14} className={MENU_ICON} aria-hidden="true" /></span>}
                  </span>
                  <span id={titleId} className="min-w-0 flex-1 truncate">{localizedTaskTitle(task.title) || t("task.untitledConversation")}</span>
                  <span className={cn(MENU_META, ROW_TIME, !isMain && ROW_TIME_YIELDS)}>{threadUpdatedLabel(threadRecency(task), now)}</span>
                </button>
                {!isMain && <span className={ROW_ACTIONS}>
                  <button type="button" role="menuitem" data-peek-action="archive" id={`${titleId}a`} aria-label={t("task.archive")} aria-labelledby={`${titleId}a ${titleId}`} title={t("task.archive")}
                    disabled={working} className={ROW_ACTION} onClick={(event) => archive(task, event)}><Archive size={14} aria-hidden="true" /></button>
                  <button type="button" role="menuitem" data-peek-action="delete" id={`${titleId}d`} aria-label={t("task.deleteAria")} aria-labelledby={`${titleId}d ${titleId}`} title={t("task.deleteAria")}
                    disabled={working} className={cn(ROW_ACTION, "hover:text-danger focus-visible:text-danger")} onClick={() => { close(); setDeletingId(task.threadId); }}><Trash2 size={14} aria-hidden="true" /></button>
                </span>}
              </div>
            );
          })}
        </div>,
        document.body,
      )}
      {confirm}
    </>
  );
}
