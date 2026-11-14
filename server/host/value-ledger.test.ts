import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { anyValue, createValueLedger, minutesSaved, valueReport } from "./value-ledger.ts";

const DAY = 24 * 60 * 60_000;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("what the Chief did, counted as it happens", () => {
  it("keeps totals and dated counts across a restart, and says what was done since a time", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-value-"));
    dirs.push(dir);
    let now = Date.parse("2026-10-27T20:00:00Z");
    const ledger = createValueLedger({ dataDir: dir, now: () => now });
    ledger.add("sorted", 12);
    now += 8 * 60 * 60_000;
    const night = now - 60_000;
    ledger.add("drafted");
    ledger.add("prepped", 2);
    ledger.add("sorted", 0);
    ledger.add("sorted", -3);
    const again = createValueLedger({ dataDir: dir, now: () => now });
    expect(again.totals()).toEqual({ sorted: 12, drafted: 1, prepped: 2 });
    expect(again.since(night)).toEqual({ sorted: 0, drafted: 1, prepped: 2 });
    now += 15 * DAY;
    again.add("sorted", 1);
    expect(again.since(0)).toEqual({ sorted: 1, drafted: 0, prepped: 0 });
    expect(again.totals()).toEqual({ sorted: 13, drafted: 1, prepped: 2 });
  });

  it("adds up the minutes saved conservatively: one an email, five a draft, ten a meeting, three a routine", () => {
    expect(minutesSaved({ sorted: 40, drafted: 6, prepped: 4, routines: 0 })).toBe(110);
    expect(minutesSaved({ sorted: 0, drafted: 0, prepped: 0, routines: 2 })).toBe(6);
    expect(valueReport({ sorted: 2, drafted: 1, prepped: 0, routines: 1 })).toEqual({ sorted: 2, drafted: 1, prepped: 0, routines: 1, minutes: 10 });
    expect(anyValue({ sorted: 0, drafted: 0, prepped: 0, routines: 0 })).toBe(false);
    expect(anyValue({ sorted: 0, drafted: 0, prepped: 0, routines: 1 })).toBe(true);
  });
});
