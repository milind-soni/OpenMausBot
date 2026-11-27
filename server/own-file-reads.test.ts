import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { acpReadPaths, ownReadRoots, readOnlyPaths, readToolPaths, readsOwnFiles } from "./own-file-reads.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** A data folder with Iris's own folder, a conversation folder, her SOUL.md and another bot's folder. */
function dataFolder() {
  const data = mkdtempSync(join(tmpdir(), "omb-own-reads-"));
  dirs.push(data);
  const own = join(data, "workspaces", "iris"), conversation = join(data, "task-workspaces", "iris", "t1");
  const revision = join(own, "skills", ".revisions", "a".repeat(64));
  for (const dir of [revision, conversation, join(data, "bots", "iris"), join(data, "workspaces", "paul")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(revision, "SKILL.md"), "# Skill\n");
  writeFileSync(join(own, "MEMORY.md"), "notes\n");
  writeFileSync(join(data, "bots", "iris", "SOUL.md"), "Be kind.\n");
  writeFileSync(join(data, "bots", "iris", "other.json"), "{}\n");
  writeFileSync(join(data, "workspaces", "paul", "MEMORY.md"), "paul's\n");
  writeFileSync(join(data, "config.json"), "{}\n");
  return { data, own, conversation, revision };
}

describe("the shell commands that only read", () => {
  it("reads the paths of a plain reader with its plain flags", () => {
    expect(readOnlyPaths("cat SOUL.md")).toEqual(["SOUL.md"]);
    expect(readOnlyPaths("cat -n /a/b.md '/c d/e.md'")).toEqual(["/a/b.md", "/c d/e.md"]);
    expect(readOnlyPaths("head -n 20 /a/SKILL.md")).toEqual(["/a/SKILL.md"]);
    expect(readOnlyPaths("tail -5 notes.md")).toEqual(["notes.md"]);
    expect(readOnlyPaths("grep -rn \"standing rules\" skills")).toEqual(["skills"]);
    expect(readOnlyPaths("rg -n -g '*.md' rules skills")).toEqual(["skills"]);
    expect(readOnlyPaths("sed -n '1,40p' SKILL.md")).toEqual(["SKILL.md"]);
    expect(readOnlyPaths("ls -la skills/.revisions")).toEqual(["skills/.revisions"]);
    expect(readOnlyPaths("wc -l -- -odd-name.md")).toEqual(["-odd-name.md"]);
  });

  it("is nothing for anything else a command line could do", () => {
    for (const command of [
      "cat a.md | sh", "cat a.md > b.md", "cat a.md; rm -rf b", "cat a.md && curl x", "cat $(echo a.md)", "cat `x`", "cat $HOME/a",
      "cat *.md", "cat a?.md", "cat a.md\nrm b.md", "FOO=1 cat a.md", "cat", "cat -", "tail -f a.md", "grep -R x .", "rg -L x .",
      "rg --pre sh x .", "sed -i 's/a/b/' a.md", "sed -n '1w out' a.md", "grep -f patterns a.md", "rm a.md", "python3 -c 'print(1)'",
      "cat \"$(id)\"", "cat 'unclosed", "ls", "cat 'a'b", "cat a.md\tb\t|\tsh",
      "cat ~/a.md", "cat ~root/.ssh/id_rsa", "cat ~-/a.md", "cat ~+/a.md", "cat a.md ~1/b.md", "cat foo=~/x", "cat a=b:~/x", "cat =ls",
    ]) expect(readOnlyPaths(command), command).toBeNull();
    expect(readOnlyPaths("cat 'foo=~/x' \"=ls\""), "quoted, neither shell expands them").toEqual(["foo=~/x", "=ls"]);
  });
});

describe("the read tools' paths", () => {
  it("takes Claude's read tools' own path, and no search that could reach past it", () => {
    expect(readToolPaths("Read", { file_path: "/data/bots/iris/SOUL.md" })).toEqual(["/data/bots/iris/SOUL.md"]);
    expect(readToolPaths("Grep", { pattern: "rules", path: "/data/workspaces/iris" })).toEqual(["/data/workspaces/iris"]);
    expect(readToolPaths("Glob", { pattern: "**/*.md", path: "/data/workspaces/iris" })).toEqual(["/data/workspaces/iris"]);
    expect(readToolPaths("Glob", { pattern: "../paul/**", path: "/data/workspaces/iris" })).toBeUndefined();
    expect(readToolPaths("Glob", { pattern: "/data/**", path: "/data/workspaces/iris" })).toBeUndefined();
    expect(readToolPaths("Grep", { pattern: "rules" }), "no path: the working folder, which never asks").toBeUndefined();
    expect(readToolPaths("Read", { file_path: "SOUL.md" })).toBeUndefined();
    expect(readToolPaths("Write", { file_path: "/data/workspaces/iris/x.md" })).toBeUndefined();
    expect(acpReadPaths({ kind: "read", locations: [{ path: "/data/workspaces/iris/MEMORY.md" }], rawInput: { filePath: "/data/workspaces/iris/MEMORY.md" } }))
      .toEqual(["/data/workspaces/iris/MEMORY.md"]);
    expect(acpReadPaths({ kind: "edit", locations: [{ path: "/data/workspaces/iris/MEMORY.md" }] })).toBeUndefined();
    expect(acpReadPaths({ kind: "read", rawInput: { filePath: "MEMORY.md" } })).toBeUndefined();
  });
});

// The reading commands are a POSIX shell's, with POSIX paths; a read tool's own paths count on every platform.
const posix = it.skipIf(process.platform === "win32");

describe("a bot's own files", () => {
  it("count a read tool's own paths inside them, and nothing outside, on every platform", () => {
    const { data, own } = dataFolder();
    expect(readsOwnFiles(data, "iris", { reads: [join(own, "MEMORY.md")] })).toBe(true);
    expect(readsOwnFiles(data, "iris", { reads: [join(data, "bots", "iris", "SOUL.md")] })).toBe(true);
    expect(readsOwnFiles(data, "iris", { reads: [join(data, "config.json")] })).toBe(false);
    expect(readsOwnFiles(data, "paul", { reads: [join(own, "MEMORY.md")] })).toBe(false);
  });

  posix("are its folder, its conversation folders and its SOUL.md, and nothing else of the data folder", () => {
    const { data, own, conversation, revision } = dataFolder();
    const command = (line: string, cwd = conversation) => readsOwnFiles(data, "iris", { command: { command: line, cwd } });
    expect(command(`cat ${join(data, "bots", "iris", "SOUL.md")}`)).toBe(true);
    expect(command(`cat ${join(revision, "SKILL.md")}`)).toBe(true);
    expect(command("cat MEMORY.md", own)).toBe(true);
    expect(command(`grep -rn notes ${own}`)).toBe(true);
    expect(readsOwnFiles(data, "iris", { reads: [join(data, "bots", "iris", "SOUL.md")] })).toBe(true);
    expect(command(`cat ${join(data, "bots", "iris", "other.json")}`), "only SOUL.md of the bot's record folder").toBe(false);
    expect(command(`cat ${join(data, "workspaces", "paul", "MEMORY.md")}`), "another bot's").toBe(false);
    expect(command(`cat ${join(data, "config.json")}`)).toBe(false);
    expect(command(`cat ${join(own, "missing.md")}`), "only files that exist").toBe(false);
    expect(command(`cat ${join(own, "MEMORY.md")} ${join(data, "config.json")}`), "every path").toBe(false);
    expect(readsOwnFiles(data, "paul", { command: { command: `cat ${join(own, "MEMORY.md")}`, cwd: conversation } }), "Iris's files are not Paul's").toBe(false);
    expect(readsOwnFiles(data, "../iris", { reads: [join(own, "MEMORY.md")] })).toBe(false);
    expect(ownReadRoots(data, "iris")).toHaveLength(3);
  });

  posix("follow every link before they count", () => {
    const { data, own, conversation } = dataFolder();
    symlinkSync(join(data, "config.json"), join(own, "config-link.json"));
    symlinkSync(join(data, "workspaces", "paul"), join(conversation, "paul"));
    expect(readsOwnFiles(data, "iris", { command: { command: "cat config-link.json", cwd: own } })).toBe(false);
    expect(readsOwnFiles(data, "iris", { command: { command: "cat paul/MEMORY.md", cwd: conversation } })).toBe(false);
    expect(readsOwnFiles(data, "iris", { reads: [join(conversation, "paul", "MEMORY.md")] })).toBe(false);
  });
});
