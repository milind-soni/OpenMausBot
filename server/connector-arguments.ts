// What a bot sends a connected-app tool, put in the shape the tool's listed schema asks for when the bot plainly meant
// that shape, and a plain note on how to call again when the call is still refused over its arguments. Composio checks
// each call against the tool's schema and refuses the whole call over one argument ("Invalid request for
// COMPOSIO_SEARCH_TOOLS: Validation error: Required at "queries""), and a bot can read that as "there is no such tool".

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** Composio's refusal of a call's arguments. Only failed results are read: a successful answer may quote it. */
export const ARGUMENT_REFUSAL = /Invalid request for [A-Z0-9_]+: Validation error|Validation error: (?:Required|Expected|Invalid)/;

/** `node` with local `$ref`s followed, the way the listed schema's own definitions resolve them. */
function resolved(node: unknown, root: Json, hops = 0): Json | null {
  if (!isObject(node)) return null;
  if (typeof node.$ref !== "string" || hops > 8 || !node.$ref.startsWith("#/")) return node;
  let current: unknown = root;
  for (const part of node.$ref.slice(2).split("/")) current = isObject(current) ? current[part.replaceAll("~1", "/").replaceAll("~0", "~")] : undefined;
  return resolved(current, root, hops + 1);
}

function typeOf(node: Json | null): string | undefined {
  if (!node) return undefined;
  const type = Array.isArray(node.type) ? node.type.find((entry) => entry !== "null") : node.type;
  if (typeof type === "string") return type;
  if (isObject(node.properties)) return "object";
  if ("items" in node) return "array";
  return undefined;
}

/** The one string field an object must carry, as `queries: [{ use_case }]` asks: a bare string becomes that object. */
function soleStringField(node: Json | null, root: Json): string | null {
  if (typeOf(node) !== "object" || !isObject(node!.properties)) return null;
  const required = Array.isArray(node!.required) ? node!.required.filter((key): key is string => typeof key === "string") : [];
  const keys = required.length ? required : Object.keys(node!.properties);
  if (keys.length !== 1) return null;
  return typeOf(resolved(node!.properties[keys[0]!], root)) === "string" ? keys[0]! : null;
}

function parsedJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** `value` as `node` asks for it when that is plainly what was meant, else `value` itself; `changed` names the change. */
function coerce(value: unknown, node: Json | null, root: Json, path: string, changed: string[]): unknown {
  const type = typeOf(node);
  if (type === "array") {
    const items = resolved(node!.items, root);
    const field = soleStringField(items, root);
    if (typeof value === "string") {
      const parsed = parsedJson(value);
      if (Array.isArray(parsed)) {
        changed.push(`${path} from text to a list`);
        return parsed.map((item, index) => coerce(item, items, root, `${path}[${index}]`, []));
      }
      if (field) {
        changed.push(`${path} as [{"${field}": …}]`);
        return [{ [field]: value }];
      }
      if (typeOf(items) === "string") {
        changed.push(`${path} as a list of one`);
        return [value];
      }
      return value;
    }
    if (Array.isArray(value)) {
      return value.map((item, index) => {
        if (field && typeof item === "string") {
          changed.push(`${path}[${index}] as {"${field}": …}`);
          return { [field]: item };
        }
        return coerce(item, items, root, `${path}[${index}]`, changed);
      });
    }
    return value;
  }
  if (type === "object") {
    const parsed = typeof value === "string" ? parsedJson(value) : undefined;
    if (isObject(parsed)) changed.push(`${path} from text to an object`);
    const object = isObject(parsed) ? parsed : value;
    if (!isObject(object) || !isObject(node!.properties)) return object;
    const properties = node!.properties;
    return Object.fromEntries(Object.entries(object).map(([key, item]) =>
      [key, key in properties ? coerce(item, resolved(properties[key], root), root, `${path}.${key}`, changed) : item]));
  }
  if ((type === "number" || type === "integer") && typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value.trim())) {
    changed.push(`${path} as a number`);
    return Number(value.trim());
  }
  if (type === "boolean" && (value === "true" || value === "false")) {
    changed.push(`${path} as ${value}`);
    return value === "true";
  }
  return value;
}

/** Whether `value` could be the field `node` describes, once coerce has done its part. */
function couldBe(value: unknown, node: Json | null): boolean {
  const type = typeOf(node);
  if (!type) return true;
  if (type === "array") return typeof value === "string" || Array.isArray(value);
  if (type === "object") return isObject(value) || typeof value === "string";
  if (type === "string") return typeof value === "string";
  if (type === "number" || type === "integer") return typeof value === "number" || typeof value === "string";
  if (type === "boolean") return typeof value === "boolean" || value === "true" || value === "false";
  return true;
}

