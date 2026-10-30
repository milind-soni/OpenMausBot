// The twenty HighLevel tools: small flat inputs validated against their advertised schema, outputs trimmed by the
// client. A write returns, beside the result, the record id and the field names it changed for the activity log.
import type { ValidateFunction } from "ajv";

import { HIGHLEVEL_TOOL_NAMES, type HighLevelToolName } from "../../shared/highlevel.ts";
import { isReadOnlyAction } from "../../shared/connector-scopes.ts";
import { compileToolSchema, schemaProblems } from "../mcp-schema-validator.ts";
import { HighLevelError, PAGE_MAX, PAGE_NUMBER_MAX, type ContactFields, type HighLevelClient } from "./client.ts";

const ID = { type: "string", minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9_.-]+$" };
const TEXT = (maxLength: number, description?: string) => ({ type: "string", maxLength, ...(description ? { description } : {}) });
const TAGS = { type: "array", minItems: 1, maxItems: 50, items: { type: "string", minLength: 1, maxLength: 100 } };
const PAGE = { type: "integer", minimum: 1, maximum: PAGE_NUMBER_MAX, description: "Page number, from 1." };
const LIMIT = { type: "integer", minimum: 1, maximum: PAGE_MAX, description: `Results per page, at most ${PAGE_MAX}. Default 20.` };
const DATE = TEXT(64, "ISO 8601 date-time, e.g. 2026-10-20T15:00:00Z.");

const CONTACT_FIELDS = {
  firstName: TEXT(200), lastName: TEXT(200), name: TEXT(400, "Full name; use firstName and lastName when you have them."),
  email: TEXT(320), phone: TEXT(50, "With country code, e.g. +15551234567."), companyName: TEXT(200),
  tags: { type: "array", maxItems: 50, items: { type: "string", minLength: 1, maxLength: 100 } },
  source: TEXT(200, "Where the contact came from."), address1: TEXT(400), city: TEXT(200), state: TEXT(200), postalCode: TEXT(40), country: TEXT(8, "Two-letter country code."),
  website: TEXT(400), timezone: TEXT(100), assignedTo: TEXT(128, "User id of the owner."), dateOfBirth: TEXT(32, "YYYY-MM-DD."),
  customFields: { type: "object", maxProperties: 50, description: "Custom field values by field name (HIGHLEVEL_GET_LOCATION lists them).", additionalProperties: { type: ["string", "number", "boolean", "array"], items: { type: "string", maxLength: 1000 }, maxLength: 4000 } },
};

const tool = (name: HighLevelToolName, description: string, properties: Record<string, unknown>, required: string[] = []) =>
  ({ name, description, inputSchema: { type: "object", properties, required, additionalProperties: false } });

