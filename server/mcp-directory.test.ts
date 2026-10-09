import { describe, expect, it } from "vitest";

import {
  CALL_TOOL,
  DESCRIBE_BYTES,
  DESCRIBE_TOOL,
  LISTED_CHARS_MAX,
  LISTED_TOOLS_MAX,
  SEARCH_LIMIT_DEFAULT,
  SEARCH_LIMIT_MAX,
  SEARCH_TOOL,
  SELECTION_EXCLUDES,
  SIGNATURE_CHARS,
  ToolDirectory,
  areaSummary,
  bm25Ranker,
  directoryCallTarget,
  inputSignature,
  schemaText,
  searchesCatalog,
  stem,
  terms,
  toolArea,
  type CatalogTool,
  type DirectoryResult,
} from "./mcp-directory.ts";
import { parameterHeavyCatalog, whopLikeCatalog } from "./testing/whop-like-catalog.ts";

const catalog = whopLikeCatalog(300);
const text = (result: DirectoryResult) => result.content[0].text;
const matches = async (directory: ToolDirectory, args: unknown) =>
  (JSON.parse(text(await directory.search(args))) as { matches: Array<{ name: string; description: string; input: string; readOnly?: true; destructive?: true }> }).matches;
const tool = (name: string, description = "", inputSchema: unknown = { type: "object" }): CatalogTool => ({ name, description, inputSchema });

describe("when a catalog is searched", () => {
  it("lists up to forty small tools and searches one more", () => {
    const tools = Array.from({ length: LISTED_TOOLS_MAX }, (_, index) => tool(`tool_${index}`));
    expect(searchesCatalog(tools)).toBe(false);
    expect(searchesCatalog([...tools, tool("one_more")])).toBe(true);
  });

  it("searches a few tools whose definitions run past the character limit", () => {
    const huge = (name: string) => tool(name, "x".repeat(LISTED_CHARS_MAX / 2));
    expect(searchesCatalog([huge("a"), tool("b")])).toBe(false);
    expect(searchesCatalog([huge("a"), huge("b"), tool("c")])).toBe(true);
  });

  it("searches any catalog that uses a directory tool's name itself", () => {
    expect(searchesCatalog([tool("read"), tool(CALL_TOOL)])).toBe(true);
    expect(searchesCatalog([tool(SEARCH_TOOL)])).toBe(true);
  });

  it("names the upstream tool each call runs", () => {
    expect(directoryCallTarget(SEARCH_TOOL, { query: "x" })).toBeUndefined();
    expect(directoryCallTarget(DESCRIBE_TOOL, { name: "payments_list" })).toBeUndefined();
    expect(directoryCallTarget(CALL_TOOL, { name: "payments_list", arguments: {} })).toBe("payments_list");
    // naming no tool runs nothing: the directory answers it
    expect(directoryCallTarget(CALL_TOOL, { arguments: {} })).toBeUndefined();
    expect(directoryCallTarget(CALL_TOOL, { name: " " })).toBeUndefined();
    expect(directoryCallTarget("payments_list", {})).toBe("payments_list");
  });
});

