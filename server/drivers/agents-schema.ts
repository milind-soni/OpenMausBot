// An agents tool's input schema twice over: the full one in the catalog, which every call is held to before the tool
// runs, and the one tools/list advertises, which leaves out bounds a model reads from the words or never comes near.
// The advertised schema may only leave out what callTool enforces, so a shorter list never loosens a call.
import type { Json } from "./agents-client.ts";

/** Checked on every call wherever they sit in the full schema; the only keywords the advertised schema may omit. A
 * free-form object keeps `additionalProperties: true`: Moonshot reads a bare `{"type":"object"}` as endless recursion. */
export const ENFORCED_KEYWORDS = ["minLength", "maxLength", "minimum", "maximum", "minItems", "maxItems", "uniqueItems", "pattern"] as const;

/** A cap at least this generous is left out: no sensible value comes near it, and a call past it is refused in words. */
const GENEROUS_MAX_LENGTH = 200;
const GENEROUS_MAX_ITEMS = 32;
const PROBLEMS_SHOWN = 4;

function record(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** "1440" or "1,440" standing alone in the words. */
function stated(value: number, words: string): boolean {
  const grouped = String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return [...new Set([String(value), grouped])].some((form) => new RegExp(`(?<![\\d,.])${form.replace(/[.,]/g, "\\$&")}(?![\\d,])`).test(words));
}

function leftOut(keyword: string, value: unknown, node: Json, words: string): boolean {
  if (keyword === "uniqueItems") return true;
  if (typeof value !== "number") return false;
  if (stated(value, words)) return true;
  if (keyword === "minLength" || keyword === "minItems") return value <= 1;
  if (keyword === "minimum") return node.type === "integer" && value <= 1;
  if (keyword === "maxLength") return value >= GENEROUS_MAX_LENGTH;
  if (keyword === "maxItems") return value >= GENEROUS_MAX_ITEMS;
  return false;
}

function compact(node: unknown, toolWords: string): unknown {
  if (!record(node)) return node;
  const words = `${typeof node.description === "string" ? node.description : ""} ${toolWords}`;
  const out: Json = {};
  for (const [key, value] of Object.entries(node)) {
    if ((ENFORCED_KEYWORDS as readonly string[]).includes(key) && leftOut(key, value, node, words)) continue;
    if (key === "properties" && record(value)) {
      out[key] = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, compact(child, toolWords)]));
    } else if ((key === "items" || key === "additionalProperties") && record(value)) {
      out[key] = compact(value, toolWords);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** The input schema tools/list sends for a tool described by `description`. */
export function advertisedSchema<T>(schema: T, description: string): T {
  return compact(schema, description) as T;
}

function characters(text: string): number {
  return [...text].length;
}

function check(node: unknown, value: unknown, where: string, problems: string[]): void {
  if (!record(node) || value === undefined || value === null) return;
  const at = where || "arguments";
  if (typeof value === "string") {
    const length = characters(value);
    if (typeof node.minLength === "number" && length < node.minLength) problems.push(length === 0 ? `${at} must not be empty` : `${at} needs at least ${node.minLength} characters (it has ${length})`);
    if (typeof node.maxLength === "number" && length > node.maxLength) problems.push(`${at} takes at most ${node.maxLength} characters (it has ${length})`);
    if (typeof node.pattern === "string" && !new RegExp(node.pattern, "u").test(value)) problems.push(`${at} must match ${node.pattern}`);
  } else if (typeof value === "number") {
    if (typeof node.minimum === "number" && value < node.minimum) problems.push(`${at} must be at least ${node.minimum} (it is ${value})`);
    if (typeof node.maximum === "number" && value > node.maximum) problems.push(`${at} must be at most ${node.maximum} (it is ${value})`);
  } else if (Array.isArray(value)) {
    if (typeof node.minItems === "number" && value.length < node.minItems) problems.push(value.length === 0 ? `${at} must not be empty` : `${at} needs at least ${node.minItems} items (it has ${value.length})`);
    if (typeof node.maxItems === "number" && value.length > node.maxItems) problems.push(`${at} takes at most ${node.maxItems} items (it has ${value.length})`);
    if (node.uniqueItems === true && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) problems.push(`${at} must not repeat an item`);
    value.forEach((item, index) => check(node.items, item, `${at}[${index}]`, problems));
  } else if (record(value)) {
    const declared = record(node.properties) ? node.properties : {};
    for (const [key, child] of Object.entries(value)) {
      const schema = Object.hasOwn(declared, key) ? declared[key] : node.additionalProperties;
      check(schema, child, where ? `${where}.${key}` : key, problems);
    }
  }
}

/** Why `args` falls outside the full schema's bounds, in words a model can act on; undefined when it fits. A null
 * stands for a field left out, as providers send unused optional fields. Types, enums and required fields are each
 * tool's own to check: several accept a stringified object, a camelCase alias or a case variant on purpose. */
export function outOfBounds(tool: string, schema: unknown, args: Json): string | undefined {
  const problems: string[] = [];
  check(schema, args, "", problems);
  if (!problems.length) return undefined;
  const shown = problems.slice(0, PROBLEMS_SHOWN).join("; ");
  return `${tool} was not run: ${shown}${problems.length > PROBLEMS_SHOWN ? `; and ${problems.length - PROBLEMS_SHOWN} more` : ""}. Fix these and call it again.`;
}
