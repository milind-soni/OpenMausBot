// A byte budget over the MCP tool definitions an engine shows its model, for an engine that shows every tool eagerly and,
// past its budget, silently leaves out the largest tools first. Google's native Antigravity CLI (1.5.x over ACP) is one
// (google-antigravity/antigravity-cli#1530): it counts every server's tool definitions ({name, description, parameters})
// together. On 1.5.16 the drop started between 58,700 and 60,600 bytes; on 1.5.17 one tool alone was kept up to 56,608
// bytes, on 1.5.18 up to about 56,780, about 38 more per further tool. There is no limit for one tool: with many tools
// the cut only looks like one, since every tool over some size goes. A session's servers share out
// ANTIGRAVITY_CLI_TOOL_BUDGET and each fits its list into its share, least loss first: the schema compacted, then its
// annotations, shorter parameter descriptions, shorter tool descriptions, and last nested fields. Only a list that is over
// its share even then leaves tools out, and it chooses them itself, the least important first, so the CLI never drops one
// that the bot must keep. No name or required field changes, and every call is still checked against the tool's own full
// schema.
import { compactAdvertisedSchema } from "./advertised-schema.ts";
import { itemsOf, schemaBytes } from "./tool-schema-profile.ts";

type Json = Record<string, unknown>;
export type ListedTool = { name: string; description?: string; inputSchema?: unknown } & Json;

/** Below the CLI's drop point, with room for its per-path overhead and the person's own servers. */
export const ANTIGRAVITY_CLI_TOOL_BUDGET = 55_000;

/** The most a session's tools came to that the CLI kept whole in every measurement: one tool alone on 1.5.17 (56,608), more
 * with more tools. A list leaves tools out only past its share's part of this, so a session a little over the budget
 * loses nothing the CLI would have kept. */
export const ANTIGRAVITY_CLI_TOOL_LIMIT = 56_600;

/** What a list with `share` of ANTIGRAVITY_CLI_TOOL_BUDGET may come to before it leaves tools out. */
export function toolListLimit(share: number): number {
  return Math.floor((share * ANTIGRAVITY_CLI_TOOL_LIMIT) / ANTIGRAVITY_CLI_TOOL_BUDGET);
}

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

/** Tools a list never leaves out, however far over its share: a bot that loses them cannot reach its team or read the
 * rest of a long result. */
export const COORDINATION_TOOLS: readonly string[] = ["coordinate_bots", "assignment_status", "list_bots", "list_room_targets", "post_to_thread", "tool_result_read"];

/** The order a list over its share leaves tools out in: a lower rank first, Infinity never. */
export function toolKeepRank(name: string): number {
  if (COORDINATION_TOOLS.includes(name)) return Infinity;
  return PROTECTED_TOOLS.includes(name) ? 1 : 0;
}

/** Tool descriptions are cut to this many characters before any is cut further. */
export const TOOL_DESCRIPTION_FLOOR = 120;

/** A tool description is never cut below this many characters while fitting; past it the list is over its share. */
export const TOOL_DESCRIPTION_MIN = 40;

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

/** Keywords that tell a model nothing a call must follow: they go before any description does. */
const ANNOTATIONS = new Set(["title", "examples", "example", "$comment", "deprecated", "readOnly", "writeOnly", "$schema", "$id"]);

/** A schema with every `description`, at any depth, cut to `parameters` characters (gone at 0), and with `annotations`
 * its ANNOTATIONS left out. Property names are never touched. */
function withSchemaLevel(node: unknown, parameters: number, annotations: boolean): unknown {
  if (!isObject(node)) return node;
  const result: Json = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "description" && typeof value === "string") {
      const kept = cutText(value, parameters);
      if (kept !== undefined) result[key] = kept;
    } else if (annotations && ANNOTATIONS.has(key)) continue;
    else if (SCHEMA_MAPS.has(key) && isObject(value)) {
      result[key] = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, withSchemaLevel(child, parameters, annotations)]));
    } else if (SCHEMA_LISTS.has(key) && Array.isArray(value)) result[key] = value.map((child) => withSchemaLevel(child, parameters, annotations));
    else if (SCHEMA_SLOTS.has(key) && isObject(value)) result[key] = withSchemaLevel(value, parameters, annotations);
    else result[key] = value;
  }
  return result;
}

function acceptsArray(type: unknown): boolean {
  return type === "array" || (Array.isArray(type) && type.includes("array"));
}

/** A top-level field that holds an object, or a nested value, as just its type and choices. Gemini requires `items` on
 * every array: a list of objects keeps `{type:"object"}`, and any other array keeps its item type (a string when that
 * type cannot be named). A field that is not nested stays as it was, except an array that would otherwise go out with
 * no `items`. A field with no `type` of its own stays as it was. */
