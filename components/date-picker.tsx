"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, X } from "lucide-react";
import clsx from "clsx";
import { LOCALE, formatDate, formatDue, parseDueDate, toDueDate } from "@/lib/format";
import { useAnchoredPopover } from "./use-anchored-popover";
import { SheetHeader } from "./sheet-header";

type WeekInfoLocale = Intl.Locale & { getWeekInfo?: () => { firstDay: number }; weekInfo?: { firstDay: number } };

/** First day of the week for the viewer's locale: 0 = Sunday ... 6 = Saturday. */
function localeWeekStart() {
  const language = typeof navigator === "undefined" ? LOCALE : navigator.language || LOCALE;
  try {
    const locale = new Intl.Locale(language) as WeekInfoLocale;
    const info = locale.getWeekInfo?.() ?? locale.weekInfo;
    if (info?.firstDay) return info.firstDay % 7;
  } catch { /* Older engines: fall through to the region guess. */ }
  return /-(US|CA|MX|BR|JP|KR|TW|IL|PH|IN)$/i.test(language) || /^(en|ja|ko|he|zh)$/i.test(language) ? 0 : 1;
}

const addDays = (date: Date, days: number) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
const addMonths = (date: Date, months: number) => {
  const target = new Date(date.getFullYear(), date.getMonth() + months, 1);
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  return new Date(target.getFullYear(), target.getMonth(), Math.min(date.getDate(), last));
};
const sameDay = (a: Date | null, b: Date | null) => Boolean(a && b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate());
const today = () => { const now = new Date(); return new Date(now.getFullYear(), now.getMonth(), now.getDate()); };
/** Monday of next week; a week later when that Monday is tomorrow (so it never repeats "Tomorrow"). */
const nextWeek = () => { const start = today(); const days = ((8 - start.getDay()) % 7) || 7; return addDays(start, days < 2 ? days + 7 : days); };

const monthFormat = new Intl.DateTimeFormat(LOCALE, { month: "long", year: "numeric" });
const weekdayFormat = new Intl.DateTimeFormat(LOCALE, { weekday: "short" });
const dayLabelFormat = new Intl.DateTimeFormat(LOCALE, { weekday: "long", month: "long", day: "numeric", year: "numeric" });

/**
 * Due date field: a trigger showing the formatted due date and a popover with quick picks and a calendar.
 * `value` and `onChange` use "YYYY-MM-DD"; an empty string means no date.
 */
export function DatePicker({ value, onChange, disabled, label = "Due date", placeholder, className, done = false }: {
  value: string; onChange: (value: string) => void; disabled?: boolean; label?: string; placeholder?: string; className?: string;
  /** A completed issue: its date shows in the neutral tone, never overdue. */
  done?: boolean;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const due = formatDue(value);
  const close = (restore = true) => { setOpen(false); if (restore) trigger.current?.focus({ preventScroll: true }); };

  return <div className={clsx("date-picker", className)}>
    <button ref={trigger} type="button" className={clsx("date-picker-trigger", due && !done && `due-${due.tone}`)} data-empty={!due || undefined} aria-label={`${label}: ${due ? due.label : "No due date"}`} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} disabled={disabled} onClick={() => { if (open) close(false); else setOpen(true); }} onKeyDown={event => {
      if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) { event.preventDefault(); setOpen(true); }
      else if (open && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
      else if (open && event.key === "Tab") close(false);
    }}>
      <CalendarDays size={14} /><span>{due ? due.label : placeholder || label}</span>
    </button>
    {open && <DatePopover id={id} anchor={trigger} value={value} label={label} onChange={onChange} onClose={close} />}
  </div>;
}

/**
 * The due date popover on its own, anchored to any element (a board card's due chip or the card itself).
 * Calls `onChange` only when the date changes, then `onClose(true)`; outside presses and Tab call `onClose(false)`.
 * `title` names the issue above the caption on phones, like the card menu, when the issue is not already on screen.
 */