export const HIGHLEVEL_TOOLS = [
  tool("HIGHLEVEL_SEARCH_CONTACTS", "Search the CRM's contacts by free text (name, email, phone, company) with optional exact tag, email or phone filters. Returns trimmed contacts with ids.",
    { query: TEXT(500, "Free text to match."), tag: TEXT(100, "Only contacts with this tag."), email: TEXT(320, "Exact email."), phone: TEXT(50, "Exact phone with country code."), page: PAGE, limit: LIMIT }),
  tool("HIGHLEVEL_GET_CONTACT", "Read one contact by id, with its tags and custom fields by name.", { contactId: ID }, ["contactId"]),
  tool("HIGHLEVEL_CREATE_CONTACT", "Create a contact. Search first so you do not create a duplicate. Give at least an email, a phone or a name.", CONTACT_FIELDS),
  tool("HIGHLEVEL_UPDATE_CONTACT", "Change fields of an existing contact; only the fields given change. Tags given here replace the contact's tags: use HIGHLEVEL_ADD_TAGS to add.",
    { contactId: ID, ...CONTACT_FIELDS }, ["contactId"]),
  tool("HIGHLEVEL_ADD_TAGS", "Add tags to a contact.", { contactId: ID, tags: TAGS }, ["contactId", "tags"]),
  tool("HIGHLEVEL_REMOVE_TAGS", "Remove tags from a contact.", { contactId: ID, tags: TAGS }, ["contactId", "tags"]),
  tool("HIGHLEVEL_LIST_NOTES", "List the notes on a contact.", { contactId: ID }, ["contactId"]),
  tool("HIGHLEVEL_ADD_NOTE", "Add a note to a contact.", { contactId: ID, body: { type: "string", minLength: 1, maxLength: 10_000 } }, ["contactId", "body"]),
  tool("HIGHLEVEL_LIST_TASKS", "List the tasks on a contact.", { contactId: ID }, ["contactId"]),
  tool("HIGHLEVEL_ADD_TASK", "Add a task to a contact with a title and due date; optionally a description and an assignee (user id).",
    { contactId: ID, title: { type: "string", minLength: 1, maxLength: 500 }, dueDate: DATE, body: TEXT(5000, "Description."), assignedTo: TEXT(128, "User id.") }, ["contactId", "title", "dueDate"]),
  tool("HIGHLEVEL_LIST_PIPELINES", "List the location's pipelines with their stages (ids and names).", {}),
  tool("HIGHLEVEL_SEARCH_OPPORTUNITIES", "Search opportunities (deals) by pipeline, stage, contact, status or free text.",
    { query: TEXT(500), pipelineId: ID, stageId: ID, contactId: ID, status: { type: "string", enum: ["open", "won", "lost", "abandoned", "all"] }, page: PAGE, limit: LIMIT }),
  tool("HIGHLEVEL_GET_OPPORTUNITY", "Read one opportunity by id.", { opportunityId: ID }, ["opportunityId"]),
  tool("HIGHLEVEL_CREATE_OPPORTUNITY", "Create an opportunity for a contact in a pipeline (HIGHLEVEL_LIST_PIPELINES gives pipeline and stage ids).",
    { pipelineId: ID, stageId: ID, contactId: ID, name: { type: "string", minLength: 1, maxLength: 500 }, value: { type: "number", minimum: 0, description: "Monetary value." }, status: { type: "string", enum: ["open", "won", "lost", "abandoned"] } },
    ["pipelineId", "contactId", "name"]),
  tool("HIGHLEVEL_UPDATE_OPPORTUNITY", "Move an opportunity to a stage, change its status, value or name. Only the fields given change.",
    { opportunityId: ID, stageId: ID, status: { type: "string", enum: ["open", "won", "lost", "abandoned"] }, value: { type: "number", minimum: 0 }, name: TEXT(500) }, ["opportunityId"]),
  tool("HIGHLEVEL_SEARCH_CONVERSATIONS", "Find conversations by contact or free text; returns summaries with the last message. Read only.",
    { contactId: ID, query: TEXT(500), limit: LIMIT }),
  tool("HIGHLEVEL_READ_CONVERSATION", "Read the messages of one conversation, newest first. Read only: nothing can be sent.",
    { conversationId: ID, limit: LIMIT, lastMessageId: { ...ID, description: "Page on from this message id." } }, ["conversationId"]),
  tool("HIGHLEVEL_LIST_CALENDARS", "List the location's calendars. Read only.", {}),
  tool("HIGHLEVEL_LIST_EVENTS", "List calendar events (appointments) in a date range, optionally for one calendar or one user. Read only.",
    { startTime: DATE, endTime: DATE, calendarId: ID, userId: ID }, ["startTime", "endTime"]),
  tool("HIGHLEVEL_GET_LOCATION", "The connected location: name, timezone, contact details and its custom field definitions.", {}),
] as const;

export type HighLevelTool = (typeof HIGHLEVEL_TOOLS)[number];

export function isHighLevelToolName(name: unknown): name is HighLevelToolName {
  return typeof name === "string" && (HIGHLEVEL_TOOL_NAMES as readonly string[]).includes(name);
}

/** SEARCH/GET/LIST/READ read; everything else writes. */
export function isHighLevelWrite(name: string): boolean {
  return !isReadOnlyAction(name, "highlevel");
}

let validators: Map<string, ValidateFunction> | undefined;

export function highlevelToolCallProblem(name: unknown, args: unknown): string | null {
  validators ??= new Map(HIGHLEVEL_TOOLS.map((entry) => [entry.name, compileToolSchema(entry.inputSchema as Record<string, unknown>, { allErrors: true })]));
  const validate = typeof name === "string" ? validators.get(name) : undefined;
  if (!validate) return `Unknown HighLevel tool. Use one of ${HIGHLEVEL_TOOL_NAMES.join(", ")}.`;
  if (!args || typeof args !== "object" || Array.isArray(args) || !validate(args)) {
    return `Tool arguments do not match the advertised input schema: ${schemaProblems(validate.errors).join("; ") || "use its required fields and types"}.`;
  }
  return null;
}

export interface HighLevelToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** What the activity row records for a write: the record's id and the fields changed, never the values. */
export interface HighLevelWriteRecord {
  tool: HighLevelToolName;
  kind: "contact" | "note" | "task" | "opportunity" | "tags";
  recordId: string;
  fields: string[];
}

export function highlevelErrorResult(message: string, extra: Record<string, unknown> = {}): HighLevelToolResult {
  return { content: [{ type: "text", text: message }], structuredContent: { error: message, ...extra }, isError: true };
}

const ok = (value: unknown): HighLevelToolResult => {
  const structured = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : { value };
  return { content: [{ type: "text", text: JSON.stringify(structured) }], structuredContent: structured };
};

const changed = (fields: object, skip: string[] = []) =>
  Object.entries(fields).filter(([key, value]) => value !== undefined && !skip.includes(key)).map(([key]) => key).sort();

