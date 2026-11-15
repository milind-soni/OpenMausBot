import { ChevronRight, Plus } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type Dispatch, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { localizedTaskTitle } from "@/lib/task-title";
import { usePopoverDismiss } from "@/hooks/use-popover-dismiss";
import type { Action, Bot, Task } from "@/state/store";
import { botOpensTo } from "@/state/thread-navigation";
import { MENU_GUTTER, MENU_ICON, MENU_META, MENU_ROW, MENU_SEPARATOR, MENU_SHEET } from "./menu-recipe";
import { useHeldMenuMotion } from "./MenuMotion";
import { isArchived, isSnoozed, threadRecency, threadUpdatedLabel } from "./SidebarThreadRow";

export const PEEK_LIMIT = 3;
/** Long enough that sweeping the pointer down the list opens nothing. */
export const PEEK_OPEN_MS = 350;
/** Long enough to cross from the row onto the sheet. */
export const PEEK_CLOSE_MS = 200;
const SHEET_WIDTH = 240;
const EDGE = 8;

type PeekBot = Pick<Bot, "id" | "name" | "threadId" | "mainThreadId" | "tasks">;

/** The bot's open conversations other than the one its row opens, newest first. */
export function peekThreads(bot: Pick<PeekBot, "threadId" | "mainThreadId" | "tasks">): Task[] {
  const rowThread = botOpensTo(bot, false);
  return (bot.tasks ?? [])
    .filter((task) => task.threadId !== rowThread && !task.routineRunId && !task.openedBy?.burstId && !task.closedBy && !isArchived(task) && !isSnoozed(task))
    .sort((a, b) => threadRecency(b) - threadRecency(a))
    .slice(0, PEEK_LIMIT);
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

const SLOT = "pointer-events-none absolute right-[30px] top-1.5 flex size-6 items-center justify-center rounded-lg text-ink-secondary opacity-0 transition-opacity hover:bg-raised hover:text-ink group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 max-md:hidden touch:pointer-events-auto touch:opacity-70 motion-reduce:transition-none";

/** Beside a Simple row's "…": a "+" for a bot with one conversation, else the disclosure of a sheet listing its other open ones, which hovering the row also opens. */
export function SidebarBotThreadsPeek({ bot, dispatch }: { bot: PeekBot; dispatch: Dispatch<Action> }) {
  const threads = useMemo(() => peekThreads(bot), [bot.tasks, bot.mainThreadId, bot.threadId]);
  const [place, setPlace] = useState<Place | null>(null);
  const motion = useHeldMenuMotion(place);
  const anchor = useRef<HTMLButtonElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const focusSheet = useRef(false);
  const has = threads.length > 0;
  const open = place !== null;

  const cancel = () => window.clearTimeout(timer.current);
  const close = () => { cancel(); setPlace(null); };
  const show = () => {
    cancel();
    const row = anchor.current?.parentElement;
    if (!row) return;
    setPlace(peekPlace(row.getBoundingClientRect(), threads.length + 1, { width: window.innerWidth, height: window.innerHeight }, getComputedStyle(row).direction === "rtl"));
  };
  const later = (run: () => void, ms: number) => { cancel(); timer.current = window.setTimeout(run, ms); };

  useEffect(() => cancel, []);
  useEffect(() => { if (!has) close(); }, [has]);
  // React reports entering the sheet while the pointer is still leaving the row, so each side checks where the pointer went.
  const within = (target: EventTarget | null) => target instanceof Node && Boolean(sheet.current?.contains(target) || anchor.current?.parentElement?.contains(target));
  const leave = (event: Pick<PointerEvent, "pointerType" | "relatedTarget">) => { if (event.pointerType === "mouse" && !within(event.relatedTarget)) later(() => setPlace(null), PEEK_CLOSE_MS); };
  useEffect(() => {
    const row = anchor.current?.parentElement;
    if (!row || !has) return;
    // offsetParent is null while the disclosure is hidden, which it is on a phone-width window.
    const enter = (event: PointerEvent) => { if (event.pointerType === "mouse" && event.buttons === 0 && anchor.current?.offsetParent) later(show, PEEK_OPEN_MS); };
    row.addEventListener("pointerenter", enter);
    row.addEventListener("pointerleave", leave);
    return () => { row.removeEventListener("pointerenter", enter); row.removeEventListener("pointerleave", leave); };
  }, [has, threads.length]);
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

  const slot = cn(SLOT, open && "pointer-events-auto opacity-100");
  if (!has) {
    return <button ref={anchor} type="button" data-bot-new-thread={bot.id} aria-label={t("task.newShort")} title={t("task.newShort")}
      onClick={() => dispatch({ type: "newTask", botId: bot.id })} className={slot}><Plus size={14} /></button>;
  }

  const pick = (action: Action) => { close(); dispatch(action); };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(sheet.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? []);
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      items[(at + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      items[event.key === "Home" ? 0 : items.length - 1]?.focus();
    } else if (event.key === "Tab") {
      anchor.current?.focus();
      close();
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
          onPointerEnter={cancel} onPointerLeave={leave} onKeyDown={onKeyDown}
          className={cn(MENU_SHEET, "fixed z-[60] gap-0", motion.className)} {...motion.exitProps}>
          <button type="button" role="menuitem" className={MENU_ROW} onClick={() => pick({ type: "newTask", botId: bot.id })}>
            <span className={MENU_GUTTER}><Plus size={14} className={MENU_ICON} /></span>
            <span className="min-w-0 flex-1 truncate">{t("task.newShort")}</span>
          </button>
          <div role="separator" className={MENU_SEPARATOR} />
          {threads.map((task) => {
            const waiting = task.activity === "waiting-on-you";
            const mark = waiting ? t("sidebar.preview.waiting") : task.unread ? t("task.unread") : undefined;
            return (
              <button key={task.threadId} type="button" role="menuitem" data-peek-thread={task.threadId} aria-current={task.threadId === bot.threadId ? "page" : undefined}
                className={MENU_ROW} onClick={() => pick({ type: "switchTask", botId: bot.id, threadId: task.threadId })}>
                <span className={MENU_GUTTER}>{mark && <span role="img" aria-label={mark} title={mark} className={cn("size-1.5 rounded-full", waiting ? "bg-warning" : "bg-accent")} />}</span>
                <span className="min-w-0 flex-1 truncate">{localizedTaskTitle(task.title) || t("task.untitledConversation")}</span>
                <span className={cn(MENU_META, "tabular-nums")}>{threadUpdatedLabel(threadRecency(task), now)}</span>
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </>
  );
}
