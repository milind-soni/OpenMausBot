import { describe, expect, it } from "vitest";

import { createToolListNormalizer, fitToolList, fitToolListResult, providerSafeInputSchema, shortenedToolNote } from "./mcp-tool-schema.ts";
import { createPageSchema, wideSchema } from "./testing/oversized-tool-schema.ts";
import { schemaBytes, toolSchemaProfile } from "./tool-schema-profile.ts";

const MOONSHOT = toolSchemaProfile("moonshot")!;

// Verbatim from `cua-driver describe browser_prepare`, cua-driver 0.22.1: strict providers reject its root anyOf.
const BROWSER_PREPARE_0_22_1 = {
  additionalProperties: true,
  anyOf: [
    { required: ["pid"] },
    {
      properties: {
        allow_launch: { const: true },
        profile: { properties: { mode: { enum: ["isolated_new", "isolated_named"] } }, required: ["mode"] },
      },
      required: ["allow_launch", "profile"],
    },
  ],
  properties: {
    allow_launch: { description: "Allow a separate driver-owned isolated Chromium process to be launched (default false).", type: "boolean" },
    pid: { description: "Browser process id to prepare.", type: "integer" },
    profile: {
      additionalProperties: false,
      properties: {
        mode: { enum: ["isolated_new", "isolated_named"], type: "string" },
        name: { description: "Required only for isolated_named.", type: "string" },
      },
      required: ["mode"],
      type: "object",
    },
    session: { description: "Public session label.", type: "string" },
    strategy: {
      additionalProperties: false,
      properties: { kind: { enum: ["existing_profile"], type: "string" } },
      required: ["kind"],
      type: "object",
    },
    window_id: { description: "Exact native window approval anchor.", type: "integer" },
  },
  required: [],
  type: "object",
};

const ROOT_COMBINATORS = ["anyOf", "oneOf", "allOf", "not"];

