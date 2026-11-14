import assert from "node:assert/strict";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { caseInsensitive, scanPc, sha256File, watchFolder } from "./cloud-sync-scan.mjs";

const LATER = () => Date.now() + 60_000;
function folder(t) {
  const dir = mkdtempSync(join(tmpdir(), "omb-sync-scan-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("lists files as wire paths with hashes, keeping links and hard links as present, skipping litter and sync's own downloads", async (t) => {
  const dir = folder(t);
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "sub", "a.txt"), "one");
  writeFileSync(join(dir, "Thumbs.db"), "x");
  writeFileSync(join(dir, ".a.txt.omb-sync-1a2b3c4d"), "half");
  symlinkSync(join(dir, "sub", "a.txt"), join(dir, "link.txt"));
  writeFileSync(join(dir, "hard.txt"), "two");
  linkSync(join(dir, "hard.txt"), join(dir, "sub", "hard-too.txt"));
  mkdirSync(join(dir, "elsewhere"));
  symlinkSync(join(dir, "elsewhere"), join(dir, "linked-dir"));
  const { entries, temps, keptDirs } = await scanPc(dir, new Map(), { now: LATER });
  assert.deepEqual([...entries].filter(([, entry]) => entry.kept).map(([path]) => path).sort(), ["hard.txt", "link.txt", "sub/hard-too.txt"]);
  assert.deepEqual(keptDirs, ["linked-dir"]);
  assert.deepEqual([...entries].filter(([, entry]) => !entry.kept).map(([path]) => path), ["sub/a.txt"]);
  assert.equal(entries.get("sub/a.txt").sha256, await sha256File(join(dir, "sub", "a.txt")));
  assert.deepEqual(temps.map((temp) => temp.file), [join(dir, ".a.txt.omb-sync-1a2b3c4d")]);
});

test("reuses the base's hash when size and modified time match, and hashes again when they do not", async (t) => {
  const dir = folder(t);
  writeFileSync(join(dir, "a.txt"), "one");
  utimesSync(join(dir, "a.txt"), new Date(1_000), new Date(1_000));
  const base = new Map([["a.txt", { sha256: "cached", size: 3, mtimeMs: 1_000 }]]);
  assert.equal((await scanPc(dir, base, { now: LATER })).entries.get("a.txt").sha256, "cached");
  utimesSync(join(dir, "a.txt"), new Date(2_000), new Date(2_000));
  assert.notEqual((await scanPc(dir, base, { now: LATER })).entries.get("a.txt").sha256, "cached");
});

test("a file saved in the last two seconds, or open in Office, waits", async (t) => {
  const dir = folder(t);
  writeFileSync(join(dir, "fresh.txt"), "now");
  writeFileSync(join(dir, "Report.docx"), "doc");
  writeFileSync(join(dir, "~$port.docx"), "lock");
  utimesSync(join(dir, "Report.docx"), new Date(1_000), new Date(1_000));
  const { entries } = await scanPc(dir, new Map(), { now: () => Date.now() });
  assert.deepEqual(entries.get("fresh.txt"), { unsettled: true });
  assert.deepEqual(entries.get("Report.docx"), { unsettled: true });
});

test("Windows folders are always case-insensitive", () => {
  assert.equal(caseInsensitive("C:\\Users\\Ash\\PA", "win32"), true);
});

test("a burst of changes is reported once, after it goes quiet", async () => {
  let fire;
  const calls = [];
  const close = watchFolder("/x", () => calls.push(Date.now()), { debounceMs: 20, watchImpl: (_root, _options, listener) => { fire = listener; return { close() {}, on() {} }; } });
  fire(); fire(); fire();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(calls.length, 1);
  close();
});

// chmod cannot make a folder unreadable on Windows (no POSIX mode bits), so this case is POSIX-only.
test("a folder it cannot read stops the scan instead of reading as empty", { skip: process.platform === "win32" }, async (t) => {
  const dir = folder(t);
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "sub", "a.txt"), "one");
  chmodSync(join(dir, "sub"), 0o000);
  try { await assert.rejects(scanPc(dir, new Map(), { now: LATER }), /EACCES|EPERM/); } finally { chmodSync(join(dir, "sub"), 0o700); }
});
