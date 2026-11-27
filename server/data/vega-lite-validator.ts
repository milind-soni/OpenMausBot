// Inline rows and URLs are refused: rows always come from the card's SQL and bind as the dataset "table".
import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import { None, logger, parse, View } from "vega";
import { expressionInterpreter } from "vega-interpreter";
import { compile, type TopLevelSpec } from "vega-lite";
import vegaLiteSchema from "vega-lite/vega-lite-schema.json" with { type: "json" };

import { schemaProblems } from "../mcp-schema-validator.ts";
import { DataFailure, type VegaLiteValidator } from "./types.ts";

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);

function fail(message: string, hint?: string): never {
  throw new DataFailure({ code: "spec_invalid", message, ...(hint ? { hint } : {}) });
}

let validator: ValidateFunction | undefined;

/** Formats are skipped: "color-hex" and "uri-reference" guard looks, not safety, and Vega accepts any CSS colour anyway. */
function schemaValidator(): ValidateFunction {
  validator ??= new Ajv({ allowUnionTypes: true, strict: false, allErrors: true, validateFormats: false, logger: false }).compile(vegaLiteSchema);
  return validator;
}

/** The top-level anyOf yields one complaint per branch: report the deepest path, preferring enum over type over const. */
function firstProblem(errors: readonly ErrorObject[] | null | undefined): string {
  const rank: Record<string, number> = { enum: 0, type: 1, const: 2, required: 3, additionalProperties: 3 };
  const specific = (errors ?? []).filter((e) => e.keyword !== "anyOf" && e.keyword !== "oneOf" && e.keyword !== "if");
  const best = [...specific].sort((a, b) => b.instancePath.length - a.instancePath.length || (rank[a.keyword] ?? 9) - (rank[b.keyword] ?? 9))[0];
  return schemaProblems(best ? [best] : errors, 1)[0] ?? "is not a valid Vega-Lite spec";
}

const INLINE_DATA_KEYS = ["values", "url", "sequence", "graticule", "sphere"];

/** Every `data` must be `{name: "table"}`, layers, concat children and `lookup` transforms included. */
function refuseInlineData(node: unknown, path: string): void {
  if (Array.isArray(node)) {
    node.forEach((item, i) => refuseInlineData(item, `${path}[${i}]`));
    return;
  }
  if (!isRecord(node)) return;
  for (const [key, value] of Object.entries(node)) {
    const here = path ? `${path}.${key}` : key;
    if (key === "datasets" && path === "") fail("datasets: inline data is not allowed; the rows come from the card's SQL", 'Remove datasets and read from data: {name: "table"}');
    if (key === "data" && (isRecord(value) || value === null)) {
      if (value === null || INLINE_DATA_KEYS.some((k) => k in value)) {
        fail(`${here}: inline data is not allowed; the rows come from the card's SQL`, 'Use data: {name: "table"}');
      }
      if (value.name !== "table") fail(`${here}: data must be {name: "table"}`, "The card's SQL result is bound as the dataset named table");
    }
    refuseInlineData(value, here);
  }
}

const silent = logger(None);

export const validateVegaLite: VegaLiteValidator = async (input) => {
  if (!isRecord(input)) fail("vegaLite must be an object");
  const spec: Json = structuredClone(input);
  spec.data ??= { name: "table" };
  spec.$schema ??= "https://vega.github.io/schema/vega-lite/v6.json";
  if (("mark" in spec || "layer" in spec) && spec.width === undefined) spec.width = "container";

  refuseInlineData(spec, "");

  const validate = schemaValidator();
  if (!validate(spec)) fail(firstProblem(validate.errors));

  try {
    const { spec: runtime } = compile(spec as unknown as TopLevelSpec, { logger: silent });
    const view = new View(parse(runtime, undefined, { ast: true }), { renderer: "none", expr: expressionInterpreter }).logger(silent);
    try {
      await view.runAsync();
    } finally {
      view.finalize();
    }
  } catch (error) {
    fail(`Vega-Lite spec does not compile: ${error instanceof Error ? error.message : String(error)}`);
  }
  return spec;
};
