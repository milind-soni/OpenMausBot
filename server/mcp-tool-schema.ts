// Strict providers (OpenAI, xAI, Bedrock, Kimi…) refuse a tool schema whose root is not a plain `type: "object"`, failing
// the whole turn; cua-driver 0.22.1 ships such a root on browser_prepare. Servers still validate calls against their own.
import { fitToolSchema, type ToolSchemaProfile } from "./tool-schema-profile.ts";

type JsonObject = Record<string, unknown>;

const ROOT_COMBINATORS = ["anyOf", "oneOf", "allOf", "not"] as const;

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function branches(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

function objectShape(schema: JsonObject): { properties: JsonObject; required: string[] } {
  const properties: JsonObject = isObject(schema.properties) ? { ...schema.properties } : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((key) => typeof key === "string") : []);

  const adopt = (shape: { properties: JsonObject }) => {
    for (const [key, value] of Object.entries(shape.properties)) if (!(key in properties)) properties[key] = value;
  };

  for (const branch of branches(schema.allOf)) {
    const shape = objectShape(branch);
    adopt(shape);
    for (const key of shape.required) required.add(key);
  }
  for (const keyword of ["anyOf", "oneOf"] as const) {
    const choices = branches(schema[keyword]).map(objectShape);
    if (choices.length === 0) continue;
    for (const choice of choices) adopt(choice);
    for (const key of choices[0].required) {
      if (choices.every((choice) => choice.required.includes(key))) required.add(key);
    }
  }
  return { properties, required: [...required] };
}

function describesObject(type: unknown): boolean {
  return type === undefined || type === "object" || (Array.isArray(type) && type.includes("object"));
}

export function providerSafeInputSchema(schema: unknown): JsonObject {
  if (!isObject(schema) || !describesObject(schema.type)) return { type: "object", properties: {} };
  if (schema.type === "object" && ROOT_COMBINATORS.every((keyword) => !(keyword in schema))) return schema;

  const { properties, required } = objectShape(schema);
  const safe: JsonObject = { ...schema, type: "object", properties };
  for (const keyword of ROOT_COMBINATORS) delete safe[keyword];
  if (required.length > 0) safe.required = required;
  else delete safe.required;
  return safe;
}

function toolName(tool: JsonObject): string {
  return typeof tool.name === "string" && tool.name ? tool.name : "unnamed";
}

/** The note a shortened tool carries, so the model fills in what its schema no longer spells out. */
export function shortenedToolNote(provider: string): string {
  return `(OpenMausBot shortened this tool's parameters to fit ${provider}'s size limit for one tool: give any field it no longer lists `
    + "as this description says. The tool still checks every call against its full schema.)";
}

/** A tool list under a provider's profile: each schema keeps a plain object root and fits, or the tool is left out.
 * Every change is one line to `log`; a tool already within the limits is the same object. */
export function fitToolList(tools: readonly unknown[], profile: ToolSchemaProfile, log: (line: string) => void = () => {}): unknown[] {
  const fitted: unknown[] = [];
  for (const tool of tools) {
    if (!isObject(tool)) {
      fitted.push(tool);
      continue;
    }
    const rooted = providerSafeInputSchema(tool.inputSchema);
    const fit = fitToolSchema(rooted, profile);
    const name = toolName(tool);
    const limit = `${profile.provider}'s ${profile.maxSchemaBytes}-byte limit for one tool`;
    if (fit.outcome === "dropped") {
      log(`left out tool "${name}": its parameters are ${fit.from} bytes and still ${fit.bytes} at their shortest, over ${limit}`);
      continue;
    }
    if (fit.outcome === "kept") {
      fitted.push(fit.schema === tool.inputSchema ? tool : { ...tool, inputSchema: fit.schema });
      continue;
    }
    const what = { trimmed: "shortened the descriptions in", loosened: "left nested fields out of", minimal: "kept only the top-level fields of" }[fit.outcome];
    log(`${what} tool "${name}"'s parameters (${fit.from} to ${fit.bytes} bytes) to fit ${limit}`);
    if (fit.outcome === "trimmed") {
      fitted.push({ ...tool, inputSchema: fit.schema });
      continue;
    }
    const description = typeof tool.description === "string" && tool.description.trim() ? `${tool.description.trimEnd()}\n\n` : "";
    fitted.push({ ...tool, description: description + shortenedToolNote(profile.provider), inputSchema: fit.schema });
  }
  return fitted;
}

/** A `tools/list` result with its tools fitted to `profile`; anything else as it came. */
export function fitToolListResult(result: unknown, profile: ToolSchemaProfile | undefined, log?: (line: string) => void): unknown {
  if (!profile || !isObject(result) || !Array.isArray(result.tools)) return result;
  return { ...result, tools: fitToolList(result.tools, profile, log) };
}

/** Every listed schema gets a plain object root; under a profile each is also fitted to it. */
export function createToolListNormalizer(profile?: ToolSchemaProfile, log?: (line: string) => void): {
  observeRequest: (line: string) => void;
  rewriteResponse: (line: string) => string;
} {
  // JSON-RPC ids may be numbers or strings, and 7 is not "7".
  const pending = new Set<string>();
  const idKey = (id: unknown) => `${typeof id}:${String(id)}`;

  return {
    observeRequest(line) {
      let frame: unknown;
      try {
        frame = JSON.parse(line);
      } catch {
        return;
      }
      if (isObject(frame) && frame.method === "tools/list" && (typeof frame.id === "number" || typeof frame.id === "string")) {
        pending.add(idKey(frame.id));
      }
    },
    rewriteResponse(line) {
      if (pending.size === 0) return line;
      let frame: unknown;
      try {
        frame = JSON.parse(line);
      } catch {
        return line;
      }
      if (!isObject(frame) || "method" in frame || !pending.delete(idKey(frame.id))) return line;
      if (!isObject(frame.result) || !Array.isArray(frame.result.tools)) return line;

      const listed: unknown[] = frame.result.tools;
      const tools = profile ? fitToolList(listed, profile, log) : listed.map((tool: unknown) => {
        if (!isObject(tool)) return tool;
        const inputSchema = providerSafeInputSchema(tool.inputSchema);
        return inputSchema === tool.inputSchema ? tool : { ...tool, inputSchema };
      });
      const changed = tools.length !== listed.length || tools.some((tool, index) => tool !== listed[index]);
      return changed ? JSON.stringify({ ...frame, result: { ...frame.result, tools } }) : line;
    },
  };
}
