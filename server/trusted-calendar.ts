import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AvailabilityConfig, TimeSlot } from "../shared/trusted-contacts.ts";
import type { JsonValue } from "./schema.ts";
import { ContactError, mergeIntervals } from "./trusted-contacts.ts";

export const CALENDAR_AVAILABILITY_TOOL = "GOOGLECALENDAR_FREE_BUSY_QUERY";
const date = z.string().datetime({ offset: true });
const providerData = z.object({ calendars: z.record(z.string(), z.object({
  errors: z.array(z.unknown()).optional(), busy: z.array(z.object({ start: date, end: date })).max(10000),
})) });
export async function readCalendarBusy(
  config: AvailabilityConfig, window: TimeSlot, call: (payload: JsonValue) => Promise<unknown>,
): Promise<TimeSlot[]> {
  try {
    const response = await call({ jsonrpc: "2.0", id: randomUUID(), method: "tools/call", params: {
      name: "COMPOSIO_MULTI_EXECUTE_TOOL",
      arguments: { sync_response_to_workbench: false, current_step: "CHECKING_AVAILABILITY", tools: [{
        tool_slug: CALENDAR_AVAILABILITY_TOOL, ...(config.accountId ? { account: config.accountId } : {}),
        arguments: { items: config.calendarIds.map(id => ({ id })), timeMin: new Date(window.start).toISOString(), timeMax: new Date(window.end).toISOString(), timeZone: "UTC" },
      }] },
    } });
    const rpc = z.object({ result: z.object({ isError: z.boolean().optional(), content: z.array(z.object({ type: z.string(), text: z.string().optional() })) }) }).parse(response);
    if (rpc.result.isError) throw new Error("Tool failed");
    const block = rpc.result.content.find(c => c.type === "text" && c.text);
    if (!block?.text) throw new Error("No tool data");
    const envelope = z.object({ successful: z.literal(true), data: z.unknown() }).parse(JSON.parse(block.text));
    const batch = z.object({ results: z.array(z.object({
      tool_slug: z.literal(CALENDAR_AVAILABILITY_TOOL),
      response: z.object({ successful: z.literal(true), data: z.unknown() }),
    })).length(1) }).parse(envelope.data);
    const data = providerData.parse(batch.results[0]!.response.data); const busy: TimeSlot[] = [];
    for (const id of config.calendarIds) {
      const calendar = data.calendars[id];
      if (!calendar || calendar.errors?.length) throw new Error("Calendar not readable");
      for (const item of calendar.busy) {
        const start = Date.parse(item.start), end = Date.parse(item.end);
        if (end <= start) throw new Error("Invalid interval");
        const clipped = { start: Math.max(start, window.start), end: Math.min(end, window.end) };
        if (clipped.end > clipped.start) busy.push(clipped);
      }
    }
    return mergeIntervals(busy);
  } catch { throw new ContactError("Calendar availability could not be verified. Check the connection and calendar access.", 503); }
}
// Composio may answer JSON or SSE. Never interpret arbitrary prose as free time.
export function calendarRpcFrame(bytes: Uint8Array): unknown {
  const text = new TextDecoder().decode(bytes).trim();
  if (text.startsWith("{")) return JSON.parse(text);
  const frames = text.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).filter(Boolean);
  for (const line of frames.reverse()) {
    try { const value = JSON.parse(line); if (value && typeof value === "object" && "result" in value) return value; } catch { /* SSE comment or non-JSON frame */ }
  }
  throw new ContactError("Calendar returned no usable response", 503);
}
