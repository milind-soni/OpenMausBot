// The searchable voice list for Fish Audio and ElevenLabs. The list floats in a portal so the settings panel's scroll
// area never clips it, and the focus stays in the search box while the arrow keys walk the rows.
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Loader2, Search } from "lucide-react";

import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { usePopoverDismiss } from "@/hooks/use-popover-dismiss";
import { useMenuMotion } from "./MenuMotion";

export interface PickerVoice {
  id: string;
  label: string;
  description?: string;
  publicOwnerId?: string;
}

const EDGE = 8;
const GAP = 4;
const MIN_WIDTH = 240;
const MAX_HEIGHT = 380;
const MIN_HEIGHT = 160;
/** Below the field is where a list is expected: it opens there whenever this much of it fits. */
const ROOM_BELOW = 260;
const SKELETON_ROWS = 4;

type Box = { left: number; right: number; top: number; bottom: number; width: number };
type Size = { width: number; height: number };

export interface VoiceListPlace {
  left: number;
  width: number;
  maxHeight: number;
  top?: number;
  bottom?: number;
}

/** Below the field when a good part of the list fits there or there is more room below, else above it; never off
 * screen. */
export function voiceListPlace(anchor: Box, viewport: Size, rtl = false): VoiceListPlace {
  const width = Math.min(Math.max(anchor.width, MIN_WIDTH), viewport.width - EDGE * 2);
  const left = Math.max(EDGE, Math.min(rtl ? anchor.right - width : anchor.left, viewport.width - width - EDGE));
  const below = viewport.height - anchor.bottom - GAP - EDGE;
  const above = anchor.top - GAP - EDGE;
  const down = below >= ROOM_BELOW || below >= above;
  const maxHeight = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, down ? below : above));
  return down
    ? { left, width, maxHeight, top: anchor.bottom + GAP }
    : { left, width, maxHeight, bottom: viewport.height - anchor.top + GAP };
}

/** Your own voices first, then the ElevenLabs library ones that picking adds to the account. */
export function voiceRows(voices: PickerVoice[], defaultLabel: string, searching: boolean) {
  const mine = voices.filter((voice) => !voice.publicOwnerId);
  const library = voices.filter((voice) => voice.publicOwnerId);
  const mineStart = searching ? 0 : 1;
  const grouped = library.length > 0;
  return {
    rows: [...(searching ? [] : [{ id: "", label: defaultLabel }]), ...mine, ...library],
    /** Where the "Your voices" heading goes, or -1 when the list has one kind of voice. */
    mineStart: grouped && mine.length > 0 ? mineStart : -1,
    /** Where the library heading goes, or -1 when there are no library voices. */
    libraryStart: grouped ? mineStart + mine.length : -1,
  };
}

const isRtl = (element: Element | null) =>
  typeof getComputedStyle === "function" && element ? getComputedStyle(element).direction === "rtl" : false;

