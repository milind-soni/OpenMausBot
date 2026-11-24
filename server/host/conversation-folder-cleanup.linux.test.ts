// The drain on Linux, as on a Cloud home: the system's GNU rm removes what was moved to .removing, and a process still
// in an entry keeps it. Races a link swapped in for a folder while rm walks the tree. Elsewhere the suite skips.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createConversationFolderCleanup, gnuRm, linuxProcessPaths, REMOVING_DIR } from "./conversation-folder-cleanup.ts";

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "omb-drain-linux-"));
  made.push(root);
  const dataDir = join(root, "data");
  const outside = join(root, "outside");
  mkdirSync(join(dataDir, REMOVING_DIR), { recursive: true });
  mkdirSync(outside, { recursive: true });
  const logs: string[] = [];
  const cleanup = createConversationFolderCleanup({ dataDir, records: () => ({ bots: [], groups: [] }), drainAfterMs: false, log: (line) => { logs.push(line); }, warn: (line) => { logs.push(line); } });
  return { root, dataDir, outside, cleanup, logs, entry: (name: string) => join(dataDir, REMOVING_DIR, name) };
}

describe.runIf(process.platform === "linux")("the drain on Linux", () => {
  it("uses the system's GNU rm", async () => {
    expect(await gnuRm()).toBe("rm");
  });

  it("never reaches an outside folder through links swapped in while rm walks the tree", async () => {
    const s = sandbox();
    const precious = join(s.outside, "work", "thesis.docx");
    mkdirSync(join(s.outside, "work"), { recursive: true });
    writeFileSync(precious, "work");
    const entry = s.entry("1700000000000-0123456789ab");
    const folders: string[] = [];
    for (let d = 0; d < 300; d++) {
      const folder = join(entry, `pkg${d}`, "lib");
      mkdirSync(folder, { recursive: true });
      for (let i = 0; i < 40; i++) writeFileSync(join(folder, `${i}.js`), "x");
      folders.push(folder);
    }
    // While the drain runs, each folder in turn becomes a link to the outside folder.
    let racing = true, swapped = 0;
    const race = (async () => {
      while (racing) {
        for (const folder of folders) {
          if (!racing) break;
          try { renameSync(folder, `${folder}-x`); symlinkSync(join(s.outside, "work"), folder, "dir"); swapped++; } catch { /* rm took it first */ }
          await new Promise<void>((done) => setImmediate(done));
        }
      }
    })();
    await s.cleanup.drain();
    racing = false;
    await race;
    for (let pass = 0; pass < 3 && existsSync(entry); pass++) await s.cleanup.drain();
    expect(swapped).toBeGreaterThan(0);
    expect(existsSync(precious)).toBe(true);
    expect(readdirSync(join(s.outside, "work"))).toEqual(["thesis.docx"]);
    expect(existsSync(entry)).toBe(false);
  });

  it("leaves an entry a process works in, and finishes it once the process is gone", async () => {
    const s = sandbox();
    const entry = s.entry("1700000000001-0123456789ab");
    mkdirSync(join(entry, "app"), { recursive: true });
    writeFileSync(join(entry, "app", "server.js"), "x");
    const child = spawn("sleep", ["60"], { cwd: join(entry, "app"), stdio: "ignore" });
    try {
      await new Promise<void>((done) => child.once("spawn", () => done()));
      expect((await linuxProcessPaths())?.some((path) => path.startsWith(entry))).toBe(true);
      await s.cleanup.drain();
      expect(existsSync(entry)).toBe(true);
      expect(s.logs.join("\n")).toMatch(/a process still holds something in it/);
    } finally {
      child.kill("SIGKILL");
      await new Promise<void>((done) => (child.exitCode !== null || child.signalCode !== null ? done() : child.once("exit", () => done())));
    }
    await s.cleanup.drain();
    expect(existsSync(entry)).toBe(false);
  });

  it("moves nothing it cannot confirm and renames nothing outside .removing", async () => {
    const s = sandbox();
    const outsideEntry = join(s.outside, "1700000000002-0123456789ab");
    mkdirSync(outsideEntry, { recursive: true });
    writeFileSync(join(outsideEntry, "keep.txt"), "x");
    // A link in .removing under a drain name goes as a link; what it leads to stays.
    symlinkSync(outsideEntry, s.entry("1700000000002-0123456789ab"), "dir");
    renameSync(s.entry("1700000000002-0123456789ab"), s.entry("1700000000003-0123456789ab"));
    await s.cleanup.drain();
    expect(existsSync(join(outsideEntry, "keep.txt"))).toBe(true);
    expect(readdirSync(join(s.dataDir, REMOVING_DIR))).toEqual([]);
  });
});