export function DatePopover({ id, anchor, value, label = "Due date", title, onChange, onClose }: {
  id?: string; anchor: RefObject<HTMLElement | null>; value: string; label?: string; title?: string; onChange: (value: string) => void; onClose: (restoreFocus: boolean) => void;
}) {
  const menu = useRef<HTMLDivElement>(null), grid = useRef<HTMLDivElement>(null);
  const selected = parseDueDate(value);
  const [cursor, setCursor] = useState<Date>(() => selected || today());
  const weekStart = useMemo(() => localeWeekStart(), []);
  const focusDay = useRef(false);
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; });
  useAnchoredPopover(true, anchor, menu, grid, { width: 272, maxHeight: 540, onDismiss: restore => closeRef.current(restore) });

  const choose = (date: Date | null) => { const next = date ? toDueDate(date) : ""; if (next !== value) onChange(next); onClose(true); };
  // Keyboard moves keep focus on the active day as the month changes under it.
  useEffect(() => {
    if (!focusDay.current) return;
    focusDay.current = false;
    grid.current?.querySelector<HTMLButtonElement>('[tabindex="0"]')?.focus({ preventScroll: true });
  }, [cursor]);

  const monthStart = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const gridStart = addDays(monthStart, -((monthStart.getDay() - weekStart + 7) % 7));
  const days = Array.from({ length: 42 }, (_, index) => addDays(gridStart, index));
  const weeks = Array.from({ length: 6 }, (_, week) => days.slice(week * 7, week * 7 + 7)).filter((week, index) => index < 5 || week[0].getMonth() === cursor.getMonth());
  const now = today();
  const quick = [
    { key: "today", label: "Today", date: now },
    { key: "tomorrow", label: "Tomorrow", date: addDays(now, 1) },
    { key: "next-week", label: "Next week", date: nextWeek() },
  ];

  const move = (date: Date) => { focusDay.current = true; setCursor(date); };
  const onGridKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const offset = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key as "ArrowLeft"];
    if (offset !== undefined) { event.preventDefault(); move(addDays(cursor, offset)); return; }
    if (event.key === "PageUp" || event.key === "PageDown") { event.preventDefault(); move(addMonths(cursor, (event.key === "PageUp" ? -1 : 1) * (event.shiftKey ? 12 : 1))); return; }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const fromStart = (cursor.getDay() - weekStart + 7) % 7;
      move(addDays(cursor, event.key === "Home" ? -fromStart : 6 - fromStart));
      return;
    }
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(cursor); }
  };

  return <div ref={menu} id={id} popover="manual" role="dialog" aria-label={label} className="date-picker-popover" onClick={event => event.stopPropagation()} onKeyDown={event => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(true); }
    else if (event.key === "Tab") onClose(false);
  }}>
      <SheetHeader title={title} caption={label} />
      <div className="date-picker-quick">
        {quick.map(item => <button key={item.key} type="button" aria-pressed={sameDay(selected, item.date)} onClick={() => choose(item.date)}><span>{item.label}</span><small>{formatDate(item.date)}</small></button>)}
        {selected && <button type="button" className="date-picker-clear" onClick={() => choose(null)}><X size={13} /><span>Clear</span></button>}
      </div>
      <div className="date-picker-month">
        <strong aria-live="polite">{monthFormat.format(cursor)}</strong>
        <button type="button" className="icon-button" aria-label="Previous month" onClick={() => setCursor(addMonths(cursor, -1))}><ChevronLeft size={15} /></button>
        <button type="button" className="icon-button" aria-label="Next month" onClick={() => setCursor(addMonths(cursor, 1))}><ChevronRight size={15} /></button>
      </div>
      <div ref={grid} role="grid" aria-label={monthFormat.format(cursor)} className="date-picker-grid" tabIndex={-1} onKeyDown={onGridKey} onFocus={event => { if (event.target === grid.current) grid.current?.querySelector<HTMLButtonElement>('[tabindex="0"]')?.focus({ preventScroll: true }); }}>
        <div role="row" className="date-picker-weekdays">{days.slice(0, 7).map(day => <span role="columnheader" key={day.getDay()} aria-label={new Intl.DateTimeFormat(LOCALE, { weekday: "long" }).format(day)}>{weekdayFormat.format(day).slice(0, 2)}</span>)}</div>
        {weeks.map(week => <div role="row" key={week[0].getTime()}>{week.map(day => {
          const active = sameDay(day, cursor);
          return <span role="gridcell" key={day.getTime()} aria-selected={sameDay(day, selected)}>
            <button type="button" tabIndex={active ? 0 : -1} aria-label={dayLabelFormat.format(day)} aria-current={sameDay(day, now) ? "date" : undefined}
              className={clsx(day.getMonth() !== cursor.getMonth() && "outside", sameDay(day, selected) && "selected", sameDay(day, now) && "today")}
              onClick={() => choose(day)}>{day.getDate()}</button>
          </span>;
        })}</div>)}
      </div>
  </div>;
}
