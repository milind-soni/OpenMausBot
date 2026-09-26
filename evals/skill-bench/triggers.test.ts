import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// E4 fixture QA: the trigger sets are data only (no router runs them),
// so their contract is pinned structurally — unique ids, honest splits,
// and texts that actually contain (or avoid) the declared trigger terms
// the way their set claims. R3's router validation inherits these guards.
interface TriggerEntry {
  id: string;
  text: string;
  because: string;
}

const triggersDir = dirname(fileURLToPath(import.meta.url));
const set = JSON.parse(readFileSync(join(triggersDir, "triggers", "bench-triage-handoff.json"), "utf8")) as {
  skill: string;
  triggerTerms: string[];
  shouldTrigger: { train: TriggerEntry[]; heldOut: TriggerEntry[] };
  shouldNotTrigger: { train: TriggerEntry[]; heldOut: TriggerEntry[] };
  nearMiss: TriggerEntry[];
};

const containsTerm = (text: string): boolean =>
  set.triggerTerms.some((term) => text.toLowerCase().includes(term.toLowerCase()));

describe("trigger-eval fixture set (bench-triage-handoff)", () => {
  it("has honest train/held-out splits and near misses", () => {
    for (const group of [set.shouldTrigger, set.shouldNotTrigger]) {
      expect(group.train.length).toBeGreaterThanOrEqual(4);
      expect(group.heldOut.length).toBeGreaterThanOrEqual(3);
    }
    expect(set.nearMiss.length).toBeGreaterThanOrEqual(4);
  });

  it("uses globally unique ids with a reason for every prompt", () => {
    const entries = [...set.shouldTrigger.train, ...set.shouldTrigger.heldOut, ...set.shouldNotTrigger.train, ...set.shouldNotTrigger.heldOut, ...set.nearMiss];
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(entries.length);
    for (const entry of entries) {
      expect(entry.text.trim().length).toBeGreaterThan(0);
      expect(entry.because.trim().length).toBeGreaterThan(0);
    }
  });

  it("should-trigger texts contain a trigger term and should-not-trigger texts contain none", () => {
    for (const entry of [...set.shouldTrigger.train, ...set.shouldTrigger.heldOut]) {
      expect(containsTerm(entry.text), entry.id + ": " + entry.text).toBe(true);
    }
    for (const entry of [...set.shouldNotTrigger.train, ...set.shouldNotTrigger.heldOut]) {
      expect(containsTerm(entry.text), entry.id + ": " + entry.text).toBe(false);
    }
  });

  it("near misses contain the term but must not fire — the over-trigger set for R3", () => {
    for (const entry of set.nearMiss) {
      expect(containsTerm(entry.text), entry.id + ": " + entry.text).toBe(true);
    }
  });
});
