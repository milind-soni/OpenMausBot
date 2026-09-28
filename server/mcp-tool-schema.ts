// Provider-safe MCP tool input schemas.
//
// Every engine hands an MCP tool's inputSchema to its model provider as the
// function's parameters. The strict providers (OpenAI, xAI, Bedrock, Kimi…)
// require that root to be a plain `type: "object"` and refuse a root
// anyOf/oneOf/allOf/not outright — and a refused schema fails the whole turn,
// not just the one tool. The bundled cua-driver 0.22.1 ships exactly that
// shape on browser_prepare, which is what broke "This computer" for OpenCode
// once Windows started mounting the desktop in v0.1.83.
//
// The rewrite only relaxes what the model is TOLD. The MCP server still
// validates every call against its own schema — upstream cua-driver made the
// same move (#3311): a plain object root, with the conditional rules enforced
// in the tool itself. Nested schemas are left exactly as written.
type JsonObject = Record<string, unknown>;

const ROOT_COMBINATORS = ["anyOf", "oneOf", "allOf", "not"] as const;

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function branches(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

/** The object shape a schema implies, gathered through its combinators.
 * Its own declarations win over a branch's narrower copy; a property that
 * only a branch declares is kept so the model still knows it exists. A name
 * is required when the schema or an allOf branch requires it, or when every
 * anyOf/oneOf choice does — a requirement of only one choice is not. */
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

/** A strict-provider-safe version of an MCP tool's inputSchema. A schema
 * that is already safe is returned as the same object, so callers can tell
 * whether anything changed. The input is never mutated. */
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

/** Rewrites tools/list responses on an MCP stdio stream. Only a response to
 * a tools/list the agent actually sent is touched; every other line — tool
 * results, notifications, errors, non-JSON — passes through byte-for-byte. */
export function createToolListNormalizer(): {
  /** Record an agent → server line. */
  observeRequest: (line: string) => void;
  /** Map a server → agent line to what the agent should receive. */
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

      let changed = false;
      const tools = frame.result.tools.map((tool: unknown) => {
        if (!isObject(tool)) return tool;
        const inputSchema = providerSafeInputSchema(tool.inputSchema);
        if (inputSchema === tool.inputSchema) return tool;
        changed = true;
        return { ...tool, inputSchema };
      });
      return changed ? JSON.stringify({ ...frame, result: { ...frame.result, tools } }) : line;
    },
  };
}
