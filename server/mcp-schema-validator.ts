import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import formats from "ajv-formats";

// A schema is a contract: no coercion, defaults, removed fields or fetched external references.
const validatorOptions = {
  strict: true, allErrors: false, coerceTypes: false, useDefaults: false,
  removeAdditional: false, validateFormats: true, ownProperties: true, logger: false as const,
  // Style diagnostics, not unsupported keywords: Ajv still enforces every constraint.
  strictRequired: false, strictTypes: false, strictTuples: false,
};

const SAFE_MIN = Number.MIN_SAFE_INTEGER;
const SAFE_MAX = Number.MAX_SAFE_INTEGER;
// schemars 1.x writes one of these formats for each Rust integer type (isize/usize are `int`/`uint`); its `float` and
// `double` come from ajv-formats, which takes any number, and JSON.parse never yields NaN or Infinity. These replace
// ajv-formats' int32/int64: its int64 takes any integer, but past the safe integer JSON.parse may already have rounded
// the value and cannot tell, so it is refused rather than sent on.
const INTEGER_FORMATS: ReadonlyArray<readonly [string, number, number]> = [
  ["int8", -128, 127],
  ["int16", -32768, 32767],
  ["int32", -2147483648, 2147483647],
  ["int64", SAFE_MIN, SAFE_MAX],
  ["int128", SAFE_MIN, SAFE_MAX],
  ["int", SAFE_MIN, SAFE_MAX],
  ["uint8", 0, 255],
  ["uint16", 0, 65535],
  ["uint32", 0, 4294967295],
  ["uint64", 0, SAFE_MAX],
  ["uint128", 0, SAFE_MAX],
  ["uint", 0, SAFE_MAX],
];

export function compileToolSchema(schema: Record<string, unknown>, options: { allErrors?: boolean; strict?: boolean } = {}): ValidateFunction {
  const dialect = schema.$schema;
  if (dialect !== undefined && dialect !== "http://json-schema.org/draft-07/schema#" && dialect !== "https://json-schema.org/draft/2020-12/schema") {
    throw new Error("MCP tool schema uses an unsupported dialect; use JSON Schema draft-07 or 2020-12");
  }
  // One compiler per schema keeps external IDs from resolving against unrelated tools.
  const settings = { ...validatorOptions, allErrors: options.allErrors === true, strict: options.strict !== false };
  const compiler = dialect === "https://json-schema.org/draft/2020-12/schema" ? new Ajv2020(settings) : new Ajv(settings);
  // ajv-formats is CommonJS and exports the plugin as both module.exports and .default.
  formats.default(compiler);
  // GitHub's MCP server tags header-routed arguments with this annotation; it adds no constraint to check.
  compiler.addKeyword({ keyword: "x-mcp-header", schemaType: "string" });
  // Google's remote MCP servers (Maps, Gmail, Drive) annotate enums with per-value descriptions; it adds no constraint to check.
  compiler.addKeyword({ keyword: "x-google-enum-descriptions", schemaType: "array" });
  for (const [format, min, max] of INTEGER_FORMATS) compiler.addFormat(format, { type: "number", validate: value => Number.isInteger(value) && value >= min && value <= max });
  try { return compiler.compile(schema); }
  catch { throw new Error("MCP tool schema could not be validated; check its constraints, formats, and references"); }
}

export function schemaProblems(errors: readonly ErrorObject[] | null | undefined, max = 8): string[] {
  const lines = (errors ?? []).map((error) => {
    const where = error.instancePath ? `${error.instancePath.slice(1).replace(/\//g, ".")}: ` : "";
    const params = error.params as Record<string, unknown>;
    const detail = error.keyword === "additionalProperties" ? ` (${String(params.additionalProperty)})`
      : error.keyword === "enum" ? `: ${JSON.stringify(params.allowedValues).slice(0, 200)}` : "";
    return `${where}${error.message ?? "is not valid"}${detail}`;
  });
  return [...new Set(lines)].slice(0, max);
}

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);

export const LENIENT_SCHEMA_CHARS = 64_000;
const SCHEMA_MAPS = ["properties", "$defs", "definitions", "dependentSchemas"];
const SCHEMA_LISTS = ["anyOf", "oneOf", "allOf", "prefixItems"];
const SCHEMA_ONE = ["items", "additionalItems", "additionalProperties", "not", "if", "then", "else", "contains", "propertyNames", "unevaluatedItems", "unevaluatedProperties"];

/** Drops what a checker in front of the server must never refuse on: `pattern`, `patternProperties` and `format` (ReDoS,
 * format disagreements), and `additionalProperties: false` beside patternProperties or combinators. */
export function lenientSchema(schema: unknown, depth = 0): unknown {
  if (Array.isArray(schema)) return schema.map((child) => lenientSchema(child, depth));
  if (!isRecord(schema) || depth > 64) return schema;
  const copy: Json = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "pattern" || key === "patternProperties" || key === "format") continue;
    if (SCHEMA_MAPS.includes(key) && isRecord(value)) copy[key] = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, lenientSchema(child, depth + 1)]));
    else if (SCHEMA_LISTS.includes(key) || SCHEMA_ONE.includes(key)) copy[key] = lenientSchema(value, depth + 1);
    else if (key === "dependencies" && isRecord(value)) copy[key] = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, Array.isArray(child) ? child : lenientSchema(child, depth + 1)]));
    else copy[key] = value;
  }
  const opened = "patternProperties" in schema || SCHEMA_LISTS.slice(0, 3).some((key) => key in schema);
  if (opened && copy.additionalProperties === false) delete copy.additionalProperties;
  return copy;
}

export function lenientToolValidator(schema: unknown): ValidateFunction | null {
  if (!isRecord(schema)) return null;
  try {
    if (JSON.stringify(schema).length > LENIENT_SCHEMA_CHARS) return null;
    return compileToolSchema(lenientSchema(schema) as Json, { allErrors: true, strict: false });
  } catch {
    return null;
  }
}
