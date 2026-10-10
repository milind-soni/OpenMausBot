import type { RoutineCronSchedule } from "./routine-schedule.ts";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** Describe familiar presets; retain the exact expression for everything else.
 * This is presentation only, never a second parser or source of scheduling truth. */
export function cronScheduleLabel(schedule: RoutineCronSchedule): string {
  const [minute, hour, day, month, weekday] = schedule.expression.trim().split(/\s+/);
  let label = `Cron ${schedule.expression}`;
  if (/^\d+$/.test(minute ?? "") && /^\d+$/.test(hour ?? "")) {
    const time = `${hour!.padStart(2, "0")}:${minute!.padStart(2, "0")}`;
    const monthDay = /^\d+$/.test(day ?? "") ? Number(day) : null;
    if (weekday === "*" && month === "*") {
      if (day === "*") label = `Every day at ${time}`;
      else if (day === "L") label = `Monthly on the last day at ${time}`;
      else if (monthDay !== null) label = `Monthly on day ${monthDay} at ${time}`;
    } else if (weekday === "*" && /^\d+$/.test(month ?? "") && monthDay !== null) {
      const name = MONTHS[Number(month) - 1];
      if (name) label = `Yearly on ${name} ${monthDay} at ${time}`;
    } else if (day === "*" && month === "*") {
      if (weekday === "1-5" || weekday?.toUpperCase() === "MON-FRI") label = `Every weekday at ${time}`;
      else if (/^[0-7]$/.test(weekday ?? "")) label = `Weekly on ${WEEKDAYS[Number(weekday) % 7]} at ${time}`;
      else {
        const nth = /^([0-7])#([1-5]|L)$/i.exec(weekday ?? "");
        if (nth) {
          const order = nth[2]!.toUpperCase() === "L" ? "last" : ["", "first", "second", "third", "fourth", "fifth"][Number(nth[2])];
          label = `Monthly on the ${order} ${WEEKDAYS[Number(nth[1]) % 7]} at ${time}`;
        }
      }
    }
  }
  return `${label} · ${schedule.timeZone}`;
}
