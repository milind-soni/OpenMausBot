// A byte budget over the MCP tool definitions an engine shows its model, for an engine that shows every tool eagerly and,
// past its budget, silently leaves out the largest tools first. Google's native Antigravity CLI (1.5.x over ACP) is one
// (google-antigravity/antigravity-cli#1530): it writes each tool to <app-data-dir>/mcp/<server>/<tool>.json as
// {name, description, parameters} and counts those files across every server of the session. On 1.5.16 the drop
// started between 58,700 and 60,600 bytes; on 1.5.17 one tool alone was kept up to 56,608 bytes, about 38 more per
// further tool and about 6 fewer per character of the profile's path. A session's own servers share out
// ANTIGRAVITY_CLI_TOOL_BUDGET and each fits its list into its share, least loss first: the schema compacted, then
// shorter parameter descriptions, then shorter tool descriptions. No tool is left out, and every call is still checked
// against the tool's own full schema.
import { compactAdvertisedSchema } from "./advertised-schema.ts";
import { schemaBytes } from "./tool-schema-profile.ts";

type Json = Record<string, unknown>;
export type ListedTool = { name: string; description?: string; inputSchema?: unknown } & Json;

/** Below the CLI's drop point, with room for its per-path overhead and the person's own servers. */
export const ANTIGRAVITY_CLI_TOOL_BUDGET = 55_000;

/** The value of OMB_TOOL_SCHEMA_PROFILE that gives a server its share of a session's budget, in bytes. */
const SHARE_PREFIX = "listShare:";

export function toolListShareProfile(bytes: number): string {
  return `${SHARE_PREFIX}${Math.max(0, Math.floor(bytes))}`;
}

export function toolListShare(profile: unknown): number | undefined {
  if (typeof profile !== "string" || !profile.startsWith(SHARE_PREFIX)) return undefined;
  const digits = profile.slice(SHARE_PREFIX.length);
  return /^\d{1,9}$/.test(digits) ? Number(digits) : undefined;
}

/** One tool as the CLI writes its definition file: compact JSON, `<`, `>` and `&` as six-byte escapes. */
export function definitionBytes(tool: ListedTool): number {
  return schemaBytes({ name: tool.name, description: tool.description ?? "", parameters: tool.inputSchema ?? { type: "object" } });
}

export function definitionListBytes(tools: readonly ListedTool[]): number {
  return tools.reduce((sum, tool) => sum + definitionBytes(tool), 0);
}

/** Tools never to be the ones the CLI leaves out, most important first. It drops the largest first, so when a list cannot
 * fit these are made smaller still. */
export const PROTECTED_TOOLS: readonly string[] = ["coordinate_bots", "start_thread", "show_html", "trigger", "memory_update", "attach_file"];

/** A tool description is never cut below this many characters while fitting; past it the list is over its share. */
export const TOOL_DESCRIPTION_FLOOR = 120;

/** `text` cut to at most `max` characters: at the last sentence end that fits, else at a word with an ellipsis; undefined
 * when nothing is left. The kept length never shrinks as `max` grows, so a search over `max` is sound. */
export function cutText(text: string, max: number): string | undefined {
  if (text.length <= max) return text;
  if (max <= 1) return undefined;
  let end = -1;
  for (const match of text.slice(0, max + 1).matchAll(/[.!?](?=\s|$)/g)) if (match.index + 1 <= max) end = match.index + 1;
  if (end > 0) return text.slice(0, end);
  const words = text.slice(0, max - 1).replace(/\s+\S*$/, "").trimEnd();
  return words ? `${words}…` : undefined;
}

/** Where a schema holds named subschemas, single subschemas, and lists of them. Everything else is a value. */
const SCHEMA_MAPS = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);
const SCHEMA_SLOTS = new Set(["items", "additionalProperties", "additionalItems", "contains", "propertyNames", "not", "if", "then", "else", "unevaluatedProperties", "unevaluatedItems"]);
const SCHEMA_LISTS = new Set(["anyOf", "oneOf", "allOf", "prefixItems", "items"]);

