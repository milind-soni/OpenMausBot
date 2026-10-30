import { describe, expect, it } from "vitest";

import { WATCHER_OPTIONS_CARD_BOT_ID } from "../../shared/options-card.ts";
import { callTool, type ToolCallContext } from "./agents-call.ts";
import { availableTools, catalogProfileFromEnv, fullInputSchema } from "./agents-catalog.ts";
import type { Json } from "./agents-client.ts";
import { advertisedSchema, ENFORCED_KEYWORDS, outOfBounds } from "./agents-schema.ts";

const record = (value: unknown): value is Json => value !== null && typeof value === "object" && !Array.isArray(value);

/** Every switch on: each tool the catalog can list, in the form tools/list sends it. */
const LISTED = availableTools(catalogProfileFromEnv({
  OMB_BOT_ID: WATCHER_OPTIONS_CARD_BOT_ID, OMB_CHIEF_OF_STAFF: "1", OMB_SKILL_AUTHORING_ENABLED: "1", OMB_SHARED_COMPUTERS_ENABLED: "1",
  OMB_VOICE_NOTES: "1", OMB_X_RESEARCH: "1", OMB_ESCALATIONS: "1", OMB_TEAM_PEOPLE: "1", OMB_MAUSBOT: "1",
}));

/** Each keyword the advertised node lacks, with where it sat in the full one. */
function omitted(full: unknown, listed: unknown, path: string, out: Array<{ path: string; keyword: string; value: unknown }>) {
  if (!record(full)) return out;
  for (const [key, value] of Object.entries(full)) {
    if (!record(listed) || !Object.hasOwn(listed, key)) out.push({ path, keyword: key, value });
    else if (key === "properties" && record(value)) {
      for (const [name, child] of Object.entries(value)) omitted(child, (listed.properties as Json)[name], `${path}.${name}`, out);
    } else if ((key === "items" || key === "additionalProperties") && record(value)) omitted(value, listed[key], `${path}${key === "items" ? "[]" : "{}"}`, out);
    else expect(JSON.stringify(listed[key]), `${path} ${key}`).toBe(JSON.stringify(value));
  }
  return out;
}

type Bound = { path: string[]; keyword: string; value: unknown; node: Json };

function bounds(node: unknown, path: string[] = [], out: Bound[] = []): Bound[] {
  if (!record(node)) return out;
  for (const keyword of ENFORCED_KEYWORDS) if (keyword in node) out.push({ path, keyword, value: node[keyword], node });
  if (record(node.properties)) for (const [name, child] of Object.entries(node.properties)) bounds(child, [...path, name], out);
  if (record(node.items)) bounds(node.items, [...path, "[]"], out);
  if (record(node.additionalProperties)) bounds(node.additionalProperties, [...path, "{}"], out);
  return out;
}

function sampleItem(node: Json, index: number): unknown {
  const items = record(node.items) ? node.items : {};
  return items.type === "object" ? { n: index } : items.type === "integer" || items.type === "number" ? index : `item-${index}`;
}

/** A value that breaks exactly this bound. */
function breaking({ keyword, value, node }: Bound): unknown {
  const n = Number(value);
  if (keyword === "minLength") return "a".repeat(n - 1);
  if (keyword === "maxLength") return "a".repeat(n + 1);
  if (keyword === "minimum") return n - 1;
  if (keyword === "maximum") return n + 1;
  if (keyword === "minItems") return Array.from({ length: n - 1 }, (_, index) => sampleItem(node, index));
  if (keyword === "maxItems") return Array.from({ length: n + 1 }, (_, index) => sampleItem(node, index));
  if (keyword === "uniqueItems") return [sampleItem(node, 0), sampleItem(node, 0)];
  return "!";
}

/** Arguments that reach the bound's node along its path, with the breaking value there. */
function argumentsBreaking(bound: Bound): Json {
  const leaf = breaking(bound);
  const build = (path: string[]): unknown => {
    if (!path.length) return leaf;
    const [head, ...rest] = path;
    if (head === "[]") return [build(rest)];
    if (head === "{}") return { KEY: build(rest) };
    return { [head!]: build(rest) };
  };
  return build(bound.path) as Json;
}

