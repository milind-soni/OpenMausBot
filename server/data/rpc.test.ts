// The Data server's rpc as harness-mcp-proxy data calls it: the catalog
// with the dialect instructions, the capability check before and after a
// call, arguments refused before anything touches the database, and the
// bot's connection for every statement.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DATA_TOOL_NAMES } from "../../shared/data-surface.ts";
import { FakeDataDatabase } from "../testing/fake-data-database.ts";
import { DATA_INSTRUCTIONS } from "./instructions.ts";
import { dataRpc, type DataRpcDeps } from "./rpc.ts";
import { DataSheetStore } from "./sheet.ts";
import { showCard } from "./tools.ts";
import { DataFailure } from "./types.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function harness(signal = new AbortController().signal) {
  const dir = mkdtempSync(join(tmpdir(), "omb-data-rpc-"));
  dirs.push(dir);
  const database = new FakeDataDatabase();
  let checks = 0;
  const deps: DataRpcDeps = {
    database,
    sheet: new DataSheetStore({ botId: "bot-1", dir }),
    compileChart: () => { throw new DataFailure({ code: "spec_invalid", message: "not in this test" }); },
    validateVegaLite: async () => ({}),
    renderer: { svg: async () => "<svg/>", png: async () => Buffer.alloc(0) },
    exportRoots: () => [dir],
    signal,
    assertActive: () => { checks++; },
  };
  return { deps, database, checks: () => checks };
}

