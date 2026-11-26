import type { DashboardAgendaDay as AgendaDay, DashboardAgendaEvent as AgendaEvent } from "../../shared/dashboard-calendar.ts";
import type { CalendarEvent } from "../connected-reads.ts";

import { addAgendaDays, berlinDay } from "./calendar-time.ts";

export type CalendarInput = {
  calendarId: string;
  events: CalendarEvent[];
  metadata?: { backgroundColor?: string };
};

export function toAgenda(
  calendars: CalendarInput[],
  today: string,
): AgendaDay[] {
  const windowEnd = addAgendaDays(today, 4);
  const days = new Map<string, AgendaDay>([
    [today, { date: today, events: [] }],
  ]);

  for (const calendar of calendars) {
    for (const event of calendar.events) {
      const start = Number.isFinite(event.start) ? new Date(event.start).toISOString() : "";
      const end = Number.isFinite(event.end) ? new Date(event.end).toISOString() : "";

      if (event.status === "cancelled" || !event.id || !start || !end) {
        continue;
      }

      const agendaEvent: AgendaEvent = {
        id: `${calendar.calendarId}:${event.id}`,
        title: event.title.trim() || "Untitled",
        start: event.allDay ? start.slice(0, 10) : start,
        end: event.allDay ? end.slice(0, 10) : end,
        allDay: event.allDay,
        calendarId: calendar.calendarId,
        color: calendar.metadata?.backgroundColor,
      };
      const startTime = Date.parse(start);
      const endTime = Date.parse(end);
      if (
        !Number.isFinite(startTime) ||
        !Number.isFinite(endTime) ||
        endTime <= startTime
      ) {
        continue;
      }

      const firstDay = agendaEvent.allDay
        ? start.slice(0, 10)
        : berlinDay(new Date(startTime));
      const lastDay = agendaEvent.allDay
        ? addAgendaDays(end.slice(0, 10), -1)
        : berlinDay(new Date(endTime - 1));

      for (
        let date = firstDay < today ? today : firstDay;
        date <= lastDay && date < windowEnd;
        date = addAgendaDays(date, 1)
      ) {
        const day = days.get(date);
        if (day) {
          day.events.push(agendaEvent);
        } else {
          days.set(date, { date, events: [agendaEvent] });
        }
      }
    }
  }

  const agenda = [...days.values()].sort((a, b) =>
    a.date.localeCompare(b.date),
  );
  for (const { events } of agenda) {
    events.sort(
      (a, b) =>
        Number(b.allDay) - Number(a.allDay) ||
        Date.parse(a.start) - Date.parse(b.start),
    );
  }

  return agenda;
}
