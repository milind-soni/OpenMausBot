import assert from "node:assert/strict";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fetchOutputs, newReport, shareFolder } from "./cloud-sync-engine.mjs";
import { openSyncState } from "./cloud-sync-state.mjs";
import { fakeCloud } from "./fixtures/cloud-sync-fake-cloud.mjs";

const AT = new Date(2026, 9, 15, 12).getTime();
const GB = 1024 ** 3;
function setup(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "omb-files-engine-"));
  const state = openSyncState(join(dir, "state.db"));
  t.after(() => { state.close(); rmSync(dir, { recursive: true, force: true }); });
  const local = join(dir, "Clients");
  mkdirSync(local);
  const cloud = fakeCloud(options);
  const folder = cloud.addFolder({ id: "f1", kind: "pc", computerId: "c", pcPath: local, cloudPath: "/data/Synced/PC/Clients" });
  const trashed = [], marked = [];
  const share = async (extra = {}) => { const report = newReport(); return shareFolder({ client: cloud.client, state, folder, local, now: () => AT + 60_000, report, ...extra }); };
  const outputs = async (extra = {}) => {
    const report = newReport();
    return fetchOutputs({ client: cloud.client, state, folder, local, platform: "linux", now: () => AT + 60_000, freeBytes: () => 100 * GB,
      trashItem: async (file) => { trashed.push(file); rmSync(file); }, markDownloaded: async (file) => { marked.push(file); }, report, ...extra });
  };
  const write = (path, text, at = AT) => { const file = join(local, ...path.split("/")); mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, text); utimesSync(file, new Date(at), new Date(at)); };
  const read = (path) => readFileSync(join(local, ...path.split("/")), "utf8");
  return { dir, state, local, cloud, folder, share, outputs, write, read, trashed, marked };
}

test("shared: this computer's files go to My Cloud, a second pass sends nothing, and a bot's change there is replaced", async (t) => {
  const s = setup(t);
  s.write("brief.docx", "v1");
  s.write("notes/plan.md", "plan");
  assert.equal((await s.share()).status, "synced");
  assert.equal(s.cloud.get("f1", "brief.docx"), "v1");
  assert.equal(s.cloud.get("f1", "notes/plan.md"), "plan");
  const sent = s.cloud.calls.length;
  await s.share();
  assert.equal(s.cloud.calls.length, sent);
  // A bot edits the copy anyway, and adds a file of its own: the edit is replaced, the bot's file stays.
  s.cloud.put("f1", "brief.docx", "bot's edit");
  s.cloud.put("f1", "bot-made.md", "mine");
  await s.share();
  assert.equal(s.cloud.get("f1", "brief.docx"), "v1");
  assert.equal(s.cloud.get("f1", "bot-made.md"), "mine");
  assert.equal(existsSync(join(s.local, "bot-made.md")), false);
});

test("shared: a file removed here is removed from My Cloud; many at once wait for the person, and Keep keeps them", async (t) => {
  const s = setup(t);
  for (let n = 0; n < 12; n++) s.write(`f${n}.txt`, `file ${n}`);
  await s.share();
  rmSync(join(s.local, "f0.txt"));
  await s.share();
  assert.equal(s.cloud.get("f1", "f0.txt"), undefined);
  for (let n = 1; n < 12; n++) rmSync(join(s.local, `f${n}.txt`));
  const asked = await s.share();
  assert.equal(asked.status, "confirm-deletes");
  assert.equal(asked.pendingDeletes, 11);
  assert.equal(s.cloud.get("f1", "f5.txt"), "file 5");
  // Keep them: they stay on My Cloud, and the folder is not asked about them again.
  await s.share({ approveDeletes: false });
  assert.equal(s.cloud.get("f1", "f5.txt"), "file 5");
  assert.equal((await s.share()).status, "synced");
  assert.equal(s.cloud.get("f1", "f5.txt"), "file 5");
});

test("shared: Remove from My Cloud carries the deletes out", async (t) => {
  const s = setup(t);
  s.write("a.txt", "a");
  await s.share();
  rmSync(join(s.local, "a.txt"));
  assert.equal((await s.share()).status, "confirm-deletes");
  await s.share({ approveDeletes: true });
  assert.equal(s.cloud.get("f1", "a.txt"), undefined);
});

test("shared: a missing folder, a link and a hard-linked file never read as deleted", async (t) => {
  const s = setup(t);
  s.write("a.txt", "a");
  s.write("b.txt", "b");
  s.write("sub/c.txt", "c");
  await s.share();
  // b.txt becomes a hard link and sub a link to a folder elsewhere: both still there, neither removed from My Cloud.
  rmSync(join(s.local, "b.txt"));
  writeFileSync(join(s.dir, "b-elsewhere.txt"), "b");
  linkSync(join(s.dir, "b-elsewhere.txt"), join(s.local, "b.txt"));
  rmSync(join(s.local, "sub"), { recursive: true });
  mkdirSync(join(s.dir, "moved-sub"));
  symlinkSync(join(s.dir, "moved-sub"), join(s.local, "sub"));
  await s.share();
  assert.equal(s.cloud.get("f1", "b.txt"), "b");
  assert.equal(s.cloud.get("f1", "sub/c.txt"), "c");
  // The whole folder moved away: nothing is touched, and the person is asked where it went.
  rmSync(s.local, { recursive: true });
  assert.equal((await s.share()).status, "missing");
  assert.equal(s.cloud.get("f1", "a.txt"), "a");
});

