// The scheduled-room ("calendar call") HTTP routes, extracted verbatim from
// index.ts's dispatch chain. Path matching, methods, and status codes are
// unchanged; the handler returns false for anything it does not own so the
// chain falls through in the same order.
import type { IncomingMessage, ServerResponse } from "node:http";

import { json, readBody, type RouteContext } from "./http.ts";
import type { CalendarCall, CalendarCallManager } from "../calendar-calls.ts";
import { store } from "../runtime.ts";
import type { GroupRecord } from "../store.ts";
import type { WireGroup } from "../../shared/wire.ts";

export function createCalendarCallRoutes(deps: {
  calendarCalls: () => CalendarCallManager;
  ensureCalendarCallRoom: (call: CalendarCall) => GroupRecord;
  publicGroupState: (group: GroupRecord) => WireGroup;
}) {
  return async (req: IncomingMessage, res: ServerResponse, rctx: RouteContext): Promise<boolean> => {
    const { method, path } = rctx;
    const { calendarCalls, ensureCalendarCallRoom, publicGroupState } = deps;
    // ── scheduled room sessions ────────────────────────────────────────
    if (path === "/api/calendar-calls" && method === "GET") {
      json(res, 200, { calls: calendarCalls().list() });
      return true;
    }
    if (path === "/api/calendar-calls" && method === "POST") {
      try {
        json(res, 201, { call: calendarCalls().create(await readBody(req)) });
        return true;
      } catch (error) {
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), { status: 400 });
      }
    }
    const calendarCallRoomMatch = path.match(/^\/api\/calendar-calls\/([\w-]+)\/room$/);
    if (calendarCallRoomMatch && method === "POST") {
      const call = calendarCalls().get(calendarCallRoomMatch[1]);
      if (!call) {
        json(res, 404, { error: "no such scheduled call" });
        return true;
      }
      if (call.botIds.length < 2) {
        json(res, 400, { error: "single-bot events open that bot's chat directly" });
        return true;
      }
      const group = ensureCalendarCallRoom(call);
      json(res, 200, { group: { ...publicGroupState(group), messages: store.messagesFor(group.threadId) } });
      return true;
    }
    const calendarCallMatch = path.match(/^\/api\/calendar-calls\/([\w-]+)$/);
    if (calendarCallMatch && method === "PATCH") {
      if (!calendarCalls().get(calendarCallMatch[1])) {
        json(res, 404, { error: "no such scheduled call" });
        return true;
      }
      try {
        json(res, 200, { call: calendarCalls().update(calendarCallMatch[1], await readBody(req)) });
        return true;
      } catch (error) {
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), { status: 400 });
      }
    }
    if (calendarCallMatch && method === "DELETE") {
      if (calendarCalls().remove(calendarCallMatch[1])) {
        json(res, 200, { ok: true });
      } else {
        json(res, 404, { error: "no such scheduled call" });
      }
      return true;
    }
    return false;
  };
}
