import { describe, expect, it } from "vitest";

import { TOOL_LIST as BROWSER_TOOLS } from "./browser/tools.ts";
import { CLOUD_COMPUTER_TOOLS } from "./cloud-computer-tools.ts";
import { DATA_TOOLS } from "./data/tools.ts";
import bridgedAgents from "./drivers/agents-catalog-goldens/bridged.tools-list.json" with { type: "json" };
import fullAgents from "./drivers/agents-catalog-goldens/full.tools-list.json" with { type: "json" };
import { HIGHLEVEL_TOOLS } from "./highlevel/tools.ts";
import { createPageSchema, wideSchema } from "./testing/oversized-tool-schema.ts";
import { fitToolSchema, schemaBytes, toolSchemaProfile, toolSchemaProfileFor, type ToolSchemaProfile } from "./tool-schema-profile.ts";

type Json = Record<string, unknown>;
const MOONSHOT = toolSchemaProfile("moonshot")!;
const isObject = (value: unknown): value is Json => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** What Moonshot's validator (walle, MFJS) rejects in a fitted schema: an untyped subschema, a `required` name with no
 * property, or a reference left behind. */
function mfjsProblems(schema: Json): string[] {
  const problems: string[] = [];
  const visit = (node: unknown, path: string, root = false) => {
    if (!isObject(node)) return;
    if (!root && !("type" in node) && !("anyOf" in node)) problems.push(`${path}: no type`);
    if ("$ref" in node || "$defs" in node) problems.push(`${path}: reference`);
    if (Array.isArray(node.required) && node.required.some((key) => !isObject(node.properties) || !Object.hasOwn(node.properties, key as string))) {
      problems.push(`${path}: required names an undeclared property`);
    }
    if (isObject(node.properties)) for (const [key, child] of Object.entries(node.properties)) visit(child, `${path}.${key}`);
    if (isObject(node.items)) visit(node.items, `${path}[]`);
    if (Array.isArray(node.anyOf)) node.anyOf.forEach((branch, index) => visit(branch, `${path}|${index}`));
  };
  visit(schema, "root", true);
  return problems;
}

/** Every property path with its declared type, through items and alternatives. */
function typedPaths(schema: unknown, path = "", out = new Map<string, string>()): Map<string, string> {
  if (!isObject(schema)) return out;
  if (path && "type" in schema) out.set(path, JSON.stringify(schema.type));
  if (isObject(schema.properties)) for (const [key, child] of Object.entries(schema.properties)) typedPaths(child, `${path}.${key}`, out);
  if (isObject(schema.items)) typedPaths(schema.items, `${path}[]`, out);
  if (Array.isArray(schema.anyOf)) schema.anyOf.forEach((branch) => typedPaths(branch, path, out));
  return out;
}

function inlined(schema: Json): Json {
  const defs = isObject(schema.$defs) ? schema.$defs : {};
  const resolve = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(resolve);
    if (!isObject(node)) return node;
    if (typeof node.$ref === "string") return resolve(defs[node.$ref.replace("#/$defs/", "")]);
    return Object.fromEntries(Object.entries(node).filter(([key]) => key !== "$defs").map(([key, value]) => [key, resolve(value)]));
  };
  return resolve(schema) as Json;
}

