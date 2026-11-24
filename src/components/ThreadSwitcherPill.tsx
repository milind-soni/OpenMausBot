import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type WheelEvent as ReactWheelEvent } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, Pin, Star } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { localizedTaskTitle } from "@/lib/task-title";
import type { Bot } from "@/state/store";
import { useStoreDispatch } from "@/state/store-select";
import { BOT_PANEL_ID } from "./bot-panel/side-panel";
import { ELEVATED_FLOAT } from "./elevated";
import { reducedMotion } from "./MenuMotion";
import { mainThreadFirst } from "./SidebarThreadRow";
import { openTabId, type ThreadTab } from "./thread-tabs";

const RESIZE_MS = 240;
const LIST_FADE = 40;
const NUDGE_WIDTH = 24;
const CLEAR_OF_CONTROLS = 24;
const WIDEST = 720;
const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
const PART = "flex h-full min-w-0 items-center rounded-full outline-none transition-colors duration-[120ms] hover:bg-ink/[0.06] active:bg-ink/[0.08] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus motion-reduce:transition-none";
/** At rest the bot's face and name carry no fill of their own: hovering them tints the whole pill, as the plain pill does. */
const FACE = "flex h-full items-center rounded-full outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus";
const NAME_HOVER = "transition-colors duration-[120ms] motion-reduce:transition-none has-[[data-chathead-pill]:hover]:bg-[color-mix(in_srgb,var(--color-composer),var(--color-ink)_7%)]";
const ICON = "size-7 shrink-0 justify-center text-ink-secondary hover:text-ink";
const NUDGE = "absolute inset-y-0 z-10 flex w-6 items-center justify-center rounded-full text-ink-tertiary outline-none transition-colors duration-[120ms] hover:text-ink motion-reduce:transition-none";
const CHIP = "flex h-7 max-w-42 shrink-0 items-center gap-1.5 rounded-full px-3 text-[13px] leading-[18px] outline-none transition-colors duration-[120ms] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus motion-reduce:transition-none";

/** The widest the open pill may be while staying centred in the header and clear of the controls on either side. */
function centredRoom(pill: HTMLElement): number {
  const row = pill.closest("[data-chathead-row]");
  const centre = row ? row.getBoundingClientRect().left + row.getBoundingClientRect().width / 2 : 0;
  let half = row ? row.getBoundingClientRect().width / 2 : WIDEST / 2;
  for (const side of row?.querySelectorAll<HTMLElement>("[data-chathead-controls]") ?? []) {
    const box = side.getBoundingClientRect();
    if (box.width === 0) continue;
    half = Math.min(half, box.left >= centre ? box.left - centre : centre - box.right);
  }
  return Math.max(0, Math.min(WIDEST, 2 * (half - CLEAR_OF_CONTROLS)));
}

/** Which ends of a sideways row hide threads, in reading order. */
function hiddenEnds(row: HTMLElement): { back: boolean; on: boolean } {
  const room = row.scrollWidth - row.clientWidth;
  if (room <= 1) return { back: false, on: false };
  const scrolled = Math.abs(row.scrollLeft);
  return { back: scrolled > 1, on: room - scrolled > 1 };
}

/** Fades the row toward each end that hides threads, clear under that end's arrow so the arrow never sits on text. */
function endsMask(ends: { back: boolean; on: boolean }, rtl: boolean): string | undefined {
  if (!ends.back && !ends.on) return undefined;
  const start = ends.back ? `transparent ${NUDGE_WIDTH}px, black ${NUDGE_WIDTH + LIST_FADE}px` : "black 0";
  const end = ends.on ? `black calc(100% - ${NUDGE_WIDTH + LIST_FADE}px), transparent calc(100% - ${NUDGE_WIDTH}px)` : "black 100%";
  return `linear-gradient(to ${rtl ? "left" : "right"}, ${start}, ${end})`;
}

/** Scrolls a chip to the middle of its row, so its neighbours show on both sides. */
function centreChip(row: HTMLElement, chip: HTMLElement | null) {
  if (!chip) return;
  const rowBox = row.getBoundingClientRect(), chipBox = chip.getBoundingClientRect();
  const by = chipBox.left + chipBox.width / 2 - (rowBox.left + rowBox.width / 2);
  if (Math.abs(by) > 1) row.scrollBy?.({ left: by, behavior: reducedMotion() ? "auto" : "smooth" });
}

export const tabTitle = (tab: ThreadTab): string => (tab.draft ? t("task.newShort") : !tab.title || tab.title === "New thread" ? t("task.untitledChat") : localizedTaskTitle(tab.title));

