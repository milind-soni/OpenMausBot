import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUuid } from "./random-uuid";

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("randomUuid", () => {
  it("uses crypto.randomUUID where the page has it", () => {
    vi.stubGlobal("crypto", { randomUUID: () => "11111111-2222-4333-8444-555555555555", getRandomValues: crypto.getRandomValues.bind(crypto) });
    expect(randomUuid()).toBe("11111111-2222-4333-8444-555555555555");
  });

  it("still makes v4 ids on plain http, where crypto.randomUUID is missing", () => {
    vi.stubGlobal("crypto", { getRandomValues: crypto.getRandomValues.bind(crypto) });
    const ids = Array.from({ length: 200 }, () => randomUuid());
    for (const id of ids) expect(id).toMatch(V4);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// A self-hosted server opened by its IP over plain http is not a secure
// context, so a bare crypto.randomUUID() call there throws and, in the
// composer, stopped every message from sending.
describe("browser code", () => {
  it("never calls crypto.randomUUID() without a fallback", () => {
    const src = join(import.meta.dirname, "..");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
          readFileSync(path, "utf8").split("\n").forEach((line, index) => {
            if (/(?<![?.])\bcrypto\.randomUUID\(\)/.test(line) && !/typeof crypto\?\.randomUUID/.test(line)) offenders.push(`${path.slice(src.length + 1)}:${index + 1}`);
          });
        }
      }
    };
    walk(src);
    expect(offenders).toEqual([]);
  });
});
