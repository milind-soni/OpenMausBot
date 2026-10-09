// A big MCP catalog, searched instead of listed.
//
// Claude Code and Codex on its own login defer MCP tools natively (tool
// search), so a large catalog costs them almost nothing until a tool is
// needed. The other engines put every definition into every model call: the
// chat-completions runtime refuses more than 128 tools, Pi registers each one,
// and Codex on a ChatGPT plan runs with tool_search off. Whop's official
// server lists 425 tools in 1.2 MB of JSON, roughly 315k tokens.
//
// For those engines the remote proxy (mcp-remote-proxy.ts) stands in for a
// big catalog with three tools of its own:
//   search_tools   ranked matches, each with a bounded input signature
//   describe_tool  one tool's exact description and input schema
//   call_tool      runs one tool by name; its result comes back unchanged
// call_tool reaches every tool of the catalog at any time, so a tool the
// model has found never needs activating and cannot drop out of reach again.
//
// Ranking is Okapi BM25 over each tool's name, its area (the name's first
// word), its description and, at half weight, the words of its input schema:
// property names, enum values and property descriptions. Servers put meaning
// there: Whop's revenue figures are a `metric` enum value of stats_get, not a
// word of any description that answers a revenue question. One proxy serves
// one server, which already writes every name and description it is ranked
// on, so its schemas are no less trustworthy; they weigh less only because
// they say less about what a tool is for. Words are Unicode letters and
// digits; English stop words drop out and ASCII words are lightly stemmed.
// BM25 sits behind ToolRanker so a decision model can rank later without
// the proxy changing.
//
// Pure: no I/O. The remote proxy runs the directory; the gate and the drivers
// use directoryCallTarget to see which tool a call really runs, for tool
// selections and approval cards.

type Json = Record<string, unknown>;

/** One upstream tool definition, as the server sent it. */
export interface CatalogTool {
  name: string;
  [key: string]: unknown;
}

/** What a directory tool answers: an ordinary MCP tool result. */
export interface DirectoryResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: true;
}

export const SEARCH_TOOL = "search_tools";
export const DESCRIBE_TOOL = "describe_tool";
export const CALL_TOOL = "call_tool";
const DIRECTORY_TOOLS = new Set([SEARCH_TOOL, DESCRIBE_TOOL, CALL_TOOL]);

/** A catalog with more tools than this is searched. Past a few dozen tools
 * models pick the wrong one more often, and the chat runtime's 128-tool cap
 * is shared by every server of a turn plus the built-ins. */
export const LISTED_TOOLS_MAX = 40;
/** A catalog whose definitions are longer than this is searched too: about
 * 25k tokens, near where Claude Code turns on its own tool search (MCP tools
 * past a tenth of a 200k context), so every engine draws the line in about
 * the same place. A few tools with huge schemas cross it on their own. */
export const LISTED_CHARS_MAX = 100_000;
export const SEARCH_LIMIT_DEFAULT = 8;
export const SEARCH_LIMIT_MAX = 20;
/** One match's description: one line. */
const DESCRIPTION_CHARS = 200;
/** One match's input signature, enough to call most tools without describe. */
export const SIGNATURE_CHARS = 300;
/** The areas listed in search_tools' own description. */
const AREAS_CHARS = 2_000;
/** The upstream instructions quoted in search_tools' own description. */
const ABOUT_CHARS = 400;
/** The upstream initialize instructions a searched server passes through. */
export const INSTRUCTIONS_CHARS = 2_000;
const QUERY_CHARS = 1_000;

