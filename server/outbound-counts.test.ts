// How many things left the building today, per bot. The cap is only as
// good as this count, so it has to survive a restart and roll over with the
// day rather than with the process.
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { OutboundCounts } from "./outbound-counts.ts";
import { removeTempDir } from "./testing/cleanup.ts";

let dir: string;
const file = () => join(dir, "outbound-counts.json");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omb-outbound-"));
});

afterEach(async () => {
  await removeTempDir(dir);
});

const morning = new Date(2026, 8, 7, 9, 0);
const evening = new Date(2026, 8, 7, 23, 30);
const nextDay = new Date(2026, 8, 8, 0, 10);

describe("OutboundCounts", () => {
  it("starts at zero with no file, and counts what is recorded", () => {
    const counts = new OutboundCounts(file());
    expect(existsSync(file())).toBe(false);
    expect(counts.today("b1", morning)).toBe(0);
    expect(counts.record("b1", morning)).toBe(1);
    expect(counts.record("b1", evening)).toBe(2);
    expect(counts.today("b1", evening)).toBe(2);
  });

  it("keeps bots apart", () => {
    const counts = new OutboundCounts(file());
    counts.record("b1", morning);
    expect(counts.today("b2", morning)).toBe(0);
  });

  it("rolls over at local midnight", () => {
    const counts = new OutboundCounts(file());
    counts.record("b1", evening);
    expect(counts.today("b1", nextDay)).toBe(0);
    expect(counts.record("b1", nextDay)).toBe(1);
  });

  it("survives a restart and keeps the file private", () => {
    new OutboundCounts(file()).record("b1", morning);
    const reopened = new OutboundCounts(file());
    expect(reopened.today("b1", morning)).toBe(1);
    if (process.platform !== "win32") expect(statSync(file()).mode & 0o777).toBe(0o600);
  });

  it("forgets days other than the one being written, so the file stays small", () => {
    const counts = new OutboundCounts(file());
    counts.record("b1", morning);
    counts.record("b1", nextDay);
    const reopened = new OutboundCounts(file());
    expect(reopened.today("b1", morning)).toBe(0);
    expect(reopened.today("b1", nextDay)).toBe(1);
  });
});
