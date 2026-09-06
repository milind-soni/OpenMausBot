import { atLocalTime } from "@/lib/routine-calendar";
import type { RoutineSchedule } from "@/lib/routines";

export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export function niceTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function niceDate(at: number): string {
  return new Date(at).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
}

/** A change's timestamp for a list row: the time alone if it happened
 * today, else the date — one rule shared by the Overview's recent-changes
 * card and the History section so the same row never reads two ways. */
export function whenLabel(at: number): string {
  const date = new Date(at);
  const sameDay = new Date().toDateString() === date.toDateString();
  return sameDay ? niceTime(at) : date.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function durationLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  if (minutes % 60 === 0) return `${minutes / 60} hr`;
  return `${Math.floor(minutes / 60)} hr ${minutes % 60} min`;
}

export function intervalLabel(minutes: number): string {
  if (minutes < 60) return `Every ${minutes} min`;
  if (minutes === 60) return "Every hour";
  if (minutes % 60 === 0) return `Every ${minutes / 60} hr`;
  return `Every ${Math.floor(minutes / 60)} hr ${minutes % 60} min`;
}

export function scheduleLabel(schedule: RoutineSchedule | { type: "once"; at: number } | { type: "daily"; time: string; weekdays: number[] }): string {
  if (schedule.type === "once") return `${niceDate(schedule.at)}, ${niceTime(schedule.at)}`;
  if (schedule.type === "interval") {
    return `${intervalLabel(schedule.everyMinutes)} · starting ${niceDate(schedule.anchorAt)}, ${niceTime(schedule.anchorAt)}`;
  }
  const days = schedule.weekdays;
  const label = days.length === 7
    ? "Every day"
    : days.join(",") === "1,2,3,4,5"
      ? "Every weekday"
      : days.length === 1
        ? `Weekly on ${DAY_NAMES[days[0]!]}`
        : days.map((day) => DAY_NAMES[day]).join(", ");
  return `${label} at ${niceTime(atLocalTime(Date.now(), schedule.time))}`;
}

export function scheduleSentence(schedule: RoutineSchedule): string {
  if (schedule.type === "interval") {
    const label = intervalLabel(schedule.everyMinutes);
    // Convert "Every X min" → "every X minutes", "Every hour" → "every hour", etc.
    const lowercase = label.replace(/^Every /, "every ");
    // Replace "N min" with "N minutes" (avoid replacing if already "minutes")
    const withMinutes = lowercase.replace(/(\d+) min(?!ute)/g, "$1 minutes");
    // Replace "1 hr" with "1 hour" and "N hr" with "N hours" (but leave "every hour" unchanged)
    return withMinutes.replace(/(\d+) hr(?!our)/g, (_match, num) => {
      return num === "1" ? "1 hour" : `${num} hours`;
    });
  }
  if (schedule.type === "once") {
    return `once on ${niceDate(schedule.at)}, ${niceTime(schedule.at)}`;
  }
  // type === "daily"
  const days = schedule.weekdays;
  const timeStr = niceTime(atLocalTime(Date.now(), schedule.time));

  if (days.length === 7) {
    return `every day at ${timeStr}`;
  }
  if (days.join(",") === "1,2,3,4,5") {
    return `every weekday at ${timeStr}`;
  }
  if (days.length === 1) {
    return `weekly on ${DAY_NAMES[days[0]!]} at ${timeStr}`;
  }

  // Custom multi-day selection
  return `${days.map((day) => DAY_NAMES[day]).join(", ")} at ${timeStr}`;
}
