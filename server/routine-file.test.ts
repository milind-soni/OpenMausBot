import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { keepUnreadableAside, readRoutineFile } from "./routine-file.ts";

const dirs: string[] = [];
const tempFile = () => { const dir = mkdtempSync(join(tmpdir(), "omb-routine-file-")); dirs.push(dir); return join(dir, "routines.json"); };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("reading routines.json", () => {
  it("tells a file that is not there from one that cannot be read", () => {
    const file = tempFile();
    expect(readRoutineFile(file, 0)).toEqual({ state: "missing" });
    writeFileSync(file, '{"version":1,"routines":[{"name":"Secret plan"');
    expect(readRoutineFile(file, 0)).toEqual({ state: "unreadable", reason: "invalid JSON" });
    writeFileSync(file, "[]");
    expect(readRoutineFile(file, 0)).toEqual({ state: "unreadable", reason: "Invalid routines file" });
    writeFileSync(file, JSON.stringify({ version: 1, routines: [], runs: "none" }));
    expect(readRoutineFile(file, 0)).toEqual({ state: "unreadable", reason: "Invalid routines file: runs is not a list" });
  });

  it("reads a saved file back, with the text it was read from", () => {
    const file = tempFile();
    const text = JSON.stringify({ version: 1, frozenResultsCleared: true, routines: [], runs: [], holds: ["no_connections"], startupLaunchId: "launch-1" });
    writeFileSync(file, text);
    expect(readRoutineFile(file, 0)).toMatchObject({ state: "ok", text, routines: [], runs: [], frozenPending: false, holds: ["no_connections"], startupLaunchId: "launch-1", malformedAttachments: false, noStartOffsChecked: false });
    writeFileSync(file, JSON.stringify({ version: 1, routines: [], runs: [], noStartOffsChecked: true }));
    expect(readRoutineFile(file, 0)).toMatchObject({ state: "ok", noStartOffsChecked: true, startupLaunchId: undefined });
  });
});

describe("an unreadable routines.json", () => {
  it("is copied beside itself once per content, private to its owner, and stays where it is", () => {
    const file = tempFile();
    const broken = '{"version":1,"routines":[{"name":"Morning check"';
    writeFileSync(file, broken);
    const aside = keepUnreadableAside(file)!;
    expect(aside).toMatch(/routines\.json\.unreadable-[0-9a-f]{12}$/);
    expect(readFileSync(aside, "utf8")).toBe(broken);
    expect(readFileSync(file, "utf8")).toBe(broken);
    if (process.platform !== "win32") expect(statSync(aside).mode & 0o777).toBe(0o600);
    expect(keepUnreadableAside(file)).toBe(aside);
    expect(readdirSync(dirname(file)).sort()).toEqual(["routines.json", basename(aside)].sort());
  });

  it("keeps a copy of each different content, up to five", () => {
    const file = tempFile();
    for (let index = 0; index < 5; index += 1) { writeFileSync(file, `{broken ${index}`); expect(keepUnreadableAside(file)).not.toBeNull(); }
    writeFileSync(file, "{broken again");
    expect(keepUnreadableAside(file)).toBeNull();
    expect(readdirSync(dirname(file)).filter((name) => name.includes(".unreadable-"))).toHaveLength(5);
    expect(readFileSync(file, "utf8")).toBe("{broken again");
  });

  it("answers null when there is no file to copy", () => {
    expect(keepUnreadableAside(tempFile())).toBeNull();
  });
});
