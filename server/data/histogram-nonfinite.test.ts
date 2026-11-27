import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createDataEngine } from "./engine.ts";

const root = mkdtempSync(join(tmpdir(), "omb-histogram-finite-"));
const engine = createDataEngine({ botFolder: (id) => join(root, id), dataDir: join(root, "data") });
const connection = "bot" as const;
afterAll(async () => {
  await engine.closeAll();
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("histograms with non-finite numeric and temporal values", () => {
  it("keeps finite buckets when floating data includes NaN and both infinities", async () => {
    const db = await engine.forBot("mixed-numeric");
    await db.run("CREATE TABLE samples AS SELECT * FROM (VALUES (1.0::DOUBLE), (2.0), ('NaN'::DOUBLE), ('Infinity'::DOUBLE), ('-Infinity'::DOUBLE), (NULL)) t(value)", { connection });
    expect((await db.histogram("samples", "value", { bins: 2 })).bins).toEqual([
      { label: "1 – 1.5", count: 1 }, { label: "1.5 – 2", count: 1 },
    ]);
  });

  it.each(["DOUBLE", "DATE", "TIMESTAMP"])("returns no buckets for an entirely non-finite %s column", async (type) => {
    const db = await engine.forBot(`empty-${type.toLowerCase()}`);
    await db.run(`CREATE TABLE samples AS SELECT * FROM (VALUES ('infinity'::${type}), ('-infinity'::${type}), (NULL)) t(value)`, { connection });
    expect((await db.histogram("samples", "value", { bins: 4 })).bins).toEqual([]);
  });

  it("preserves a constant finite distribution beside NaN", async () => {
    const db = await engine.forBot("constant-numeric");
    await db.run("CREATE TABLE samples AS SELECT * FROM (VALUES (7.0::DOUBLE), (7.0), ('NaN'::DOUBLE), ('Infinity'::DOUBLE)) t(value)", { connection });
    expect((await db.histogram("samples", "value", { bins: 10 })).bins).toEqual([{ label: "7", count: 2 }]);
  });

  it.each(["DATE", "TIMESTAMP"])("does not count infinite %s values in the first finite bucket", async (type) => {
    const db = await engine.forBot(`mixed-${type.toLowerCase()}`);
    await db.run(`CREATE TABLE samples AS SELECT * FROM (VALUES ('2026-01-01'::${type}), ('2026-01-05'::${type}), ('infinity'::${type}), ('-infinity'::${type}), (NULL)) t(value)`, { connection });
    const bins = (await db.histogram("samples", "value", { bins: 2 })).bins;
    expect(bins.map((bin) => bin.count)).toEqual([1, 1]);
    expect(bins[0].label).toMatch(/^2026-01-01/);
    expect(bins[1].label).toMatch(/^2026-01-03/);
  });

  it("retains non-finite-looking strings as ordinary categorical labels", async () => {
    const db = await engine.forBot("strings");
    await db.run("CREATE TABLE samples AS SELECT * FROM (VALUES ('NaN'), ('Infinity'), ('Infinity'), ('-Infinity'), (NULL)) t(value)", { connection });
    expect((await db.histogram("samples", "value")).bins).toEqual([
      { label: "Infinity", count: 2 }, { label: "-Infinity", count: 1 }, { label: "NaN", count: 1 },
    ]);
  });
});
