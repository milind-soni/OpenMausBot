import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { adoptSavedTimeZone, knownTimeZone, TIME_ZONE_FILE, useTimeZone } from "./time-zone.ts";

const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "omb-zone-casing-")); dirs.push(dir); return dir; };
const at = Date.parse("2026-07-01T12:00:00Z");
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the IANA spelling used by the process clock", () => {
  it.each([
    ["europe/berlin", "Europe/Berlin", 14],
    ["america/new_york", "America/New_York", 8],
    ["ASIA/TOKYO", "Asia/Tokyo", 21],
  ] as const)("runs in %s when Intl accepts its case", (input, canonical, hour) => {
    vi.stubEnv("TZ", "UTC");
    const dataDir = temp();
    const zone = knownTimeZone(input)!;
    expect(useTimeZone(dataDir, zone)).toBe(true);
    expect(new Date(at).getHours()).toBe(hour);
    expect(process.env.TZ).toBe(canonical);
    expect(JSON.parse(readFileSync(join(dataDir, TIME_ZONE_FILE), "utf8")).timeZone).toBe(canonical);
    expect(useTimeZone(dataDir, knownTimeZone(canonical)!)).toBe(false);
  });

  it("repairs a previously saved mixed-case zone before the process clock adopts it", () => {
    vi.stubEnv("TZ", "UTC");
    const dataDir = temp();
    writeFileSync(join(dataDir, TIME_ZONE_FILE), JSON.stringify({ version: 1, timeZone: "eUrOpE/bErLiN" }));
    adoptSavedTimeZone(dataDir);
    expect(new Date(at).getHours()).toBe(14);
    expect(process.env.TZ).toBe("Europe/Berlin");
  });

  it("keeps a recognized alias's offset when normalizing its spelling", () => {
    vi.stubEnv("TZ", "UTC");
    const zone = knownTimeZone("asia/kolkata")!;
    useTimeZone(temp(), zone);
    expect([new Date(at).getHours(), new Date(at).getMinutes()]).toEqual([17, 30]);
    expect(knownTimeZone(zone)).toBe(zone);
  });
});
