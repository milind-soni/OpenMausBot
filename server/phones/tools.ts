// The phone tools the `device` MCP server lists: small flat inputs validated against their advertised schema.
import type { ValidateFunction } from "ajv";

import { PHONE_TOOL_NAMES, type PhonePlatform, type PhoneToolName } from "../../shared/phone-apps.ts";
import { compileToolSchema, schemaProblems } from "../mcp-schema-validator.ts";

const ID = { type: "string", minLength: 1, maxLength: 256, description: "An id from an earlier result." };
const TEXT = (maxLength: number, description?: string) => ({ type: "string", maxLength, ...(description ? { description } : {}) });
const DATE = (what: string) => TEXT(64, `${what}, ISO 8601 with offset, e.g. 2026-10-24T12:00:00+05:30.`);
const LIST = (description: string) => ({ type: "array", maxItems: 20, description, items: { type: "string", minLength: 1, maxLength: 320 } });
const PHONE = TEXT(100, "Which phone, by name, when more than one is paired. Default: the one used most recently.");

interface PhoneTool {
  name: PhoneToolName;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required: string[]; additionalProperties: false };
}

const tool = (name: PhoneToolName, description: string, properties: Record<string, unknown>, required: string[] = []): PhoneTool =>
  ({ name, description, inputSchema: { type: "object", properties: { ...properties, phone: PHONE }, required, additionalProperties: false } });

const EVENT_FIELDS = {
  title: TEXT(500, "Event title."), start: DATE("Start"), end: DATE("End"), allDay: { type: "boolean", description: "An all-day event." },
  location: TEXT(500, "Where it takes place."), notes: TEXT(5000, "Notes."), attendees: LIST("Attendee emails or names."),
};
const CONTACT_FIELDS = {
  givenName: TEXT(200, "First name."), familyName: TEXT(200, "Last name."), phones: LIST("Phone numbers with country code."),
  emails: LIST("Email addresses."), organization: TEXT(200, "Company."), notes: TEXT(5000, "Notes."),
};

