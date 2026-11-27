import { describe, expect, it } from "vitest";

import fullAgents from "./drivers/agents-catalog-goldens/full.tools-list.json" with { type: "json" };
import { compactAdvertisedSchema } from "./advertised-schema.ts";
import { cliDrops } from "./testing/cli-tool-drop.ts";
import {
  ANTIGRAVITY_CLI_TOOL_BUDGET, ANTIGRAVITY_CLI_TOOL_LIMIT, COORDINATION_TOOLS, cutText, definitionBytes, fitToolListWithinShare, toolKeepRank, toolListLimit,
  withCompactSchemas, withDescriptionLevel, definitionListBytes, fitToolListToShare, PROTECTED_TOOLS, TOOL_DESCRIPTION_FLOOR, TOOL_DESCRIPTION_MIN, toolListShare, toolListShareProfile,
  toolsForShareProfile, toolsListResultForShareProfile, type ListedTool,
} from "./tool-list-budget.ts";

type Json = Record<string, unknown>;
const agents = fullAgents.tools as ListedTool[];
const names = (tools: readonly ListedTool[]) => tools.map((tool) => tool.name);

/** Every description in a schema, and the schema with none of them. */
function descriptions(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(descriptions);
  if (!node || typeof node !== "object") return [];
  return Object.entries(node).flatMap(([key, value]) => (key === "description" && typeof value === "string" ? [value] : descriptions(value)));
}
function withoutDescriptions(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(withoutDescriptions);
  if (!node || typeof node !== "object") return node;
  return Object.fromEntries(Object.entries(node).filter(([key, value]) => !(key === "description" && typeof value === "string")).map(([key, value]) => [key, withoutDescriptions(value)]));
}

describe("a tool's size as the CLI counts it", () => {
  it("is its definition file: name, description and parameters, compact, with <, > and & as six-byte escapes", () => {
    expect(definitionBytes({ name: "a", description: "x", inputSchema: { type: "object" } })).toBe(JSON.stringify({ name: "a", description: "x", parameters: { type: "object" } }).length);
    expect(definitionBytes({ name: "a", description: "<&>" })).toBe(JSON.stringify({ name: "a", description: "<&>", parameters: { type: "object" } }).length + 15);
    expect(definitionListBytes([{ name: "a" }, { name: "b" }])).toBe(2 * definitionBytes({ name: "a" }));
  });

  it("rides OMB_TOOL_SCHEMA_PROFILE as a share; any other profile is not one", () => {
    expect(toolListShare(toolListShareProfile(12_345.9))).toBe(12_345);
    for (const other of [undefined, "", "moonshot", "gemini", "listShare:", "listShare:-1", "listShare:1e3", "listShare:12345678901"]) expect(toolListShare(other)).toBeUndefined();
  });
});

describe("cutting a description", () => {
  const text = "First sentence here. Second one is longer, with more words. Third.";

  it("keeps whole sentences when one fits, else words with an ellipsis, and nothing at all at zero", () => {
    expect(cutText(text, 1_000)).toBe(text);
    expect(cutText(text, 25)).toBe("First sentence here.");
    expect(cutText(text, 14)).toBe("First…");
    expect(cutText(text, 0)).toBeUndefined();
  });

  it("never keeps less as the limit grows", () => {
    let previous = 0;
    for (let max = 0; max <= text.length; max += 1) {
      const kept = cutText(text, max)?.length ?? 0;
      expect(kept).toBeLessThanOrEqual(Math.max(max, 0));
      expect(kept).toBeGreaterThanOrEqual(previous - 1);
      previous = Math.max(previous, kept);
    }
  });
});

