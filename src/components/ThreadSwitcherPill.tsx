import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { ChevronDown, Pin, Plus, Star } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { localizedTaskTitle } from "@/lib/task-title";
import type { Bot } from "@/state/store";
import { useStoreDispatch } from "@/state/store-select";
import { BOT_PANEL_ID } from "./bot-panel/side-panel";
import { ELEVATED_FLOAT } from "./elevated";
import { edgeFade } from "./HeaderThreadTabs";
import { reducedMotion } from "./MenuMotion";
import { mainThreadFirst } from "./SidebarThreadRow";
import { openTabId, type ThreadTab } from "./thread-tabs";

const RESIZE_MS = 240;
const LIST_FADE = 40;
const CLEAR_OF_CONTROLS = 24;
const WIDEST = 720;
const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
const PART = "flex h-full min-w-0 items-center rounded-full outline-none transition-colors duration-[120ms] hover:bg-ink/[0.06] active:bg-ink/[0.08] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus motion-reduce:transition-none";
/** At rest the bot's face and name carry no fill of their own: hovering them tints the whole pill, as the plain pill does. */
const FACE = "flex h-full items-center rounded-full outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus";
const NAME_HOVER = "transition-colors duration-[120ms] motion-reduce:transition-none has-[[data-chathead-pill]:hover]:bg-[color-mix(in_srgb,var(--color-composer),var(--color-ink)_7%)]";
const ICON = "size-7 shrink-0 justify-center text-ink-secondary hover:text-ink";
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

/**
 * Simple mode's pill for a bot with two threads or more: its face and name open the bot panel as ever, a chevron beside
 * them widens the pill in place into the bot's threads (its main thread first) and folds it back, and a plus starts a
 * thread either way. A pick, Escape or a click elsewhere folds it too.
 */
export function ThreadSwitcherPill({ bot, tabs, head, label, panelOpen, onToggle }: {
  bot: Bot; tabs: ThreadTab[]; head: ReactNode; label: string; panelOpen: boolean; onToggle: () => void;
}) {
  const dispatch = useStoreDispatch();
  const [open, setOpen] = useState(false);
  const [room, setRoom] = useState(WIDEST);
  const box = useGlidingWidth(open);
  const list = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const [fade, setFade] = useState<string | undefined>();
  const active = openTabId(bot);
  const main = bot.mainThreadId;
  const shown = useMemo(() => mainThreadFirst(tabs, main), [tabs, main]);
  const canWrite = bot.yourAccess !== "view";

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) requestAnimationFrame(() => toggle.current?.focus());
  };
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => { if (!box.current?.contains(event.target as Node)) setOpen(false); };
    const resize = () => { if (box.current) setRoom(centredRoom(box.current)); };
    document.addEventListener("pointerdown", away);
    window.addEventListener("resize", resize);
    return () => { document.removeEventListener("pointerdown", away); window.removeEventListener("resize", resize); };
  }, [open]);
  useLayoutEffect(() => {
    if (!open || !list.current) return;
    const row = list.current;
    row.scrollLeft = 0;
    const chip = row.querySelector<HTMLElement>('[aria-selected="true"]') ?? row.querySelector<HTMLElement>("[role=option]");
    chip?.focus({ preventScroll: true });
    const settle = window.setTimeout(() => {
      chip?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
      setFade(edgeFade(row, LIST_FADE));
    }, reducedMotion() ? 0 : RESIZE_MS);
    return () => window.clearTimeout(settle);
  }, [open]);

  const pick = (tab: ThreadTab) => {
    if (tab.threadId !== active) dispatch({ type: "switchTask", botId: bot.id, threadId: tab.threadId });
    close(true);
  };
  const onKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); return; }
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
          <div ref={list} role="listbox" aria-label={t("task.namedList", { name: bot.name })} aria-orientation="horizontal"
            onScroll={(event) => setFade(edgeFade(event.currentTarget, LIST_FADE))} style={{ maskImage: fade, WebkitMaskImage: fade }}
            className="flex min-w-0 animate-fade-in items-center gap-1 overflow-x-auto [scrollbar-width:none] motion-reduce:animate-none [&::-webkit-scrollbar]:hidden">
            {shown.map((tab) => {
              const selected = tab.threadId === active;
              const title = tabTitle(tab);
              return (
                <button key={tab.threadId} type="button" role="option" aria-selected={selected} tabIndex={selected ? 0 : -1} title={title}
                  data-thread-chip={tab.threadId} onClick={() => pick(tab)}
                  className={cn(CHIP, selected ? "bg-ink/[0.1] text-ink" : "text-ink-secondary hover:bg-ink/[0.06] hover:text-ink")}>
                  {tab.working ? <span role="img" aria-label={t("chat.activity.working")} className="size-1.5 shrink-0 animate-pulse rounded-full bg-success motion-reduce:animate-none" />
                    : tab.threadId === main ? <Star size={12} role="img" aria-label={t("sidebar.threads.main")} data-thread-chip-main className="shrink-0 fill-current text-ink-tertiary" />
                    : tab.pinned ? <Pin size={12} role="img" aria-label={t("task.pinned")} className="shrink-0 text-ink-tertiary" /> : null}
                  <span dir="auto" className="min-w-0 truncate">{title}</span>
                </button>
              );
            })}
          </div>
        )}
        <button ref={toggle} type="button" data-chathead-threads aria-haspopup="listbox" aria-expanded={open}
          aria-label={toggleLabel} title={toggleLabel} onClick={() => (open ? close(false) : unfold())}
          className={cn(PART, ICON)}>
          <ChevronDown size={16} aria-hidden="true" className={cn("transition-transform duration-[120ms] motion-reduce:transition-none", open && "rotate-180")} />
        </button>
        {canWrite && (
          <button type="button" data-thread-chip-new aria-label={t("task.newShort")} title={t("task.newShort")} aria-keyshortcuts="Meta+T Control+T"
            onClick={() => { dispatch({ type: "newTask", botId: bot.id }); close(false); }}
            className={cn(PART, ICON)}>
            <Plus size={16} aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}
