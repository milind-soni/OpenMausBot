import { spawnSync, execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { removeTempDir } from "../server/testing/cleanup.ts";
import { checksFor, pushedCommits } from "./pre-push-check.mjs";

const names = (files: string[]) => checksFor(files).map((check: { name: string }) => check.name);
const guards = (files: string[]) => checksFor(files).find((check: { name: string }) => check.name === "source guards")?.guards ?? [];

describe("what a push's changed files call for", () => {
  it("lints only the changed code", () => {
    const [lint] = checksFor(["server/a.ts", "docs/a.md", "src/b.tsx", "electron/c.mjs"]);
    expect(lint.args).toEqual(["--deny-warnings", "server/a.ts", "src/b.tsx", "electron/c.mjs"]);
  });

  it("checks nothing for docs alone", () => {
    expect(names(["README.md", "docs/ci.md"])).toEqual([]);
  });

  it("checks the catalogs only when one changed", () => {
    expect(names(["src/locales/de.json"])).toContain("locale catalogs");
    expect(names(["server/a.ts"])).not.toContain("locale catalogs");
  });

  it("runs a guard only when a source it reads changed", () => {
    expect(guards(["server/index.ts"])).toEqual(["scripts/testing/file-size-ratchet.test.ts", "src/locales/vocabulary.test.ts"]);
    expect(guards(["scripts/release-ci.mjs"])).toEqual(["scripts/testing/file-size-ratchet.test.ts"]);
    expect(guards(["src/locales/en.json"])).toEqual(["src/locales/vocabulary.test.ts"]);
    expect(guards(["server/a.test.ts", "server/testing/fake.ts"])).toEqual([]);
  });

  it("reads the pushed commits, and a deleted branch sends none", () => {
    const sha = "a".repeat(40);
    expect(pushedCommits(`refs/heads/x ${sha} refs/heads/x ${"0".repeat(40)}\n`)).toEqual([sha]);
    expect(pushedCommits(`(delete) ${"0".repeat(40)} refs/heads/x ${sha}\n`)).toEqual([]);
    expect(pushedCommits("")).toEqual([]);
  });
});

describe("the hook in a checkout without dependencies", () => {
  const dirs: string[] = [];
  afterAll(async () => { for (const dir of dirs) await removeTempDir(dir); });

  function checkout() {
    const dir = mkdtempSync(join(tmpdir(), "omb-pre-push-hook-"));
    dirs.push(dir);
    const repo = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
    repo("init", "-q");
    repo("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "start");
    mkdirSync(join(dir, "hooks"));
    const hook = join(dir, "hooks", "pre-push");
    copyFileSync(fileURLToPath(new URL("./git-hooks/pre-push", import.meta.url)), hook);
    chmodSync(hook, 0o755);
    return { dir, hook };
  }

  it.skipIf(process.platform === "win32")("lets the push go and says CI will check it", () => {
    const { dir, hook } = checkout();
    const run = spawnSync(hook, { cwd: dir, encoding: "utf8", input: "", timeout: 10_000 });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("no dependencies in this checkout");
  });

  it.skipIf(process.platform === "win32")("stays out of the way when skipped", () => {
    const { dir, hook } = checkout();
    writeFileSync(join(dir, "ignored"), "");
    const run = spawnSync(hook, { cwd: dir, encoding: "utf8", input: "", timeout: 10_000, env: { ...process.env, OMB_SKIP_HOOKS: "1" } });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("skipped");
  });
});