describe("BM25 ranking", () => {
  it("stems queries and tools the same way", () => {
    expect(stem("payments")).toBe(stem("payment"));
    expect(stem("listing")).toBe(stem("list"));
    expect(stem("updated")).toBe(stem("update"));
    expect(stem("companies")).toBe(stem("company"));
    expect(stem("statuses")).toBe(stem("status"));
    expect(terms("listPayments for the company_id")).toEqual(["list", "payment", "company", "id"]);
  });

  it("drops the words a request is phrased with, and keeps words in any script", () => {
    expect(terms("Which payments failed this month? How much revenue is there?")).toEqual(["payment", "fail", "month", stem("revenue")]);
    // Unicode letters and digits are words; only ASCII ones are stemmed
    expect(terms("Список платежей · 支払い 一覧 · facturaciónMensual")).toEqual(["список", "платежей", "支払い", "一覧", "facturación", "mensual"]);
  });

  it("keeps words whole that carry combining marks, and normalizes what looks alike", () => {
    expect(terms("भुगतान सूची")).toEqual(["भुगतान", "सूची"]);
    // one Thai word, in its normalized form (NFKC splits SARA AM in two)
    expect(terms("การชำระเงิน")).toEqual(["การชำระเงิน".normalize("NFKC")]);
    expect(terms("cafe\u0301 menu")).toEqual(["café", "menu"]);
    expect(terms("ｐａｙｍｅｎｔｓ")).toEqual(["payment"]);
  });

  it("matches a word however its accents were typed", async () => {
    const tools = [tool("menus_get", "Gets the café menu."), tool("menus_list", "Lists menus.")];
    expect((await bm25Ranker("cafe\u0301", tools, 2)).map((entry) => entry.name)).toEqual(["menus_get"]);
    const hindi = [tool("bhugtan_list", "भुगतान सूची"), tool("bhugtan_get", "एक भुगतान")];
    expect((await bm25Ranker("सूची", hindi, 2)).map((entry) => entry.name)).toEqual(["bhugtan_list"]);
  });

  it("finds tools described in other scripts", async () => {
    const tools = [tool("platezhi_list", "Список платежей компании."), tool("shiharai_list", "支払い 一覧"), tool("payments_list", "Lists payments.")];
    expect((await bm25Ranker("платежей", tools, 3)).map((entry) => entry.name)).toEqual(["platezhi_list"]);
    expect((await bm25Ranker("支払い", tools, 3)).map((entry) => entry.name)).toEqual(["shiharai_list"]);
  });

  it("ranks payments_list first for \"list payments\" among Whop-like tools", async () => {
    const found = await bm25Ranker("list payments", catalog, 8);
    expect(found[0].name).toBe("payments_list");
    expect(found.map((entry) => entry.name)).toContain("payments_list_refunded");
    // a tool that only mentions both words in passing ranks below them
    expect(found.findIndex((entry) => entry.name === "stats_get")).toBe(-1);
  });

  it("puts an exact tool name first and breaks ties by name", async () => {
    expect((await bm25Ranker("payments_list_refunded", catalog, 3))[0].name).toBe("payments_list_refunded");
    const twins = [tool("zeta_read", "Read the notes"), tool("alpha_read", "Read the notes")];
    expect((await bm25Ranker("notes", twins, 2)).map((entry) => entry.name)).toEqual(["alpha_read", "zeta_read"]);
  });

  it("names a tool's area by its prefix before the first underscore", () => {
    expect(toolArea("payments_list")).toBe("payments");
    expect(toolArea("promo-codes_create")).toBe("promo-codes");
    expect(toolArea("accounts_update-fees")).toBe("accounts");
    expect(toolArea("getUser")).toBe("get");
    expect(toolArea("_private_tool")).toBe("private");
  });

  it("puts the tools of an area a request names above tools that only mention it", async () => {
    // "payment" is everywhere, so the word alone says little; the area does
    const tools = [
      tool("payments_summary", "Summarizes."),
      tool("ledgers_payment", "Gets the ledger entry of a payment, with the payment's amount and the payment's date."),
      ...Array.from({ length: 20 }, (_, index) => tool(`area${index}_get`, `Gets item ${index} and its payment.`)),
    ];
    expect((await bm25Ranker("payments", tools, 3))[0].name).toBe("payments_summary");
    // an area of several words counts by how much of it the request names
    const areas = [tool("promo-codes_list", "Lists them."), tool("promo-banners_list", "Lists them."), tool("codes_list", "Lists them.")];
    expect((await bm25Ranker("promo codes", areas, 3))[0].name).toBe("promo-codes_list");
  });

  it("lifts listing tools a little when the request asks what there is", async () => {
    const tools = [tool("members_list", "Lists members."), tool("members_ban", "Bans a member."), tool("notes_get", "Gets a note.")];
    // the same words without asking: a tie, ordered by name
    expect((await bm25Ranker("members", tools, 3)).map((entry) => entry.name)).toEqual(["members_ban", "members_list"]);
    for (const query of ["which members", "who are the members", "show members", "newest members", "all members"]) {
      expect((await bm25Ranker(query, tools, 3))[0].name).toBe("members_list");
    }
    // a description starting "Lists" counts as listing too
    const described = [tool("members_roster", "Lists the members of a company."), tool("members_ban", "Bans a member.")];
    expect((await bm25Ranker("which members", described, 2))[0].name).toBe("members_roster");
    // and a verb the request names still wins
    expect((await bm25Ranker("which member should I ban", tools, 3))[0].name).toBe("members_ban");
  });

  it("counts a schema's words, at less weight than a name's or a description's", async () => {
    const said = tool("widgets_report", "Reports revenue for widgets.");
    const offered = tool("gizmos_get", "Gets one gizmo.", { type: "object", properties: { metric: { type: "string", enum: ["revenue", "units"] } } });
    expect((await bm25Ranker("revenue", [offered, said], 8)).map((entry) => entry.name)).toEqual(["widgets_report", "gizmos_get"]);
    // a long schema dilutes only its own words, never a match in the name
    const long = tool("payments_list", "Lists payments.", { type: "object", properties: Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`field_${index}`, { type: "string", description: "A filter." }])) });
    const short = tool("payments_archive", "Archives payments so they leave lists.");
    expect((await bm25Ranker("list payments", [short, long], 8))[0].name).toBe("payments_list");
  });

  it("reads property names, enum values and descriptions from a schema, bounded", () => {
    expect(schemaText({ type: "object", description: "Root.", properties: {
      metric: { type: "string", description: "What to total.", enum: ["net_revenue", "fees"] },
      filters: { type: "object", properties: { status: { type: "array", items: { enum: ["failed"] } } } },
      choice: { anyOf: [{ const: "this_week" }] },
    } })).toBe("Root. metric What to total. net_revenue fees filters status failed choice this_week");
    expect(schemaText({ type: "object", properties: { big: { description: "x".repeat(10_000) } } }).length).toBeLessThanOrEqual(4_001);
  });
});

