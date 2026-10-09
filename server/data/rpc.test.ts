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
});
