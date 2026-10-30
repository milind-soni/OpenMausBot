// The engines' usage limits and the automations that wait for them to reset. All three need admin scope
// (request-auth's default):
//   GET  /api/limit-resets              each engine's limit: how full, when it resets, whether it refuses work
//   POST /api/limit-resets/continue     {botId, threadId}: the stopped turn's "Continue when your limit resets"
//   POST /api/limit-resets/after-reset  {routineId, engine}: move only that automation's next run past the reset
import { AFTER_RESET_MS, type LimitResetSchedule } from "../../shared/limit-reset.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { LimitResetClock } from "../limit-resets.ts";
import type { RoutineRequestService } from "../routine-requests.ts";
import type { Routine, RoutineManager } from "../routines.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface LimitResetRouteDeps {
  clock: LimitResetClock;
  now?: () => number;
  routines: RoutineManager;
  requests: Pick<RoutineRequestService, "submit">;
  /** The conversation's title, or null when the bot has no such conversation. */
  threadTitle(botId: string, threadId: string): string | null;
  /** The engine this conversation runs on now. */
  threadEngine(botId: string, threadId: string): string | undefined;
  engineName(engine: string): string;
  /** The automation the button made, for whoever's it is (a Cloud home's authors). */
  created?(routineId: string, auth: RequestAuth): void;
}

const MAX_TITLE = 60;

/** What the continuation is told: the previous turn stopped on the limit, so it picks up from there without redoing work. */
export function continueInstructions(title: string, engine: string): string {
  return `Continue the conversation “${title}” where it stopped. Your previous turn here was cut off because ${engine}'s usage limit ` +
    "was reached before you finished. Read the conversation, pick up exactly where you left off and finish the work; do not redo " +
    "what is already done. Then say in a sentence or two what you finished.";
}

function waitingIn(routines: readonly Routine[], botId: string, threadId: string): Routine | undefined {
  return routines.find((routine) => routine.enabled && routine.botId === botId && routine.sourceThreadId === threadId &&
    routine.schedule.type === "limit_reset" && routine.schedule.repeat === "once");
}

const text = (value: unknown, max: number) => typeof value === "string" && value.trim() && value.length <= max ? value.trim() : null;

export function createLimitResetRoutes(deps: LimitResetRouteDeps): RouteHandler {
  return async ({ req, res, url, path, method, auth, json, readBody }) => {
    if (path === "/api/limit-resets" && method === "GET") {
      res.setHeader("cache-control", "no-store");
      const fresh = deps.clock.ensureFresh();
      if (url.searchParams.get("refresh") === "1" || deps.clock.report().checkedAt === 0) await fresh;
      return json(res, 200, deps.clock.report());
    }
    if (path === "/api/limit-resets/continue" && method === "POST") {
      const body = await readBody(req, 4096) as Record<string, unknown> | null;
      const botId = text(body?.botId, 128), threadId = text(body?.threadId, 128);
      if (!botId || !threadId) return json(res, 400, { error: "botId and threadId are required" });
      const title = deps.threadTitle(botId, threadId);
      if (title === null) return json(res, 404, { error: "no such conversation" });
      const existing = waitingIn(deps.routines.listRoutines(), botId, threadId);
      if (existing) return json(res, 200, { routine: existing });
      const engine = deps.threadEngine(botId, threadId);
      if (!engine) return json(res, 409, { error: "This conversation has no engine to wait for." });
      const short = title.length > MAX_TITLE ? `${title.slice(0, MAX_TITLE - 1).trimEnd()}…` : title;
      const schedule: Omit<LimitResetSchedule, "at"> = { type: "limit_reset", engine, repeat: "once" };
      try {
        const submitted = await deps.requests.submit({ botId, threadId, proposal: { action: "create", routine: {
          name: `Continue “${short}”`.slice(0, 80), instructions: continueInstructions(short, deps.engineName(engine)), schedule,
        } } });
        const routineId = submitted.result?.resultId;
        const routine = routineId ? deps.routines.listRoutines().find((candidate) => candidate.id === routineId) : undefined;
        if (routine) deps.created?.(routine.id, auth);
        return json(res, 201, { routine, messageId: submitted.messageId });
      } catch (error) {
        const status = (error as { status?: unknown }).status;
        return json(res, typeof status === "number" ? status : 400, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (path === "/api/limit-resets/after-reset" && method === "POST") {
      const body = await readBody(req, 4096) as Record<string, unknown> | null;
      const routineId = text(body?.routineId, 200), engine = text(body?.engine, 128);
      if (!routineId || !engine) return json(res, 400, { error: "routineId and engine are required" });
      const reset = deps.clock.resetAt(engine);
      if (reset === null) return json(res, 409, { error: "That limit's reset time is not known yet." });
      const routine = deps.routines.deferNextRun(routineId, Math.max(reset + AFTER_RESET_MS, (deps.now ?? Date.now)()));
      return routine ? json(res, 200, { routine }) : json(res, 404, { error: "no such automation" });
    }
    return PASS;
  };
}
