import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { DATA_LIMITS } from "../../shared/data-surface.ts";
import { FakeDataDatabase } from "../testing/fake-data-database.ts";
import { dataRpc, type DataRpcDeps } from "./rpc.ts";
import { DataSheetStore } from "./sheet.ts";
import type { DataToolResult, SqlOutput } from "./tools.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "omb-data-sql-truncation-"));
  dirs.push(dir);
  const database = new FakeDataDatabase();
  const deps: DataRpcDeps = {
    database,
    sheet: new DataSheetStore({ botId: "bot-1", dir }),
    compileChart: () => { throw new Error("No chart in a SQL call"); },
    validateVegaLite: async () => ({}),
    renderer: { svg: async () => "<svg/>", png: async () => Buffer.alloc(0) },
    exportRoots: () => [dir],
    signal: new AbortController().signal,
    assertActive: () => {},
  };
  return {
    database,
    async call(sql: string): Promise<SqlOutput> {
      const result = await dataRpc({ method: "tools/call", params: { name: "data_sql", arguments: { sql } } }, deps) as DataToolResult;
      expect(result.isError).toBeUndefined();
      const output = result.structuredContent as unknown as SqlOutput;
      expect(JSON.parse(result.content[0]!.text)).toEqual(output);
      return output;
    },
  };
}

for (const sql of ["SELECT text FROM documents", "DESCRIBE documents"]) {
  it.each([2000, 2001])(`reports cell clipping in ${sql} at %i characters`, async (length) => {
    const { database, call } = harness();
    const value = "x".repeat(length);
    database.next = { columns: [{ name: "text", type: "VARCHAR" }], rows: [[value]] };

    const result = await call(sql);

    expect(result.rowCount).toBe(1);
    expect(result.rows).toEqual([[length > 2000 ? `${value.slice(0, 2000)}…` : value]]);
    expect(result.truncated).toBe(length > 2000);
    if (result.table) expect(database.results.get("q_1")!.rows).toEqual([[value]]);
  });
}

it.each([DATA_LIMITS.describeColumnsMax, DATA_LIMITS.describeColumnsMax + 1])(
  "reports reduced CREATE metadata for %i columns",
  async (count) => {
    const { database, call } = harness();
    database.next = {
      columns: Array.from({ length: count }, (_, index) => ({ name: `c${index}`, type: "INTEGER" })),
      rows: [Array.from({ length: count }, (_, index) => index)],
    };

    const result = await call('CREATE TABLE "wide" AS SELECT * FROM source');

    expect(result.table).toBe('"wide"');
    expect(result.rows).toEqual([]);
    expect(result.columns).toHaveLength(count);
    expect(result.truncated).toBe(count > DATA_LIMITS.describeColumnsMax);
    if (count > DATA_LIMITS.describeColumnsMax) expect(Object.keys(result.columns[0]!)).toEqual(["name", "type"]);
    else expect(result.columns[0]).toHaveProperty("nullPct", 0);
  },
);