function isObject(value: unknown): value is Json {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Every `description` inside a schema, at any depth, cut to `max` characters (gone at 0). */
function withParameterDescriptions(node: unknown, max: number): unknown {
  if (!isObject(node)) return node;
  const result: Json = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "description" && typeof value === "string") {
      const kept = cutText(value, max);
      if (kept !== undefined) result[key] = kept;
    } else if (SCHEMA_MAPS.has(key) && isObject(value)) {
      result[key] = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, withParameterDescriptions(child, max)]));
    } else if (SCHEMA_LISTS.has(key) && Array.isArray(value)) result[key] = value.map((child) => withParameterDescriptions(child, max));
    else if (SCHEMA_SLOTS.has(key) && isObject(value)) result[key] = withParameterDescriptions(value, max);
    else result[key] = value;
  }
  return result;
}

/** How much of each description a list keeps, in characters; Infinity keeps all of it. */
export interface DescriptionLevel { parameters: number; tools: number }

export const FULL_DESCRIPTIONS: DescriptionLevel = { parameters: Infinity, tools: Infinity };

export function withDescriptionLevel<T extends ListedTool>(tools: readonly T[], level: DescriptionLevel): T[] {
  return tools.map((tool) => {
    const description = typeof tool.description === "string" ? cutText(tool.description, level.tools) ?? "" : tool.description;
    const inputSchema = level.parameters === Infinity ? tool.inputSchema : withParameterDescriptions(tool.inputSchema, level.parameters);
    return description === tool.description && inputSchema === tool.inputSchema ? tool : { ...tool, description, inputSchema };
  });
}

/** Each tool's schema as a model is shown it. */
export function withCompactSchemas<T extends ListedTool>(tools: readonly T[]): T[] {
  return tools.map((tool) => (isObject(tool.inputSchema) ? { ...tool, inputSchema: compactAdvertisedSchema(tool.inputSchema) } : tool));
}

function longest(tools: readonly ListedTool[], of: (tool: ListedTool) => string[]): number {
  return Math.max(0, ...tools.flatMap(of).map((text) => text.length));
}

function parameterDescriptions(node: unknown): string[] {
  if (!isObject(node)) return [];
  const own = typeof node.description === "string" ? [node.description] : [];
  return [...own, ...Object.entries(node).flatMap(([key, value]) => {
    if (SCHEMA_MAPS.has(key) && isObject(value)) return Object.values(value).flatMap(parameterDescriptions);
    if (SCHEMA_LISTS.has(key) && Array.isArray(value)) return value.flatMap(parameterDescriptions);
    return SCHEMA_SLOTS.has(key) ? parameterDescriptions(value) : [];
  })];
}

/** The largest value in [low, high] for which `fits` holds, given that it holds at `low`. */
function largestFitting(low: number, high: number, fits: (value: number) => boolean): number {
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(middle)) low = middle; else high = middle - 1;
  }
  return low;
}

/** The least cut that brings `tools` (already compacted) to `budget` bytes: parameter descriptions first, then tool
 * descriptions down to TOOL_DESCRIPTION_FLOOR. `fits` is false when even that is over. */
export function descriptionLevelFor(tools: readonly ListedTool[], budget: number): { level: DescriptionLevel; fits: boolean } {
  const bytesAt = (level: DescriptionLevel) => definitionListBytes(withDescriptionLevel(tools, level));
  if (bytesAt(FULL_DESCRIPTIONS) <= budget) return { level: FULL_DESCRIPTIONS, fits: true };
  const maxParameter = longest(tools, (tool) => parameterDescriptions(tool.inputSchema));
  if (bytesAt({ parameters: 0, tools: Infinity }) <= budget) {
    const parameters = largestFitting(0, maxParameter, (chars) => bytesAt({ parameters: chars, tools: Infinity }) <= budget);
    return { level: { parameters, tools: Infinity }, fits: true };
  }
  const floor = { parameters: 0, tools: TOOL_DESCRIPTION_FLOOR };
  if (bytesAt(floor) > budget) return { level: floor, fits: false };
  const maxTool = longest(tools, (tool) => (typeof tool.description === "string" ? [tool.description] : []));
  const chars = largestFitting(TOOL_DESCRIPTION_FLOOR, Math.max(TOOL_DESCRIPTION_FLOOR, maxTool), (max) => bytesAt({ parameters: 0, tools: max }) <= budget);
  return { level: { parameters: 0, tools: chars }, fits: true };
}