const tools: PhoneTool[] = [
  tool("PHONE_LIST_EVENTS", "List calendar events on the phone between two times, optionally for one calendar. Read only.", { from: DATE("Range start"), to: DATE("Range end"), calendar: TEXT(200, "Calendar name.") }, ["from", "to"]),
  tool("PHONE_GET_EVENT", "Read one calendar event by id. Read only.", { id: ID }, ["id"]),
  tool("PHONE_FIND_FREE_TIME", "Find gaps of at least the given length in the person's calendar between two times. Read only.", { from: DATE("Range start"), to: DATE("Range end"), minutes: { type: "integer", minimum: 5, maximum: 1440, description: "Shortest gap wanted, in minutes." } }, ["from", "to", "minutes"]),
  tool("PHONE_CREATE_EVENT", "Add an event to the phone's calendar. Check for conflicts first with PHONE_LIST_EVENTS.", EVENT_FIELDS, ["title", "start", "end"]),
  tool("PHONE_UPDATE_EVENT", "Change an existing event; only the fields given change.", { id: ID, ...EVENT_FIELDS }, ["id"]),
  tool("PHONE_DELETE_EVENT", "Delete a calendar event by id.", { id: ID }, ["id"]),
  tool("PHONE_RESPOND_TO_INVITE", "Accept, decline or tentatively accept a calendar invitation.", { id: ID, response: { type: "string", enum: ["accept", "decline", "tentative"] } }, ["id", "response"]),
  tool("PHONE_LIST_REMINDERS", "List reminders, optionally for one list, a due date range, or only completed ones. Read only.", { list: TEXT(200, "Reminder list name."), from: DATE("Due on or after"), to: DATE("Due on or before"), completed: { type: "boolean", description: "True for completed reminders only; default is open ones." } }),
  tool("PHONE_CREATE_REMINDER", "Add a reminder, optionally with a due time and a list.", { title: TEXT(500, "What to be reminded of."), due: DATE("Due"), notes: TEXT(5000, "Notes."), list: TEXT(200, "Reminder list name.") }, ["title"]),
  tool("PHONE_UPDATE_REMINDER", "Change a reminder's title, due time or notes; only the fields given change.", { id: ID, title: TEXT(500, "New title."), due: DATE("New due time"), notes: TEXT(5000, "New notes.") }, ["id"]),
  tool("PHONE_COMPLETE_REMINDER", "Mark a reminder done.", { id: ID }, ["id"]),
  tool("PHONE_DELETE_REMINDER", "Delete a reminder by id.", { id: ID }, ["id"]),
  tool("PHONE_SEARCH_CONTACTS", "Search the phone's contacts by name, number, email or company. Returns contacts with ids. Read only.", { query: TEXT(200, "Free text to match.") }, ["query"]),
  tool("PHONE_GET_CONTACT", "Read one contact by id, with numbers and emails. Read only.", { id: ID }, ["id"]),
  tool("PHONE_CREATE_CONTACT", "Add a contact. Search first so you do not create a duplicate.", CONTACT_FIELDS, ["givenName"]),
  tool("PHONE_UPDATE_CONTACT", "Change a contact; only the fields given change.", { id: ID, ...CONTACT_FIELDS }, ["id"]),
  tool("PHONE_GET_LOCATION", "Where the phone is right now: coordinates and a place name. Read only.", {}),
  tool("PHONE_FIND_PLACES_NEARBY", "Find places near the phone, such as a cafe or a pharmacy. Read only.", { query: TEXT(200, "What to look for."), radiusMeters: { type: "integer", minimum: 50, maximum: 50000, description: "Search radius in meters." } }, ["query"]),
  tool("PHONE_LIST_HOME", "List the home's accessories, their current state and the scenes. Read only.", {}),
  tool("PHONE_SET_ACCESSORY", "Set one characteristic of a home accessory, such as turning a light on or setting a thermostat.", { accessoryId: ID, characteristic: TEXT(100, "Characteristic name from PHONE_LIST_HOME, e.g. power."), value: { type: ["string", "number", "boolean"], description: "The new value." } }, ["accessoryId", "characteristic", "value"]),
  tool("PHONE_RUN_SCENE", "Run a home scene by id.", { sceneId: ID }, ["sceneId"]),
  tool("PHONE_SEND_MESSAGE", "Prepare a text message. It opens a sheet on the phone and is sent only when the person taps Send.", { to: TEXT(200, "Contact name or phone number."), text: { type: "string", minLength: 1, maxLength: 4000 } }, ["to", "text"]),
  tool("PHONE_SEND_WHATSAPP", "Prepare a WhatsApp message. It opens a sheet on the phone and is sent only when the person taps Send.", { to: TEXT(200, "Contact name or phone number."), text: { type: "string", minLength: 1, maxLength: 4000 } }, ["to", "text"]),
];

/** Catalog in PHONE_TOOL_NAMES order. */
export const PHONE_TOOLS: ReadonlyArray<PhoneTool> = PHONE_TOOL_NAMES.map((name) => tools.find((t) => t.name === name)!);

let validators: Map<string, ValidateFunction> | undefined;

export function phoneToolCallProblem(name: unknown, args: unknown): string | null {
  validators ??= new Map(PHONE_TOOLS.map((entry) => [entry.name, compileToolSchema(entry.inputSchema as Record<string, unknown>, { allErrors: true })]));
  const validate = typeof name === "string" ? validators.get(name) : undefined;
  if (!validate) return `Unknown phone tool. Use one of ${PHONE_TOOL_NAMES.join(", ")}.`;
  if (!args || typeof args !== "object" || Array.isArray(args) || !validate(args)) {
    return `Tool arguments do not match the advertised input schema: ${schemaProblems(validate.errors).join("; ") || "use its required fields and types"}.`;
  }
  return null;
}

export interface PhoneToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export function phoneErrorResult(message: string, extra: Record<string, unknown> = {}): PhoneToolResult {
  return { content: [{ type: "text", text: message }], structuredContent: { error: message, ...extra }, isError: true };
}

export function phoneOkResult(result: unknown, phone: { name: string; platform: PhonePlatform }): PhoneToolResult {
  // The phone last, so no key in the phone's answer can relabel where it ran.
  const body = result && typeof result === "object" && !Array.isArray(result) ? { ...(result as object), phone } : { phone, result };
  return { content: [{ type: "text", text: JSON.stringify(body) }], structuredContent: body as Record<string, unknown> };
}
