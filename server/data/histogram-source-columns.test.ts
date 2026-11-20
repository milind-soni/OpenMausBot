import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { createDataEngine } from "./engine.ts";

const root = mkdtempSync(join(tmpdir(), "omb-histogram-columns-"));
const engine = createDataEngine({ botFolder: (id) => join(root, id), dataDir: join(root, "data") });
const connection = "bot" as const;

afterAll(async () => {
  await engine.closeAll();
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("histogram source columns alongside range columns", () => {
  it.each([
    ["lo", "lower-lo"], ["hi", "lower-hi"], ["LO", "upper-lo"], ["Hi", "mixed-hi"],
  ])("counts numeric source values named %s", async (name, botId) => {
    const db = await engine.forBot(botId);
    await db.run(`CREATE TABLE measurements AS SELECT range AS "${name}" FROM range(5)`, { connection });
    expect((await db.histogram("measurements", name, { bins: 2 })).bins).toEqual([
      { label: "0 – 2", count: 2 }, { label: "2 – 4", count: 3 },
    ]);
  });

  it.each(["lo", "hi"])("counts temporal source values named %s", async (name) => {
    const db = await engine.forBot(`temporal-${name}`);
    await db.run(`CREATE TABLE measurements AS SELECT DATE '2026-01-01' + range::INTEGER AS "${name}" FROM range(5)`, { connection });
    expect((await db.histogram("measurements", name, { bins: 2 })).bins).toEqual([
      { label: "2026-01-01", count: 2 }, { label: "2026-01-03", count: 3 },
    ]);
  });

  it("preserves categorical values named lo", async () => {
    const db = await engine.forBot("categorical");
    await db.run("CREATE TABLE measurements AS SELECT * FROM (VALUES ('small'), ('large'), ('large')) t(lo)", { connection });
    expect((await db.histogram("measurements", "lo", { bins: 2 })).bins).toEqual([
      { label: "large", count: 2 }, { label: "small", count: 1 },
    ]);
  });
});
