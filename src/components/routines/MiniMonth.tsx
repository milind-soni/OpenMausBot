import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { activeLocale, t } from "@/lib/i18n";
import { dayFull, dayNarrow } from "@/lib/schedule-label";

/** Monday first, and each initial comes from the translated day name. */
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

function startOfMonth(value: number | Date) {
  const date = new Date(value);
  return new Date(date.getFullYear(), date.getMonth(), 1);
}
function sameDay(left: Date, right: Date) {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

function moveMonth(date: Date, offset: number) {
  return new Date(date.getFullYear(), date.getMonth() + offset, 1);
}

export interface MiniMonthProps {
  anchor: number;
  onSelect: (at: number) => void;
}

/** A compact, Monday-first month picker for the calendar sidebar. */
export function MiniMonth({ anchor, onSelect }: MiniMonthProps) {
  const [visibleMonth, setVisibleMonth] = useState(() => startOfMonth(anchor));

  useEffect(() => {
    setVisibleMonth(startOfMonth(anchor));
  }, [anchor]);

  const days = useMemo(() => {
    const first = startOfMonth(visibleMonth);
    const mondayOffset = (first.getDay() + 6) % 7;
    const gridStart = new Date(first);
    gridStart.setDate(first.getDate() - mondayOffset);

    return Array.from({ length: 42 }, (_, index) => {
      const date = new Date(gridStart);
      date.setDate(gridStart.getDate() + index);
      return date;
    });
  }, [visibleMonth]);

  const selected = new Date(anchor);
  const today = new Date();
  const monthLabel = visibleMonth.toLocaleDateString(activeLocale(), {
    month: "long",
    year: "numeric",
  });

  return (
    <section aria-label={t("calendar.miniAria")} className="select-none px-3 py-3">
      <div className="mb-2 flex items-center justify-between px-1">
        <div className="text-[12.5px] font-semibold text-ink">{monthLabel}</div>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => setVisibleMonth((month) => moveMonth(month, -1))}
            className="flex size-7 items-center justify-center rounded-full text-ink-secondary transition-colors hover:bg-raised hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
            aria-label={t("calendar.prevMonth")}
          >
            <ChevronLeft size={15} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => setVisibleMonth((month) => moveMonth(month, 1))}
            className="flex size-7 items-center justify-center rounded-full text-ink-secondary transition-colors hover:bg-raised hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
            aria-label={t("calendar.nextMonth")}
          >
            <ChevronRight size={15} aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-7" aria-hidden="true">
        {WEEKDAY_ORDER.map((day) => (
          <div
            key={day}
            title={dayFull(day)}
            className="flex h-6 items-center justify-center text-[9px] font-semibold uppercase tracking-[0.08em] text-ink-secondary/75"
          >
            {dayNarrow(day)}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-y-0.5">
        {days.map((date) => {
          const isSelected = sameDay(date, selected);
          const isToday = sameDay(date, today);
          const isOutsideMonth = date.getMonth() !== visibleMonth.getMonth();
          const label = date.toLocaleDateString(activeLocale(), {
            weekday: "long",
            month: "long",
            day: "numeric",
            year: "numeric",
          });

          return (
            <button
              key={`${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`}
              type="button"
              onClick={() => onSelect(date.getTime())}
              aria-label={label}
              aria-current={isToday ? "date" : undefined}
              aria-pressed={isSelected}
              className="group flex h-7 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
            >
              <span
                className={`flex size-6 items-center justify-center rounded-full text-[10.5px] transition-colors ${
                  isSelected
                    ? "bg-accent font-semibold text-white shadow-sm"
                    : isToday
                      ? "font-semibold text-accent group-hover:bg-accent/12"
                      : isOutsideMonth
                        ? "text-ink-secondary/35 group-hover:bg-raised group-hover:text-ink-secondary"
                        : "text-ink-secondary group-hover:bg-raised group-hover:text-ink"
                }`}
              >
                {date.getDate()}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
