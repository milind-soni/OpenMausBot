// A routine as a person, a bot or an import asked for it, checked and cleaned before RoutineManager keeps it.
import { runsOnce } from "../shared/limit-reset.ts";
import { cleanAttachments, cleanTimeoutMinutes } from "./routine-attachments.ts";
import { loadChecks } from "./routine-load.ts";
import { cleanSchedule } from "./routine-schedules.ts";
import type { Routine, RoutineInput } from "./routines.ts";

export function sanitizeInput(input: RoutineInput, after: number): Omit<Routine, "id" | "createdAt" | "updatedAt" | "nextRunAt"> {
  const name = String(input.name ?? "").trim().slice(0, 80);
  const prompt = String(input.prompt ?? "").trim().slice(0, 20_000);
  const botId = String(input.botId ?? "").trim();
  if (!name) throw new Error("Give the routine a name");
  if (!prompt) throw new Error("Tell the bot what to do");
  if (!botId) throw new Error("Choose a bot");
  const target = input.target ?? "bot";
  if (target !== "bot" && target !== "room-goal") throw new Error("Choose a valid routine target");
  const groupId = typeof input.groupId === "string" ? input.groupId.trim() : "";
  const runOn = input.runOn ?? "maus";
  if (runOn !== "maus" && runOn !== "cloud") throw new Error("Choose where this routine runs");
  const attachments = cleanAttachments(input.attachments);
  const timeoutMinutes = cleanTimeoutMinutes(input.timeoutMinutes);
  if (target === "room-goal" && runOn === "cloud") {
    throw new Error("Room goals can only run on this computer");
  }
  if (target === "room-goal" && attachments.length > 0) {
    throw new Error("Room goals do not support attachments yet");
  }
  if (runOn === "cloud" && attachments.length > 0) {
    throw new Error("Attachments can only run on this computer until cloud file staging is available");
  }
  const continuity = input.continuity === true;
  if (input.overlap !== undefined && input.overlap !== "skip" && input.overlap !== "queue") {
    throw new Error("Choose skip or queue for overlapping runs");
  }
  if (continuity && target === "room-goal") {
    throw new Error("Room goals do not carry continuity yet");
  }
  const schedule = cleanSchedule(input.schedule, after);
  const asked = Array.isArray(input.checks) && input.checks.length === 0 ? null : input.checks;
  const checks = asked == null ? undefined : loadChecks(asked);
  if (asked != null && (!checks || checks.length !== new Set(asked).size)) throw new Error("Choose checks from calendar, mail and runs");
  if (checks && (target !== "bot" || runsOnce(schedule))) throw new Error("Checks need a bot routine that repeats");
  if (input.access != null && input.access !== "read-and-draft") throw new Error("Choose read-and-draft access or none");
  if (input.deliver != null && (input.deliver !== "brief" || target !== "bot")) throw new Error("Only a bot routine can deliver to the brief");
  return {
    name,
    prompt,
    target,
    botId,
    groupId: target === "room-goal" && groupId ? groupId : undefined,
    runOn,
    enabled: input.enabled !== false,
    schedule,
    durationMinutes: Math.min(240, Math.max(5, Math.round(Number(input.durationMinutes) || 30))),
    ...(timeoutMinutes === undefined ? {} : { timeoutMinutes }),
    attachments,
    ...(continuity ? { continuity: true } : {}),
    ...(input.overlap === "queue" ? { overlap: "queue" as const } : {}),
    ...(input.runOnStartup === true && !runsOnce(schedule) ? { runOnStartup: true } : {}),
    ...(checks ? { checks } : {}),
    ...(input.access === "read-and-draft" ? { access: "read-and-draft" as const } : {}),
    ...(input.deliver === "brief" ? { deliver: "brief" as const } : {}),
  };
}