/** The pill's width glides from what it was to what its new content needs, then lets go. */
function useGlidingWidth(key: unknown) {
  const box = useRef<HTMLDivElement>(null);
  const last = useRef<number | null>(null);
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    element.style.transition = "";
    element.style.width = "";
    const to = element.getBoundingClientRect().width;
    const from = last.current;
    last.current = to;
    if (from === null || Math.abs(from - to) < 1 || reducedMotion()) return;
    element.style.width = `${from}px`;
    void element.offsetWidth;
    element.style.transition = `width ${RESIZE_MS}ms ${EASE}`;
    element.style.width = `${to}px`;
    const done = window.setTimeout(() => { element.style.transition = ""; element.style.width = ""; }, RESIZE_MS);
    return () => { window.clearTimeout(done); element.style.transition = ""; element.style.width = ""; };
  }, [key]);
  return box;
}

const OVERLAY = '[role="dialog"], [role="alertdialog"], [aria-modal="true"], [role="menu"], [popover]';
function overlayOpen(target: EventTarget | null) {
  return (target instanceof Element && Boolean(target.closest(OVERLAY))) || Boolean(document.querySelector('[aria-modal="true"]'));
}

/**
 * Simple mode's pill for a bot with two threads or more: its face and name open the bot panel as ever, a chevron beside
 * them widens the pill in place into the bot's threads (its main thread first) and folds it back. It stays open while
 * the person moves between threads, until the chevron or Escape folds it or they leave the bot. New thread stays at the
 * header's end, as for any bot.
 */
