import type { AppConfig } from "../config.ts";
import type { DashboardCalendarChoice } from "../../shared/dashboard-calendar.ts";
import * as composio from "../composio.ts";
import { createConnectedReads, type MailBodySession } from "../connected-reads.ts";
import type { CalendarInput } from "./agenda.ts";

export const CALENDAR_CHOICES_TTL_MS = 60_000;

export class DashboardCalendarStageError extends Error {
  readonly stage: "calendar_validation" | "events";

  constructor(stage: "calendar_validation" | "events", cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.stage = stage;
  }
}

export function createDashboardCalendarService(getCfg: () => AppConfig, now: () => number = Date.now) {
  const choicesCache = new Map<string, { at: number; calendars: DashboardCalendarChoice[] }>();

  async function session() {
    const cfg = getCfg();
    if (!composio.configured(cfg)) throw new Error("Google Calendar is unavailable");
    const { services } = await composio.sharedConnectedInventory(cfg);
    const service = services.googlecalendar;
    if (!service?.connected) {
      choicesCache.clear();
      throw new Error("Google Calendar is disconnected");
    }
    const accounts = service.accounts ?? [];
    const account = accounts.find((entry) => /^active$/i.test(entry.status))?.id;
    if (accounts.length > 0 && !account) throw new Error("Google Calendar has no active account");
    const reads = createConnectedReads({
      connected: async () => ({ googlecalendar: true }),
      relay: (payload, transportSessionId, signal) =>
        composio.relayMcp(cfg, payload as never, transportSessionId, undefined, signal),
    }).session();
    return { reads, account, accountId: account ?? "default" };
  }

  async function listChoices(
    reads: MailBodySession,
    accountId: string,
    account: string | undefined,
    requiredIds?: readonly string[],
  ): Promise<DashboardCalendarChoice[]> {
    const cached = choicesCache.get(accountId);
    const fresh = cached !== undefined && now() - cached.at < CALENDAR_CHOICES_TTL_MS;
    const coversRequired = !requiredIds || requiredIds.every((id) => cached?.calendars.some((calendar) => calendar.id === id));
    if (fresh && coversRequired) return cached.calendars;

    const calendars = await reads.calendarChoices(account);
    choicesCache.set(accountId, { at: now(), calendars });
    return calendars;
  }

  return {
    calendars: async () => {
      const { reads, account, accountId } = await session();
      return {
        accountId,
        calendars: await listChoices(reads, accountId, account),
      };
    },
    events: async (calendarIds: readonly string[], from: number, to: number): Promise<CalendarInput[]> => {
      const { reads, account } = await session();
      const events = await reads.selectedCalendarEvents({
        ...(account ? { account } : {}),
        calendarIds,
        fromMs: from,
        toMs: to,
      });
      return calendarIds.map((calendarId) => ({
        calendarId,
        events: events.filter((event) => event.calendarId === calendarId),
      }));
    },
    agenda: async (calendarIds: readonly string[], from: number, to: number): Promise<
      | { missing: true }
      | { missing: false; calendars: DashboardCalendarChoice[]; selected: CalendarInput[] }
    > => {
      let current: Awaited<ReturnType<typeof session>>;
      let calendars: DashboardCalendarChoice[];
      try {
        current = await session();
        calendars = await listChoices(current.reads, current.accountId, current.account, calendarIds);
      } catch (error) {
        throw new DashboardCalendarStageError("calendar_validation", error);
      }
      const available = new Set(calendars.map((calendar) => calendar.id));
      if (calendarIds.some((id) => !available.has(id))) {
        return { missing: true };
      }
      try {
        const events = await current.reads.selectedCalendarEvents({
          ...(current.account ? { account: current.account } : {}),
          calendarIds,
          fromMs: from,
          toMs: to,
        });
        return {
          missing: false,
          calendars,
          selected: calendarIds.map((calendarId) => ({
            calendarId,
            events: events.filter((event) => event.calendarId === calendarId),
          })),
        };
      } catch (error) {
        throw new DashboardCalendarStageError("events", error);
      }
    },
  };
}
