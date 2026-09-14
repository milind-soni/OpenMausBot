// The board's day switcher.
//
// A board shows every card ever put on it, which stops being readable the
// moment it has more than a day of work on it. This narrows the board to one
// day at a time, and it opens on TODAY: a card with no date of its own belongs
// to the day it was made, so on a board that has not been dated by hand every
// card is today's — and a filter that started on "everything" would be a
// control that visibly does nothing.
//
// Three named days cover the ground people actually move across, and the
// calendar behind the "Day" label reaches every other one. That pairing is
// what makes it safe to have no "all days" escape hatch: no card is ever
// unreachable, because any date can be picked directly.
import { useEffect, useRef, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";

import { cardsByDay, dayLabel, relativeDays, type BoardCard } from "@/lib/task-board";
import { startOfDay } from "@/lib/routine-calendar";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";

export interface BoardDayPickerProps {
  cards: BoardCard[];
  /** The chosen day, as the start of that local day. Never `null` here — the
   * board always has a day, it just may be a different one. */
  value: number;
  onChange: (day: number) => void;
  /** Passed in rather than read here, so the picker and the counts agree with
   * whatever moment the board itself is rendering against. */
  now: number;
}

export function BoardDayPicker({ cards, value, onChange, now }: BoardDayPickerProps) {
  const counts = cardsByDay(cards);
  const today = startOfDay(now);
  const { yesterday, tomorrow } = relativeDays(now);

  /** Whether yesterday is worth a chip.
 *
 * Only when work actually happened on it. An empty "Yesterday 0" sitting
 * permanently beside today is a button that leads to an empty board — the
 * chip earns its place by holding something, and a person who wants to look
 * at a day with nothing on it can reach it through the calendar. */
  const showYesterday = value === yesterday || (counts.get(yesterday) ?? 0) > 0;

  /** Days beyond the named ones that are worth a chip: the day being looked at,
   * and any future day that actually holds cards.
   *
   * The selected day is included whatever it is. Without it, picking a past
   * date from the calendar left the board showing a day no chip named and none
   * of them marked as chosen — so the row above the board disagreed with the
   * board, and the only way back to the date was to open the calendar again.
   *
   * The named days are excluded explicitly. An earlier version only excluded
   * tomorrow, so selecting today emitted it twice — once as the fixed chip and
   * once through this list — and the row showed two identical "Today"
   * buttons, both marked as chosen.
   *
   * Past days that merely hold cards are still left out: history is reached
   * deliberately through the calendar, not by a row that grows a button for
   * every day that ever had work on it. */
  const extraDays = [...new Set<number>([...counts.keys(), value])]
    .filter((day) => (day > tomorrow || day === value) && day !== yesterday && day !== today && day !== tomorrow)
    .sort((a, b) => a - b);

  return (
    <div className="flex min-w-0 items-center gap-2">
      <DayLabelButton
        label={t("taskBoard.day.label")}
        title={t("taskBoard.day.pick")}
        value={value}
        now={now}
        counts={counts}
        onChange={onChange}
      />

      <div className="flex min-w-0 items-center gap-1.5 overflow-x-auto">
        {showYesterday && (
          <DayChip
            day={yesterday}
            count={counts.get(yesterday) ?? 0}
            now={now}
            selected={value === yesterday}
            onSelect={onChange}
          />
        )}
        <DayChip
          day={today}
          count={counts.get(today) ?? 0}
          now={now}
          selected={value === today}
          onSelect={onChange}
        />
        <DayChip
          day={tomorrow}
          count={counts.get(tomorrow) ?? 0}
          now={now}
          selected={value === tomorrow}
          onSelect={onChange}
        />
        {extraDays.map((day) => (
          <DayChip key={day} day={day} count={counts.get(day) ?? 0} now={now} selected={value === day} onSelect={onChange} />
        ))}
      </div>
    </div>
  );
}

/** The "Day" label, which is also the button that opens the calendar.
 *
 * Making the label itself the control keeps the row to one line: the thing
 * that names the filter is the thing that changes it, and there is no separate
 * icon whose purpose has to be guessed. */
function DayLabelButton({
  label,
  title,
  value,
  now,
  counts,
  onChange,
}: {
  label: string;
  title: string;
  value: number;
  now: number;
  counts: Map<number, number>;
  onChange: (day: number) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((was) => !was)}
        aria-expanded={open}
        title={title}
        className={cn(
          "flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] transition",
          open ? "bg-accent/15 text-accent" : "text-ink-secondary hover:bg-raised hover:text-ink",
        )}
      >
        <CalendarDays size={13} />
        {label}
      </button>
      {open && (
        <DayCalendarPopover
          value={value}
          now={now}
          counts={counts}
          onChange={onChange}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

/** A month grid for reaching any day at all. Purely the calendar: choosing a
 * date closes it, and closing it is the only other thing it does.
 *
 * Days that hold cards are marked, so the grid answers "where is the work"
 * before a date is picked. Without that, finding a day with something on it
 * meant opening dates one at a time and reading an empty board each time. */
function DayCalendarPopover({
  value,
  now,
  counts,
  onChange,
  onClose,
}: {
  value: number;
  now: number;
  counts: Map<number, number>;
  onChange: (day: number) => void;
  onClose: () => void;
}) {
  const [month, setMonth] = useState(() => startOfMonth(value));
  const ref = useRef<HTMLDivElement>(null);

  /** Closing on an outside click or Escape — a popover with no way to dismiss
   * it except by choosing something is a trap. */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey);
    // `mousedown`, not `click`: a click that starts inside and ends outside
    // would otherwise close on its own toggle and reopen it.
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [onClose]);

  const today = startOfDay(now);
  const first = startOfMonth(month);
  // Grid starts on Monday, which is how the rest of the app's calendar reads.
  const lead = (new Date(first).getDay() + 6) % 7;
  const daysInMonth = new Date(new Date(first).getFullYear(), new Date(first).getMonth() + 1, 0).getDate();

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={t("taskBoard.day.pick")}
      className="animate-pop-in absolute left-0 top-full z-30 mt-1.5 w-[248px] rounded-xl border border-hairline/50 bg-panel p-2.5 shadow-2xl shadow-black/40"
    >
      <div className="mb-2 flex items-center justify-between">
        <button
          type="button"
          onClick={() => setMonth(addMonths(month, -1))}
          aria-label={t("taskBoard.day.prevMonth")}
          className="rounded-md p-1 text-ink-secondary transition hover:bg-raised hover:text-ink"
        >
          <ChevronLeft size={14} />
        </button>
        <span className="text-[12px] font-semibold text-ink">
          {new Date(month).toLocaleDateString([], { month: "long", year: "numeric" })}
        </span>
        <button
          type="button"
          onClick={() => setMonth(addMonths(month, 1))}
          aria-label={t("taskBoard.day.nextMonth")}
          className="rounded-md p-1 text-ink-secondary transition hover:bg-raised hover:text-ink"
        >
          <ChevronRight size={14} />
        </button>
      </div>

      <div className="grid grid-cols-7 gap-0.5">
        {WEEKDAY_INITIALS.map((initial, index) => (
          <span key={`${initial}-${index}`} className="py-1 text-center text-[10px] font-medium text-ink-secondary/70">
            {initial}
          </span>
        ))}
        {Array.from({ length: lead }, (_, index) => (
          <span key={`lead-${index}`} />
        ))}
        {Array.from({ length: daysInMonth }, (_, index) => {
          const day = new Date(new Date(first).getFullYear(), new Date(first).getMonth(), index + 1).getTime();
          const isSelected = day === value;
          const isToday = day === today;
          const count = counts.get(day) ?? 0;
          return (
            <button
              key={day}
              type="button"
              onClick={() => {
                onChange(day);
                onClose();
              }}
              aria-pressed={isSelected}
              // The count travels with the date rather than being drawn in the
              // cell: a seven-column grid has no room for a number beside the
              // day, and the accessible name is what a screen reader reads out.
              aria-label={count > 0 ? `${index + 1} — ${t("taskBoard.day.cardCount", { count })}` : String(index + 1)}
              title={count > 0 ? t("taskBoard.day.cardCount", { count }) : undefined}
              className={cn(
                "relative flex size-7 items-center justify-center rounded-md text-[11.5px] tabular-nums transition",
                isSelected
                  ? "bg-accent font-semibold text-white"
                  : isToday
                    ? "font-semibold text-accent hover:bg-raised"
                    : count > 0
                      ? // A day holding work is not muted like an empty one, so
                        // the grid shows where the cards are at a glance.
                        "font-medium text-ink hover:bg-raised"
                      : "text-ink-secondary hover:bg-raised hover:text-ink",
              )}
            >
              {index + 1}
              {/* A dot under the number, not a badge on it: at this size a
                  badge would swallow the digit it is meant to annotate. */}
              {count > 0 && !isSelected && (
                <span
                  aria-hidden="true"
                  className="absolute bottom-[3px] left-1/2 size-1 -translate-x-1/2 rounded-full bg-accent"
                />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** One day, with how much is on it.
 *
 * The count is a round badge rather than plain text beside the name: a number
 * floating next to a word has to be paired up with it before it means
 * anything, where a badge reads as belonging to its chip at a glance. */
function DayChip({
  day,
  count,
  now,
  selected,
  onSelect,
}: {
  day: number;
  count: number;
  now: number;
  selected: boolean;
  onSelect: (day: number) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(day)}
      aria-pressed={selected}
      className={cn(
        "flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1 text-[12px] font-medium transition",
        selected ? "bg-accent/15 text-accent" : "text-ink-secondary hover:bg-raised hover:text-ink",
      )}
    >
      {dayLabel(day, now)}
      <span
        className={cn(
          "flex size-[17px] items-center justify-center rounded-full text-[10.5px] font-semibold tabular-nums leading-none",
          selected
            ? "bg-accent text-white"
            : count === 0
              ? "bg-ink-secondary/10 text-ink-secondary/60"
              : "bg-ink-secondary/15 text-ink-secondary",
        )}
      >
        {count}
      </span>
    </button>
  );
}

const WEEKDAY_INITIALS = ["M", "T", "W", "T", "F", "S", "S"] as const;

function startOfMonth(at: number): number {
  const date = new Date(at);
  return new Date(date.getFullYear(), date.getMonth(), 1).getTime();
}

function addMonths(at: number, months: number): number {
  const date = new Date(at);
  return new Date(date.getFullYear(), date.getMonth() + months, 1).getTime();
}