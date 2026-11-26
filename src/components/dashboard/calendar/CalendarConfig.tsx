import type { DashboardCalendarChoice } from "../../../../shared/dashboard-calendar";

export function CalendarConfig(props: {
  id?: string;
  calendars: DashboardCalendarChoice[];
  selectedIds: readonly string[];
  saving: boolean;
  error: boolean;
  onToggle(id: string): void;
  onRetry(): void;
}) {
  return <div id={props.id} className="flex flex-col gap-1">
    {props.calendars.length === 0 && <p className="text-sm text-ink-secondary">No calendars available.</p>}
    {props.calendars.map((calendar) => <label key={calendar.id} className="flex min-h-10 cursor-pointer items-center gap-3 rounded-lg px-3 text-sm text-ink hover:bg-ink/[0.06]">
      <input type="checkbox" checked={props.selectedIds.includes(calendar.id)} onChange={() => props.onToggle(calendar.id)} className="size-4 shrink-0 accent-accent" />
      <span aria-hidden="true" className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: calendar.color ?? "var(--color-accent)" }} />
      <span className="min-w-0 flex-1 truncate">{calendar.name}</span>
      {calendar.primary && <span className="shrink-0 text-xs text-ink-secondary">Primary</span>}
    </label>)}
    {props.error && <p role="alert" className="px-3 pt-1 text-sm text-ink-secondary">Couldn’t save your calendar selection. <button type="button" className="underline" onClick={props.onRetry}>Try again</button></p>}
    {props.saving && <span className="sr-only" role="status">Saving calendar selection</span>}
  </div>;
}
