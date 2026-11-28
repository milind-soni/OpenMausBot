import type { CalendarCall, CalendarCallInput, CalendarCallManager, CalendarCallPatch } from "../calendar-calls.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { GroupRecord } from "../store.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface CalendarCallRouteDeps {
  calls: Pick<CalendarCallManager, "list" | "get" | "create" | "update" | "remove">;
  /** The audience refusal for a roster, worded once in index.ts and shared with room creation. */
  audienceConflict(body: unknown): string | null;
  /** The room a multi-bot call opens. index.ts also uses it when a call is delivered. */
  ensureRoom(call: CalendarCall): GroupRecord;
  /** The room as this caller may see it. */
  roomView(auth: RequestAuth, group: GroupRecord): object;
  messages(threadId: string): unknown[];
}

export function createCalendarCallRoutes(deps: CalendarCallRouteDeps): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (path === "/api/calendar-calls" && method === "GET") {
      return json(res, 200, { calls: deps.calls.list() });
    }
    if (path === "/api/calendar-calls" && method === "POST") {
      try {
        const body = await readBody(req);
        const conflict = deps.audienceConflict(body);
        if (conflict) return json(res, 400, { error: conflict });
        return json(res, 201, { call: deps.calls.create(body as CalendarCallInput) });
      } catch (error) {
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), { status: 400 });
      }
    }
    const calendarCallRoomMatch = path.match(/^\/api\/calendar-calls\/([\w-]+)\/room$/);
    if (calendarCallRoomMatch && method === "POST") {
      const call = deps.calls.get(calendarCallRoomMatch[1]!);
      if (!call) return json(res, 404, { error: "no such scheduled call" });
      if (call.botIds.length < 2) {
        return json(res, 400, { error: "single-bot events open that bot's chat directly" });
      }
      const group = deps.ensureRoom(call);
      return json(res, 200, { group: { ...deps.roomView(auth, group), messages: deps.messages(group.threadId) } });
    }
    const calendarCallMatch = path.match(/^\/api\/calendar-calls\/([\w-]+)$/);
    if (calendarCallMatch && method === "PATCH") {
      if (!deps.calls.get(calendarCallMatch[1]!)) return json(res, 404, { error: "no such scheduled call" });
      try {
        const body = await readBody(req);
        const conflict = deps.audienceConflict(body);
        if (conflict) return json(res, 400, { error: conflict });
        return json(res, 200, { call: deps.calls.update(calendarCallMatch[1]!, body as CalendarCallPatch) });
      } catch (error) {
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), { status: 400 });
      }
    }
    if (calendarCallMatch && method === "DELETE") {
      return deps.calls.remove(calendarCallMatch[1]!)
        ? json(res, 200, { ok: true })
        : json(res, 404, { error: "no such scheduled call" });
    }
    return PASS;
  };
}
