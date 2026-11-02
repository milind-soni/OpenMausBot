import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ThreadStarters } from "./thread-starters.ts";

const ADA = `p_${"a".repeat(22)}`, BOB = `p_${"b".repeat(22)}`;
const dirs: string[] = [];
const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-starters-"));
  dirs.push(dir);
  const file = join(dir, "thread-starters.json");
  return { dir, file, starters: new ThreadStarters(file) };
};
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("durable thread owners", () => {
  it("does not retain a failed owner or skip its retry", () => {
    const { file, starters } = fixture();
    starters.set("ada-chat", ADA);
    const before = readFileSync(file, "utf8");
    rmSync(file);
    mkdirSync(file);
    expect(() => starters.set("bob-chat", BOB)).toThrow();
    expect(starters.get("bob-chat")).toBeUndefined();
    expect(starters.get("ada-chat")).toBe(ADA);
    rmSync(file, { recursive: true });
    writeFileSync(file, before);
    starters.set("bob-chat", BOB);
    const reloaded = new ThreadStarters(file);
    expect(reloaded.get("bob-chat")).toBe(BOB);
    expect(reloaded.get("ada-chat")).toBe(ADA);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("propagates EACCES without publishing an owner in memory", () => {
    const { dir, starters } = fixture();
    chmodSync(dir, 0o500);
    try {
      expect(() => starters.set("bob-chat", BOB)).toThrow(expect.objectContaining({ code: "EACCES" }));
      expect(starters.get("bob-chat")).toBeUndefined();
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  it("does not evict an existing private owner when the registry is full", () => {
    const { file } = fixture();
    writeFileSync(file, JSON.stringify(Object.fromEntries(Array.from({ length: 50_000 }, (_, i) => [`thread-${i}`, ADA]))));
    const starters = new ThreadStarters(file);
    expect(() => starters.set("bob-chat", BOB)).toThrow();
    expect(starters.get("thread-0")).toBe(ADA);
    expect(starters.get("bob-chat")).toBeUndefined();
    expect(new ThreadStarters(file).get("thread-0")).toBe(ADA);
  });

  it("retains the saved owner when reassignment cannot be persisted", () => {
    const { file, starters } = fixture();
    starters.set("ada-chat", ADA);
    rmSync(file);
    mkdirSync(file);
    expect(() => starters.reassign((person) => person === ADA, BOB)).toThrow();
    expect(starters.get("ada-chat")).toBe(ADA);
  });
});
