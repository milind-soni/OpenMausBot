// Scheduled work and the bot's own profile. The propose_* tools answer
// through confirmationResult: granted Full Access may apply immediately,
// anything else surfaces a confirmation card. propose_profile rides along
// because it answers with that same shape.
import type { Json, ToolContext, ToolHandler, ToolOutcome } from "./context.ts";

type RoutineAction = "update" | "pause" | "resume" | "run_now" | "delete";

function routineAction(value: unknown): RoutineAction | null {
  return value === "update" || value === "pause" || value === "resume" || value === "run_now" || value === "delete"
    ? value
    : null;
}

export const handlers = {
  async list_routines(_args: Json, ctx: ToolContext): Promise<ToolOutcome> {
    const query = new URLSearchParams({ fromBotId: ctx.botId, fromThreadId: ctx.threadId });
    const r = await ctx.api(`/api/internal/routines?${query.toString()}`);
    const routines = Array.isArray(r.routines) ? r.routines : [];
    const now = typeof r.now === "string" ? r.now : new Date().toISOString();
    const timeZone = typeof r.timeZone === "string" && r.timeZone ? r.timeZone : "local computer timezone";
    if (!routines.length) {
      return { text: `This bot has no routines. Current time: ${now}. Timezone: ${timeZone}.` };
    }
    return {
      text: `This bot's routines (current time: ${now}; timezone: ${timeZone}):\n${JSON.stringify(routines, null, 2)}`,
    };
  },
  async propose_routine(args: Json, ctx: ToolContext): Promise<ToolOutcome> {
    const { fields: routine, error: scheduleError } = ctx.routineFields(args);
    if (scheduleError) return { text: scheduleError, isError: true };
    if (!routine.name || !routine.instructions || !routine.schedule) {
      return { text: "propose_routine needs name, instructions, and schedule.", isError: true };
    }
    const forBotId = String(args.for_bot_id ?? "").trim();
    const r = await ctx.api("/api/internal/routine-requests", {
      method: "POST",
      body: JSON.stringify({
        fromBotId: ctx.botId,
        fromThreadId: ctx.threadId,
        action: "create",
        routine,
        // JSON.stringify drops the key entirely when no target was named
        forBotId: forBotId || undefined,
      }),
    });
    return ctx.confirmationResult(r, `the new routine “${routine.name}”`);
  },
  async propose_routine_action(args: Json, ctx: ToolContext): Promise<ToolOutcome> {
    const routineId = String(args.routine_id ?? "").trim();
    const action = routineAction(args.action);
    if (!routineId || !action) {
      return { text: "propose_routine_action needs a routine_id and supported action.", isError: true };
    }
    const body: Json = {
      fromBotId: ctx.botId,
      fromThreadId: ctx.threadId,
      action,
      routineId,
    };
    if (action === "update") {
      if (!ctx.jsonRecord(args.changes)) {
        return { text: "The update action needs at least one field in changes.", isError: true };
      }
      const { fields: changes, error: scheduleError } = ctx.routineFields(args.changes);
      if (scheduleError) return { text: scheduleError, isError: true };
      if (!Object.keys(changes).length) {
        return { text: "The update action needs at least one supported field in changes.", isError: true };
      }
      body.changes = changes;
    } else if (args.changes !== undefined) {
      return { text: `The ${action} action does not accept changes.`, isError: true };
    }
    const r = await ctx.api("/api/internal/routine-requests", {
      method: "POST",
      body: JSON.stringify(body),
    });
    return ctx.confirmationResult(r, `${action.replace("_", " ")} on routine ${routineId}`);
  },
  async propose_profile(args: Json, ctx: ToolContext): Promise<ToolOutcome> {
    const changes: Json = {};
    if (typeof args.name === "string") changes.name = args.name.trim();
    if (typeof args.title === "string") changes.title = args.title.trim();
    if (typeof args.description === "string") changes.description = args.description.trim();
    if (typeof args.soul === "string") changes.soul = args.soul;
    if (typeof args.cwd === "string") changes.cwd = args.cwd.trim();
    if (!Object.keys(changes).length) {
      return { text: "propose_profile needs at least one of name, title, description, soul, or cwd.", isError: true };
    }
    const forBotId = String(args.for_bot_id ?? "").trim();
    const r = await ctx.api("/api/internal/profile-requests", {
      method: "POST",
      body: JSON.stringify({
        fromBotId: ctx.botId,
        fromThreadId: ctx.threadId,
        changes,
        reason: args.reason,
        // JSON.stringify drops the key entirely when no target was named
        forBotId: forBotId || undefined,
      }),
    });
    return ctx.confirmationResult(r, "the profile change", "profile");
  },
} satisfies Record<string, ToolHandler>;