function isRecord(value: unknown): value is Json {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Whether `name` is one of the three tools the directory answers itself. */
export function isDirectoryTool(name: unknown): boolean {
  return typeof name === "string" && DIRECTORY_TOOLS.has(name);
}

/** Which upstream tool one call on a searched server runs, for tool scopes
 * and approval cards: the tool itself or call_tool's target. Undefined when
 * nothing upstream runs: search_tools and describe_tool only read the
 * catalog, and a call_tool naming no tool is answered by the directory. */
export function directoryCallTarget(name: string, args: unknown): string | undefined {
  if (name === SEARCH_TOOL || name === DESCRIBE_TOOL) return undefined;
  if (name !== CALL_TOOL) return name;
  const target = isRecord(args) ? args.name : undefined;
  return typeof target === "string" && target.trim() ? target : undefined;
}

/** Whether this catalog is searched rather than listed. A tool that shares a
 * directory tool's name forces the search too, so on a proxy that offers
 * the directory those three names never mean anything else. */
export function searchesCatalog(tools: readonly CatalogTool[]): boolean {
  if (tools.length > LISTED_TOOLS_MAX || tools.some((tool) => isDirectoryTool(tool.name))) return true;
  let chars = 0;
  for (const tool of tools) {
    chars += JSON.stringify(tool).length + 1;
    if (chars > LISTED_CHARS_MAX) return true;
  }
  return false;
}

/** Cut on a character boundary, never inside a surrogate pair. */
function cut(text: string, chars: number): string {
  const kept = text.slice(0, Math.max(0, chars));
  const last = kept.charCodeAt(kept.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? kept.slice(0, -1) : kept;
}

/** At most `maxChars`, with "…" when cut. */
export function bounded(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${cut(text, maxChars - 1).trimEnd()}…`;
}

/** Whitespace collapsed to single spaces and bounded, with "…" when cut. */
export function oneLine(text: unknown, maxChars: number): string {
  return typeof text === "string" ? bounded(text.replace(/\s+/g, " ").trim(), maxChars) : "";
}

// ── local references ────────────────────────────────────────────────────
// Pydantic and FastMCP schemas keep a tool's real fields in `$defs` (or
// `definitions`) behind `{"$ref": "#/$defs/Filters"}`. Only references into
// the same schema are followed, never a URL, and never in a circle.

/** The part of `root` a local `$ref` points at (`#`, `#/$defs/Filters`,
 * any `#/…` JSON pointer), or undefined. */
function resolveRef(root: unknown, ref: string): unknown {
  if (ref === "#") return root;
  if (!ref.startsWith("#/")) return undefined;
  let node = root;
  for (const raw of ref.slice(2).split("/")) {
    let key: string;
    try { key = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~"); } catch { return undefined; }
    if (!node || typeof node !== "object" || !Object.hasOwn(node, key)) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

/** `node` with its references followed, and a lone wrapper unwrapped:
 * `allOf: [X]`, or `anyOf`/`oneOf` of X and null (an optional field).
 * Undefined for a reference that leads back to one already taken. */
function deref(root: unknown, node: unknown, taken: Set<string> = new Set()): unknown {
  let current = node;
  for (let hop = 0; hop < 16 && isRecord(current); hop += 1) {
    if (typeof current.$ref === "string") {
      if (taken.has(current.$ref)) return undefined;
      taken.add(current.$ref);
      current = resolveRef(root, current.$ref);
      continue;
    }
    const wrapped = Array.isArray(current.allOf) && current.allOf.length === 1 ? current.allOf
      : (Array.isArray(current.anyOf) ? current.anyOf : Array.isArray(current.oneOf) ? current.oneOf : [])
        .filter((choice: unknown) => !(isRecord(choice) && choice.type === "null"));
    if (isRecord(current.properties) || wrapped.length !== 1) return current;
    current = wrapped[0];
  }
  return current;
}

// ── ranking ─────────────────────────────────────────────────────────────

/** Words a request is phrased with rather than about: "how much revenue
 * this week" asks about revenue and a week. */
const STOP_WORDS = new Set([
  "a", "about", "all", "am", "an", "and", "any", "are", "as", "at", "be", "been", "being", "but", "by",
  "can", "could", "did", "do", "does", "doing", "for", "from", "had", "has", "have", "having", "he", "her",
  "here", "him", "his", "how", "i", "if", "in", "into", "is", "it", "its", "just", "like", "many", "me",
  "might", "more", "most", "much", "must", "my", "need", "no", "not", "of", "on", "or", "our", "ours",
  "please", "she", "should", "so", "some", "than", "that", "the", "their", "them", "then", "there",
  "these", "they", "this", "those", "to", "too", "us", "very", "want", "was", "we", "were", "what", "when",
  "where", "which", "while", "who", "whom", "whose", "why", "will", "with", "would", "you", "your", "yours",
]);

/** Light English stemming, applied to queries and tools alike: plurals,
 * -ing and -ed, and a final e, so "payments", "listing" and "updated" meet
 * "payment", "list" and "update". Consistency matters more than linguistics:
 * "create" and "creating" both become "creat". */
export function stem(word: string): string {
  let w = word;
  if (w.length > 4 && w.endsWith("ies")) w = `${w.slice(0, -3)}y`;
  else if (w.length > 4 && w.endsWith("sses")) w = w.slice(0, -2);
  else if (w.length > 4 && /(?:[sxz]|ch|sh)es$/.test(w)) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith("s") && !/(?:ss|us|is)$/.test(w)) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith("ed")) w = w.slice(0, -2);
  if (w.length > 3 && w.endsWith("e")) w = w.slice(0, -1);
  return w;
}

/** The words of a name or a sentence: NFKC-normalized (a decomposed café,
 * fullwidth letters), runs of Unicode letters, combining marks and digits
 * (so Hindi and Thai words stay whole), camelCase and snake_case split,
 * lowercased, stop words and single ASCII letters dropped, ASCII words
 * stemmed. */
export function terms(text: string): string[] {
  return text
    .normalize("NFKC")
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1 $2")
    .toLowerCase()
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter((word) => word && (word.length > 1 || !/^[a-z0-9]$/.test(word)) && !STOP_WORDS.has(word))
    .map((word) => /^[a-z0-9]+$/.test(word) ? stem(word) : word);
}

/** Characters of one tool's input schema that are ranked on. */
const SCHEMA_TEXT_CHARS = 4_000;
const SUBSCHEMA_LISTS = ["anyOf", "oneOf", "allOf", "prefixItems"] as const;

/** The words a tool's input schema carries: property names, enum values
 * and descriptions, nested ones too, bounded. */
export function schemaText(schema: unknown, maxChars = SCHEMA_TEXT_CHARS): string {
  let text = "";
  const followed = new Set<string>();
  const add = (part: unknown) => {
    if ((typeof part === "string" || typeof part === "number") && text.length < maxChars) text = `${text} ${cut(String(part), maxChars - text.length)}`;
  };
  const visit = (node: unknown, depth: number) => {
    if (!isRecord(node) || depth > 8 || text.length >= maxChars) return;
    // each local definition is read once, wherever it is referred to
    if (typeof node.$ref === "string" && !followed.has(node.$ref)) {
      followed.add(node.$ref);
      visit(resolveRef(schema, node.$ref), depth + 1);
    }
    add(node.description);
    if (Array.isArray(node.enum)) for (const value of node.enum) add(value);
    add(node.const);
    if (isRecord(node.properties)) {
      for (const [key, child] of Object.entries(node.properties)) {
        add(key);
        visit(child, depth + 1);
      }
    }
    visit(node.items, depth + 1);
    visit(node.additionalProperties, depth + 1);
    for (const list of SUBSCHEMA_LISTS) if (Array.isArray(node[list])) for (const child of node[list]) visit(child, depth + 1);
  };
  visit(schema, 0);
  return text.trim();
}

/** A tool's area: its name up to the first underscore (`payments` for
 * `payments_list`, `promo-codes` for `promo-codes_create`), or for a name
 * without one its first word (`get` for `getUser`), lowercased. */
export function toolArea(name: string): string {
  const prefix = name.slice(0, Math.max(0, name.indexOf("_")));
  if (prefix.trim()) return cut(prefix.toLowerCase(), 40);
  const head = name.split(/[\s_./:-]+/).find(Boolean) ?? name;
  const word = /^[A-Z]?[a-z0-9]+|^[A-Z]+(?![a-z])/.exec(head)?.[0] ?? head;
  return cut(word.toLowerCase(), 40);
}

/** Orders a catalog for one query, best match first, at most `limit` tools.
 * The seam where a decision model can replace BM25: it gets the same tools
 * the directory would search and returns its pick, in order. */
export type ToolRanker = (query: string, tools: readonly CatalogTool[], limit: number) => readonly CatalogTool[] | Promise<readonly CatalogTool[]>;

const K1 = 1.2;
const B = 0.75;
/** What each part of a tool counts for against a word of its description.
 * The schema says least about what a tool is for, so its words count half. */
const FIELD_WEIGHTS = { name: 2, text: 1, schema: 0.5 } as const;
type Field = keyof typeof FIELD_WEIGHTS;
const FIELDS = Object.keys(FIELD_WEIGHTS) as Field[];
/** A query word naming a tool's area counts like one more hit in its name,
 * with the word's rarity among areas rather than in the whole catalog:
 * "payment" may appear in half the tools, yet few are in the payments area,
 * and a request that names an area wants that area's tools. */
const AREA_WEIGHT = FIELD_WEIGHTS.name;
/** Words that ask what there is ("who are my newest members", "show
 * refunds"): the request wants a listing, so tools that list get a modest
 * lift, never enough to outrank a verb the request names ("cancel"). */
const LIST_INTENT = new Set(["who", "which", "what", "show", "list", "recent", "newest", "latest", "all"]);
const LIST_WEIGHT = 0.5;

function counted(text: string): { counts: Map<string, number>; length: number } {
  const counts = new Map<string, number>();
  const words = terms(text);
  for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
  return { counts, length: words.length };
}

/** A tool's words, field by field: each field is length-normalized on its
 * own (BM25F), so a long schema cannot dilute a match in the name. */
function fields(tool: CatalogTool): Record<Field, { counts: Map<string, number>; length: number }> {
  const text = [tool.title, tool.description].filter((part): part is string => typeof part === "string").join(" ");
  return {
    name: counted(tool.name),
    text: counted(text),
    schema: counted(schemaText(tool.inputSchema)),
  };
}

/** Whether a tool lists things: `list` in its name, or a description that
 * starts with "Lists". */
function lists(name: { counts: Map<string, number> }, description: unknown): boolean {
  return name.counts.has("list") || (typeof description === "string" && terms(description.slice(0, 40))[0] === "list");
}

const rarity = (total: number, holding: number) => Math.log(1 + (total - holding + 0.5) / (holding + 0.5));
const saturated = (tf: number) => (tf * (K1 + 1)) / (tf + K1);

function byName(a: CatalogTool, b: CatalogTool): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** Okapi BM25 (in its multi-field form, BM25F) over names, descriptions
 * and, at half weight, input schemas; plus a tool's area, scored by its own
 * rarity among areas, and a lift for listing tools when the request asks
 * what there is. An exact tool name always ranks first; equal scores are
 * ordered by name. */
export const bm25Ranker: ToolRanker = (query, tools, limit) => {
  const wanted = [...new Set(terms(query))];
  const exact = query.trim().toLowerCase();
  const listing = !wanted.includes("list") && query.toLowerCase().split(/[^\p{L}\p{N}]+/u).some((word) => LIST_INTENT.has(word));
  const docs = tools.map((tool) => {
    const parts = fields(tool);
    return { tool, fields: parts, area: counted(toolArea(tool.name)), lists: lists(parts.name, tool.description) };
  });
  const average = Object.fromEntries(FIELDS.map((field) =>
    [field, docs.reduce((sum, doc) => sum + doc.fields[field].length, 0) / Math.max(1, docs.length) || 1])) as Record<Field, number>;
  const averageArea = docs.reduce((sum, doc) => sum + doc.area.length, 0) / Math.max(1, docs.length) || 1;
  const df = new Map<string, number>();
  const areaDf = new Map<string, number>();
  for (const doc of docs) {
    for (const term of wanted) {
      if (FIELDS.some((field) => doc.fields[field].counts.has(term))) df.set(term, (df.get(term) ?? 0) + 1);
      if (doc.area.counts.has(term)) areaDf.set(term, (areaDf.get(term) ?? 0) + 1);
    }
  }
  const listRarity = rarity(docs.length, docs.filter((doc) => doc.lists).length);
  const scored: Array<{ tool: CatalogTool; score: number }> = [];
  for (const doc of docs) {
    let score = doc.tool.name.toLowerCase() === exact ? 1_000 : 0;
    for (const term of wanted) {
      let tf = 0;
      for (const field of FIELDS) {
        const { counts, length } = doc.fields[field];
        const count = counts.get(term);
        if (count) tf += (FIELD_WEIGHTS[field] * count) / (1 - B + (B * length) / average[field]);
      }
      if (tf) score += rarity(docs.length, df.get(term) ?? 0) * saturated(tf);
      const inArea = doc.area.counts.get(term);
      if (inArea) score += rarity(docs.length, areaDf.get(term) ?? 0) * saturated((AREA_WEIGHT * inArea) / (1 - B + (B * doc.area.length) / averageArea));
    }
    if (score > 0 && listing && doc.lists) score += LIST_WEIGHT * listRarity;
    if (score > 0) scored.push({ tool: doc.tool, score });
  }
  scored.sort((a, b) => b.score - a.score || byName(a.tool, b.tool));
  return scored.slice(0, limit).map((entry) => entry.tool);
};

// ── signatures ──────────────────────────────────────────────────────────

function literal(value: unknown): string {
  const text = JSON.stringify(value) ?? "unknown";
  return text.length <= 30 ? text : `${cut(text, 29)}…`;
}

function union(parts: string[]): string {
  return [...new Set(parts)].join(" | ");
}

/** One schema as a short TypeScript-style type. Objects stay `object`: the
 * signature is a hint, and describe_tool has the exact shape. Local
 * references into `root` are followed a few steps deep. */
function typeText(schema: unknown, depth: number, root?: unknown, hops = 0): string {
  if (!isRecord(schema)) return "unknown";
  if (typeof schema.$ref === "string") {
    return hops < 4 && root !== undefined ? typeText(resolveRef(root, schema.$ref), depth, root, hops + 1) : "unknown";
  }
  if ("const" in schema) return literal(schema.const);
  if (Array.isArray(schema.enum) && schema.enum.length) {
    const values = union(schema.enum.slice(0, 6).map(literal)) + (schema.enum.length > 6 ? " | …" : "");
    if (values.length <= 80) return values;
  }
  const choices = Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : undefined;
  if (choices?.length) return bounded(union(choices.map((choice) => typeText(choice, depth, root, hops))), 120);
  if (Array.isArray(schema.type)) return union(schema.type.map((type) => typeText({ ...schema, type }, depth, root, hops)));
  switch (schema.type) {
    case "string": return "string";
    case "integer":
    case "number": return "number";
    case "boolean": return "boolean";
    case "null": return "null";
    case "object": return "object";
    case "array": {
      const item = depth < 2 ? typeText(schema.items, depth + 1, root, hops) : "unknown";
      return item.includes(" ") ? `(${item})[]` : `${item}[]`;
    }
  }
  if (isRecord(schema.properties)) return "object";
  if (Array.isArray(schema.allOf) && schema.allOf.length === 1) return typeText(schema.allOf[0], depth, root, hops);
  return "unknown";
}

/** A tool's input as a TypeScript-style object type, required fields first,
 * at most `maxChars` long: `{ company_id: string; first?: number }`. Fields
 * that do not fit are counted, never cut in half. */
export function inputSignature(schema: unknown, maxChars = SIGNATURE_CHARS): string {
  const root = schema;
  schema = deref(root, schema);
  const properties = isRecord(schema) && isRecord(schema.properties) ? schema.properties : {};
  const required = new Set(isRecord(schema) && Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === "string") : []);
  const keys = Object.keys(properties);
  const fields = [...keys.filter((key) => required.has(key)), ...keys.filter((key) => !required.has(key))].map((key) =>
    `${/^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key)}${required.has(key) ? "" : "?"}: ${typeText(properties[key], 0, root)}`);
  if (!fields.length) return "{}";
  const whole = `{ ${fields.join("; ")} }`;
  if (whole.length <= maxChars) return whole;
  let body = "";
  let kept = 0;
  for (const field of fields) {
    const next = body ? `${body}; ${field}` : field;
    const left = fields.length - kept - 1;
    if (`{ ${next}${left ? `; … ${left} more` : ""} }`.length > maxChars) break;
    body = next;
    kept += 1;
  }
  if (kept) return `{ ${body}; … ${fields.length - kept} more }`;
  // Not even the first field fits: show as much of it as room allows.
  const tail = fields.length > 1 ? `; … ${fields.length - 1} more }` : " }";
  return `{ ${cut(fields[0], maxChars - 3 - tail.length)}…${tail}`;
}

// ── the directory ───────────────────────────────────────────────────────

/** The areas of a catalog with their tool counts, biggest first:
 * `payments (12), memberships (9), … and 40 more`. */
export function areaSummary(tools: readonly CatalogTool[], maxChars = AREAS_CHARS): string {
  const counts = new Map<string, number>();
  for (const tool of tools) {
    const area = toolArea(tool.name);
    counts.set(area, (counts.get(area) ?? 0) + 1);
  }
  const sorted = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  let text = "";
  let shown = 0;
  for (const [area, count] of sorted) {
    const part = `${shown ? ", " : ""}${area} (${count})`;
    const last = shown === sorted.length - 1;
    // leave room to say how many areas are not listed
    if (text.length + part.length + (last ? 0 : 24) > maxChars) break;
    text += part;
    shown += 1;
  }
  return shown < sorted.length ? `${text}${shown ? ", " : ""}… and ${sorted.length - shown} more` : text;
}

function result(payload: unknown): DirectoryResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

/** What a model reads and recovers from: a name it got wrong, a search with
 * no words, arguments that do not fit. Never an error: a chat turn whose
 * tool call failed ends as failed, and these ran nothing. */
function guidance(text: string): DirectoryResult {
  return { content: [{ type: "text", text }] };
}

/** The bot's tool selection leaves the tool out. That stays a refusal, as
 * the same call to a listed tool would be. */
export const SELECTION_EXCLUDES = "Tool selection excludes this tool. Check the bot's Access settings.";
function excluded(): DirectoryResult {
  return { content: [{ type: "text", text: SELECTION_EXCLUDES }], isError: true };
}

const HOW_TO_SEARCH = `Find tool names with ${SEARCH_TOOL}({ "query": "what you want to do" }), then run one with ${CALL_TOOL}({ "name": "...", "arguments": {...} }).`;

/** describe_tool answers in at most this many UTF-8 bytes. Chat engines and
 * Pi keep 50 KiB of one tool result, and a schema cut in half is not a
 * schema, so a bigger one is compacted instead, saying so. */
export const DESCRIBE_BYTES = 40_000;
const encoder = new TextEncoder();
const byteLength = (text: string) => encoder.encode(text).length;

// Where a schema holds further schemas (JSON Schema draft-07 and 2020-12).
const SCHEMA_MAPS = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);
const SCHEMA_LISTS = new Set(["anyOf", "oneOf", "allOf", "prefixItems"]);
const SCHEMA_CHILDREN = new Set(["items", "additionalProperties", "not", "if", "then", "else", "contains", "propertyNames", "unevaluatedItems", "unevaluatedProperties"]);

/** A copy of a schema without some annotation keywords, from `depth` down
 * (0 is the root, 1 its properties). Property names are never touched. */
function withoutKeywords(schema: unknown, keywords: ReadonlySet<string>, depth: number, at = 0): unknown {
  if (Array.isArray(schema)) return schema.map((child) => withoutKeywords(child, keywords, depth, at));
  if (!isRecord(schema)) return schema;
  const copy: Json = {};
  for (const [key, value] of Object.entries(schema)) {
    if (at >= depth && keywords.has(key)) continue;
    if (SCHEMA_MAPS.has(key) && isRecord(value)) {
      copy[key] = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, withoutKeywords(child, keywords, depth, at + 1)]));
    } else if (SCHEMA_LISTS.has(key) || SCHEMA_CHILDREN.has(key)) {
      copy[key] = withoutKeywords(value, keywords, depth, at + 1);
    } else {
      copy[key] = value;
    }
  }
  return copy;
}

