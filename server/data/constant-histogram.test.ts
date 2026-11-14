import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { createDataEngine } from "./engine.ts";

const root = mkdtempSync(join(tmpdir(), "omb-constant-histogram-"));
const engine = createDataEngine({ botFolder: (id) => join(root, id), dataDir: join(root, "data") });
const connection = "bot" as const;
afterAll(async () => {
  await engine.closeAll();
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("constant column histograms", () => {
  it.each([
    ["integer", "7::INTEGER", "7"],
    ["decimal", "2.5::DECIMAL(8, 2)", "2.5"],
    ["date", "DATE '2026-11-13'", "2026-11-13"],
    ["timestamp", "TIMESTAMP '2026-11-13 12:30:00'", "2026-11-13 12:30"],
  ])("counts every non-null value in a constant %s column", async (name, expression, label) => {
    const db = await engine.forBot(name);
    await db.run(`CREATE TABLE values_to_count AS SELECT ${expression} AS value FROM range(3) UNION ALL SELECT NULL`, { connection });
    for (const bins of [2, 20, 200]) {
      expect((await db.histogram("values_to_count", "value", { bins })).bins).toEqual([{ label, count: 3 }]);
    }
  });

  it("keeps an all-null numeric column empty", async () => {
    const db = await engine.forBot("nulls");
    await db.run("CREATE TABLE values_to_count AS SELECT NULL::DOUBLE AS value FROM range(3)", { connection });
    expect((await db.histogram("values_to_count", "value")).bins).toEqual([]);
  });

  it("keeps the maximum value in the last bin for a nonconstant column", async () => {
    const db = await engine.forBot("range");
    await db.run("CREATE TABLE values_to_count AS SELECT range AS value FROM range(5)", { connection });
    expect((await db.histogram("values_to_count", "value", { bins: 2 })).bins).toEqual([
      { label: "0 – 2", count: 2 }, { label: "2 – 4", count: 3 },
    ]);
  });
});