describe("fitting a list into its share", () => {
  const from = fitToolListToShare(agents, Number.MAX_SAFE_INTEGER).bytes;

  it("leaves a list that fits as compacted, every description whole", () => {
    const fitted = fitToolListToShare(agents, from);
    expect(fitted).toMatchObject({ fits: true, bytes: from, level: { parameters: Infinity, tools: Infinity } });
    expect(fitted.tools.map((tool) => tool.description)).toEqual(agents.map((tool) => tool.description));
  });

  it("shortens parameter descriptions before any tool description", () => {
    const fitted = fitToolListToShare(agents, from - 2_000);
    expect(fitted.fits).toBe(true);
    expect(fitted.bytes).toBeLessThanOrEqual(from - 2_000);
    expect(fitted.level.tools).toBe(Infinity);
    expect(fitted.level.parameters).toBeLessThan(Infinity);
    expect(fitted.tools.map((tool) => tool.description)).toEqual(agents.map((tool) => tool.description));
  });

  it("then shortens tool descriptions, longest first, never below the floor, and keeps every tool, field, type, enum and required field", () => {
    const share = 40_000;
    const fitted = fitToolListToShare(agents, share);
    expect(fitted.fits).toBe(true);
    expect(fitted.bytes).toBeLessThanOrEqual(share);
    expect(fitted.level.parameters).toBe(0);
    expect(fitted.level.tools).toBeGreaterThanOrEqual(TOOL_DESCRIPTION_FLOOR);
    expect(names(fitted.tools)).toEqual(names(agents));
    fitted.tools.forEach((tool, index) => {
      const original = agents[index]!;
      expect(withoutDescriptions(tool.inputSchema)).toEqual(withoutDescriptions(compactAdvertisedSchema(original.inputSchema as Json)));
      expect(descriptions(tool.inputSchema)).toEqual([]);
      expect(original.description!.startsWith((tool.description ?? "").replace(/…$/, ""))).toBe(true);
      if (original.description!.length <= fitted.level.tools) expect(tool.description).toBe(original.description);
    });
  });

  it("over its share even at its shortest, keeps every tool and shrinks the protected ones, so the CLI's largest-first drop takes others first", () => {
    const fitted = fitToolListToShare(agents, 14_000);
    expect(fitted.fits).toBe(false);
    expect(names(fitted.tools)).toEqual(names(agents));
    const shortest = withDescriptionLevel(withCompactSchemas(agents), { parameters: 0, tools: TOOL_DESCRIPTION_MIN, annotations: true });
    // Past the largest unprotected tool, trigger (23 named fields) is next: shrinking cannot take it lower without hiding fields.
    const overBy = 1_000;
    expect(cliDrops(shortest, definitionListBytes(shortest) - overBy).filter((name) => PROTECTED_TOOLS.includes(name))).not.toEqual([]);
    const dropped = cliDrops(fitted.tools, fitted.bytes - overBy);
    expect(dropped.length).toBeGreaterThan(0);
    expect(dropped.filter((name) => PROTECTED_TOOLS.includes(name))).toEqual([]);
    // Each protected tool still names every top-level field it takes, its type and choices, and what it requires.
    for (const name of PROTECTED_TOOLS) {
      const shown = fitted.tools.find((tool) => tool.name === name)!.inputSchema as Json;
      const original = agents.find((tool) => tool.name === name)!.inputSchema as Json;
      expect(Object.keys(shown.properties as Json)).toEqual(Object.keys(original.properties as Json));
      for (const [field, schema] of Object.entries(shown.properties as Json)) {
        const before = (original.properties as Record<string, Json>)[field]!;
        expect((schema as Json).type).toEqual(before.type);
        expect((schema as Json).enum).toEqual(before.enum);
      }
      expect(shown.required).toEqual(original.required);
    }
  });

  it("does nothing without a share, under another engine's profile, or to anything that is not a tool list", () => {
    expect(toolsForShareProfile(agents, undefined)).toBe(agents);
    expect(toolsForShareProfile(agents, "moonshot")).toBe(agents);
    const result = { tools: agents };
    expect(toolsListResultForShareProfile(result, "gemini")).toBe(result);
    expect(toolsListResultForShareProfile({ error: "x" }, toolListShareProfile(1))).toEqual({ error: "x" });
    const logged: string[] = [];
    const fitted = toolsListResultForShareProfile(result, toolListShareProfile(14_000), (line) => logged.push(line)) as { tools: ListedTool[] };
    expect(names(fitted.tools)).toEqual(names(fitToolListWithinShare(agents, 14_000).tools));
    expect(logged).toEqual([expect.stringMatching(/^tool list is over its 14000-byte share of the session's tool budget even at its shortest: left out \d+ tool\(s\) so the engine does not choose, \w+/)]);
    // The same list under the same share again, as every request of a turn builds it: the fitted list reused, no second line.
    expect(toolsForShareProfile(structuredClone(agents), toolListShareProfile(14_000), (line) => logged.push(line))).toBe(fitted.tools);
    expect(logged).toHaveLength(1);
  });

  it("at its deepest cut keeps a list of objects an array of objects, and leaves a field with no type of its own as it was", () => {
    const tool: ListedTool = {
      name: "plain_tool", description: "Does one thing. ".repeat(20),
      inputSchema: { type: "object", required: ["rows"], properties: {
        rows: { type: "array", description: "d".repeat(200), items: { type: "object", properties: { a: { type: "string" }, b: { type: "number" } } } },
        target: { type: "object", properties: { id: { type: "string" } } },
        either: { anyOf: [{ type: "string" }, { type: "object", properties: { id: { type: "string" } } }] },
        mode: { type: "string", enum: ["a", "b"] },
      } },
    };
    const fitted = fitToolListToShare([tool], definitionBytes(withDescriptionLevel([tool], { parameters: 0, tools: TOOL_DESCRIPTION_MIN, annotations: true })[0]!) - 20);
    expect(fitted.level.topLevelOnly).toBe(true);
    expect(fitted.tools[0]!.inputSchema).toEqual({ type: "object", required: ["rows"], properties: {
      rows: { type: "array", items: { type: "object" } },
      target: { type: "object" },
      either: { anyOf: [{ type: "string" }, { type: "object", properties: { id: { type: "string" } } }] },
      mode: { type: "string", enum: ["a", "b"] },
    } });
  });

  it("rebuilds an oversized array with its item type, and leaves a plain string array as it was", () => {
    const tool: ListedTool = {
      name: "sample", description: "A sample tool.",
      inputSchema: { type: "object", required: ["keys", "labels"], properties: {
        keys: { type: "array", items: { type: "integer" }, allOf: Array.from({ length: 200 }, () => ({ maxItems: 16 })) },
        labels: { type: "array", items: { type: "string" }, maxItems: 16 },
      } },
    };
    const fitted = fitToolListToShare([tool], 500);
    expect(fitted.from).toBeGreaterThan(500);
    expect(fitted.level.topLevelOnly).toBe(true);
    expect(fitted.fits).toBe(true);
    expect(fitted.bytes).toBeLessThanOrEqual(500);
    expect(fitted.tools[0]!.inputSchema).toEqual({ type: "object", required: ["keys", "labels"], properties: {
      keys: { type: "array", items: { type: "integer" } },
      labels: { type: "array", items: { type: "string" }, maxItems: 16 },
    } });
  });

  it("keeps a nullable, nested, missing, or recursive array's items when the field is rebuilt", () => {
    const tool: ListedTool = {
      name: "sample", description: "A sample tool.",
      inputSchema: {
        type: "object", required: ["keys", "nullable"],
        $defs: { node: { type: "array", items: { $ref: "#/$defs/node" } } },
        properties: {
          keys: { type: "array", items: { type: "integer" }, allOf: Array.from({ length: 200 }, () => ({ maxItems: 16 })) },
          nullable: { type: ["array", "null"], items: { type: "integer", minimum: 0 }, allOf: [{ maxItems: 4 }] },
          nested: { type: "array", items: { type: "array", items: { type: "boolean", description: "drop me" } }, allOf: [{ maxItems: 4 }] },
          bare: { type: "array" },
          tree: { type: "array", allOf: [{ maxItems: 4 }], $ref: "#/$defs/node" },
          labels: { type: "array", items: { type: "string" }, maxItems: 16 },
        },
      },
    };
    const fitted = fitToolListToShare([tool], 700);
    expect(fitted.from).toBeGreaterThan(700);
    expect(fitted.level.topLevelOnly).toBe(true);
    expect(fitted.fits).toBe(true);
    expect(fitted.bytes).toBeLessThanOrEqual(700);
    expect(fitted.tools[0]!.inputSchema).toEqual({
      type: "object", required: ["keys", "nullable"],
      $defs: { node: { type: "array", items: { $ref: "#/$defs/node" } } },
      properties: {
        keys: { type: "array", items: { type: "integer" } },
        nullable: { type: ["array", "null"], items: { type: "integer" } },
        nested: { type: "array", items: { type: "array", items: { type: "boolean" } } },
        bare: { type: "array", items: { type: "string" } },
        tree: { type: "array", items: { type: "array", items: { type: "string" } } },
        labels: { type: "array", items: { type: "string" }, maxItems: 16 },
      },
    });
  });
});

describe("a list over its share even at its shortest", () => {
  const share = 14_000;

  it("leaves out tools itself, the least important first, never a coordination tool, until the CLI has nothing to drop", () => {
    const fitted = fitToolListWithinShare(agents, share);
    expect(fitted.left.length).toBeGreaterThan(0);
    expect(fitted.bytes).toBeLessThanOrEqual(toolListLimit(share));
    expect(cliDrops(fitted.tools, toolListLimit(share))).toEqual([]);
    for (const name of COORDINATION_TOOLS) expect(names(fitted.tools)).toContain(name);
    // A protected tool goes only once every other tool has.
    const keptPlain = fitted.tools.filter((tool) => toolKeepRank(tool.name) === 0);
    if (fitted.left.some((name) => PROTECTED_TOOLS.includes(name))) expect(keptPlain).toEqual([]);
    // What is kept is in the order given, and what is left out is named in that order too.
    expect(names(fitted.tools)).toEqual(names(agents).filter((name) => !fitted.left.includes(name)));
    expect(fitted.left).toEqual(names(agents).filter((name) => fitted.left.includes(name)));
  });

  it("leaves nothing out while it is within the CLI's own limit, and keeps the coordination tools at any share", () => {
    const shortest = fitToolListToShare(agents, 1).bytes;
    const near = Math.ceil((shortest * ANTIGRAVITY_CLI_TOOL_BUDGET) / ANTIGRAVITY_CLI_TOOL_LIMIT);
    expect(fitToolListToShare(agents, near).fits).toBe(false);
    expect(fitToolListWithinShare(agents, near).left).toEqual([]);
    const tiny = fitToolListWithinShare(agents, 1);
    expect(names(tiny.tools)).toEqual(names(agents).filter((name) => COORDINATION_TOOLS.includes(name)));
  });
});