/** Every field of a schema as a path, its type and whether it is required:
 * what is left of a schema too big to show. */
function schemaFields(schema: unknown): Array<{ path: string; type: string; required?: true }> {
  const fields: Array<{ path: string; type: string; required?: true }> = [];
  const visit = (start: unknown, prefix: string, depth: number, taken: Set<string>) => {
    const node = deref(schema, start, taken);
    if (!isRecord(node) || !isRecord(node.properties) || depth > 6) return;
    const required = new Set(Array.isArray(node.required) ? node.required : []);
    for (const [key, child] of Object.entries(node.properties)) {
      const path = bounded(prefix ? `${prefix}.${key}` : key, 200);
      fields.push({ path, type: bounded(typeText(child, 0, schema), 200), ...(required.has(key) ? { required: true as const } : {}) });
      // each path follows its own references, so a schema that nests itself stops
      const branch = new Set(taken);
      const value = deref(schema, child, branch);
      if (isRecord(value)) visit(isRecord(value.items) ? value.items : value, isRecord(value.items) ? `${path}[]` : path, depth + 1, branch);
    }
  };
  visit(schema, "", 0, new Set());
  return fields;
}

const ANNOTATIONS = new Set(["examples", "example", "default", "$comment"]);
const ANNOTATIONS_AND_WORDS = new Set([...ANNOTATIONS, "description", "title"]);
const COMPACTIONS = [
  { note: "Examples and defaults were left out of the schema to fit.", keywords: ANNOTATIONS, depth: 0 },
  { note: "Examples, defaults and the descriptions of nested fields were left out of the schema to fit.", keywords: ANNOTATIONS_AND_WORDS, depth: 2 },
  { note: "Examples, defaults and every field description were left out of the schema to fit.", keywords: ANNOTATIONS_AND_WORDS, depth: 0 },
];

