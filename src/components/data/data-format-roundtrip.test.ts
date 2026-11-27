import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { afterAll, beforeAll, expect, it } from "vitest";
import { cellText, tsv, type Cell } from "./data-format";

let instance: DuckDBInstance;
let connection: DuckDBConnection;
let directory: string;
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "omb-data-copy-"));
  instance = await DuckDBInstance.create(":memory:");
  connection = await instance.connect();
});
afterAll(() => {
  connection?.closeSync();
  instance?.closeSync();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

it.each([
  {
    name: "ordinary values",
    columns: ["id", "value", "optional"],
    rows: [["00012", 12.5, ""], ["9007199254740993", false, null]],
  },
  {
    name: "tabs, quoted text and multiline cells",
    columns: ["id", "notes\tand details", 'say "yes"', "optional"],
    rows: [
      ["00012", "line one\r\nline two\nline three\rline four", 'a\t"quoted"', ""],
      ["9007199254740993", "trailing\t", '"quoted"', null],
    ],
  },
])("round trips $name through DuckDB's tab-delimited reader", async ({ columns, rows }) => {
  const file = join(directory, "clipboard.tsv");
  writeFileSync(file, tsv(columns, rows as Cell[][]));
  const names = columns.map((name) => `'${name.replace(/'/g, "''")}'`).join(", ");
  const result = await connection.runAndReadAll(
    `SELECT * FROM read_csv($1, delim='\t', header=true, all_varchar=true, force_not_null=[${names}])`, [file],
  );
  expect(result.columnNames()).toEqual(columns);
  expect(result.getRowsJson()).toEqual(rows.map((row) => row.map(cellText)));
});
