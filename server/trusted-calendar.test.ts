import { expect, it } from "vitest";
import { readCalendarBusy } from "./trusted-calendar.ts";
const start = Date.parse("2026-11-01T09:00:00Z"), end = start + 3600000;
const config = { botId: "bot", source: "google" as const, slots: [{ start, end }], calendarIds: ["primary"] };
const rawFrame = (data: unknown) => ({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ successful: true, data }) }] } });
const frame = (data: unknown) => rawFrame({ results: [{ tool_slug: "GOOGLECALENDAR_FREE_BUSY_QUERY", response: { successful: true, data } }] });
it("projects calendar responses into busy intervals only", async () => {
  const busy = await readCalendarBusy(config, { start, end }, async () => frame({ calendars: { primary: { busy: [{ start: new Date(start).toISOString(), end: new Date(end).toISOString(), summary: "PRIVATE" }] } } }));
  expect(busy).toEqual([{ start, end }]); expect(JSON.stringify(busy)).not.toContain("PRIVATE");
});
it("does not call a missing, errored or malformed calendar free", async () => {
  for (const response of [frame({}), frame({ calendars: { primary: { errors: [{ reason: "notFound" }], busy: [] } } }), frame({ calendars: { primary: { busy: [{ start: "bad", end: "bad" }] } } }), { result: { isError: true } }]) {
    await expect(readCalendarBusy(config, { start, end }, async () => response)).rejects.toThrow("Calendar");
  }
});
it("always selects the fixed read tool and the owner's calendars", async () => {
  let call: unknown;
  await readCalendarBusy(config, { start, end }, async payload => { call = payload; return frame({ calendars: { primary: { busy: [] } } }); });
  expect(call).toMatchObject({ method: "tools/call", params: { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: [{ tool_slug: "GOOGLECALENDAR_FREE_BUSY_QUERY", arguments: { items: [{ id: "primary" }], timeMin: new Date(start).toISOString(), timeMax: new Date(end).toISOString() } }] } } });
});
it("uses the session executor and rejects unrelated or partial batch responses", async () => {
  let call: unknown;
  const data = { calendars: { primary: { busy: [] } } };
  const batch = (tool_slug: string) => rawFrame({ results: [{ tool_slug, response: { successful: true, data } }] });
  expect(await readCalendarBusy(config, { start, end }, async payload => { call = payload; return batch("GOOGLECALENDAR_FREE_BUSY_QUERY"); })).toEqual([]);
  expect(call).toMatchObject({ params: { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { sync_response_to_workbench: false, tools: [{ tool_slug: "GOOGLECALENDAR_FREE_BUSY_QUERY" }] } } });
  await expect(readCalendarBusy(config, { start, end }, async () => batch("GMAIL_FETCH_EMAILS"))).rejects.toThrow("Calendar");
});
it("binds the calendar query to the owner's explicit connected account", async () => {
  let call: unknown;
  await readCalendarBusy({ ...config, accountId: "coup_calendar_owner" }, { start, end }, async payload => { call = payload; return frame({ calendars: { primary: { busy: [] } } }); });
  expect(call).toMatchObject({ params: { arguments: { tools: [{ account: "coup_calendar_owner", tool_slug: "GOOGLECALENDAR_FREE_BUSY_QUERY" }] } } });
});