/** Who the server is, for the directory tools' own descriptions. */
export interface DirectoryContext {
  /** the name this server is configured under, e.g. "whop" */
  server: string;
  /** its own `serverInfo` title or name, when it gave one */
  title?: string;
  /** its own initialize instructions, when it gave any */
  instructions?: string;
}

export interface DirectoryOptions {
  ranker?: ToolRanker;
  /** Tools the server has that the bot's selection leaves out: naming one
   * is refused as the selection's, not answered as a miss. */
  withheld?: Iterable<string>;
  /** What is wrong with a call's arguments against the tool's input schema,
   * if anything. */
  check?: (tool: CatalogTool, args: Json) => readonly string[] | undefined;
}

/** One searched catalog: the tools the bot may use, and the three tools
 * that stand in for them. Duplicate names keep their first definition. */
export class ToolDirectory {
  readonly tools: readonly CatalogTool[];
  private readonly index = new Map<string, CatalogTool>();
  private readonly ranker: ToolRanker;
  private readonly withheld: ReadonlySet<string>;
  private readonly check: DirectoryOptions["check"];

  constructor(tools: readonly CatalogTool[], options: DirectoryOptions = {}) {
    for (const tool of tools) if (!this.index.has(tool.name)) this.index.set(tool.name, tool);
    this.tools = [...this.index.values()];
    this.ranker = options.ranker ?? bm25Ranker;
    this.withheld = new Set([...(options.withheld ?? [])].filter((name) => !this.index.has(name)));
    this.check = options.check;
  }

