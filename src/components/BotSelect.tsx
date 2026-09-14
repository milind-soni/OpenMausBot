// The board's own bot picker.
//
// A native <select> cannot show an avatar, and a card is about a bot — the
// picture is how a person tells two bots apart faster than they read a name.
// It is also styled by the OS, so on the board it looked like a form control
// borrowed from a different application. This is the same popover the rest of
// the app uses (trigger, list, click-away, Escape), sized for a card.
//
// The picker never invents a bot list: it renders exactly what it is given, so
// the board's team filter still decides who can be assigned.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Search } from "lucide-react";

import { BotAvatar } from "./Avatar";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";

export interface BotSelectOption {
  id: string;
  name: string;
  /** Shown as a second line, the way the sidebar labels a bot. */
  subtitle?: string | null;
  /** The bot's own avatar inputs. These are passed straight to BotAvatar,
   * which draws a mascot from `color` and `mascotBody` — without them every
   * row fell back to the default colour and the whole list came out green. */
  color?: string | null;
  mascotBody?: string | null;
  mascotExpression?: string | null;
}

export interface BotSelectProps {
  bots: BotSelectOption[];
  /** `null` is the deliberate "no bot" choice, not an empty picker. */
  value: string | null;
  onChange: (botId: string | null) => void;
  /** Label for the "no bot" row; also what an empty value reads as. */
  placeholder: string;
  disabled?: boolean;
  /** Sits above the trigger and labels the field. */
  label?: string;
}

/** The exact shape BotAvatar needs, taken from the option rather than
 * rebuilt from scratch — rebuilding is what dropped `color` and made every
 * avatar in this list the same green. */
function avatarBot(option: BotSelectOption) {
  return {
    id: option.id,
    name: option.name,
    color: option.color ?? undefined,
    mascotBody: option.mascotBody ?? undefined,
    mascotExpression: option.mascotExpression ?? undefined,
  } as never;
}

/** Only shown once the list is long enough that scanning it is worse than
 * typing into it. A short list stays a list. */
const SEARCH_THRESHOLD = 6;

