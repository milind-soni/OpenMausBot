import { normalizeCronSchedule, nextCronRuns, type RoutineCronSchedule } from "../../../shared/routine-schedule";

export type CronChoice = "monthly" | "yearly" | "cron";
export type CronDraft = { expression: string; timeZone: string; day: string; month: string; time: string };
export const isCronChoice = (choice: string): choice is CronChoice => ["monthly", "yearly", "cron"].includes(choice);

function presetParts(expression: string) {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, day, month, weekday] = parts;
  if (!/^\d+$/.test(minute) || Number(minute) > 59 || !/^\d+$/.test(hour) || Number(hour) > 23
    || !(day === "L" || /^\d+$/.test(day) && Number(day) >= 1 && Number(day) <= 31)
    || !(month === "*" || /^\d+$/.test(month) && Number(month) >= 1 && Number(month) <= 12)
    || weekday !== "*") return null;
  return { day: day === "L" ? day : String(Number(day)), month, time: `${String(Number(hour)).padStart(2, "0")}:${String(Number(minute)).padStart(2, "0")}` };
}

export function cronChoiceFor(schedule: RoutineCronSchedule): CronChoice {
  const preset = presetParts(schedule.expression);
  return !preset ? "cron" : preset.month === "*" ? "monthly" : "yearly";
}

export function cronDraftFor(schedule: RoutineCronSchedule | undefined, at: number): CronDraft {
  const timeZone = schedule?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const preset = schedule && presetParts(schedule.expression);
  // An existing schedule's wall clock belongs to its zone, not this browser's.
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", { timeZone, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  } catch {
    parts = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  }
  const part = (name: string) => parts.find((value) => value.type === name)!.value;
  const time = preset?.time ?? `${part("hour")}:${part("minute")}`;
  const day = preset?.day ?? part("day");
  return {
    expression: schedule?.expression ?? `${Number(time.slice(3))} ${Number(time.slice(0, 2))} ${day} * *`,
    timeZone, day, month: preset && preset.month !== "*" ? String(Number(preset.month)) : part("month"), time,
  };
}

export function cronEditorValue(choice: CronChoice, draft: CronDraft, after: number, unchanged?: RoutineCronSchedule) {
  try {
    if (choice !== "cron" && !/^\d{2}:\d{2}$/.test(draft.time)) throw new Error("Choose a time for this routine.");
    const [hour, minute] = draft.time.split(":");
    const proposed: RoutineCronSchedule = unchanged ?? {
      type: "cron", timeZone: draft.timeZone,
      expression: choice === "cron" ? draft.expression : `${Number(minute)} ${Number(hour)} ${draft.day} ${choice === "yearly" ? draft.month : "*"} *`,
    };
    const normalized = normalizeCronSchedule(proposed, after);
    // Unrelated edits must preserve arbitrary expressions and their zone exactly.
    return { schedule: unchanged ?? normalized, runs: nextCronRuns(normalized, after, 3), error: "" };
  } catch (error) {
    return { schedule: null, runs: [], error: error instanceof Error ? error.message : String(error) };
  }
}