describe("ranking a catalog that puts its meaning in parameters", () => {
  const catalog = parameterHeavyCatalog();
  const rank = async (query: string, limit = 8) => (await bm25Ranker(query, catalog, limit)).map((entry) => entry.name);

  it("finds a plain request's tool first", async () => {
    expect((await rank("list my products"))[0]).toBe("products_list");
  });

  it("finds revenue among the tools that offer it as a metric", async () => {
    const top = await rank("how much revenue this week", 3);
    expect(top.some((name) => name === "stats_get" || name === "ledgers_report")).toBe(true);
  });

  it("finds payments_list for failed payments, though it never says failed, and nothing for the question's own words", async () => {
    expect(await rank("which payments failed this month", 3)).toContain("payments_list");
    // "which" is a stop word, so the tool that "says which account it uses" stays out
    expect(await rank("which payments failed this month", 20)).not.toContain("connection_status");
  });

  it("finds the members listing among many tools that mention members", async () => {
    expect(await rank("who are my newest members", 3)).toContain("members_list");
  });

  it("keeps a verb the request names ahead of everything else", async () => {
    expect((await rank("cancel a membership"))[0]).toBe("memberships_cancel");
    expect(await rank("create a promo code", 2)).toContain("promo-codes_create");
    // even beside words that ask what there is
    expect((await rank("show me how to cancel a membership"))[0]).toBe("memberships_cancel");
    expect((await rank("which promo code should I delete"))[0]).toBe("promo-codes_delete");
  });
});

