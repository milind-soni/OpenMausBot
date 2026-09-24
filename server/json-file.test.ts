import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readJsonFile, restrictToOwner, writeJsonAtomic } from "./json-file.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gbs-json-file-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("writeJsonAtomic", () => {
  it("replaces the file, leaves no temp files, and is owner-only", () => {
    const p = join(dir, "bots.json");
    writeFileSync(p, "[1]");
    writeJsonAtomic(p, [{ id: "a" }]);
    expect(JSON.parse(readFileSync(p, "utf8"))).toEqual([{ id: "a" }]);
    expect(readdirSync(dir)).toEqual(["bots.json"]);
    if (process.platform !== "win32") expect(statSync(p).mode & 0o777).toBe(0o600);
  });
});

describe("readJsonFile", () => {
  it("returns the fallback for a missing file", () => {
    expect(readJsonFile(join(dir, "missing.json"), [])).toEqual([]);
  });

  it("moves a corrupt file aside instead of letting the next save erase it", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const p = join(dir, "config.json");
    writeFileSync(p, '{"xai":{"key":"sk-');
    expect(readJsonFile(p, {})).toEqual({});
    const kept = readdirSync(dir).filter((f) => f.startsWith("config.json.corrupt-"));
    expect(kept).toHaveLength(1);
    expect(readFileSync(join(dir, kept[0]!), "utf8")).toBe('{"xai":{"key":"sk-');
  });
});

describe("restrictToOwner", () => {
  it.skipIf(process.platform === "win32")("tightens a world-readable secrets file", () => {
    const p = join(dir, "config.json");
    writeFileSync(p, "{}", { mode: 0o644 });
    restrictToOwner(p);
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });
});