describe("dataRpc", () => {
  it("lists the five tools with the dialect instructions and touches no database", async () => {
    const { deps, database, checks } = harness();
    const listed = await dataRpc({ method: "tools/list", params: {} }, deps) as { tools: Array<{ name: string; inputSchema: unknown }>; instructions: string };
    expect(listed.tools.map((tool) => tool.name)).toEqual([...DATA_TOOL_NAMES]);
    expect(listed.instructions).toBe(DATA_INSTRUCTIONS);
    expect(listed.instructions).toContain("GROUP BY ALL");
    expect(listed.instructions).toContain("QUALIFY");
    expect(listed.instructions).toContain("read_parquet");
    expect(checks()).toBe(1);
    expect(database.calls).toEqual([]);
  });

  it("runs a call on the bot's connection with the capability checked before and after", async () => {
    const { deps, database, checks } = harness();
    const result = await dataRpc({ method: "tools/call", params: { name: "data_sql", arguments: { sql: "SELECT 1 AS one", limit: 1 } } }, deps) as { isError?: boolean; structuredContent: Record<string, unknown> };
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ table: "omb_results.q_1", rowCount: 3, truncated: true });
    expect(checks()).toBe(2);
    expect(database.calls.every((call) => call.method === "listTables" || call.connection === "bot")).toBe(true);
  });

  it("refuses arguments off the schema before the capability check or any statement", async () => {
    const { deps, database, checks } = harness();
    const bad = await dataRpc({ method: "tools/call", params: { name: "data_sql", arguments: { sql: 1 } } }, deps) as { isError?: boolean; structuredContent?: { code: string } };
    expect(bad.isError).toBe(true);
    expect(bad.structuredContent!.code).toBe("invalid_input");
    const unknown = await dataRpc({ method: "tools/call", params: { name: "data_drop" } }, deps) as { isError?: boolean; content: Array<{ text: string }> };
    expect(unknown.isError).toBe(true);
    expect(unknown.content[0]!.text).toContain("Unknown Data tool");
    expect(checks()).toBe(0);
    expect(database.calls).toEqual([]);
  });

  it("answers a refused write as a tool error, not a transport error", async () => {
    const { deps } = harness();
    const result = await dataRpc({ method: "tools/call", params: { name: "data_sql", arguments: { sql: "DROP TABLE t" } } }, deps) as { isError?: boolean; structuredContent?: { code: string } };
    expect(result).toMatchObject({ isError: true, structuredContent: { code: "write_refused" } });
  });

  it("rejects other methods with a 400", async () => {
    const { deps } = harness();
    await expect(dataRpc({ method: "resources/list" }, deps)).rejects.toMatchObject({ status: 400 });
    await expect(dataRpc(null, deps)).rejects.toMatchObject({ status: 400 });
  });

  it("publishes a receipt only for a successfully displayed result", async () => {
    const { deps } = harness();
    const published: string[] = [];
    deps.onShow = (card) => published.push(card.id);
    const shown = await dataRpc({ method: "tools/call", params: { name: "data_show", arguments: { kind: "table", title: "Summary", sql: "SELECT 1" } } }, deps) as { structuredContent: Record<string, unknown> };
    expect(published).toEqual([shown.structuredContent.id]);
    await dataRpc({ method: "tools/call", params: { name: "data_show", arguments: { kind: "chart", chart: { type: "bar", x: "x" }, sql: "SELECT 1" } } }, deps);
    expect(published).toHaveLength(1);
    deps.assertActive = () => { throw new Error("Turn ended"); };
    await expect(dataRpc({ method: "tools/call", params: { name: "data_show", arguments: { kind: "table", sql: "SELECT 1" } } }, deps)).rejects.toThrow("Turn ended");
    expect(published).toHaveLength(1);
  });

  it("reads saved edits and publishes an updated receipt for the same result id", async () => {
    const { deps } = harness();
    const published: Array<{ id: string; sql?: string }> = [];
    deps.onShow = (card) => published.push({ id: card.id, sql: card.sql });
    const call = (name: string, args: Record<string, unknown>) => dataRpc({ method: "tools/call", params: { name, arguments: args } }, deps);
    await call("data_show", { kind: "table", title: "Summary", sql: "SELECT 1" });
    deps.sheet.updateCard("c_1", { sql: "SELECT 2", by: "person" });
    const read = await call("data_describe", { id: "c_1" });
    expect(read).toMatchObject({ structuredContent: { card: { id: "c_1", kind: "table", sql: "SELECT 2", by: "person" } } });
    expect(published).toEqual([{ id: "c_1", sql: "SELECT 1" }]);
    await call("data_show", { id: "c_1", sql: "SELECT 3" });
    expect(published).toEqual([{ id: "c_1", sql: "SELECT 1" }, { id: "c_1", sql: "SELECT 3" }]);
    expect(deps.sheet.cards()).toHaveLength(1);
    await call("data_show", { id: "c_1", sql: "DROP TABLE orders" });
    expect(published).toHaveLength(2);
    expect(deps.sheet.card("c_1")).toMatchObject({ status: "ready", sql: "SELECT 3" });
  });

  it("does not receipt a person's newer edit while the bot's committed result finishes cleanup", async () => {
    const { deps, database } = harness();
    const published: string[] = [];
    deps.onShow = (card) => published.push(card.sql!);
    const call = (args: Record<string, unknown>) => dataRpc({ method: "tools/call", params: { name: "data_show", arguments: args } }, deps);
    await call({ kind: "table", sql: "SELECT 1" });
    let cleanupStarted!: () => void;
    let finishCleanup!: () => void;
    const started = new Promise<void>((resolve) => { cleanupStarted = resolve; });
    const pendingCleanup = new Promise<void>((resolve) => { finishCleanup = resolve; });
    const dropResult = database.dropResult.bind(database);
    database.dropResult = async (name) => {
      if (name === "c_1") { cleanupStarted(); await pendingCleanup; }
      await dropResult(name);
    };
    const pending = call({ id: "c_1", sql: "SELECT 2" });
    await started;
    expect(deps.sheet.card("c_1")?.sql).toBe("SELECT 2");
    await showCard({ ...deps, by: "person", connection: "panel" }, { id: "c_1", sql: "SELECT 3", live: true });
    finishCleanup();
    const result = await pending;
    expect(result).toMatchObject({ structuredContent: { id: "c_1" } });
    expect(result).not.toHaveProperty("isError");
    expect(Object.keys(result)).toEqual(["content", "structuredContent"]);
    expect(result).not.toHaveProperty("structuredContent.card");
    expect(published).toEqual(["SELECT 1"]);
    expect(deps.sheet.card("c_1")).toMatchObject({ by: "person", sql: "SELECT 3", status: "ready" });
  });

  it("checks capability after commit before emitting a captured receipt", async () => {
    const { deps, database } = harness();
    const call = (args: Record<string, unknown>) => dataRpc({ method: "tools/call", params: { name: "data_show", arguments: args } }, deps);
    await call({ kind: "table", sql: "SELECT 1" });
    const published: string[] = [];
    deps.onShow = (card) => published.push(card.sql!);
    let active = true;
    deps.assertActive = () => { if (!active) throw new Error("Turn ended"); };
    database.dropResult = async () => { active = false; };
    await expect(call({ id: "c_1", sql: "SELECT 2" })).rejects.toThrow("Turn ended");
    expect(published).toEqual([]);
  });

  it("lists a derived table from the database's catalog, never from a copy on the sheet", async () => {
    const { deps } = harness();
    await dataRpc({ method: "tools/call", params: { name: "data_sql", arguments: { sql: 'CREATE TABLE "derived" AS SELECT 1' } } }, deps);
    expect(deps.sheet.sheet()).not.toHaveProperty("tables");
    const described = await dataRpc({ method: "tools/call", params: { name: "data_describe", arguments: {} } }, deps) as { structuredContent: { tables: unknown[] } };
    expect(described.structuredContent.tables).toEqual([{ name: "derived", rowCount: 3 }]);
  });
});