/** Runs one validated call; the write record is set only when a write succeeded. */
export async function runHighLevelTool(
  client: HighLevelClient,
  name: HighLevelToolName,
  args: Record<string, unknown>,
): Promise<{ result: HighLevelToolResult; write?: HighLevelWriteRecord }> {
  const a = args as Record<string, any>;
  try {
    switch (name) {
      case "HIGHLEVEL_SEARCH_CONTACTS": return { result: ok(await client.searchContacts(a)) };
      case "HIGHLEVEL_GET_CONTACT": return { result: ok(await client.getContact(a.contactId)) };
      case "HIGHLEVEL_CREATE_CONTACT": {
        const fields = a as ContactFields;
        if (!fields.email && !fields.phone && !fields.name && !fields.firstName && !fields.lastName) {
          return { result: highlevelErrorResult("Give at least an email, a phone or a name to create a contact.") };
        }
        const contact = await client.createContact(fields);
        return { result: ok(contact), write: { tool: name, kind: "contact", recordId: contact.id, fields: changed(fields) } };
      }
      case "HIGHLEVEL_UPDATE_CONTACT": {
        const { contactId, ...fields } = a as ContactFields & { contactId: string };
        const names = changed(fields);
        if (names.length === 0) return { result: highlevelErrorResult("Give at least one field to change.") };
        const contact = await client.updateContact(contactId, fields);
        return { result: ok(contact), write: { tool: name, kind: "contact", recordId: contactId, fields: names } };
      }
      case "HIGHLEVEL_ADD_TAGS": {
        const out = await client.addTags(a.contactId, a.tags);
        return { result: ok(out), write: { tool: name, kind: "tags", recordId: a.contactId, fields: ["tags"] } };
      }
      case "HIGHLEVEL_REMOVE_TAGS": {
        const out = await client.removeTags(a.contactId, a.tags);
        return { result: ok(out), write: { tool: name, kind: "tags", recordId: a.contactId, fields: ["tags"] } };
      }
      case "HIGHLEVEL_LIST_NOTES": return { result: ok(await client.listNotes(a.contactId)) };
      case "HIGHLEVEL_ADD_NOTE": {
        const out = await client.addNote(a.contactId, a.body);
        return { result: ok(out), write: { tool: name, kind: "note", recordId: out.note.id || a.contactId, fields: ["body"] } };
      }
      case "HIGHLEVEL_LIST_TASKS": return { result: ok(await client.listTasks(a.contactId)) };
      case "HIGHLEVEL_ADD_TASK": {
        const { contactId, ...task } = a;
        const out = await client.addTask(contactId, task as { title: string; dueDate: string; body?: string; assignedTo?: string });
        return { result: ok(out), write: { tool: name, kind: "task", recordId: out.task.id || contactId, fields: changed(task) } };
      }
      case "HIGHLEVEL_LIST_PIPELINES": return { result: ok(await client.listPipelines()) };
      case "HIGHLEVEL_SEARCH_OPPORTUNITIES": return { result: ok(await client.searchOpportunities({ ...a, status: a.status === "all" ? undefined : a.status })) };
      case "HIGHLEVEL_GET_OPPORTUNITY": return { result: ok(await client.getOpportunity(a.opportunityId)) };
      case "HIGHLEVEL_CREATE_OPPORTUNITY": {
        const out = await client.createOpportunity(a as { pipelineId: string; stageId?: string; contactId: string; name: string; value?: number; status?: string });
        return { result: ok(out), write: { tool: name, kind: "opportunity", recordId: out.id, fields: changed(a) } };
      }
      case "HIGHLEVEL_UPDATE_OPPORTUNITY": {
        const { opportunityId, ...fields } = a;
        const names = changed(fields);
        if (names.length === 0) return { result: highlevelErrorResult("Give at least one field to change.") };
        const out = await client.updateOpportunity(opportunityId, fields);
        return { result: ok(out), write: { tool: name, kind: "opportunity", recordId: opportunityId, fields: names } };
      }
      case "HIGHLEVEL_SEARCH_CONVERSATIONS": return { result: ok(await client.searchConversations(a)) };
      case "HIGHLEVEL_READ_CONVERSATION": return { result: ok(await client.readConversation(a.conversationId, a)) };
      case "HIGHLEVEL_LIST_CALENDARS": return { result: ok(await client.listCalendars()) };
      case "HIGHLEVEL_LIST_EVENTS": return { result: ok(await client.listEvents(a as { startTime: string; endTime: string; calendarId?: string; userId?: string })) };
      case "HIGHLEVEL_GET_LOCATION": return { result: ok(await client.getLocation()) };
    }
  } catch (error) {
    if (error instanceof HighLevelError) return { result: highlevelErrorResult(error.message, { ...(error.status ? { status: error.status } : {}), ...(error.signedOut ? { signedOut: true } : {}) }) };
    throw error;
  }
}
