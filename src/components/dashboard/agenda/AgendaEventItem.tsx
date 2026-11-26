import type { DashboardAgendaEvent } from "../../../../shared/dashboard-calendar";

const EVENT_TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  timeZone: "Europe/Berlin",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export function AgendaEventItem({ event, calendarName }: {
  event: DashboardAgendaEvent;
  calendarName: string;
}) {
  return <article
    data-agenda-event=""
    className="grid min-w-0 grid-cols-[max-content_minmax(0,1fr)] items-baseline gap-x-3 border-s-4 py-1 ps-2"
    style={{ borderInlineStartColor: event.color ?? "var(--color-accent)" }}
  >
    {event.allDay
      ? <span className="whitespace-nowrap text-[15px] tabular-nums text-ink-secondary">All day</span>
      : <time dateTime={event.start} className="whitespace-nowrap text-[15px] tabular-nums text-ink-secondary">
        {EVENT_TIME_FORMAT.format(new Date(event.start))}
      </time>}
    <div className="min-w-0 break-words text-[15px] font-semibold leading-tight text-ink" title={`${event.title} · ${calendarName}`}>
      {event.title}
    </div>
  </article>;
}