export function VoicePicker({
  value,
  voices,
  loading,
  query,
  onQuery,
  onPick,
  defaultLabel,
  ariaLabel,
  pending,
}: {
  value: string;
  voices: PickerVoice[];
  /** True while the list is loading or the search box holds text the list does not reflect yet. */
  loading: boolean;
  query: string;
  onQuery: (query: string) => void;
  onPick: (voice: PickerVoice) => void;
  defaultLabel: string;
  ariaLabel: string;
  /** A library voice being added to the account: the field shows it and holds still until the add settles. */
  pending?: PickerVoice;
}) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<VoiceListPlace | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const motion = useMenuMotion(open);
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const lastSelected = useRef<PickerVoice | undefined>(undefined);

  const listed = voices.find((voice) => voice.id === value);
  if (listed) lastSelected.current = listed;
  const selected = listed ?? (lastSelected.current?.id === value ? lastSelected.current : undefined);
  const searching = query.trim() !== "";
  const { rows, mineStart, libraryStart } = voiceRows(voices, defaultLabel, searching);
  // The highlight follows a voice, not a slot: with none chosen by the keys or the pointer it rests on the top match
  // while searching, else on the current voice.
  const held = activeId === null ? -1 : rows.findIndex((voice) => voice.id === activeId);
  const active = held >= 0 ? held : searching ? 0 : Math.max(0, rows.findIndex((voice) => voice.id === value));
  const skeleton = loading && voices.length === 0;
  const empty = !loading && searching && voices.length === 0;

  const show = () => {
    setActiveId(null);
    setOpen(true);
  };
  const close = (refocus = false) => {
    setOpen(false);
    onQuery("");
    if (refocus) triggerRef.current?.focus();
  };
  const pick = (voice: PickerVoice | undefined) => {
    if (!voice || loading) return;
    onPick(voice);
    close(true);
  };

  const inside = useRef({
    contains: (target: unknown) => [rootRef.current, sheetRef.current].some((node) => node?.contains(target as Node)),
  });
  usePopoverDismiss(open, inside, () => close());

  useLayoutEffect(() => {
    if (!open) return;
    const measure = (event?: Event) => {
      if (event?.target instanceof Node && sheetRef.current?.contains(event.target)) return;
      const trigger = triggerRef.current;
      if (!trigger) return;
      setPlace(voiceListPlace(trigger.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight }, isRtl(trigger)));
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open]);

  // A hidden sheet cannot take focus: the search box takes it once the sheet is placed.
  const placed = place !== null;
  useEffect(() => {
    if (open && placed) inputRef.current?.focus();
  }, [open, placed]);

  useLayoutEffect(() => {
    if (!open || !placed) return;
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [open, placed, active]);

  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    const last = rows.length - 1;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (last < 0) return;
      setActiveId(rows[Math.min(last, Math.max(0, active + (event.key === "ArrowDown" ? 1 : -1)))]!.id);
    } else if (event.key === "Enter") {
      event.preventDefault();
      pick(rows[active]);
    } else if (event.key === "Escape") {
      // The picker owns this Escape, not the panel or dialog around it.
      event.preventDefault();
      event.stopPropagation();
      if (query) onQuery("");
      else close(true);
    } else if (event.key === "Tab") {
      // The list lives at the end of the page, so Tab would leave the dialog: hand focus back to the field instead.
      event.preventDefault();
      close(true);
    }
  };

  const heading = (text: string, hint?: string) => (
    <div role="presentation" className="px-2.5 pb-1 pt-2">
      <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-secondary">{text}</div>
      {hint && <div className="mt-0.5 text-[11px] leading-4 text-ink-tertiary">{hint}</div>}
    </div>
  );

  let body: ReactNode;
  if (skeleton) {
    body = (
      <div role="status" aria-label={t("voice.loading")}>
        {Array.from({ length: SKELETON_ROWS }, (_, row) => (
          <div key={row} data-voice-skeleton className="animate-pulse px-2.5 py-2">
            <span className="block h-3.5 w-2/5 rounded bg-raised" />
            <span className="mt-1.5 block h-3 w-4/5 rounded bg-raised/70" />
          </div>
        ))}
      </div>
    );
  } else if (empty) {
    body = (
      <div role="status" className="px-3 py-6 text-center">
        <div className="text-[13px] text-ink">{t("voice.noMatches")}</div>
        <div className="mt-0.5 text-[12px] text-ink-secondary">{t("voice.noMatchesHint")}</div>
      </div>
    );
  } else {
    body = rows.map((voice, index) => {
      const current = voice.id === value;
      return (
        <div key={voice.id || "default"}>
          {index === mineStart && heading(t("voice.yourVoices"))}
          {index === libraryStart && index > 0 && <div role="separator" className="mx-2.5 my-1 h-px bg-hairline/50" />}
          {index === libraryStart && heading(t("voice.library"), t("voice.libraryHint"))}
          <div
            id={`${listId}-${index}`}
            role="option"
            aria-selected={current}
            aria-disabled={loading || undefined}
            data-index={index}
            data-active={index === active || undefined}
            onMouseMove={() => index !== active && setActiveId(voice.id)}
            onClick={() => pick(voice)}
            className={cn(
              "flex items-center gap-2 rounded-lg px-2.5 py-1.5",
              loading ? "cursor-default" : "cursor-pointer",
              index === active && "bg-raised",
            )}
          >
            <span className="min-w-0 flex-1">
              <span className={cn("block truncate text-[13px] leading-5 text-ink", current && "font-medium")}>{voice.label}</span>
              {voice.description && (
                <span title={voice.description} className="block truncate text-[12px] leading-4 text-ink-secondary">
                  {voice.description}
                </span>
              )}
            </span>
            {current && <Check size={14} aria-hidden className="shrink-0 text-accent" />}
          </div>
        </div>
      );
    });
  }

  const sheet = motion.shown && (
    <div
      ref={sheetRef}
      data-voice-picker-list
      {...motion.exitProps}
      style={{ position: "fixed", ...place, visibility: place ? undefined : "hidden" }}
      className={cn(
        "popover-surface z-[70] flex flex-col overflow-hidden rounded-xl border border-hairline/50 bg-menu shadow-2xl shadow-black/50",
        motion.className,
      )}
    >
      <div className="shrink-0 p-1.5">
        <div className="flex items-center gap-2 rounded-lg border border-hairline/40 bg-inset px-2.5 py-1.5 focus-within:border-focus">
          {loading ? (
            <Loader2 size={13} aria-hidden className="shrink-0 animate-spin text-ink-secondary" />
          ) : (
            <Search size={13} aria-hidden className="shrink-0 text-ink-secondary" />
          )}
          <input
            ref={inputRef}
            type="search"
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={!skeleton && !empty && rows[active] ? `${listId}-${active}` : undefined}
            value={query}
            onChange={(event) => {
              setActiveId(null);
              onQuery(event.target.value);
            }}
            onKeyDown={onSearchKey}
            placeholder={t("voice.search")}
            aria-label={t("voice.search")}
            autoComplete="off"
            spellCheck={false}
            className="w-full bg-transparent text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none [&::-webkit-search-cancel-button]:hidden"
          />
        </div>
      </div>
      <div
        ref={listRef}
        id={listId}
        role="listbox"
        aria-label={ariaLabel}
        aria-busy={loading || undefined}
        // Keep the focus in the search box when a row is clicked.
        onMouseDown={(event) => event.preventDefault()}
        className={cn(
          "min-h-0 flex-1 overflow-y-auto overscroll-contain px-1.5 pb-1.5 transition-opacity",
          loading && !skeleton && "opacity-60",
        )}
      >
        {body}
      </div>
    </div>
  );

  return (
    <div ref={rootRef} className="min-w-0 flex-1">
      <button
        ref={triggerRef}
        type="button"
        data-voice-picker
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-busy={Boolean(pending)}
        disabled={Boolean(pending)}
        onClick={() => (open ? close() : show())}
        onKeyDown={(event) => {
          if (open || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
          event.preventDefault();
          show();
        }}
        className={cn(
          "flex w-full items-center gap-2 rounded-lg border bg-inset py-2 pl-3 pr-2 text-start text-[13px] text-ink disabled:cursor-default",
          open ? "border-focus" : "border-hairline/40",
        )}
      >
        <span className="min-w-0 flex-1 truncate">
          {pending?.label ?? selected?.label ?? (loading ? t("voice.loading") : value ? t("voice.current") : defaultLabel)}
        </span>
        {pending && <span className="shrink-0 text-[12px] text-ink-secondary">{t("voice.adding")}</span>}
        {pending ? (
          <Loader2 size={14} aria-hidden className="shrink-0 animate-spin text-ink-secondary" />
        ) : (
          <ChevronDown size={14} aria-hidden className={cn("shrink-0 text-ink-secondary transition-transform", open && "rotate-180")} />
        )}
      </button>
      {sheet && typeof document !== "undefined" ? createPortal(sheet, document.body) : null}
    </div>
  );
}