describe("input signatures", () => {
  it("writes required fields first, optional ones with ?, in TypeScript style", () => {
    expect(inputSignature({
      type: "object",
      properties: {
        first: { type: "integer" },
        company_id: { type: "string" },
        order: { type: "string", enum: ["created_at", "updated_at"] },
        tags: { type: "array", items: { type: "string" } },
        status: { anyOf: [{ type: "string" }, { type: "null" }] },
        "x-header": { type: ["string", "number"] },
        filters: { type: "object", properties: { q: { type: "string" } } },
      },
      required: ["company_id"],
    })).toBe('{ company_id: string; first?: number; order?: "created_at" | "updated_at"; tags?: string[]; status?: string | null; "x-header"?: string | number; filters?: object }');
    expect(inputSignature({ type: "object" })).toBe("{}");
    expect(inputSignature(undefined)).toBe("{}");
  });

  it("stays within its bound and counts the fields it leaves out", () => {
    const properties = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`field_number_${index}`, { type: "string" }]));
    const signature = inputSignature({ type: "object", properties, required: ["field_number_39"] });
    expect(signature.length).toBeLessThanOrEqual(SIGNATURE_CHARS);
    expect(signature.startsWith("{ field_number_39: string; field_number_0?: string")).toBe(true);
    expect(signature).toMatch(/; … \d+ more }$/);
    const lone = inputSignature({ type: "object", properties: { [`k${"y".repeat(400)}`]: { type: "string" } } });
    expect(lone.length).toBeLessThanOrEqual(SIGNATURE_CHARS);
    expect(lone.endsWith("… }")).toBe(true);
  });
});