describe("providerSafeInputSchema", () => {
  it("gives the bundled driver's browser_prepare a plain object root", () => {
    const safe = providerSafeInputSchema(BROWSER_PREPARE_0_22_1);

    expect(safe.type).toBe("object");
    for (const keyword of ROOT_COMBINATORS) expect(safe).not.toHaveProperty(keyword);
    expect(safe.properties).toEqual(BROWSER_PREPARE_0_22_1.properties);
    expect(safe.required).toBeUndefined();
    expect(safe.additionalProperties).toBe(true);
  });

  it("returns an already provider-safe schema unchanged", () => {
    const schema = {
      type: "object",
      properties: { value: { anyOf: [{ type: "string" }, { type: "null" }] } },
      required: ["value"],
      additionalProperties: false,
    };
    expect(providerSafeInputSchema(schema)).toBe(schema);
  });

  it("keeps properties declared only inside root choice branches, required by none of them", () => {
    const safe = providerSafeInputSchema({
      oneOf: [
        { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
      ],
    });
    expect(safe).toEqual({ type: "object", properties: { query: { type: "string" }, id: { type: "integer" } } });
  });

  it("keeps a requirement every choice branch shares", () => {
    const safe = providerSafeInputSchema({
      type: "object",
      properties: { target: { type: "string" }, x: { type: "number" }, ref: { type: "string" } },
      anyOf: [{ required: ["target", "x"] }, { required: ["ref", "target"] }],
    });
    expect(safe.required).toEqual(["target"]);
  });

  it("hoists allOf branches, whose requirements all hold", () => {
    const safe = providerSafeInputSchema({
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
      allOf: [{ properties: { b: { type: "number" } }, required: ["b"] }],
    });
    expect(safe).toEqual({ type: "object", properties: { a: { type: "string" }, b: { type: "number" } }, required: ["a", "b"] });
  });

  it("drops a root not, which no strict provider accepts and cannot be restated", () => {
    const safe = providerSafeInputSchema({ type: "object", properties: { a: { type: "string" } }, not: { required: ["a"] } });
    expect(safe).toEqual({ type: "object", properties: { a: { type: "string" } } });
  });

  it("types an untyped or multi-typed object root", () => {
    expect(providerSafeInputSchema({ properties: { a: { type: "string" } } })).toEqual({
      type: "object",
      properties: { a: { type: "string" } },
    });
    expect(providerSafeInputSchema({ type: ["object", "null"], properties: {} })).toEqual({ type: "object", properties: {} });
  });

  it("gives a missing or non-object root an open object schema", () => {
    expect(providerSafeInputSchema(undefined)).toEqual({ type: "object", properties: {} });
    expect(providerSafeInputSchema([])).toEqual({ type: "object", properties: {} });
    expect(providerSafeInputSchema({ type: "string" })).toEqual({ type: "object", properties: {} });
  });

  it("does not mutate the schema it was given", () => {
    const before = JSON.stringify(BROWSER_PREPARE_0_22_1);
    providerSafeInputSchema(BROWSER_PREPARE_0_22_1);
    expect(JSON.stringify(BROWSER_PREPARE_0_22_1)).toBe(before);
  });
});

describe("createToolListNormalizer", () => {
  const list = (id: unknown, tools: unknown[]) => JSON.stringify({ jsonrpc: "2.0", id, result: { tools } });

  it("rewrites the schemas in the response to a tools/list the agent sent", () => {
    const normalizer = createToolListNormalizer();
    normalizer.observeRequest(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" }));

    const rewritten = JSON.parse(normalizer.rewriteResponse(list(7, [{ name: "browser_prepare", inputSchema: BROWSER_PREPARE_0_22_1 }])));

    expect(rewritten.id).toBe(7);
    expect(rewritten.result.tools[0].name).toBe("browser_prepare");
    expect(rewritten.result.tools[0].inputSchema).not.toHaveProperty("anyOf");
  });

  it("matches string ids exactly and forgets an id once answered", () => {
    const normalizer = createToolListNormalizer();
    normalizer.observeRequest(JSON.stringify({ jsonrpc: "2.0", id: "7", method: "tools/list" }));
    const numeric = list(7, [{ name: "t", inputSchema: BROWSER_PREPARE_0_22_1 }]);
    expect(normalizer.rewriteResponse(numeric)).toBe(numeric);

    const first = list("7", [{ name: "t", inputSchema: BROWSER_PREPARE_0_22_1 }]);
    expect(normalizer.rewriteResponse(first)).not.toBe(first);
    expect(normalizer.rewriteResponse(first)).toBe(first);
  });

  it("passes every other line through byte-for-byte", () => {
    const normalizer = createToolListNormalizer();
    normalizer.observeRequest(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "x" } }));
    const callResult = list(1, [{ name: "looks-like-a-list", inputSchema: BROWSER_PREPARE_0_22_1 }]);
    for (const line of [callResult, "not json", '{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}']) {
      expect(normalizer.rewriteResponse(line)).toBe(line);
    }
  });

  it("leaves an error response and an already-safe list untouched", () => {
    const normalizer = createToolListNormalizer();
    normalizer.observeRequest(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
    const error = JSON.stringify({ jsonrpc: "2.0", id: 2, error: { code: -32603, message: "boom" } });
    expect(normalizer.rewriteResponse(error)).toBe(error);

    normalizer.observeRequest(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }));
    const safe = list(3, [{ name: "click", inputSchema: { type: "object", properties: {} } }]);
    expect(normalizer.rewriteResponse(safe)).toBe(safe);
  });
});