/** A protected tool as small as it gets while still naming every top-level field, its type and its choices: its first
 * sentence, and each nested object or list of objects as just its type. Only for a list that cannot fit otherwise; the
 * handler still checks every nested field and answers a wrong one with what it expects. */
function smallest<T extends ListedTool>(tool: T): T {
  const description = typeof tool.description === "string" ? cutText(tool.description.split(/(?<=[.!?])\s/)[0] ?? "", TOOL_DESCRIPTION_FLOOR) ?? "" : tool.description;
  const schema = tool.inputSchema;
  if (!isObject(schema) || !isObject(schema.properties)) return { ...tool, description };
  const properties = Object.fromEntries(Object.entries(schema.properties).map(([name, property]) => {
    if (!isObject(property)) return [name, property];
    const nested = isObject(property.properties) || (isObject(property.items) && isObject(property.items.properties)) || isObject(property.additionalProperties);
    return [name, nested ? Object.fromEntries(["type", "enum"].filter((key) => key in property).map((key) => [key, property[key]])) : property];
  }));
  return { ...tool, description, inputSchema: { ...schema, properties } };
}

export interface FittedToolList<T> { tools: T[]; bytes: number; from: number; level: DescriptionLevel; fits: boolean }

/** `tools` as this engine is shown them within `share` bytes. A list that cannot fit keeps every tool at its shortest,
 * with PROTECTED_TOOLS shrunk further, so the engine's largest-first drop takes others before them. */
export function fitToolListToShare<T extends ListedTool>(tools: readonly T[], share: number): FittedToolList<T> {
  const compacted = withCompactSchemas(tools);
  const from = definitionListBytes(compacted);
  const { level, fits } = descriptionLevelFor(compacted, share);
  let fitted = withDescriptionLevel(compacted, level);
  if (!fits) fitted = fitted.map((tool) => (PROTECTED_TOOLS.includes(tool.name) ? smallest(tool) : tool));
  return { tools: fitted, bytes: definitionListBytes(fitted), from, level, fits };
}

/** A tools/list `tools` array under OMB_TOOL_SCHEMA_PROFILE `profile`: fitted when the profile is a share, else as it came. */
export function toolsForShareProfile<T extends ListedTool>(tools: readonly T[], profile: unknown, log?: (line: string) => void): readonly T[] {
  const share = toolListShare(profile);
  if (share === undefined) return tools;
  // The agents server is built for every request of a turn, its calls included: a list already fitted is reused.
  const key = `${share}\0${JSON.stringify(tools)}`;
  const known = FITTED.get(key);
  if (known) return known as T[];
  const fitted = fitToolListToShare(tools, share);
  if (!fitted.fits) log?.(`tool list is ${fitted.bytes} bytes at its shortest, ${fitted.bytes - share} over its ${share}-byte share of the session's tool budget`);
  if (FITTED.size >= FITTED_KEPT) FITTED.delete(FITTED.keys().next().value!);
  FITTED.set(key, fitted.tools);
  return fitted.tools;
}

const FITTED_KEPT = 32;
const FITTED = new Map<string, readonly ListedTool[]>();

/** A tools/list result with its tools fitted the same way; anything else as it came. */
export function toolsListResultForShareProfile(result: unknown, profile: unknown, log?: (line: string) => void): unknown {
  if (toolListShare(profile) === undefined || !isObject(result) || !Array.isArray(result.tools)) return result;
  const tools = result.tools.filter((tool): tool is ListedTool => isObject(tool) && typeof tool.name === "string");
  return tools.length === result.tools.length ? { ...result, tools: toolsForShareProfile(tools, profile, log) } : result;
}