describe("fitting a tool schema to Moonshot's per-tool limit", () => {
  it("measures as Go's encoding/json does, so <, > and & count six bytes each", () => {
    expect(schemaBytes({ a: "x" })).toBe(9);
    expect(schemaBytes({ a: "<&>" })).toBe(9 + 2 + 15);
    expect(schemaBytes({ a: "é" })).toBe(10);
  });

  it("leaves a schema within the limit exactly as the server sent it", () => {
    const schema = { type: "object", properties: { query: { type: "string", description: "What to find." } }, required: ["query"] };
    const fit = fitToolSchema(schema, MOONSHOT);
    expect(fit).toEqual({ outcome: "kept", schema, bytes: schemaBytes(schema) });
    expect(fit.outcome === "kept" && fit.schema).toBe(schema);
  });

  it("measures a schema with its refs inlined, as Kimi Code sends it", () => {
    const schema = createPageSchema();
    expect(schemaBytes(schema)).toBeLessThan(12_000);
    expect(schemaBytes(inlined(schema))).toBeGreaterThan(20_000);
    expect(fitToolSchema(schema, MOONSHOT).outcome).not.toBe("kept");
  });

  it("fits a realistic oversized schema under the limit and keeps its meaning", () => {
    const original = createPageSchema();
    const fit = fitToolSchema(original, MOONSHOT);
    if (fit.outcome === "kept" || fit.outcome === "dropped") throw new Error(`unexpected ${fit.outcome}`);
    expect(fit.outcome).toBe("loosened");
    expect(fit.bytes).toBeLessThanOrEqual(12_000);
    expect(schemaBytes(fit.schema)).toBe(fit.bytes);
    expect(mfjsProblems(fit.schema)).toEqual([]);
    expect(fit.schema.required).toEqual(["parent", "title"]);
    expect(Object.keys(fit.schema.properties as Json)).toEqual(["parent", "title", "icon", "children"]);
    const before = typedPaths(inlined(original));
    const after = typedPaths(fit.schema);
    expect(after.size).toBeGreaterThan(20);
    for (const [path, type] of after) expect([path, before.get(path)]).toEqual([path, type]);
    expect((fit.schema.properties as Json).parent).toMatchObject({ description: expect.stringContaining("Where the page goes") });
    expect(JSON.stringify(fit.schema)).not.toMatch(/"\$schema"|"title":"paragraph"/);
  });

  it("first only drops words: every field, type and constraint stays", () => {
    const schema = {
      type: "object",
      properties: Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`item_${index}`, {
        type: "object",
        description: `Item ${index}.`,
        properties: { amount: { type: "integer", minimum: 0, maximum: 500, description: "An amount in cents. ".repeat(40) }, unit: { type: "string", enum: ["usd", "eur"] } },
        required: ["amount"],
      }])),
      required: ["item_0"],
    };
    const fit = fitToolSchema(schema, MOONSHOT);
    expect(fit.outcome).toBe("trimmed");
    if (fit.outcome !== "trimmed") return;
    const withoutNestedWords = structuredClone(schema) as Json;
    for (const item of Object.values(withoutNestedWords.properties as Json)) delete ((item as Json).properties as { amount: Json }).amount.description;
    expect(fit.schema).toEqual(withoutNestedWords);
  });

  it("keeps only the top-level fields when nothing less fits, and leaves out a tool even those overflow", () => {
    const wide = fitToolSchema(wideSchema(110), MOONSHOT);
    expect(wide.outcome).toBe("minimal");
    if (wide.outcome !== "minimal") return;
    expect(wide.bytes).toBeLessThanOrEqual(12_000);
    expect(Object.keys(wide.schema.properties as Json)).toHaveLength(110);
    expect(wide.schema).toMatchObject({ type: "object", required: ["field_000"], additionalProperties: true });
    expect((wide.schema.properties as Json).field_007).toEqual({ type: "object", additionalProperties: true, description: "Settings group 7." });
    expect(mfjsProblems(wide.schema)).toEqual([]);

    const fit = fitToolSchema(wideSchema(400), MOONSHOT);
    expect(fit.outcome).toBe("dropped");
    expect(fit.bytes).toBeGreaterThan(12_000);
  });

  it("brings a schema deeper than the depth limit back within it", () => {
    let deep: Json = { type: "string" };
    for (let level = 0; level < 40; level += 1) deep = { type: "object", properties: { next: deep } };
    const fit = fitToolSchema(deep, MOONSHOT);
    expect(fit.outcome).toBe("loosened");
    let depth = 0;
    for (let node = fit.outcome === "loosened" ? fit.schema : {}; isObject(node.properties); node = (node.properties as Json).next as Json) depth += 1;
    expect(depth).toBeLessThanOrEqual(30);
  });

  it("keeps a cyclic reference it cannot inline, measured beside its definition", () => {
    const tree = { type: "object", $defs: { node: { type: "object", properties: { name: { type: "string" }, children: { type: "array", items: { $ref: "#/$defs/node" } } } } },
      properties: { root: { $ref: "#/$defs/node" } } };
    expect(fitToolSchema(tree, MOONSHOT).outcome).toBe("kept");
  });
});

describe("which turns carry a schema profile", () => {
  it("is Kimi Code's engine, Moonshot's own endpoint, or a Moonshot model on OpenRouter", () => {
    expect(toolSchemaProfileFor({ engine: "kimiAgent" })).toBe(MOONSHOT);
    expect(toolSchemaProfileFor({ url: "https://api.moonshot.ai/v1" })).toBe(MOONSHOT);
    expect(toolSchemaProfileFor({ url: "https://api.moonshot.cn/v1", model: "kimi-k2.6" })).toBe(MOONSHOT);
    expect(toolSchemaProfileFor({ url: "https://openrouter.ai/api/v1", model: "moonshotai/kimi-k2.6" })).toBe(MOONSHOT);
  });

  it("is no other engine or endpoint, so their tool lists are unchanged", () => {
    for (const engine of ["claudeAgent", "codex", "geminiAgent", "grokAgent", "opencodeGo", "qwenAgent", "cursorAgent", "hermesAgent"]) {
      expect(toolSchemaProfileFor({ engine, model: "kimi-k2.6" })).toBeUndefined();
    }
    expect(toolSchemaProfileFor({ url: "https://api.groq.com/openai/v1", model: "moonshotai/kimi-k2-instruct-0905" })).toBeUndefined();
    expect(toolSchemaProfileFor({ url: "https://openrouter.ai/api/v1", model: "openai/gpt-5" })).toBeUndefined();
    expect(toolSchemaProfileFor({ url: "https://moonshot.ai.example.com/v1" })).toBeUndefined();
    expect(toolSchemaProfileFor({ url: "not a url" })).toBeUndefined();
    expect(toolSchemaProfile("__proto__")).toBeUndefined();
  });
});

describe("OpenMausBot's own tools", () => {
  const catalogs: Array<[string, ReadonlyArray<{ name: string; inputSchema: unknown }>]> = [
    ["agents (full)", fullAgents.tools], ["agents (bridged)", bridgedAgents.tools], ["browser", BROWSER_TOOLS],
    ["data", DATA_TOOLS], ["highlevel", HIGHLEVEL_TOOLS], ["cloud computer", CLOUD_COMPUTER_TOOLS],
  ];

  it.each(catalogs)("fit every profile as written: %s", (_name, tools) => {
    const profiles: ToolSchemaProfile[] = [MOONSHOT];
    for (const profile of profiles) {
      for (const tool of tools) expect([tool.name, fitToolSchema(tool.inputSchema as Json, profile).outcome]).toEqual([tool.name, "kept"]);
    }
  });
});