  has(name: string): boolean {
    return this.index.has(name);
  }

  /** search_tools, describe_tool and call_tool, described for this server. */
  listed(context: DirectoryContext): Json[] {
    const who = `the "${context.server}" MCP server${context.title && context.title !== context.server ? ` (${oneLine(context.title, 80)})` : ""}`;
    const about = oneLine(context.instructions, ABOUT_CHARS);
    const nameField = { type: "string", description: `The tool's exact name, as ${SEARCH_TOOL} gave it.` };
    return [
      {
        name: SEARCH_TOOL,
        description: [
          `Search the ${this.tools.length} tools of ${who}. There are too many to list, so find the one you need here: say what you want to do in a few words. Each match comes with what it does and its input fields. Run a match with ${CALL_TOOL}.`,
          `Areas (tools in each): ${areaSummary(this.tools)}.`,
          ...(about ? [`About this server: ${about}`] : []),
        ].join("\n"),
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "What you want to do, in a few words." },
            limit: { type: "integer", minimum: 1, maximum: SEARCH_LIMIT_MAX, description: `How many matches to return. Default ${SEARCH_LIMIT_DEFAULT}.` },
          },
          required: ["query"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true },
      },
      {
        name: DESCRIBE_TOOL,
        description: `Get the exact description and input schema of one tool of ${who}. Use it when a match's input fields are cut short or you need their exact types.`,
        inputSchema: { type: "object", properties: { name: nameField }, required: ["name"], additionalProperties: false },
        annotations: { readOnlyHint: true },
      },
      {
        name: CALL_TOOL,
        description: `Run one tool of ${who} by its exact name, with its input as arguments, and get its result. Find the name with ${SEARCH_TOOL} first; every tool it finds stays available here.`,
        inputSchema: {
          type: "object",
          properties: {
            name: nameField,
            arguments: { type: "object", description: "The tool's input, matching its input fields.", additionalProperties: true },
          },
          required: ["name"],
          additionalProperties: false,
        },
      },
    ];
  }

  /** search_tools: ranked matches with bounded descriptions, signatures and
   * the hints the server's annotations give. */
  async search(args: unknown): Promise<DirectoryResult> {
    const query = isRecord(args) && typeof args.query === "string" ? args.query.trim() : "";
    const rawLimit = isRecord(args) ? args.limit : undefined;
    if (!query || query.length > QUERY_CHARS || (rawLimit !== undefined && (typeof rawLimit !== "number" || !Number.isFinite(rawLimit)))) {
      return guidance(`${SEARCH_TOOL} needs { "query": "a few words", "limit"?: a number from 1 to ${SEARCH_LIMIT_MAX} }. Say what you want to do, for example "list payments".`);
    }
    const limit = Math.min(SEARCH_LIMIT_MAX, Math.max(1, Math.floor((rawLimit as number | undefined) ?? SEARCH_LIMIT_DEFAULT)));
    const found = await this.ranker(query, this.tools, limit);
    const matches = found.slice(0, limit).filter((tool) => this.index.get(tool.name) === tool).map((tool) => {
      const annotations = isRecord(tool.annotations) ? tool.annotations : {};
      return {
        name: tool.name,
        description: oneLine(tool.description ?? tool.title, DESCRIPTION_CHARS),
        input: inputSignature(tool.inputSchema),
        ...(annotations.readOnlyHint === true ? { readOnly: true } : annotations.destructiveHint === true ? { destructive: true } : {}),
      };
    });
    return result(matches.length
      ? { matches, next: `Run one with ${CALL_TOOL}({ "name": "...", "arguments": {...} }). ${DESCRIBE_TOOL} gives a tool's exact input schema when its input is cut short.` }
      : { matches, next: `Nothing matched. Try other words, or one of these areas: ${areaSummary(this.tools, 600)}.` });
  }

  /** describe_tool: one tool's exact definition, compacted only when it
   * would not fit DESCRIBE_BYTES. */
  describe(args: unknown): DirectoryResult {
    const name = isRecord(args) ? args.name : undefined;
    if (typeof name !== "string") return guidance(`${DESCRIBE_TOOL} needs { "name": "the tool's exact name" }. ${HOW_TO_SEARCH}`);
    if (this.withheld.has(name)) return excluded();
    const tool = this.index.get(name);
    if (!tool) return guidance(unknownTool(name));
    const definition = {
      name: tool.name,
      ...(tool.title !== undefined ? { title: tool.title } : {}),
      description: tool.description ?? "",
      inputSchema: tool.inputSchema ?? { type: "object" },
      ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
    };
    const whole = JSON.stringify(definition);
    if (byteLength(whole) <= DESCRIBE_BYTES) return guidance(whole);
    for (const step of COMPACTIONS) {
      const compacted = JSON.stringify({ ...definition, inputSchema: withoutKeywords(definition.inputSchema, step.keywords, step.depth), compacted: step.note });
      if (byteLength(compacted) <= DESCRIBE_BYTES) return guidance(compacted);
    }
    // Last resort: the fields alone, as many as fit, and how many did not.
    const fields = schemaFields(definition.inputSchema);
    const outline = (kept: number) => JSON.stringify({
      name: bounded(tool.name, 200),
      description: oneLine(tool.description, 4_000),
      fields: fields.slice(0, kept),
      ...(kept < fields.length ? { moreFields: fields.length - kept } : {}),
      compacted: "This schema is too large to show whole: these are its fields, their types and which are required.",
    });
    let kept = fields.length;
    while (kept > 0 && byteLength(outline(kept)) > DESCRIBE_BYTES) kept = Math.floor(kept * 0.9);
    return guidance(outline(kept));
  }

  /** call_tool: the upstream `tools/call` to send, or the answer to give
   * instead (a miss, arguments that do not fit, or the selection's refusal). */
  call(args: unknown): { name: string; arguments: Json } | { answer: DirectoryResult } {
    const name = isRecord(args) ? args.name : undefined;
    const input = isRecord(args) ? args.arguments : undefined;
    if (typeof name !== "string" || (input !== undefined && !isRecord(input))) {
      return { answer: guidance(`${CALL_TOOL} needs { "name": "the tool's exact name", "arguments"?: {...} }. ${HOW_TO_SEARCH}`) };
    }
    if (this.withheld.has(name)) return { answer: excluded() };
    const tool = this.index.get(name);
    if (!tool) return { answer: guidance(unknownTool(name)) };
    const problems = this.check?.(tool, input ?? {});
    if (problems?.length) {
      return { answer: result({
        problems,
        input: inputSignature(tool.inputSchema),
        next: `Nothing was run. Call ${CALL_TOOL} again with arguments that fit, or ask ${DESCRIBE_TOOL} for the exact schema.`,
      }) };
    }
    return { name, arguments: input ?? {} };
  }
}

function unknownTool(name: string): string {
  return `No tool named ${JSON.stringify(oneLine(name, 100))} on this server. ${HOW_TO_SEARCH}`;
}
