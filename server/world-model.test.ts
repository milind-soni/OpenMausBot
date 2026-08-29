import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { WorldModel } from "./world-model.ts";

const dirs: string[] = [];
const models: WorldModel[] = [];

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "omb-world-model-"));
  dirs.push(dir);
  let now = 2_000;
  const model = new WorldModel({ file: join(dir, "world.db"), now: () => now });
  models.push(model);
  return { model, setNow: (value: number) => { now = value; } };
}

afterEach(() => {
  for (const model of models.splice(0)) model.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const claim = (overrides: Record<string, unknown> = {}) => ({
  botId: "chief",
  subject: { kind: "person" as const, name: "Jessica", aliases: ["Jess"] },
  predicate: "birthday",
  object: { kind: "value" as const, value: "August 30" },
  sourceId: "calendar-account-1",
  observedAt: 1_000,
  ttlMs: 5_000,
  confidence: 1,
  sensitivity: "internal" as const,
  evidenceRef: "calendar://event/1",
  ...overrides,
});

describe("WorldModel", () => {
  it("deduplicates repeated evidence and resolves aliases", () => {
    const h = harness();
    expect(h.model.assert(claim()).status).toBe("inserted");
    expect(h.model.assert(claim({ observedAt: 1_500 })).status).toBe("deduplicated");
    const result = h.model.resolve({ botId: "chief", subject: "Jess", predicate: "birthday" });
    expect(result.claims).toHaveLength(1);
    expect(result.claims[0]?.object).toEqual({ kind: "value", value: "August 30" });
  });

  it("supersedes a changed value from the same source", () => {
    const h = harness();
    h.model.assert(claim());
    expect(h.model.assert(claim({ object: { kind: "value", value: "August 31" }, observedAt: 2_000 })).status).toBe("superseded");
    const result = h.model.resolve({ botId: "chief", subject: "Jessica", predicate: "birthday" });
    expect(result.claims.map((entry) => entry.object)).toEqual([{ kind: "value", value: "August 31" }]);
    expect(result.conflicts).toHaveLength(0);
  });

  it("keeps cross-source disagreement visible as a conflict", () => {
    const h = harness();
    h.model.assert(claim());
    h.model.assert(claim({ sourceId: "messages", object: { kind: "value", value: "August 29" }, evidenceRef: "messages://1" }));
    const result = h.model.resolve({ botId: "chief", subject: "Jessica", predicate: "birthday" });
    expect(result.claims).toHaveLength(2);
    expect(result.conflicts[0]?.values).toEqual(expect.arrayContaining(["August 30", "August 29"]));
  });

  it("filters stale and sensitive claims unless explicitly requested", () => {
    const h = harness();
    h.model.assert(claim({ sensitivity: "sensitive", ttlMs: 500 }));
    h.setNow(3_000);
    expect(h.model.resolve({ botId: "chief", subject: "Jessica" }).claims).toHaveLength(0);
    const result = h.model.resolve({ botId: "chief", subject: "Jessica", includeSensitive: true, includeStale: true });
    expect(result.claims[0]?.freshness).toBe("stale");
  });

  it("stores entity-valued relationships", () => {
    const h = harness();
    h.model.assert(claim({ predicate: "works_on", object: { kind: "entity", entity: { kind: "project", name: "Agent Centipede" } } }));
    const result = h.model.resolve({ botId: "chief", subject: "Jess", predicate: "works_on" });
    expect(result.claims[0]?.object).toMatchObject({ kind: "entity", entity: { name: "Agent Centipede" } });
    expect(h.model.statistics()).toMatchObject({ entities: 2, activeClaims: 1, conflicts: 0 });
  });

  it("summarizes one agent without leaking another agent's memory counts", () => {
    const h = harness();
    h.model.assert(claim());
    h.model.assert(claim({ botId: "research", observedAt: 1_900 }));
    expect(h.model.statistics("chief")).toMatchObject({
      entities: 1,
      activeClaims: 1,
      latestObservedAt: 1_000,
    });
    expect(h.model.statistics()).toMatchObject({ entities: 2, activeClaims: 2, latestObservedAt: 1_900 });
  });
});
