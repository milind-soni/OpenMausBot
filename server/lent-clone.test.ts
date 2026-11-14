import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLentClones, runGit } from "./lent-clone.ts";

// Clones run only on a Cloud home, which is Linux; Windows holds a just-written .git a moment too long to move it.
describe.skipIf(process.platform === "win32")("cloning a lent GitHub repository", () => {
  let dir: string, origin: string, data: string, copy: string, head: string, now: number;
  const sh = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.test", ...args], { encoding: "utf8" }).trim();

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "omb-lent-clone-")));
    // A repository standing in for GitHub: a bare one with two commits on main.
    const work = join(dir, "work");
    mkdirSync(work);
    sh(work, "init", "--quiet", "--initial-branch", "main");
    writeFileSync(join(work, "plan.md"), "v1");
    sh(work, "add", "plan.md");
    sh(work, "commit", "--quiet", "-m", "one");
    head = sh(work, "rev-parse", "HEAD");
    writeFileSync(join(work, "plan.md"), "v2");
    sh(work, "commit", "--quiet", "-am", "two");
    sh(work, "checkout", "--quiet", "-b", "feature");
    writeFileSync(join(work, "plan.md"), "feature");
    sh(work, "commit", "--quiet", "-am", "feature");
    sh(work, "checkout", "--quiet", "main");
    origin = join(dir, "origin.git");
    execFileSync("git", ["clone", "--quiet", "--bare", work, origin]);
    // A partial clone needs a server that filters: the stand-in allows it.
    sh(origin, "config", "uploadpack.allowFilter", "true");
    data = join(dir, "data");
    copy = join(data, "sync", "lent", "Ash-MBP", "notes");
    mkdirSync(copy, { recursive: true });
    now = Date.UTC(2026, 9, 27);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const clones = (changed: string[] = []) => createLentClones({ dataDir: data, now: () => now, url: (repo) => (repo === "ash/notes" ? `file://${origin}` : `file://${join(dir, "missing.git")}`), changed: (id) => changed.push(id) });

  it("clones a lent GitHub repository into its empty copy, at the computer's commit on its branch, then wakes the desktop", async () => {
    const changed: string[] = [];
    const service = clones(changed);
    expect(service.start("pc-1", copy, { repo: "ash/notes", branch: "main", head })).toBe(true);
    expect(service.cloning("pc-1")).toBe(true);
    await service.idle();
    expect(service.cloning("pc-1")).toBe(false);
    expect(service.repo("pc-1")).toBe("ash/notes");
    expect(readFileSync(join(copy, "plan.md"), "utf8")).toBe("v1");
    expect(sh(copy, "rev-parse", "HEAD")).toBe(head);
    expect(sh(copy, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(changed).toEqual(["pc-1"]);
    expect(existsSync(join(data, "sync", "clones", "pc-1"))).toBe(false);
    // Once is enough.
    expect(service.start("pc-1", copy, { repo: "ash/notes", branch: "main", head })).toBe(false);
  });

  it("a commit GitHub doesn't have falls back to the branch as GitHub has it; Files sends the rest", async () => {
    const service = clones();
    service.start("pc-1", copy, { repo: "ash/notes", branch: "feature", head: "f".repeat(40) });
    await service.idle();
    expect(readFileSync(join(copy, "plan.md"), "utf8")).toBe("feature");
    expect(sh(copy, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feature");
  });

  it("a copy Files started filling while the clone ran stays Files': the clone is dropped", async () => {
    const service = createLentClones({ dataDir: data, now: () => now, url: () => `file://${origin}`, git: async (args) => {
      await runGit(args);
      if (args[0] === "clone") writeFileSync(join(copy, "plan.md"), "from Files");
    } });
    service.start("pc-1", copy, { repo: "ash/notes", branch: "main", head });
    await service.idle();
    expect(readdirSync(copy)).toEqual(["plan.md"]);
    expect(readFileSync(join(copy, "plan.md"), "utf8")).toBe("from Files");
    expect(service.repo("pc-1")).toBeNull();
  });

  it("a clone that can't be made leaves the copy empty for Files, and is tried again a day later", async () => {
    const changed: string[] = [];
    const service = clones(changed);
    expect(service.start("pc-1", copy, { repo: "ash/private", branch: "main", head })).toBe(true);
    await service.idle();
    expect(readdirSync(copy)).toEqual([]);
    expect(service.cloning("pc-1")).toBe(false);
    expect(service.repo("pc-1")).toBeNull();
    expect(changed).toEqual(["pc-1"]);
    expect(service.start("pc-1", copy, { repo: "ash/private", branch: "main", head })).toBe(false);
    now += 25 * 60 * 60_000;
    expect(service.start("pc-1", copy, { repo: "ash/private", branch: "main", head })).toBe(true);
    await service.idle();
  });

  it("never clones into a copy Files already filled, nor anything that is not a GitHub owner/name", async () => {
    writeFileSync(join(copy, "plan.md"), "from Files");
    const service = clones();
    expect(service.start("pc-1", copy, { repo: "ash/notes", branch: "main", head })).toBe(false);
    rmSync(join(copy, "plan.md"));
    for (const git of [{ repo: "../etc", branch: null, head: null }, { repo: "ash/notes", branch: "../x", head: null }, { repo: "ash/notes", branch: "--orphan", head: null }, { repo: "ash/notes;rm", branch: null, head: null }, null]) {
      expect(service.start("pc-2", copy, git)).toBe(false);
    }
  });

  it("one clone that fails in any way never stops the next", async () => {
    const other = join(data, "sync", "lent", "Ash-MBP", "other");
    mkdirSync(other, { recursive: true });
    let calls = 0, told = 0;
    // The first clone fails, and so does telling the desktop about it.
    const service = createLentClones({ dataDir: data, now: () => now, url: () => `file://${origin}`, git: async (args) => { if (calls++ === 0) throw new Error("boom"); await runGit(args); },
      changed: () => { if (told++ === 0) throw new Error("the desktop's poll is gone"); } });
    service.start("pc-1", copy, { repo: "ash/notes", branch: "main", head });
    service.start("pc-2", other, { repo: "ash/notes", branch: "main", head });
    await service.idle();
    expect(readdirSync(copy)).toEqual([]);
    expect(readFileSync(join(other, "plan.md"), "utf8")).toBe("v1");
  });

  it("a restart mid-clone hands the copy to Files", () => {
    const service = clones();
    service.start("pc-1", copy, { repo: "ash/notes", branch: "main", head });
    expect(clones().cloning("pc-1")).toBe(false);
    return service.idle();
  });

  it("git never asks for a sign-in: one it hasn't got fails at once", async () => {
    await expect(runGit(["ls-remote", "https://127.0.0.1:9/nobody/nothing.git"], 20_000)).rejects.toThrow();
  });
});
