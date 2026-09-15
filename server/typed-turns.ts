// Typed turns (docs/plans/2026-09-14-phase-0-foundation.md, item 0.3).
//
// A harness that reads a model's decision out of prose is guessing. This is
// the engine-agnostic baseline that makes a turn's answer a validated
// object instead: the harness appends ONE fixed instruction to the turn
// text, takes the last fenced JSON block out of the reply, and checks it
// against the schema here, in code. It is the same path for Claude, Codex,
// pi, the ACP family, the HTTP family and the box agent, which is what
// keeps the platform model-agnostic. Native constrained decoding (Claude
// `--json-schema`, OpenAI `response_format`) is only ever an accelerator: a
// driver may pass its object in as `native`, and it is validated exactly
// like a fenced block. Nothing here reports `structured` from anything but
// validated JSON; a missing or invalid object is an error string, so the
// caller treats the turn as "not done" rather than acting on a guess.

/** A JSON Schema object. The validator below covers the subset the harness
 * itself writes (types, enum/const, properties/required/additionalProperties,
 * items, string/number/array bounds, anyOf/oneOf); it is not a full
 * implementation and is not meant to validate arbitrary user schemas. */
export type OutputSchema = Record<string, unknown>;

export interface StructuredResult {
  structured?: unknown;
  structuredError?: string;
}

/** The instruction appended to a schema-bearing turn. It names the schema
 * inline and deliberately opens no code fence of its own, so an engine that
 * echoes its prompt cannot manufacture a second block. */
export function structuredInstruction(schema: OutputSchema): string {
  return [
    "Reply with exactly one Markdown code block, fenced with three backticks and tagged json, whose content is a single JSON object matching this JSON Schema. Put nothing after the block.",
    `Schema: ${JSON.stringify(schema)}`,
  ].join("\n");
}

export function withStructuredInstruction(text: string, schema: OutputSchema): string {
  return `${text}\n\n${structuredInstruction(schema)}`;
}

// A fence must be followed by a line break: "tagged json" in prose is not a fence.
const FENCE = /```[ \t]*(?:json|JSON)?[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/g;

function lastFencedBlock(text: string): { body: string; start: number; end: number } | null {
  let last: { body: string; start: number; end: number } | null = null;
  for (const match of text.matchAll(FENCE)) {
    last = { body: match[1]!, start: match.index!, end: match.index! + match[0].length };
  }
  return last;
}

export function extractStructuredCandidate(text: string): { value: unknown } | { error: string } {
  const block = lastFencedBlock(text);
  const raw = block ? block.body.trim() : text.trim();
  if (!block && !(raw.startsWith("{") || raw.startsWith("["))) return { error: "no fenced JSON block in the reply" };
  try {
    return { value: JSON.parse(raw) };
  } catch (error) {
    return { error: `the JSON block does not parse: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** The reply without its last fenced JSON block: what a person should see. */
export function stripStructuredBlock(text: string): string {
  const block = lastFencedBlock(text);
  if (!block) return text.trim();
  return `${text.slice(0, block.start)}${text.slice(block.end)}`.trim();
}

const typeOf = (value: unknown): string =>
  value === null ? "null" : Array.isArray(value) ? "array" : typeof value;

function matchesType(value: unknown, type: string): boolean {
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  return typeOf(value) === type;
}

export function validateStructured(schema: OutputSchema, value: unknown, path = "$"): string[] {
  const errors: string[] = [];
  const types = typeof schema.type === "string" ? [schema.type] : Array.isArray(schema.type) ? (schema.type as string[]) : [];
  if (types.length && !types.some((type) => matchesType(value, type))) {
    errors.push(`${path}: expected ${types.join(" or ")}`);
    return errors;
  }
  if ("const" in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) {
    errors.push(`${path}: expected ${JSON.stringify(schema.const)}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => JSON.stringify(option) === JSON.stringify(value))) {
    errors.push(`${path}: expected one of ${schema.enum.map((option) => JSON.stringify(option)).join(", ")}`);
  }
  for (const key of ["anyOf", "oneOf"] as const) {
    const options = schema[key];
    if (!Array.isArray(options)) continue;
    const matching = options.filter((option) => validateStructured(option as OutputSchema, value, path).length === 0).length;
    if (matching === 0 || (key === "oneOf" && matching !== 1)) errors.push(`${path}: matches none of the allowed shapes`);
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) errors.push(`${path}: expected at least ${schema.minLength} characters`);
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) errors.push(`${path}: expected at most ${schema.maxLength} characters`);
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) errors.push(`${path}: expected at least ${schema.minimum}`);
    if (typeof schema.maximum === "number" && value > schema.maximum) errors.push(`${path}: expected at most ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) errors.push(`${path}: expected at least ${schema.minItems} item${schema.minItems === 1 ? "" : "s"}`);
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) errors.push(`${path}: expected at most ${schema.maxItems} item${schema.maxItems === 1 ? "" : "s"}`);
    if (schema.items && typeof schema.items === "object") {
      value.forEach((item, index) => errors.push(...validateStructured(schema.items as OutputSchema, item, `${path}[${index}]`)));
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const properties = (schema.properties && typeof schema.properties === "object" ? schema.properties : {}) as Record<string, OutputSchema>;
    for (const key of Array.isArray(schema.required) ? (schema.required as string[]) : []) {
      if (!(key in record)) errors.push(`${path}: missing required property ${key}`);
    }
    for (const [key, item] of Object.entries(record)) {
      const property = properties[key];
      if (property) errors.push(...validateStructured(property, item, `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}: unexpected property ${key}`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        errors.push(...validateStructured(schema.additionalProperties as OutputSchema, item, `${path}.${key}`));
      }
    }
  }
  return errors;
}

/** The one entry point the harness uses at turn end: a driver's native
 * object first (validated, never trusted), then the reply text. */
export function resolveStructured(args: { schema: OutputSchema; text: string; native?: unknown }): StructuredResult {
  if (args.native !== undefined && validateStructured(args.schema, args.native).length === 0) {
    return { structured: args.native };
  }
  const candidate = extractStructuredCandidate(args.text);
  if ("error" in candidate) return { structuredError: candidate.error };
  const errors = validateStructured(args.schema, candidate.value);
  if (errors.length) return { structuredError: `invalid: ${errors.join("; ")}` };
  return { structured: candidate.value };
}