const words = (name: string) => name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const related = (a: string, b: string) => words(a).some((word) => words(b).includes(word));

/**
 * `args` fitted to `schema`: arguments sent as text, a list or number written as text, a bare string where a list of
 * one-field objects goes, and one required field under another name when exactly one sent field can be it (a
 * `job` where `queries` is required, `code` for `code_to_execute`). What changed is listed for the bot; anything not
 * plainly meant is left for the tool to refuse.
 */
export function fitArguments(args: unknown, schema: unknown): { args: unknown; changed: string[] } {
  const root = resolved(schema, isObject(schema) ? schema : {});
  if (!root || typeOf(root) !== "object" || !isObject(root.properties)) return { args, changed: [] };
  const changed: string[] = [];
  const parsed = typeof args === "string" ? parsedJson(args) : args;
  if (typeof args === "string" && isObject(parsed)) changed.push("the arguments from text to an object");
  if (!isObject(parsed)) return { args, changed: [] };
  const properties = root.properties;
  const fields = { ...parsed };
  const required = Array.isArray(root.required) ? root.required.filter((key): key is string => typeof key === "string") : [];
  const missing = required.filter((key) => !(key in fields));
  const unknown = Object.keys(fields).filter((key) => !(key in properties));
  if (missing.length === 1) {
    const target = missing[0]!, node = resolved(properties[target], root);
    const fitting = unknown.filter((key) => couldBe(fields[key], node));
    const chosen = fitting.length === 1 ? fitting[0] : fitting.filter((key) => related(key, target)).length === 1 ? fitting.find((key) => related(key, target)) : undefined;
    if (chosen !== undefined) {
      fields[target] = fields[chosen];
      delete fields[chosen];
      changed.push(`${chosen} as ${target}`);
    }
  }
  const fitted = Object.fromEntries(Object.entries(fields).map(([key, value]) =>
    [key, key in properties ? coerce(value, resolved(properties[key], root), root, key, changed) : value]));
  return { args: changed.length ? fitted : args, changed };
}

/** A minimal call the schema accepts, its required fields only, each a placeholder of its type. */
function skeleton(node: Json | null, root: Json, depth = 0): unknown {
  const type = typeOf(node);
  if (depth > 4) return type === "array" ? [] : type === "object" ? {} : "…";
  if (type === "array") return [skeleton(resolved(node!.items, root), root, depth + 1)];
  if (type === "object") {
    const properties = isObject(node!.properties) ? node!.properties : {};
    const required = Array.isArray(node!.required) ? node!.required.filter((key): key is string => typeof key === "string" && key in properties) : [];
    return Object.fromEntries(required.map((key) => [key, skeleton(resolved(properties[key], root), root, depth + 1)]));
  }
  if (type === "number" || type === "integer") return 0;
  if (type === "boolean") return false;
  return "…";
}

export function exampleCall(schema: unknown): string | null {
  const root = resolved(schema, isObject(schema) ? schema : {});
  if (!root || typeOf(root) !== "object") return null;
  const example = skeleton(root, root);
  return isObject(example) && Object.keys(example).length ? JSON.stringify(example) : null;
}

/** What a bot is told when a tool refused its arguments: how to call again, and that this says nothing about which apps
 * or tools there are. */
export function argumentRefusalNote(tool: string, schema: unknown, apps: readonly string[]): string {
  const example = schema === undefined ? null : exampleCall(schema);
  const again = example ? `Call it again with the arguments its schema names, for example ${example} with your own values. `
    : schema === undefined && !tool.startsWith("COMPOSIO_") ? "Read its arguments with COMPOSIO_GET_TOOL_SCHEMAS, then call it again with them. "
      : "Call it again with the arguments its schema names. ";
  return `OpenMausBot note: ${tool} did not run because its arguments did not fit its schema. ${again}` +
    "This was a mistake in the arguments only: it says nothing about which apps or tools exist, so do not tell the person a tool is missing" +
    (apps.length ? `. Connected apps you can use: ${apps.join(", ")}.` : ".");
}

/** What a bot is told when its arguments were fitted, so its next call uses the shape the tool asks for. */
export function fittedArgumentsNote(tool: string, changed: readonly string[]): string {
  return `OpenMausBot note: ${tool}'s arguments were read with ${changed.join(", ")}. Send them in that shape next time.`;
}