function collapsedField(property: unknown, root: Json): unknown {
  if (!isObject(property) || !("type" in property)) return property;
  const listOfObjects = isObject(property.items) && (isObject(property.items.properties) || isObject(property.items.additionalProperties));
  const nested = isObject(property.properties) || isObject(property.additionalProperties) || listOfObjects
    || Array.isArray(property.anyOf) || Array.isArray(property.oneOf) || Array.isArray(property.allOf);
  if (!nested) {
    if (acceptsArray(property.type) && !("items" in property)) return { ...property, items: itemsOf(property, root) };
    return property;
  }
  const kept: Json = Object.fromEntries(["type", "enum"].filter((key) => key in property).map((key) => [key, property[key]]));
  if (listOfObjects) return { ...kept, items: { type: "object" } };
  return acceptsArray(property.type) ? { ...kept, items: itemsOf(property, root) } : kept;
}

/** A schema with each top-level field collapsed as above; the field names and `required` as they were. The handler still
 * checks every nested field. */
function withTopLevelFields(schema: unknown): unknown {
  if (!isObject(schema) || !isObject(schema.properties)) return schema;
  return { ...schema, properties: Object.fromEntries(Object.entries(schema.properties).map(([name, property]) => [name, collapsedField(property, schema)])) };
}

/** How much of each tool a list keeps: description lengths in characters (Infinity keeps all), whether schema
 * annotations are left out, and whether tools other than PROTECTED_TOOLS keep only their top-level fields. */
export interface DescriptionLevel { parameters: number; tools: number; annotations?: boolean; topLevelOnly?: boolean }

export const FULL_DESCRIPTIONS: DescriptionLevel = { parameters: Infinity, tools: Infinity };

