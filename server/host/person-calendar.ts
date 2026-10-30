// A Team Cloud member's busy times, for their assistant to say when they are free. Read through the member's own Google
// Calendar connection, made when Google Calendar is an app each person connects for themselves; never the team's.
// Security: only start and end times leave this module, never a title, a place, a description or who is invited.
import { createConnectedReads, type CalendarEvent, type ConnectedReadDeps } from "../connected-reads.ts";
import type { BrokerAccess } from "../team-connections.ts";
import type { Busy } from "./representative.ts";

export interface PersonCalendarDeps {
  /** The member's own connected-apps access while Google Calendar is each person's own here; null otherwise. */
  access(person: string): BrokerAccess | null;
  connected(access: BrokerAccess): Promise<boolean>;
  relay(payload: unknown, transportSessionId: string | undefined, signal: AbortSignal, access: BrokerAccess): ReturnType<ConnectedReadDeps["relay"]>;
}

/** Busy times, merged where they touch: every event the person did not decline and that is not cancelled. A day-long
 * event marks a day, not busy hours, so it is left out, as calendars count it free. */
export function busyTimes(events: readonly CalendarEvent[]): Busy[] {
  const slots = events.filter((event) => !event.allDay && event.status !== "cancelled" && !event.selfDeclined && event.end > event.start)
    .map((event) => ({ start: event.start, end: event.end })).sort((a, b) => a.start - b.start);
  const merged: Busy[] = [];
  for (const slot of slots) {
    const last = merged.at(-1);
    if (last && slot.start <= last.end) last.end = Math.max(last.end, slot.end);
    else merged.push({ ...slot });
  }
  return merged;
}

export function createPersonCalendar(deps: PersonCalendarDeps) {
  return {
    /** Null when the person connected no calendar of their own. */
    async busy(person: string, fromMs: number, toMs: number): Promise<Busy[] | null> {
      const access = deps.access(person);
      if (!access || !(await deps.connected(access))) return null;
      const reads = createConnectedReads({
        connected: async () => ({ gmail: false, googlecalendar: true }),
        relay: (payload, session, signal) => deps.relay(payload, session, signal, access),
      });
      return busyTimes(await reads.session().events(fromMs, toMs));
    },
  };
}