describe("the directory's three tools", () => {
  const directory = new ToolDirectory(catalog);

  it("describes the server and its areas, bounded", () => {
    const listed = directory.listed({ server: "whop", title: "Whop", instructions: "Run a Whop business.\nPayments, memberships and more." });
    expect(listed.map((entry) => entry.name)).toEqual([SEARCH_TOOL, DESCRIBE_TOOL, CALL_TOOL]);
    const description = listed[0].description as string;
    expect(description).toContain('300 tools of the "whop" MCP server (Whop)');
    expect(description).toContain("payments (8)");
    expect(description).toContain("About this server: Run a Whop business. Payments, memberships and more.");
    expect(description.length).toBeLessThan(3_000);
    const many = Array.from({ length: 500 }, (_, index) => tool(`area${index}_x`));
    const areas = areaSummary(many);
    expect(areas.length).toBeLessThanOrEqual(2_000);
    expect(areas).toMatch(/… and \d+ more$/);
  });

  it("returns bounded one-line matches with signatures and hints", async () => {
    const found = await matches(directory, { query: "list payments" });
    expect(found).toHaveLength(SEARCH_LIMIT_DEFAULT);
    expect(found[0]).toEqual({
      name: "payments_list",
      description: "List payments for a company, newest first. Supports pagination with first and after.",
      input: '{ company_id: string; first?: number; after?: string; order?: "created_at" | "updated_at" }',
      readOnly: true,
    });
    expect((await matches(directory, { query: "delete payments" }))[0]).toMatchObject({ name: "payments_delete", destructive: true });
    // every tool of the area, then the one that only mentions payments
    const payments = (await matches(directory, { query: "payments", limit: 500 })).map((entry) => entry.name);
    expect(payments).toHaveLength(9);
    expect(payments.at(-1)).toBe("stats_get");
    expect(await matches(directory, { query: "company", limit: 500 })).toHaveLength(SEARCH_LIMIT_MAX);
    expect(await matches(directory, { query: "company", limit: 0 })).toHaveLength(1);
    const long = new ToolDirectory([tool("long_one", `${"word ".repeat(100)}\n\nmore`)]);
    const [only] = await matches(long, { query: "long" });
    expect(only.description.length).toBeLessThanOrEqual(200);
    expect(only.description).not.toContain("\n");
  });

  it("says how to go on when nothing matches, and answers a bad search with guidance, not an error", async () => {
    const empty = JSON.parse(text(await directory.search({ query: "zzz" })));
    expect(empty).toMatchObject({ matches: [] });
    expect(empty.next).toContain("payments (8)");
    for (const args of [{}, { query: "" }, { query: "x", limit: "8" }, undefined]) {
      const answer = await directory.search(args);
      expect(answer.isError).toBeUndefined();
      expect(text(answer)).toContain('"query"');
    }
  });

  it("describes one tool exactly, and guides past a name it does not have", () => {
    const original = catalog.find((entry) => entry.name === "payments_list")!;
    expect(JSON.parse(text(directory.describe({ name: "payments_list" })))).toEqual({
      name: "payments_list", description: original.description, inputSchema: original.inputSchema, annotations: original.annotations,
    });
    for (const args of [{ name: "payments_teleport" }, {}]) {
      const miss = directory.describe(args);
      expect(miss.isError).toBeUndefined();
      expect(text(miss)).toContain(SEARCH_TOOL);
    }
  });

  it("plans call_tool only for a tool in the catalog, and guides past anything else", () => {
    expect(directory.call({ name: "payments_list", arguments: { company_id: "biz_1" } })).toEqual({ name: "payments_list", arguments: { company_id: "biz_1" } });
    expect(directory.call({ name: "payments_list" })).toEqual({ name: "payments_list", arguments: {} });
    for (const args of [{ name: "payments_teleport" }, { arguments: {} }, { name: "payments_list", arguments: [] }]) {
      const planned = directory.call(args);
      if (!("answer" in planned)) throw new Error("expected an answer instead of a call");
      expect(planned.answer.isError).toBeUndefined();
      expect(text(planned.answer)).toContain(SEARCH_TOOL);
    }
  });

  it("refuses a tool the selection leaves out, as an error", () => {
    const narrowed = new ToolDirectory(catalog.filter((entry) => entry.name !== "payments_create"), { withheld: ["payments_create"] });
    for (const answer of [narrowed.describe({ name: "payments_create" }), (narrowed.call({ name: "payments_create" }) as { answer: DirectoryResult }).answer]) {
      expect(answer).toEqual({ content: [{ type: "text", text: SELECTION_EXCLUDES }], isError: true });
    }
  });

  it("answers arguments that do not fit with their problems and the tool's input, running nothing", () => {
    const checked = new ToolDirectory(catalog, { check: (_tool, args) => typeof args.company_id === "string" ? undefined : ["must have required property 'company_id'"] });
    expect(checked.call({ name: "payments_list", arguments: { company_id: "biz_1" } })).toEqual({ name: "payments_list", arguments: { company_id: "biz_1" } });
    const planned = checked.call({ name: "payments_list", arguments: { first: 5 } });
    if (!("answer" in planned)) throw new Error("expected an answer instead of a call");
    expect(planned.answer.isError).toBeUndefined();
    expect(JSON.parse(text(planned.answer))).toMatchObject({
      problems: ["must have required property 'company_id'"],
      input: expect.stringContaining("company_id: string"),
      next: expect.stringContaining("Nothing was run"),
    });
  });

  it("ranks through a replaceable seam, and only ever returns catalog tools", async () => {
    const reversed = new ToolDirectory(catalog, { ranker: (_query, tools, limit) => [...tools].reverse().slice(0, limit) });
    expect((await matches(reversed, { query: "anything", limit: 2 })).map((entry) => entry.name)).toEqual(
      [...catalog].reverse().slice(0, 2).map((entry) => entry.name));
    const forged = new ToolDirectory(catalog, { ranker: async () => [tool("payments_list", "forged")] });
    expect(await matches(forged, { query: "x" })).toEqual([]);
  });
});

