import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { settledFileCache, settledFileStamp } from "./settled-file.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function settledFile(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), "omb-settled-"));
  dirs.push(dir);
  const path = join(dir, "config.json");
  writeFileSync(path, text);
  const past = new Date(Date.now() - 60_000);
  utimesSync(path, past, past);
  return path;
}

describe("settledFileCache", () => {
  it("parses once while the file is unchanged, again after it changes or forget()", () => {
    const path = settledFile('{"a":1}');
    const parse = vi.fn(() => JSON.parse(readFileSync(path, "utf8")) as { a: number });
    const cache = settledFileCache(() => path, parse);
    for (let i = 0; i < 100; i++) expect(cache.read()).toEqual({ a: 1 });
    expect(parse).toHaveBeenCalledTimes(1);
    cache.forget();
    cache.read();
    expect(parse).toHaveBeenCalledTimes(2);
    writeFileSync(path, '{"a":22}');
    const past = new Date(Date.now() - 30_000);
    utimesSync(path, past, past);
    expect(cache.read()).toEqual({ a: 22 });
    expect(parse).toHaveBeenCalledTimes(3);
  });

  it("never keeps a file written in the last two seconds, a missing file or a parse that threw", () => {
    const path = settledFile('{"a":1}');
    writeFileSync(path, '{"a":2}');
    expect(settledFileStamp(path)).toBeNull();
    const parse = vi.fn(() => 1);
    const fresh = settledFileCache(() => path, parse);
    fresh.read(); fresh.read();
    expect(parse).toHaveBeenCalledTimes(2);
    expect(settledFileStamp(join(path, "..", "missing.json"))).toBeNull();
    const old = settledFile("{}");
    let fail = true;
    const flaky = settledFileCache(() => old, () => { if (fail) throw new Error("bad"); return 3; });
    expect(() => flaky.read()).toThrow("bad");
    fail = false;
    expect(flaky.read()).toBe(3);
  });
});
