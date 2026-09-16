// Phase 3 part 1: a project's checks, discovered and run by the harness,
// and the one line that says what ran. Pure discovery, then real child
// processes in a temp folder.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeTempDir } from "./testing/cleanup.ts";
import { discoverGates, runGates, scopeLine, type GateResult } from "./gates.ts";

const dirs: string[] = [];
const temp = () => { const d = mkdtempSync(join(tmpdir(), "omb-gates-")); dirs.push(d); return d; };
afterEach(async () => { for (const d of dirs.splice(0)) await removeTempDir(d); });

describe("gate discovery", () => {
  it("takes the declared sequence in .openmausbot/gates.json first, in the order written", () => {
    const cwd = temp();
    mkdirSync(join(cwd, ".openmausbot"));
    writeFileSync(join(cwd, ".openmausbot", "gates.json"), JSON.stringify([{ name: "unit", run: "node -e 0" }, { name: "types", run: "tsc -p ." }]));
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }));
    expect(discoverGates(cwd)).toEqual([{ name: "unit", command: "node -e 0" }, { name: "types", command: "tsc -p ." }]);
  });
  it("otherwise reads typecheck, lint, test, build from package.json in that order, through the lockfile's package manager", () => {
    const cwd = temp();
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts: { build: "x", test: "y", lint: "z", start: "s", typecheck: "t" } }));
    writeFileSync(join(cwd, "pnpm-lock.yaml"), "");
    expect(discoverGates(cwd).map((g) => `${g.name}: ${g.command}`)).toEqual(["typecheck: pnpm run typecheck", "lint: pnpm run lint", "test: pnpm run test", "build: pnpm run build"]);
    const yarn = temp();
    writeFileSync(join(yarn, "package.json"), JSON.stringify({ scripts: { test: "y" } }));
    writeFileSync(join(yarn, "yarn.lock"), "");
    expect(discoverGates(yarn)).toEqual([{ name: "test", command: "yarn run test" }]);
    const npm = temp();
    writeFileSync(join(npm, "package.json"), JSON.stringify({ scripts: { lint: "l" } }));
    expect(discoverGates(npm)).toEqual([{ name: "lint", command: "npm run lint" }]);
  });
  it("finds nothing in a folder with no scripts, a broken package.json, or no folder", () => {
    const cwd = temp();
    expect(discoverGates(cwd)).toEqual([]);
    writeFileSync(join(cwd, "package.json"), "{not json");
    expect(discoverGates(cwd)).toEqual([]);
    expect(discoverGates(join(cwd, "missing"))).toEqual([]);
    expect(discoverGates(undefined)).toEqual([]);
  });
  it("ignores a malformed declared file rather than throwing", () => {
    const cwd = temp();
    mkdirSync(join(cwd, ".openmausbot"));
    writeFileSync(join(cwd, ".openmausbot", "gates.json"), JSON.stringify({ name: "not a list" }));
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts: { test: "y" } }));
    expect(discoverGates(cwd)).toEqual([{ name: "test", command: "npm run test" }]);
  });
});

describe("gate runs", () => {
  it("runs every gate in order, records pass and fail with the output tail, and never stops at the first failure", async () => {
    const cwd = temp();
    const results = await runGates(cwd, [
      { name: "typecheck", command: "node -e \"console.log('ok')\"" },
      { name: "test", command: "node -e \"console.error('2 failed'); process.exit(1)\"" },
      { name: "build", command: "node -e 0" },
    ], { timeoutMs: 10_000 });
    expect(results.map((r) => `${r.name}:${r.status}`)).toEqual(["typecheck:pass", "test:fail", "build:pass"]);
    expect(results[1].tail).toContain("2 failed");
    expect(results[0].seconds).toBeGreaterThanOrEqual(0);
  });
  it("marks a gate that outlives its timeout and moves on", async () => {
    const cwd = temp();
    const results = await runGates(cwd, [
      { name: "slow", command: "node -e \"setTimeout(() => {}, 60000)\"" },
      { name: "after", command: "node -e 0" },
    ], { timeoutMs: 500 });
    expect(results.map((r) => r.status)).toEqual(["timeout", "pass"]);
  }, 15_000);
  it("marks a command that cannot start as fail with the reason", async () => {
    const results = await runGates(temp(), [{ name: "ghost", command: "definitely-not-a-command-xyz --version" }], { timeoutMs: 5_000 });
    expect(results[0].status).toBe("fail");
    expect(results[0].tail.length).toBeGreaterThan(0);
  });
});

describe("the scope line", () => {
  const r = (name: string, status: GateResult["status"], seconds = 3, tail = ""): GateResult => ({ name, status, seconds, tail });
  it("names every gate with its outcome, and says which declared gates were not run", () => {
    expect(scopeLine([r("typecheck", "pass", 12), r("lint", "pass", 4), r("test", "fail", 30, "…\n2 failed")], ["typecheck", "lint", "test", "build"]))
      .toBe("Gates: typecheck pass (12 s), lint pass (4 s), test fail (30 s); build not run.");
  });
  it("says so when a folder declares no gates", () => {
    expect(scopeLine([], [])).toBe("Gates: none declared for this folder; nothing was run.");
  });
  it("reports a timeout as such", () => {
    expect(scopeLine([r("test", "timeout", 600)], ["test"])).toBe("Gates: test timed out (600 s).");
  });
});