describe("describe_tool on a huge schema", () => {
  const bytes = (value: string) => Buffer.byteLength(value);
  const groups = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"];
  /** About 51 KB, like Whop's largest tool: nested objects whose fields
   * carry long descriptions, examples and defaults. */
  const described = () => {
    const leaf = (index: number) => ({ type: "string", description: `Filter ${index}: ${"narrows the results to matching records. ".repeat(5)}`, examples: ["first example", "second example"], default: "first example" });
    const group = (name: string) => ({ type: "object", description: `${name} filters.`, properties: Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`${name}_${index}`, leaf(index)])) });
    return { type: "object", required: ["company_id"], properties: { company_id: { type: "string", description: "The company." }, ...Object.fromEntries(groups.map((name) => [name, group(name)])) } };
  };
  /** Too big even without a single description: hundreds of enum fields. */
  const structural = (perGroup: number) => {
    const leaf = { type: "string", enum: ["one", "two", "three", "four", "five", "six"] };
    const group = (name: string) => ({ type: "object", properties: Object.fromEntries(Array.from({ length: perGroup }, (_, index) => [`${name}_${index}`, leaf])) });
    return { type: "object", required: ["company_id"], properties: { company_id: { type: "string" }, ...Object.fromEntries(groups.map((name) => [name, group(name)])) } };
  };
  const describeOne = (schema: unknown) => new ToolDirectory([tool("orders_search", "Searches orders.", schema)]).describe({ name: "orders_search" });

  it("leaves a schema that fits exactly as it is", () => {
    const small = tool("small_get", "Gets one.", { type: "object", properties: { id: { type: "string", examples: ["x"] } } });
    expect(JSON.parse(text(new ToolDirectory([small]).describe({ name: "small_get" })))).not.toHaveProperty("compacted");
  });

  it("compacts a 51 KB schema step by step, valid JSON within the budget", () => {
    const schema = described();
    expect(bytes(JSON.stringify(schema))).toBeGreaterThan(50_000);
    const answer = describeOne(schema);
    expect(answer.isError).toBeUndefined();
    expect(bytes(text(answer))).toBeLessThanOrEqual(DESCRIBE_BYTES);
    const parsed = JSON.parse(text(answer));
    expect(parsed.compacted).toMatch(/nested fields were left out/);
    // the schema's real shape survives; the top level keeps its words
    expect(parsed.inputSchema.required).toEqual(["company_id"]);
    expect(parsed.inputSchema.properties.company_id.description).toBe("The company.");
    expect(parsed.inputSchema.properties.alpha.description).toBe("alpha filters.");
    expect(Object.keys(parsed.inputSchema.properties.alpha.properties)).toHaveLength(20);
    expect(parsed.inputSchema.properties.alpha.properties.alpha_0).toEqual({ type: "string" });
  });

  it("falls back to field paths, types and required, then counts what it leaves out", () => {
    for (const perGroup of [80, 400]) {
      const answer = describeOne(structural(perGroup));
      expect(bytes(text(answer))).toBeLessThanOrEqual(DESCRIBE_BYTES);
      const parsed = JSON.parse(text(answer));
      expect(parsed.inputSchema).toBeUndefined();
      expect(parsed.compacted).toMatch(/too large to show whole/);
      expect(parsed.fields[0]).toEqual({ path: "company_id", type: "string", required: true });
      expect(parsed.fields).toContainEqual({ path: "alpha.alpha_0", type: '"one" | "two" | "three" | "four" | "five" | "six"' });
      expect(parsed.fields.length + (parsed.moreFields ?? 0)).toBe(1 + groups.length * (perGroup + 1));
    }
    expect(JSON.parse(text(describeOne(structural(400)))).moreFields).toBeGreaterThan(0);
  });
});

