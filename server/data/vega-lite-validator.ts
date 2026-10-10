// The escape hatch of PLAN D5: a bot may hand over raw Vega-Lite instead of
// the small chart spec. Three gates stand before it reaches a card. The JSON
// schema (ajv) catches the wrong shape; the data walk refuses inline rows
// and URLs, because rows always come from the card's SQL and bind as the
// dataset "table"; then one headless compile and parse catches what a
// schema cannot — a broken expression in a transform or an axis label —
// so it fails here with a message the bot can act on, not in the person's
// panel. VegaChat's validate-then-render loop, done once per spec.
import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import { None, logger, parse, View } from "vega";
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

/** The 1.8 MB schema compiles in about half a second, once per process.
 * Formats are skipped: "color-hex" and "uri-reference" guard looks, not
 * safety, and Vega accepts any CSS colour anyway. */
function schemaValidator(): ValidateFunction {
  validator ??= new Ajv({ allowUnionTypes: true, strict: false, allErrors: true, validateFormats: false, logger: false }).compile(vegaLiteSchema);
  return validator;
}

/** The schema's top level is an anyOf over unit, layer, facet, repeat and
 * concat specs, so a wrong value produces one complaint per branch, most of
 * them about the branch and not the mistake. The mistake is the deepest
 * path the validator reached; at equal depth an enum beats a type check
 * beats a constant, because the enum lists what would have been right. */
function firstProblem(errors: readonly ErrorObject[] | null | undefined): string {
  const rank: Record<string, number> = { enum: 0, type: 1, const: 2, required: 3, additionalProperties: 3 };
  const specific = (errors ?? []).filter((e) => e.keyword !== "anyOf" && e.keyword !== "oneOf" && e.keyword !== "if");
  const best = [...specific].sort((a, b) => b.instancePath.length - a.instancePath.length || (rank[a.keyword] ?? 9) - (rank[b.keyword] ?? 9))[0];
  return schemaProblems(best ? [best] : errors, 1)[0] ?? "is not a valid Vega-Lite spec";
}

const INLINE_DATA_KEYS = ["values", "url", "sequence", "graticule", "sphere"];

/** Every `data` in the tree must be `{name: "table"}`: layers, concat
 * children and `lookup` transforms included. `datasets` is inline by nature. */
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

/** Vega-Lite and Vega both log through this during the check; a warning
 * about a default is not a failure, and the test output stays clean. */
const silent = logger(None);

export const validateVegaLite: VegaLiteValidator = async (input) => {
  if (!isRecord(input)) fail("vegaLite must be an object");
  const spec: Json = structuredClone(input);
  spec.data ??= { name: "table" };
  spec.$schema ??= "https://vega.github.io/schema/vega-lite/v6.json";
  // A unit or layer spec fills the card; concat and facet size their children.
  if (("mark" in spec || "layer" in spec) && spec.width === undefined) spec.width = "container";

  refuseInlineData(spec, "");

  const validate = schemaValidator();
  if (!validate(spec)) fail(firstProblem(validate.errors));

  try {
    // The runtime check renders nothing: an empty "table" is enough to run
    // every transform, scale and expression once.
    const { spec: runtime } = compile(spec as unknown as TopLevelSpec, { logger: silent });
    const view = new View(parse(runtime), { renderer: "none" }).logger(silent);
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