test("shared: a full My Cloud leaves the rest waiting, smallest first", async (t) => {
  const s = setup(t, { freeBytes: GB + 10 });
  s.write("small.txt", "12345");
  s.write("big.txt", "x".repeat(100));
  const result = await s.share();
  assert.equal(result.status, "waiting");
  assert.equal(result.waitingBytes, 100);
  assert.equal(s.cloud.get("f1", "small.txt"), "12345");
});

test("bots' work: new files come down marked as downloaded; nothing here is deleted, and agent configs never come", async (t) => {
  const s = setup(t);
  s.cloud.put("f1", "report.md", "v1");
  s.cloud.put("f1", ".mcp.json", "{\"mcpServers\":{}}");
  s.cloud.put("f1", ".Claude/settings.json", "{}");
  s.cloud.put("f1", "node_modules/x/index.js", "x");
  await s.outputs();
  assert.equal(s.read("report.md"), "v1");
  assert.deepEqual(readdirSync(s.local).sort(), ["report.md"]);
  assert.equal(s.marked.length, 1);
  // Removed on My Cloud: still here.
  s.cloud.folders.get("f1").files.delete("report.md");
  await s.outputs();
  assert.equal(s.read("report.md"), "v1");
});

test("bots' work: waits for the local disk reserve, then downloads when it fits", async (t) => {
  const s = setup(t);
  s.cloud.put("f1", "report.md", "v1");
  const waiting = await s.outputs({ freeBytes: () => GB + 1 });
  assert.equal(waiting.status, "waiting");
  assert.equal(waiting.waitingBytes, 2);
  assert.equal(existsSync(join(s.local, "report.md")), false);
  assert.deepEqual(s.cloud.calls.filter(([kind]) => kind === "download"), []);

  const ready = await s.outputs({ freeBytes: () => GB + 2 });
  assert.equal(ready.status, "synced");
  assert.equal(ready.waitingBytes, 0);
  assert.equal(s.read("report.md"), "v1");
  assert.deepEqual(s.cloud.calls.filter(([kind]) => kind === "download"), [["download", "report.md"]]);
});

test("bots' work: a newer version replaces an untouched file (the old one to the Recycle Bin), and lands beside the person's edit", async (t) => {
  const s = setup(t);
  s.cloud.put("f1", "report.md", "v1");
  s.cloud.put("f1", "draft.md", "d1");
  await s.outputs();
  s.cloud.put("f1", "report.md", "v2");
  s.write("draft.md", "my edit", AT + 1_000);
  s.cloud.put("f1", "draft.md", "d2");
  await s.outputs();
  assert.equal(s.read("report.md"), "v2");
  assert.equal(s.trashed.length, 1);
  assert.equal(s.read("draft.md"), "my edit");
  const beside = readdirSync(s.local).find((name) => name.startsWith("draft (new from My Cloud"));
  assert.ok(beside, readdirSync(s.local).join(", "));
  assert.equal(s.read(beside), "d2");
  // Once beside it, not again until My Cloud changes it.
  await s.outputs();
  assert.equal(readdirSync(s.local).filter((name) => name.startsWith("draft (new")).length, 1);
});

test("bots' work: a damaged download is thrown away, and a path from My Cloud never leaves the folder", async (t) => {
  const s = setup(t);
  s.cloud.put("f1", "ok.md", "fine");
  const download = s.cloud.client.download;
  s.cloud.client.download = async (folderId, path, temporary, size) => { const sent = await download(folderId, path, temporary, size); writeFileSync(temporary, "tampered"); return sent; };
  const result = await s.outputs();
  assert.equal(existsSync(join(s.local, "ok.md")), false);
  assert.equal(result.status, "copying");
  s.cloud.client.download = download;
  s.cloud.folders.get("f1").files.set("../escape.md", Buffer.from("x"));
  await s.outputs();
  assert.equal(s.read("ok.md"), "fine");
  assert.equal(existsSync(join(s.dir, "escape.md")), false);
});

test("bots' work: a repeatedly failing file is a problem rather than endless copying", async (t) => {
  const s = setup(t);
  s.cloud.put("f1", "report.md", "the report");
  const download = s.cloud.client.download;
  s.cloud.client.download = async () => { throw new Error("File is locked"); };
  assert.equal((await s.outputs()).status, "copying");
  assert.equal((await s.outputs()).status, "copying");
  const failed = await s.outputs();
  assert.equal(failed.status, "problem");
  assert.equal(failed.problem, "report.md: File is locked");
  s.cloud.client.download = download;
  const recovered = await s.outputs();
  assert.equal(recovered.status, "synced");
  assert.equal(recovered.problem, null);
  assert.deepEqual(s.state.failures(), []);
});
