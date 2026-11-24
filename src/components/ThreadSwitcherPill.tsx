import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { ChevronDown, Pin, Plus } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { localizedTaskTitle } from "@/lib/task-title";
import type { Bot } from "@/state/store";
import { useStoreDispatch } from "@/state/store-select";
import { BOT_PANEL_ID } from "./bot-panel/side-panel";
import { ELEVATED_FLOAT } from "./elevated";
import { edgeFade } from "./HeaderThreadTabs";
import { reducedMotion } from "./MenuMotion";
import { openTabId, type ThreadTab } from "./thread-tabs";

const RESIZE_MS = 240;
const LIST_FADE = 40;
const CLEAR_OF_CONTROLS = 24;
const WIDEST = 720;
const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
const PART = "flex h-full min-w-0 items-center rounded-full outline-none transition-colors duration-[120ms] hover:bg-ink/[0.06] active:bg-ink/[0.08] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus motion-reduce:transition-none";
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
 * Simple mode's pill for a bot with two threads or more: its face and name open the bot panel as ever, and the open
 * thread's name beside them widens the pill in place into the bot's threads, to pick one or start one. A pick, Escape
 * or a click elsewhere folds it back.
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
  const current = tabs.find((tab) => tab.threadId === active);
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

  return (
    <div ref={box} data-chathead-switch={open ? "open" : "closed"} onKeyDown={open ? onKey : undefined}
      className={cn("flex h-[39px] min-w-0 items-center overflow-hidden rounded-full p-[5.5px] text-ink", ELEVATED_FLOAT, !open && "max-w-full")} style={open ? { maxWidth: room } : undefined}>
      {open ? (
        <div key="open" className="flex min-w-0 animate-fade-in items-center gap-1 motion-reduce:animate-none">
          <button type="button" data-chathead-pill data-tour="bot-pill" onClick={onToggle} title={t("chat.openBotPanel")} aria-label={label}
            aria-expanded={panelOpen} aria-controls={panelOpen ? BOT_PANEL_ID : undefined} className={cn(PART, "shrink-0")}>
            {head}
          </button>
          <div ref={list} role="listbox" aria-label={t("task.namedList", { name: bot.name })} aria-orientation="horizontal"
            onScroll={(event) => setFade(edgeFade(event.currentTarget, LIST_FADE))} style={{ maskImage: fade, WebkitMaskImage: fade }}
            className="flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {tabs.map((tab) => {
              const selected = tab.threadId === active;
              const title = tabTitle(tab);
              return (
                <button key={tab.threadId} type="button" role="option" aria-selected={selected} tabIndex={selected ? 0 : -1} title={title}
                  data-thread-chip={tab.threadId} onClick={() => pick(tab)}
                  className={cn(CHIP, selected ? "bg-ink/[0.1] text-ink" : "text-ink-secondary hover:bg-ink/[0.06] hover:text-ink")}>
                  {tab.working ? <span role="img" aria-label={t("chat.activity.working")} className="size-1.5 shrink-0 animate-pulse rounded-full bg-success motion-reduce:animate-none" />
                    : tab.pinned ? <Pin size={12} role="img" aria-label={t("task.pinned")} className="shrink-0 text-ink-tertiary" /> : null}
                  <span dir="auto" className="min-w-0 truncate">{title}</span>
                </button>
              );
            })}
          </div>
          {canWrite && (
            <button type="button" data-thread-chip-new aria-label={t("task.newShort")} title={t("task.newShort")}
              onClick={() => { dispatch({ type: "newTask", botId: bot.id }); close(false); }}
              className={cn(PART, "size-7 shrink-0 justify-center text-ink-secondary hover:text-ink")}>
              <Plus size={16} aria-hidden="true" />
            </button>
          )}
        </div>
      ) : (
        <div key="closed" className="flex min-w-0 items-center">
          <button type="button" data-chathead-pill data-tour="bot-pill" onClick={onToggle} title={t("chat.openBotPanel")} aria-label={label}
            aria-expanded={panelOpen} aria-controls={panelOpen ? BOT_PANEL_ID : undefined} className={cn(PART, "shrink-0")}>
            {head}
          </button>
          <button ref={toggle} type="button" data-chathead-threads aria-haspopup="listbox" aria-expanded={false}
            aria-label={t("task.namedList", { name: bot.name })} onClick={() => { if (box.current) setRoom(centredRoom(box.current)); setOpen(true); }}
            className={cn(PART, "gap-1.5 pe-2.5 ps-1.5 text-[14px] font-medium leading-5 text-ink-secondary hover:text-ink")}>
            <span aria-hidden="true" className="text-ink-tertiary">·</span>
            <span data-chathead-conversation dir="auto" className="min-w-0 max-w-[180px] truncate">{current ? tabTitle(current) : ""}</span>
            <ChevronDown size={12} aria-hidden="true" className="shrink-0 text-ink-tertiary" />
          </button>
        </div>
      )}
    </div>
  );
}
