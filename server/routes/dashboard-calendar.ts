import { createHash } from "node:crypto";
import { z } from "zod";

import { addAgendaDays, berlinDay, berlinMidnight } from "../dashboard/calendar-time.ts";
import { toAgenda, type CalendarInput } from "../dashboard/agenda.ts";
import type { DashboardCalendarChoice } from "../../shared/dashboard-calendar.ts";
import type { CalendarPreferencesStore } from "../dashboard/calendar-preferences.ts";
import { DashboardCalendarStageError } from "../dashboard/calendar-service.ts";
import { SourceError } from "../connected-reads.ts";
import { PASS, type RouteHandler } from "./table.ts";

const selectionSchema = z.object({
  calendarIds: z.array(z.string().trim().min(1).max(512)).max(50),
}).strict();

function preferenceUserId(auth: Parameters<RouteHandler>[0]["auth"]): string | null {
  if (auth.kind === "loopback") return "local-owner";
  const { session } = auth;
  if (session.userId && session.membershipAuthority !== "portal") return `user:${session.userId}`;
  const email = session.email?.trim().toLowerCase();
  if (email) return `email:${createHash("sha256").update(email).digest("hex")}`;
  return session.membershipAuthority ? null : "local-owner";
}

function failureCode(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (/invalid[_ ]grant|unauthori[sz]ed|unauthenticated|expired|401|reconnect/.test(message)) return "reconnect_required";
  if (/403|forbidden|permission|access denied|insufficient scope/.test(message)) return "calendar_access_denied";
  if (/404|not found|requested entity/.test(message)) return "calendar_not_found";
  if (/shortened|too large|size limit/.test(message)) return "response_too_large";
  if (error instanceof SourceError && error.severalAccounts) return "account_selection_required";
  return "provider_read_failed";
}

export function createDashboardCalendarRoute(deps: {
  calendars(): Promise<{ accountId: string; calendars: DashboardCalendarChoice[] }>;
  events(calendarIds: readonly string[], from: number, to: number): Promise<CalendarInput[]>;
  agenda?(calendarIds: readonly string[], from: number, to: number): Promise<
    | { missing: true }
    | { missing: false; calendars: DashboardCalendarChoice[]; selected: CalendarInput[] }
  >;
  preferences: CalendarPreferencesStore;
}): RouteHandler {
  return async ({ res, path, method, json, url, auth, readBody, req }) => {
    if (path !== "/api/dashboard/calendar-agenda" || (method !== "GET" && method !== "PUT")) return PASS;
    res.setHeader("cache-control", "no-store");
    const userId = preferenceUserId(auth);
    if (!userId) return json(res, 403, { error: "A stable account identity is required for calendar preferences" });

    if (method === "PUT") {
      const parsed = selectionSchema.safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "Invalid calendar selection" });
      const calendarIds = [...new Set(parsed.data.calendarIds)];
      let context: Awaited<ReturnType<typeof deps.calendars>>;
      try {
        context = await deps.calendars();
      } catch {
        return json(res, 503, { error: "Calendar list could not be read", stage: "calendar_validation" });
      }
      if (calendarIds.some((id) => !context.calendars.some((calendar) => calendar.id === id))) {
        return json(res, 404, { error: "A selected calendar is no longer available" });
      }
      try {
        deps.preferences.save(userId, context.accountId, calendarIds);
        return json(res, 200, { selectedCalendarIds: calendarIds });
      } catch {
        return json(res, 503, { error: "Calendar preferences could not be saved" });
      }
    }

    if (method !== "GET") return PASS;
    const calendarIds = [...new Set(url.searchParams.getAll("calendarId"))];
    const today = berlinDay(new Date());
    const from = Date.parse(berlinMidnight(today));
    const to = Date.parse(berlinMidnight(addAgendaDays(today, 4)));
    if (calendarIds.length === 0) {
      let context: Awaited<ReturnType<typeof deps.calendars>>;
      try {
        context = await deps.calendars();
      } catch {
        return json(res, 503, { error: "Calendar list could not be read", stage: "calendar_list" });
      }
      try {
        const availableIds = new Set(context.calendars.map((calendar) => calendar.id));
        const storedIds = deps.preferences.selected(userId, context.accountId);
        const selectedCalendarIds = storedIds.filter((id) => availableIds.has(id));
        if (selectedCalendarIds.length !== storedIds.length) {
          deps.preferences.save(userId, context.accountId, selectedCalendarIds);
        }
        return json(res, 200, { calendars: context.calendars, selectedCalendarIds });
      } catch {
        return json(res, 503, { error: "Calendar preferences could not be read", stage: "preferences" });
      }
    }
    if (calendarIds.length > 50 || calendarIds.some((id) => !id.trim() || id.length > 512)) return json(res, 400, { error: "Invalid calendar selection" });
    if (deps.agenda) {
      try {
        const result = await deps.agenda(calendarIds, from, to);
        if (result.missing) return json(res, 404, { error: "A selected calendar is no longer available" });
        const calendarById = new Map(result.calendars.map((calendar) => [calendar.id, calendar]));
        const withColors = result.selected.map((item) => {
          const color = calendarById.get(item.calendarId)?.color;
          return item.metadata || !color ? item : { ...item, metadata: { backgroundColor: color } };
        });
        return json(res, 200, toAgenda(withColors, today));
      } catch (error) {
        if (error instanceof DashboardCalendarStageError && error.stage === "calendar_validation") {
          return json(res, 503, { error: "Calendar list could not be read", stage: "calendar_validation" });
        }
        const cause = error instanceof DashboardCalendarStageError ? error.cause : error;
        return json(res, 503, { error: "Calendar events could not be read", stage: "events", code: failureCode(cause) });
      }
    }
    let calendars: DashboardCalendarChoice[];
    try {
      calendars = (await deps.calendars()).calendars;
    } catch {
      return json(res, 503, { error: "Calendar list could not be read", stage: "calendar_validation" });
    }
    const calendarById = new Map(calendars.map((calendar) => [calendar.id, calendar]));
    if (calendarIds.some((id) => !calendarById.has(id))) return json(res, 404, { error: "A selected calendar is no longer available" });
    try {
      const selected = await deps.events(calendarIds, from, to);
      const withColors = selected.map((item) => {
        const color = calendarById.get(item.calendarId)?.color;
        return item.metadata || !color ? item : { ...item, metadata: { backgroundColor: color } };
      });
      return json(res, 200, toAgenda(withColors, today));
    } catch (error) {
      return json(res, 503, { error: "Calendar events could not be read", stage: "events", code: failureCode(error) });
    }
  };
}