describe("a tool list under a provider's schema profile", () => {
  const small = { name: "search", description: "Find pages.", inputSchema: { type: "object", properties: { query: { type: "string" } } } };

  it("preserves a referenced type beside a mixed enum", () => {
    const inputSchema = { type: "object", $defs: {
      text: { type: "string" }, integer: { type: "integer" },
      alias: { $ref: "#/$defs/text" },
    }, properties: {
      choice: { $ref: "#/$defs/alias", enum: ["a", null] },
      count: { $ref: "#/$defs/integer", enum: [1, 2.5, null] },
      nullable: { enum: ["a", null] },
    } };
    const [tool] = fitToolList([{ name: "choose", inputSchema }], MOONSHOT) as Array<{ inputSchema: typeof inputSchema }>;
    expect(tool!.inputSchema.properties.choice).toEqual(inputSchema.properties.choice);
    expect(tool!.inputSchema.properties.count).toEqual(inputSchema.properties.count);
    expect(tool!.inputSchema.properties.nullable).toEqual({ enum: ["a", null], type: ["string", "null"] });
    expect(inputSchema.properties.nullable).not.toHaveProperty("type");
  });

  it("keeps nullable and mixed enum choices usable in Kimi's tools/list", () => {
    const genre = { enum: ["puzzle", "rpg", null], description: "Choose a genre" };
    const values = { enum: [1, 2.5, false, null, { name: "one" }, []] };
    const inputSchema = { type: "object", $defs: { genre }, properties: {
      genre: { $ref: "#/$defs/genre" }, options: { type: "array", items: values },
      typed: { type: "string", enum: ["one", null] }, numeric: { enum: [1, 2.5] },
    } };
    const result = { tools: [{ name: "game", inputSchema }] };
    expect(fitToolListResult(result, MOONSHOT)).toMatchObject({ tools: [{ inputSchema: { $defs: { genre: { ...genre, type: ["string", "null"] } }, properties: {
      genre: { $ref: "#/$defs/genre" },
      options: { items: { ...values, type: ["number", "boolean", "null", "object", "array"] } },
      typed: inputSchema.properties.typed, numeric: inputSchema.properties.numeric,
    } } }] });
    expect(genre).not.toHaveProperty("type");
    expect(values).not.toHaveProperty("type");
    expect(fitToolListResult(result, undefined)).toBe(result);
  });

  it("keeps a tool within the limit as the same object, shortens one over it with a note, and leaves out one that cannot fit", () => {
    const lines: string[] = [];
    const tools = [small, { name: "create_page", description: "Create a page.", inputSchema: createPageSchema() },
      { name: "configure_everything", inputSchema: wideSchema(400) }, { name: "rooted", inputSchema: BROWSER_PREPARE_0_22_1 }];
    const fitted = fitToolList(tools, MOONSHOT, (line) => lines.push(line)) as Array<Record<string, any>>;

    expect(fitted.map((tool) => tool.name)).toEqual(["search", "create_page", "rooted"]);
    expect(fitted[0]).toBe(small);
    expect(schemaBytes(fitted[1]!.inputSchema)).toBeLessThanOrEqual(12_000);
    expect(fitted[1]!.description).toBe(`Create a page.\n\n${shortenedToolNote("Kimi")}`);
    expect(fitted[2]!.inputSchema).not.toHaveProperty("anyOf");
    expect(lines).toEqual([
      expect.stringMatching(/^left nested fields out of tool "create_page"'s parameters \(\d+ to \d+ bytes\) to fit Kimi's 12000-byte limit for one tool$/),
      expect.stringMatching(/^left out tool "configure_everything": its parameters are \d+ bytes and still \d+ at their shortest, over Kimi's 12000-byte limit for one tool$/),
    ]);
  });

  it("adds no note when only words were dropped", () => {
    const wordy = { type: "object", properties: Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`f${index}`,
      { type: "object", properties: { v: { type: "string", description: "Words. ".repeat(120) } } }])) };
    const [tool] = fitToolList([{ name: "wordy", description: "Wordy.", inputSchema: wordy }], MOONSHOT) as Array<Record<string, unknown>>;
    expect(tool!.description).toBe("Wordy.");
    expect(schemaBytes(tool!.inputSchema)).toBeLessThanOrEqual(12_000);
  });

  it("leaves a result without a profile, or without a tools array, as it came", () => {
    const result = { tools: [{ name: "create_page", inputSchema: createPageSchema() }] };
    expect(fitToolListResult(result, undefined)).toBe(result);
    expect(fitToolListResult({ content: [] }, MOONSHOT)).toEqual({ content: [] });
  });

  it("fits the response a bridge relays under a profile, and only roots it without one", () => {
    const list = JSON.stringify({ jsonrpc: "2.0", id: 4, result: { tools: [small, { name: "create_page", inputSchema: createPageSchema() }] } });
    const request = JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list" });

    const plain = createToolListNormalizer();
    plain.observeRequest(request);
    expect(plain.rewriteResponse(list)).toBe(list);

    const lines: string[] = [];
    const profiled = createToolListNormalizer(MOONSHOT, (line) => lines.push(line));
    profiled.observeRequest(request);
    const tools = JSON.parse(profiled.rewriteResponse(list)).result.tools;
    expect(tools[0]).toEqual(small);
    expect(schemaBytes(tools[1].inputSchema)).toBeLessThanOrEqual(12_000);
    expect(lines).toHaveLength(1);
  });
});


