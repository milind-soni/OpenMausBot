// How a routine request's card words its schedule; server/routine-requests.ts re-exports these.
import type { RoutineRequestSchedule } from "../shared/routine-request.ts";
import { plainClock, plainTimeZone, plainWeekdays } from "../shared/plain-time-zone.ts";
import { formatInstant, routineCronText } from "./routine-cron-text.ts";
import { intervalHasRestrictions } from "./routine-intervals.ts";

/** Names an engine and says when its usage limit resets, for a limit-reset routine's card. */
export interface LimitResetEngines {
  name(engine: string): string;
  resetAt(engine: string): number | null;
  /** The engine a bot works on now, for a limit-reset routine that names none. */
  botEngine(botId: string): string | undefined;
}

export function scheduleText(schedule: RoutineRequestSchedule, timeZone: string, engines?: LimitResetEngines, language?: string): string {
  if (schedule.type === "cron") return `${routineCronText(schedule, language)} · Cron: ${schedule.expression}`;
  if (schedule.type === "limit_reset") {
    const name = engines?.name(schedule.engine) ?? schedule.engine;
    return schedule.repeat === "every_reset" ? `Each time ${name}'s usage limit resets` : `When ${name}'s usage limit resets`;
  }
  const zone = plainTimeZone(timeZone);
  if (schedule.type === "once") return `${formatInstant(schedule.at, timeZone)} ${zone}`;
  if (schedule.type === "interval") {
    const restricted = intervalHasRestrictions(schedule);
    const cadence = schedule.anchorAt === undefined
      ? restricted
        ? `Every ${schedule.everyMinutes} minutes, cadence starting at confirmation; first run is the next allowed time`
        : `Every ${schedule.everyMinutes} minutes, starting one interval after confirmation`
      : `Every ${schedule.everyMinutes} minutes, anchored at ${formatInstant(schedule.anchorAt, timeZone)} ${zone}`;
    const restrictions = [
      schedule.weekdays?.length
        ? `on ${plainWeekdays(schedule.weekdays)} (${zone})`
        : null,
      schedule.window ? `during ${plainClock(schedule.window.start)}–${plainClock(schedule.window.end)} ${zone}` : null,
      schedule.endsAt !== undefined ? `until ${formatInstant(schedule.endsAt, timeZone)} ${zone}` : null,
    ].filter((part): part is string => part !== null);
    return restrictions.length ? `${cadence} · ${restrictions.join(" · ")}` : cadence;
  }
  return `${plainWeekdays(schedule.weekdays)} at ${plainClock(schedule.time)} ${zone}`;
}

export function consequenceLine(schedule: RoutineRequestSchedule, continuity = false): string {
  const session = continuity ? "each run starts a fresh session with the previous run's report" : "each run starts a fresh session";
  if (schedule.type === "cron") return `Will run at matching calendar times, ${plainTimeZone(schedule.timeZone)}; ${session}.`;
  if (schedule.type === "once") return "Will run once; that run starts a fresh session.";
  if (schedule.type === "limit_reset") {
    return schedule.repeat === "every_reset"
      ? "Will run a minute after each time that usage limit resets, in this conversation."
      : "Will run once, a minute after that usage limit resets, and continue in this conversation.";
  }
  if (schedule.type === "interval") {
    if (intervalHasRestrictions(schedule)) {
      return `Will run every ${schedule.everyMinutes} minutes when its day, time, and end restrictions allow; ${session}.`;
    }
    const runsPerDay = Math.round(1440 / schedule.everyMinutes);
    const cadence = runsPerDay <= 1 ? "about once a day" : `about ${runsPerDay} times a day`;
    return `Will run ${cadence}; ${session}.`;
  }
  const days = schedule.weekdays.length;
  const cadence = days === 7 ? "every day" : days === 1 ? "one day a week" : `${days} days a week`;
  return `Will run ${cadence}; ${session}.`;
}