export function BotSelect({
  bots,
  value,
  onChange,
  placeholder,
  disabled = false,
  label,
}: BotSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [anchor, setAnchor] = useState<CSSProperties | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const selected = bots.find((bot) => bot.id === value) ?? null;

  /** The picker lives inside the card editor, whose body scrolls and whose
   * shell rounds its corners — either can clip a list drawn inside it. So the
   * list is portalled to the body and positioned from the trigger's own box,
   * and it flips above the trigger when the space below is too small to show
   * it. A short list must not become unreachable just because the field it
   * hangs from is near the bottom of the dialog. */
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const box = rootRef.current?.getBoundingClientRect();
      if (!box) return;
      const margin = 8;
      const roomBelow = window.innerHeight - box.bottom - margin;
      const roomAbove = box.top - margin;
      const wanted = 300;
      const below = roomBelow >= Math.min(wanted, 200) || roomBelow >= roomAbove;
      setAnchor({
        left: box.left,
        width: box.width,
        ...(below
          ? { top: box.bottom + 6, maxHeight: Math.max(120, Math.min(wanted, roomBelow)) }
          : { bottom: window.innerHeight - box.top + 6, maxHeight: Math.max(120, Math.min(wanted, roomAbove)) }),
      });
    };
    place();
    window.addEventListener("resize", place);
    // capture: the dialog body is the scroller, so a bubble-phase listener on
    // window would miss it.
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      // The list is portalled, so it is not inside rootRef: a click on it must
      // not read as a click outside the picker.
      if (rootRef.current?.contains(target) || listRef.current?.contains(target)) return;
      setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown);
    };
    // `open` only. `bots.length` used to be here too, which meant a board poll
    // that changed the roster tore the listeners down and re-ran the effect —
    // and re-focused the search box under whoever was typing in it.
  }, [open]);

  // Focus the search box once, when the list opens, and not again while it is
  // being typed into.
  useEffect(() => {
    if (!open) return;
    if (bots.length >= SEARCH_THRESHOLD) searchRef.current?.focus();
  }, [open]);

  const needle = query.trim().toLowerCase();
  const shown = needle
    ? bots.filter((bot) => `${bot.name} ${bot.subtitle ?? ""}`.toLowerCase().includes(needle))
    : bots;

  const pick = (botId: string | null) => {
    onChange(botId);
    setOpen(false);
  };

  return (
    <div ref={rootRef} className="relative">
      {label && (
        <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-secondary">
          {label}
        </span>
      )}
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        className={cn(
          "flex w-full items-center gap-2 rounded-xl border bg-card px-3 py-2 text-left transition",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
          open ? "border-accent/50" : "border-hairline/50 hover:border-hairline",
          disabled && "cursor-not-allowed opacity-45",
        )}
      >
        {selected ? (
          <>
            <BotAvatar bot={avatarBot(selected)} size={22} motion="none" motionKey={0} animated={false} />
            <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink">{selected.name}</span>
          </>
        ) : (
          <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-secondary">{placeholder}</span>
        )}
        <ChevronDown size={14} className={cn("shrink-0 text-ink-secondary transition", open && "rotate-180")} />
      </button>

      {open && anchor && createPortal(
        <div
          ref={listRef}
          role="listbox"
          style={anchor}
          className="animate-pop-in fixed z-[60] flex flex-col overflow-hidden rounded-xl border border-hairline/50 bg-menu py-1.5 shadow-2xl shadow-black/50"
        >
          {bots.length >= SEARCH_THRESHOLD && (
            <label className="mx-1.5 mb-1 flex items-center gap-2 rounded-lg bg-control px-2.5 py-1.5 text-ink-secondary">
              <Search size={13} className="shrink-0" />
              <input
                ref={searchRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("taskBoard.editor.agentSearch")}
                className="min-w-0 flex-1 bg-transparent text-[12px] text-ink outline-none placeholder:text-ink-secondary/60"
              />
            </label>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto">
            {/* "No bot" is a real choice, not the absence of one: a card is
                allowed to sit unassigned, and once it is assigned there must
                be a way back out. */}
            <button
              type="button"
              role="option"
              aria-selected={value === null}
              onClick={() => pick(null)}
              className={cn(
                "flex w-full items-center gap-2 px-2.5 py-2 text-left text-[12.5px] transition",
                value === null ? "bg-accent/12 text-ink" : "text-ink-secondary hover:bg-raised hover:text-ink",
              )}
            >
              <span className="flex size-[22px] shrink-0 items-center justify-center rounded-full bg-ink-secondary/10 text-[10px] text-ink-secondary">
                —
              </span>
              <span className="min-w-0 flex-1 truncate">{placeholder}</span>
              {value === null && <Check size={13} className="shrink-0 text-accent" />}
            </button>

            {shown.map((bot) => {
              const active = bot.id === value;
              return (
                <button
                  key={bot.id}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onClick={() => pick(bot.id)}
                  className={cn(
                    "flex w-full items-center gap-2 px-2.5 py-2 text-left transition",
                    active ? "bg-accent/12" : "hover:bg-raised",
                  )}
                >
                  <BotAvatar bot={avatarBot(bot)} size={22} motion="none" motionKey={0} animated={false} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] font-medium text-ink">{bot.name}</span>
                    {bot.subtitle && (
                      <span className="block truncate text-[11px] text-ink-secondary">{bot.subtitle}</span>
                    )}
                  </span>
                  {active && <Check size={13} className="shrink-0 text-accent" />}
                </button>
              );
            })}

            {shown.length === 0 && (
              <p className="px-2.5 py-3 text-center text-[11.5px] text-ink-secondary">{t("taskBoard.editor.agentNone")}</p>
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}