describe("owned tools across paginated catalogs", () => {
  const own = { name: "read_file", description: "Read through the authorized host relay", inputSchema: { type: "object", properties: { path: { type: "string" } } } };
  const shadow = { name: "read_file", description: "An upstream tool with incompatible arguments", inputSchema: { type: "object", properties: { id: { type: "number" } } } };
  const other = { name: "search", inputSchema: { type: "object" }, _meta: { source: "child" } };
  const page = (id: number, tools: unknown[], nextCursor?: string) => JSON.stringify({ jsonrpc: "2.0", id, result: { tools, ...(nextCursor === undefined ? {} : { nextCursor }), _meta: { page: id } } });
  const observe = (normalizer: ReturnType<typeof createToolListNormalizer>, id: number) => normalizer.observeRequest(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list" }));

  for (const profile of [undefined, MOONSHOT]) {
    it(`removes an owned name from every child page before advertising its relay schema (${profile?.provider ?? "no profile"})`, () => {
      const normalizer = createToolListNormalizer(profile, undefined, [own]);
      const all: unknown[] = [];
      for (const [id, tools, cursor] of [[1, [shadow, other], "next"], [2, [shadow], "last"], [3, [shadow], undefined]] as const) {
        observe(normalizer, id);
        const result = JSON.parse(normalizer.rewriteResponse(page(id, [...tools], cursor))).result;
        expect(result._meta).toEqual({ page: id });
        expect(result.nextCursor).toBe(cursor);
        expect(result.tools).toEqual(id === 1 ? [other] : id === 2 ? [] : [own]);
        all.push(...result.tools);
      }
      expect(all).toEqual([other, own]);
    });
  }

  it("keeps byte-identical intermediate pages that contain no owned names", () => {
    const normalizer = createToolListNormalizer(undefined, undefined, [own]);
    observe(normalizer, 1);
    const input = page(1, [other], "next");
    expect(normalizer.rewriteResponse(input)).toBe(input);
  });

  it("preserves the upstream tool when no local replacement is registered", () => {
    const normalizer = createToolListNormalizer();
    observe(normalizer, 1);
    const input = page(1, [shadow, other], "next");
    expect(normalizer.rewriteResponse(input)).toBe(input);
  });

  it("does not rewrite unsolicited or tools/call frames with a matching name", () => {
    const normalizer = createToolListNormalizer(undefined, undefined, [own]);
    const input = page(1, [shadow], "next");
    expect(normalizer.rewriteResponse(input)).toBe(input);
    normalizer.observeRequest(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call" }));
    expect(normalizer.rewriteResponse(input)).toBe(input);
  });
});