function recordingContext(): { context: ToolCallContext; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    context: {
      botId: "bot-schema", threadId: "thread-schema", depth: 0, externalRuntime: false, sharedComputers: true,
      client: {
        api: async (path) => { calls.push(path); return {}; },
        apiResponse: async (path) => { calls.push(path); return { ok: true, status: 200, body: {} }; },
      },
    },
  };
}

describe("the advertised agents tool schemas", () => {
  it("leave out only bounds every call is held to", () => {
    const left = LISTED.flatMap((tool) => omitted(fullInputSchema(tool.name), tool.inputSchema, tool.name, []));
    expect(left.length).toBeGreaterThan(0);
    for (const { path, keyword, value } of left) {
      expect((ENFORCED_KEYWORDS as readonly string[]).includes(keyword), `${path} ${keyword} ${JSON.stringify(value)}`).toBe(true);
    }
  });

  it("keep a bound the model needs and drop one it reads from the words or never comes near", () => {
    const coordinate = LISTED.find((tool) => tool.name === "coordinate_bots")!.inputSchema.properties as Record<string, Json>;
    expect(coordinate.title).toMatchObject({ maxLength: 80 });
    expect(coordinate.bot_ids).not.toHaveProperty("maxItems");
    expect(coordinate.bot_ids).not.toHaveProperty("minItems");
    expect(coordinate.bot_ids).not.toHaveProperty("uniqueItems");
    expect(coordinate.message).not.toHaveProperty("maxLength");
    expect(fullInputSchema("coordinate_bots")).toMatchObject({ properties: { bot_ids: { minItems: 1, maxItems: 4, uniqueItems: true }, message: { maxLength: 4000 } } });
    const schema = { type: "object", additionalProperties: false, properties: {
      every_minutes: { type: "integer", minimum: 5, maximum: 1_440, description: "Whole minutes, from 5 to 1440." },
      limit: { type: "integer", minimum: 1, maximum: 25 },
      code: { type: "string", pattern: "^\\d+$", minLength: 2 },
      free: { type: "object", additionalProperties: true },
    } };
    expect(advertisedSchema(schema, "A tool.")).toEqual({ type: "object", additionalProperties: false, properties: {
      every_minutes: { type: "integer", description: "Whole minutes, from 5 to 1440." },
      limit: { type: "integer", maximum: 25 },
      code: { type: "string", pattern: "^\\d+$", minLength: 2 },
      free: { type: "object", additionalProperties: true },
    } });
  });
});

describe("every agents call is held to its full schema", () => {
  const cases = LISTED.flatMap((tool) => bounds(fullInputSchema(tool.name)).map((bound) => [`${tool.name} ${bound.path.join(".")} ${bound.keyword}`, tool.name, bound] as const));

  it("covers every bound of every listed tool", () => {
    expect(cases.length).toBeGreaterThan(80);
  });

  it.each(cases)("%s: refused before anything runs", async (_label, tool, bound) => {
    const { context, calls } = recordingContext();
    const result = await callTool(tool, argumentsBreaking(bound), context);
    expect(result.isError).toBe(true);
    expect(result.text).toContain(`${tool} was not run:`);
    expect(result.text).toContain(bound.path.filter((part) => part !== "[]" && part !== "{}").at(-1) ?? "arguments");
    expect(calls).toEqual([]);
  });

  it("reads a null as a field left out, and names every problem up to four", () => {
    const schema = fullInputSchema("coordinate_bots");
    expect(outOfBounds("coordinate_bots", schema, { bot_ids: ["a"], message: "hi", title: null, reason: null })).toBeUndefined();
    const refused = outOfBounds("coordinate_bots", schema, {
      bot_ids: ["a", "a", "b", "c", "d"], message: "m".repeat(4_001), title: "t".repeat(81), reason: "r".repeat(201), done_when: "d".repeat(1_001),
    })!;
    expect(refused).toContain("bot_ids takes at most 4 items (it has 5)");
    expect(refused).toContain("bot_ids must not repeat an item");
    expect(refused).toContain("message takes at most 4000 characters (it has 4001)");
    expect(refused).toContain("and 2 more");
  });
});
