import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { CalendarDays, ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";
import { intlLocale, t } from "@/lib/i18n";
import { fromLocalDateAndTime, toLocalDateInput } from "@/lib/routine-calendar";
import { MiniMonth } from "./MiniMonth";

export function RoutineDatePicker({ value, onChange, min, label, invalid, describedBy }: {
  value: string;
  onChange: (value: string) => void;
  min?: string;
  label: string;
  invalid?: boolean;
  describedBy?: string;
}) {
  const [open, setOpen] = useState(false);
  const picker = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; width: number; maxHeight: number; top?: number; bottom?: number }>();
  const trigger = useRef<HTMLButtonElement>(null);
  const calendarId = useId();
  const at = fromLocalDateAndTime(value, "00:00");
  const dateLabel = Number.isFinite(at)
    ? new Date(at).toLocaleDateString(intlLocale(), { year: "numeric", month: "short", day: "numeric", weekday: "short" })
    : t("routines.miniCalendar.label");

  const close = useCallback(() => {
    setOpen(false);
    trigger.current?.focus();
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const button = trigger.current;
      if (!button) return;
      const rect = button.getBoundingClientRect();
      const edge = 12;
      const width = Math.min(268, window.innerWidth - edge * 2);
      const start = getComputedStyle(button).direction === "rtl" ? rect.right - width : rect.left;
      const left = Math.max(edge, Math.min(start, window.innerWidth - width - edge));
      const below = window.innerHeight - rect.bottom - edge - 5;
      const above = rect.top - edge - 5;
      setPosition(below >= 266 || below >= above
        ? { left, width, top: rect.bottom + 5, maxHeight: below }
        : { left, width, bottom: window.innerHeight - rect.top + 5, maxHeight: above });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  useEffect(() => {
    const element = picker.current;
    if (!open || !element) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !element.contains(event.target)) setOpen(false);
    };
    element.addEventListener("keydown", escape);
    document.addEventListener("pointerdown", dismiss);
    return () => {
      element.removeEventListener("keydown", escape);
      document.removeEventListener("pointerdown", dismiss);
    };
  }, [close, open]);

  return (
    <div ref={picker} className="min-w-0">
      <button ref={trigger} type="button" aria-label={`${label} · ${dateLabel}`} aria-expanded={open}
        aria-controls={open ? calendarId : undefined} aria-invalid={invalid} aria-describedby={describedBy}
        onClick={() => setOpen(value => !value)}
        className={cn("flex min-h-9 max-w-full items-center gap-2 rounded-lg border bg-control px-3 text-start text-[13px] text-ink interaction:bg-raised/50", invalid ? "border-danger/70" : "border-hairline/45")}>
        <CalendarDays size={15} className="shrink-0 text-ink-secondary" aria-hidden="true" />
        <span className="truncate">{dateLabel}</span>
        <ChevronDown size={13} className="shrink-0 text-ink-secondary" aria-hidden="true" />
      </button>
      {open && position && <div id={calendarId} style={position} className="fixed z-30 overflow-y-auto overscroll-contain rounded-xl border border-hairline/45 bg-menu shadow-(--shadow-float)">
        <MiniMonth anchor={Number.isFinite(at) ? at : Date.now()} min={min ? fromLocalDateAndTime(min, "00:00") : undefined}
          onSelect={day => { onChange(toLocalDateInput(day)); close(); }} />
      </div>}
    </div>
  );
}
