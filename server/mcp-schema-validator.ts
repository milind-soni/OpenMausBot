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
  compiler.addFormat("uint32", { type: "number", validate: value => Number.isInteger(value) && value >= 0 && value <= 4294967295 });
  compiler.addFormat("uint64", { type: "number", validate: value => Number.isSafeInteger(value) && value >= 0 });
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