export function withDescriptionLevel<T extends ListedTool>(tools: readonly T[], level: DescriptionLevel): T[] {
  const annotations = level.annotations === true;
  return tools.map((tool) => {
    const description = typeof tool.description === "string" ? cutText(tool.description, level.tools) ?? "" : tool.description;
    let inputSchema = level.parameters === Infinity && !annotations ? tool.inputSchema : withSchemaLevel(tool.inputSchema, level.parameters, annotations);
    if (level.topLevelOnly && !PROTECTED_TOOLS.includes(tool.name)) inputSchema = withTopLevelFields(inputSchema);
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

/** The least cut that brings `tools` (already compacted) to `budget` bytes, each step only when the one before is not
 * enough: schema annotations; parameter descriptions; tool descriptions down to TOOL_DESCRIPTION_FLOOR, then down to
 * TOOL_DESCRIPTION_MIN; then nested fields, PROTECTED_TOOLS aside. `fits` is false when even that is over. */
export function descriptionLevelFor(tools: readonly ListedTool[], budget: number): { level: DescriptionLevel; fits: boolean } {
  const bytesAt = (level: DescriptionLevel) => definitionListBytes(withDescriptionLevel(tools, level));
  if (bytesAt(FULL_DESCRIPTIONS) <= budget) return { level: FULL_DESCRIPTIONS, fits: true };
  const plain = { parameters: Infinity, tools: Infinity, annotations: true };
  if (bytesAt(plain) <= budget) return { level: plain, fits: true };
  const maxParameter = longest(tools, (tool) => parameterDescriptions(tool.inputSchema));
  if (bytesAt({ ...plain, parameters: 0 }) <= budget) {
    const parameters = largestFitting(0, maxParameter, (chars) => bytesAt({ ...plain, parameters: chars }) <= budget);
    return { level: { ...plain, parameters }, fits: true };
  }
  const maxTool = longest(tools, (tool) => (typeof tool.description === "string" ? [tool.description] : []));
  const shortest = (floor: number) => largestFitting(floor, Math.max(floor, maxTool), (max) => bytesAt({ ...plain, parameters: 0, tools: max }) <= budget);
  if (bytesAt({ ...plain, parameters: 0, tools: TOOL_DESCRIPTION_FLOOR }) <= budget) return { level: { ...plain, parameters: 0, tools: shortest(TOOL_DESCRIPTION_FLOOR) }, fits: true };
  if (bytesAt({ ...plain, parameters: 0, tools: TOOL_DESCRIPTION_MIN }) <= budget) return { level: { ...plain, parameters: 0, tools: shortest(TOOL_DESCRIPTION_MIN) }, fits: true };
  const floor = { ...plain, parameters: 0, tools: TOOL_DESCRIPTION_MIN, topLevelOnly: true };
  if (bytesAt(floor) > budget) return { level: floor, fits: false };
  const chars = largestFitting(TOOL_DESCRIPTION_MIN, Math.max(TOOL_DESCRIPTION_MIN, maxTool), (max) => bytesAt({ ...floor, tools: max }) <= budget);
  return { level: { ...floor, tools: chars }, fits: true };
}

/** A protected tool as small as it gets while still naming every top-level field, its type and its choices: its first
 * sentence, and each nested object or list of objects as just its type. Only for a list that cannot fit otherwise; the
 * handler still checks every nested field and answers a wrong one with what it expects. */
function smallest<T extends ListedTool>(tool: T): T {
  const description = typeof tool.description === "string" ? cutText(tool.description.split(/(?<=[.!?])\s/)[0] ?? "", TOOL_DESCRIPTION_FLOOR) ?? "" : tool.description;
  return { ...tool, description, inputSchema: withTopLevelFields(tool.inputSchema) };
}

const FLOOR_LEVEL: DescriptionLevel = { parameters: 0, tools: TOOL_DESCRIPTION_MIN, annotations: true, topLevelOnly: true };

/** What `tools` come to at the deepest cut there is, protected tools kept whole. */
export function toolListFloorBytes(tools: readonly ListedTool[]): number {
  return definitionListBytes(withDescriptionLevel(withCompactSchemas(tools), FLOOR_LEVEL));
}

export interface FittedToolList<T> { tools: T[]; bytes: number; from: number; level: DescriptionLevel; fits: boolean }

/** `tools` as this engine is shown them within `share` bytes. A list that cannot fit keeps every tool at its shortest,
 * with PROTECTED_TOOLS shrunk further; another tool keeps its nested fields only where leaving them out would take it
 * below the largest protected tool, so the engine's largest-first drop still takes it before them. */
export function fitToolListToShare<T extends ListedTool>(tools: readonly T[], share: number): FittedToolList<T> {
  const compacted = withCompactSchemas(tools);
  const from = definitionListBytes(compacted);
  const { level, fits } = descriptionLevelFor(compacted, share);
  let fitted = withDescriptionLevel(compacted, level);
  if (!fits) {
    const nested = withDescriptionLevel(compacted, { ...level, topLevelOnly: false });
    fitted = fitted.map((tool, index) => (PROTECTED_TOOLS.includes(tool.name) ? smallest(nested[index]!) : tool));
    const largestProtected = Math.max(0, ...fitted.filter((tool) => PROTECTED_TOOLS.includes(tool.name)).map(definitionBytes));
    fitted = fitted.map((tool, index) => (definitionBytes(tool) < largestProtected && definitionBytes(nested[index]!) >= largestProtected ? nested[index]! : tool));
  }
  return { tools: fitted, bytes: definitionListBytes(fitted), from, level, fits };
}

export interface ToolListWithinShare<T> extends FittedToolList<T> {
  /** The names of the tools left out, in the order given. */
  left: string[];
}

/** `tools` fitted into `share` bytes as fitToolListToShare does; when even their shortest is over toolListLimit(share),
 * without the tools of lowest toolKeepRank, the largest first within a rank, until the rest is within it at its shortest.
 * The engine then has nothing to leave out itself. `left` is empty while the list is within that limit. */
export function fitToolListWithinShare<T extends ListedTool>(tools: readonly T[], share: number): ToolListWithinShare<T> {
  const whole = fitToolListToShare(tools, share);
  const limit = toolListLimit(share);
  if (whole.fits || whole.bytes <= limit) return { ...whole, left: [] };
  const floor = withDescriptionLevel(withCompactSchemas(tools), FLOOR_LEVEL).map((tool, index) => ({ index, bytes: definitionBytes(tool), rank: toolKeepRank(tool.name) }));
  let total = floor.reduce((sum, entry) => sum + entry.bytes, 0);
  const left = new Set<number>();
  for (const entry of floor.filter((candidate) => candidate.rank !== Infinity).sort((a, b) => a.rank - b.rank || b.bytes - a.bytes || a.index - b.index)) {
    if (total <= limit) break;
    left.add(entry.index);
    total -= entry.bytes;
  }
  const kept = fitToolListToShare(tools.filter((_, index) => !left.has(index)), share);
  return { ...kept, from: whole.from, left: tools.filter((_, index) => left.has(index)).map((tool) => tool.name) };
}

/** The log line for a list over its share, or undefined when it fit. */
export function overShareNote(fitted: ToolListWithinShare<ListedTool>, share: number): string | undefined {
  if (fitted.left.length) {
    return `tool list is over its ${share}-byte share of the session's tool budget even at its shortest: left out ${fitted.left.length} tool(s) so the engine does not choose, ${fitted.left.join(", ")}`
      + (fitted.bytes > toolListLimit(share) ? `; still ${fitted.bytes - share} bytes over` : "");
  }
  return fitted.fits ? undefined : `tool list is ${fitted.bytes} bytes at its shortest, ${fitted.bytes - share} over its ${share}-byte share of the session's tool budget`;
}

/** A tools/list `tools` array under OMB_TOOL_SCHEMA_PROFILE `profile`: fitted when the profile is a share, else as it came. */
export function toolsForShareProfile<T extends ListedTool>(tools: readonly T[], profile: unknown, log?: (line: string) => void): readonly T[] {
  const share = toolListShare(profile);
  if (share === undefined) return tools;
  // The agents server is built for every request of a turn, its calls included: a list already fitted is reused.
  const key = `${share}\0${JSON.stringify(tools)}`;
  const known = FITTED.get(key);
  if (known) return known as T[];
  const fitted = fitToolListWithinShare(tools, share);
  const note = overShareNote(fitted, share);
  if (note) log?.(note);
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