describe("schemas that keep their fields in $defs", () => {
  const defs = {
    PaymentFilters: { type: "object", properties: { status: { type: "string", enum: ["failed", "paid"] }, created_after: { type: "string", format: "date-time" } }, required: ["status"] },
    Cursor: { type: "object", properties: { after: { type: "string" } } },
    Tree: { type: "object", properties: { label: { type: "string", enum: ["leaf"] }, children: { type: "array", items: { $ref: "#/$defs/Tree" } } } },
  };
  /** The shape Pydantic and FastMCP write. */
  const pydantic = {
    type: "object",
    properties: {
      params: { $ref: "#/$defs/PaymentFilters" },
      cursor: { anyOf: [{ $ref: "#/$defs/Cursor" }, { type: "null" }], default: null },
    },
    required: ["params"],
    $defs: defs,
  };

  it("reads the words its definitions hold, each once, never in a circle", () => {
    expect(schemaText(pydantic)).toBe("params status failed paid created_after cursor after");
    expect(schemaText({ type: "object", properties: { root: { $ref: "#/$defs/Tree" } }, $defs: defs }).match(/leaf/g)).toHaveLength(1);
    expect(schemaText({ $ref: "#" })).toBe("");
    // only references into the same schema
    expect(schemaText({ type: "object", properties: { x: { $ref: "https://example.test/remote.json" } } })).toBe("x");
    expect(schemaText({ type: "object", definitions: { Old: { enum: ["legacy"] } }, properties: { x: { $ref: "#/definitions/Old" } } })).toBe("x legacy");
  });

  it("ranks a tool on the words its definitions hold", async () => {
    const tools = [tool("payments_list", "Lists payments.", pydantic), tool("payouts_list", "Lists payouts.")];
    expect((await bm25Ranker("failed", tools, 2)).map((entry) => entry.name)).toEqual(["payments_list"]);
  });

  it("writes signatures with the types references lead to", () => {
    expect(inputSignature(pydantic)).toBe("{ params: object; cursor?: object | null }");
    expect(inputSignature({ $ref: "#/$defs/Root", $defs: { Root: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } } })).toBe("{ id: string }");
    expect(inputSignature({ type: "object", properties: { me: { $ref: "#" } } })).toBe("{ me?: object }");
  });

  it("outlines the fields behind references when a schema is too big to show", () => {
    const filters = Object.fromEntries(Array.from({ length: 700 }, (_, index) => [`filter_${index}`, { type: "string", enum: ["one", "two", "three", "four", "five", "six"] }]));
    const big = { type: "object", properties: { tree: { $ref: "#/$defs/Tree" }, params: { $ref: "#/$defs/Filters" } }, required: ["params"],
      $defs: { Filters: { type: "object", properties: filters }, Tree: defs.Tree } };
    const parsed = JSON.parse(text(new ToolDirectory([tool("orders_search", "Searches orders.", big)]).describe({ name: "orders_search" })));
    expect(parsed.compacted).toMatch(/too large to show whole/);
    // a definition that holds itself is walked once along each path
    expect(parsed.fields.slice(0, 4)).toEqual([
      { path: "tree", type: "object" },
      { path: "tree.label", type: '"leaf"' },
      { path: "tree.children", type: "object[]" },
      { path: "params", type: "object", required: true },
    ]);
    expect(parsed.fields[4]).toEqual({ path: "params.filter_0", type: '"one" | "two" | "three" | "four" | "five" | "six"' });
    // a schema whose root is itself a reference
    const rooted = { $ref: "#/$defs/Root", $defs: { Root: { type: "object", properties: filters, required: ["filter_0"] } } };
    const outlined = JSON.parse(text(new ToolDirectory([tool("orders_filter", "Filters orders.", rooted)]).describe({ name: "orders_filter" })));
    expect(outlined.fields[0]).toEqual({ path: "filter_0", type: '"one" | "two" | "three" | "four" | "five" | "six"', required: true });
  });
});

describe("describe_tool's last resort, whatever the names", () => {
  it("stays within its budget with an enormous tool name or field names", () => {
    const name = `orders_${"n".repeat(60_000)}`;
    const answer = new ToolDirectory([tool(name, "Searches orders.", { type: "object", properties: { id: { type: "string" } } })]).describe({ name });
    expect(Buffer.byteLength(text(answer))).toBeLessThanOrEqual(DESCRIBE_BYTES);
    const parsed = JSON.parse(text(answer));
    expect(parsed.name.length).toBeLessThanOrEqual(200);
    expect(parsed.fields).toEqual([{ path: "id", type: "string" }]);
    const wide = { type: "object", properties: Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`${"p".repeat(5_000)}${index}`, { type: "string" }])) };
    const outline = new ToolDirectory([tool("wide_get", "Wide.", wide)]).describe({ name: "wide_get" });
    expect(Buffer.byteLength(text(outline))).toBeLessThanOrEqual(DESCRIBE_BYTES);
    for (const field of JSON.parse(text(outline)).fields) expect(field.path.length).toBeLessThanOrEqual(200);
  });
});