export function ThreadSwitcherPill({ bot, tabs, head, label, panelOpen, onToggle }: {
  bot: Bot; tabs: ThreadTab[]; head: ReactNode; label: string; panelOpen: boolean; onToggle: () => void;
}) {
  const dispatch = useStoreDispatch();
  const [openFor, setOpenFor] = useState<string | null>(null);
  const open = openFor === bot.id;
  const setOpen = (value: boolean) => setOpenFor(value ? bot.id : null);
  useEffect(() => setOpenFor((was) => (was === bot.id ? was : null)), [bot.id]);
  const [room, setRoom] = useState(WIDEST);
  const box = useGlidingWidth(open);
  const list = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const [fade, setFade] = useState<string | undefined>();
  const [ends, setEnds] = useState({ back: false, on: false });
  const active = openTabId(bot);
  const main = bot.mainThreadId;
  const shown = useMemo(() => mainThreadFirst(tabs, main), [tabs, main]);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) requestAnimationFrame(() => toggle.current?.focus());
  };
  const measure = useCallback(() => {
    const row = list.current;
    if (!row) return;
    const next = hiddenEnds(row);
    setFade(endsMask(next, getComputedStyle(row).direction === "rtl"));
    setEnds((was) => (was.back === next.back && was.on === next.on ? was : next));
  }, []);
  useEffect(() => {
    if (!open) return;
    const resize = () => { if (box.current) setRoom(centredRoom(box.current)); measure(); };
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [open, measure]);
  useLayoutEffect(() => {
    if (!open || !list.current) return;
    const row = list.current;
    row.scrollLeft = 0;
    const chip = row.querySelector<HTMLElement>('[aria-selected="true"]') ?? row.querySelector<HTMLElement>("[role=option]");
    chip?.focus({ preventScroll: true });
    const settle = window.setTimeout(() => {
      centreChip(row, chip);
      measure();
    }, reducedMotion() ? 0 : RESIZE_MS);
    return () => window.clearTimeout(settle);
  }, [open, measure]);
  const lastActive = useRef(active);
  useEffect(() => {
    if (lastActive.current === active) return;
    lastActive.current = active;
    const row = list.current;
    if (open && row) centreChip(row, row.querySelector<HTMLElement>(`[data-thread-chip="${CSS.escape(active)}"]`));
  }, [open, active]);
  useLayoutEffect(() => { if (open) measure(); }, [open, shown, measure]);
  useEffect(() => {
    if (!open) return;
    // Bubbles to window last, so a dialog, menu or the composer's own pickers claim Escape first.
    const fold = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || overlayOpen(event.target)) return;
      event.preventDefault();
      close(Boolean(box.current?.contains(document.activeElement)));
    };
    window.addEventListener("keydown", fold);
    return () => window.removeEventListener("keydown", fold);
  });

  const pick = (tab: ThreadTab) => {
    if (tab.threadId !== active) dispatch({ type: "switchTask", botId: bot.id, threadId: tab.threadId });
  };
  const nudge = (forward: boolean) => {
    const row = list.current;
    if (!row) return;
    const rtl = getComputedStyle(row).direction === "rtl";
    row.scrollBy?.({ left: (forward !== rtl ? 1 : -1) * row.clientWidth * 0.7, behavior: reducedMotion() ? "auto" : "smooth" });
  };
  const scrollSideways = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
    event.currentTarget.scrollLeft += event.deltaY;
  };
  const onKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const chips = Array.from(list.current?.querySelectorAll<HTMLElement>("[role=option]") ?? []);
    const at = chips.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
    const step = event.key === "ArrowRight" ? (rtl ? -1 : 1) : event.key === "ArrowLeft" ? (rtl ? 1 : -1) : 0;
    const to = step ? Math.min(Math.max(at + step, 0), chips.length - 1) : event.key === "Home" ? 0 : event.key === "End" ? chips.length - 1 : null;
    if (to === null) return;
    event.preventDefault();
    chips[to]?.focus();
  };
  const unfold = () => {
    if (box.current) setRoom(centredRoom(box.current));
    setOpen(true);
  };
  const toggleLabel = t(open ? "task.collapseNamed" : "task.expandNamed", { name: bot.name });

  return (
    <div ref={box} data-chathead-switch={open ? "open" : "closed"} onKeyDown={open ? onKey : undefined}
      className={cn("flex h-[39px] min-w-0 items-center overflow-hidden rounded-full p-[5.5px] text-ink", ELEVATED_FLOAT, !open && cn("max-w-full", NAME_HOVER))}
      style={open ? { maxWidth: room } : undefined}>
      <div className="flex min-w-0 items-center gap-0.5">
        <button type="button" data-chathead-pill data-tour="bot-pill" onClick={onToggle} title={t("chat.openBotPanel")} aria-label={label}
          aria-expanded={panelOpen} aria-controls={panelOpen ? BOT_PANEL_ID : undefined}
          className={cn(open ? PART : FACE, "min-w-0", open && "shrink-0")}>
          {head}
        </button>
        {open && (
          <div className="relative flex min-w-0 items-center">
          <div ref={list} role="listbox" aria-label={t("task.namedList", { name: bot.name })} aria-orientation="horizontal"
            onScroll={measure} onWheel={scrollSideways} style={{ maskImage: fade, WebkitMaskImage: fade }}
            className="flex min-w-0 animate-fade-in items-center gap-1 overflow-x-auto [scrollbar-width:none] motion-reduce:animate-none [&::-webkit-scrollbar]:hidden">
            {shown.map((tab) => {
              const selected = tab.threadId === active;
              const title = tabTitle(tab);
              return (
                <button key={tab.threadId} type="button" role="option" aria-selected={selected} tabIndex={selected ? 0 : -1} title={title}
                  data-thread-chip={tab.threadId} onClick={() => pick(tab)}
                  className={cn(CHIP, selected ? "bg-ink/[0.1] text-ink" : "text-ink-secondary hover:bg-ink/[0.06] hover:text-ink")}>
                  {tab.threadId === main && <Star size={12} role="img" aria-label={t("sidebar.threads.main")} data-thread-chip-main className="shrink-0 fill-current text-ink-tertiary" />}
                  {tab.working ? <span role="img" aria-label={t("chat.activity.working")} className="size-1.5 shrink-0 animate-pulse rounded-full bg-success motion-reduce:animate-none" />
                    : tab.pinned && tab.threadId !== main ? <Pin size={12} role="img" aria-label={t("task.pinned")} className="shrink-0 text-ink-tertiary" /> : null}
                  <span dir="auto" className="min-w-0 truncate">{title}</span>
                </button>
              );
            })}
          </div>
          {ends.back && (
            <button type="button" tabIndex={-1} data-chathead-nudge="back" aria-label={t("task.scrollBack")} title={t("task.scrollBack")}
              onClick={() => nudge(false)} className={cn(NUDGE, "start-0")}>
              <ChevronLeft size={14} aria-hidden="true" className="rtl:-scale-x-100" />
            </button>
          )}
          {ends.on && (
            <button type="button" tabIndex={-1} data-chathead-nudge="on" aria-label={t("task.scrollOn")} title={t("task.scrollOn")}
              onClick={() => nudge(true)} className={cn(NUDGE, "end-0")}>
              <ChevronRight size={14} aria-hidden="true" className="rtl:-scale-x-100" />
            </button>
          )}
          </div>
        )}
        <button ref={toggle} type="button" data-chathead-threads aria-haspopup="listbox" aria-expanded={open}
          aria-label={toggleLabel} title={toggleLabel} onClick={() => (open ? close(false) : unfold())}
          className={cn(PART, ICON)}>
          <ChevronDown size={16} aria-hidden="true" className={cn("transition-transform duration-[120ms] motion-reduce:transition-none", open && "rotate-180")} />
        </button>
      </div>
    </div>
  );
}
