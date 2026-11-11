import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fetchOutputs, newReport, shareFolder } from "./cloud-sync-engine.mjs";
import { scanPc, caseInsensitive } from "./cloud-sync-scan.mjs";
import { openSyncState } from "./cloud-sync-state.mjs";
import { fakeCloud } from "./fixtures/cloud-sync-fake-cloud.mjs";

function setup(t) {
  const home = mkdtempSync(join(tmpdir(), "omb-sync-names-"));
  const local = join(home, "Local");
  mkdirSync(local);
  const state = openSyncState(join(home, "state.db"));
  t.after(() => { state.close(); rmSync(home, { recursive: true, force: true }); });
  const cloud = fakeCloud();
  const folder = cloud.addFolder({ id: "folder", kind: "pc", cloudPath: "/cloud" });
  const ctx = { local, state, client: cloud.client, folder, report: newReport(), now: () => Date.now() + 60_000 };
  return { ...ctx, cloud };
}

for (const directory of [false, true]) test(`refuses two ${directory ? "directories" : "files"} with the same normalized sync name`, async (t) => {
  const ctx = setup(t);
  const names = ["café", "cafe\u0301"];
  for (const [index, name] of names.entries()) {
    if (directory) mkdirSync(join(ctx.local, name), { recursive: true });
    writeFileSync(join(ctx.local, name, ...(directory ? ["note.txt"] : [])), `copy ${index}`);
  }
  if (readdirSync(ctx.local).length !== 2) { t.skip("this filesystem already aliases Unicode-normalized names"); return; }
  ctx.cloud.put(ctx.folder.id, "existing.txt", "keep");
  await assert.rejects(shareFolder(ctx), /same.*name|name.*conflict/i);
  assert.equal(ctx.cloud.get(ctx.folder.id, "existing.txt"), "keep");
  assert.equal(ctx.cloud.calls.length, 0);
  assert.equal(ctx.state.base(ctx.folder.id).size, 0);
});

test("a single decomposed filename still uploads using its normalized wire name", async (t) => {
  const ctx = setup(t);
  writeFileSync(join(ctx.local, "cafe\u0301.txt"), "coffee");
  await shareFolder(ctx);
  assert.equal(ctx.cloud.get(ctx.folder.id, "café.txt"), "coffee");
});

for (const names of [["Report.txt", "report.txt"], ["Data", "data/result.txt"], ["Docs/a.txt", "docs/b.txt"]]) test(`refuses case-aliasing Cloud paths ${names.join(" and ")} on Windows`, async (t) => {
  const ctx = setup(t);
  ctx.cloud.put(ctx.folder.id, names[0], "first");
  ctx.cloud.put(ctx.folder.id, names[1], "second");
  const downloaded = [];
  await assert.rejects(fetchOutputs({ ...ctx, platform: "win32", freeBytes: () => 100 * 1024 ** 3,
    markDownloaded: async file => { downloaded.push(file); }, trashItem: async () => { throw new Error("must not trash"); },
  }), /same.*name|name.*conflict/i);
  assert.deepEqual(downloaded, []);
  assert.deepEqual(readdirSync(ctx.local), []);
  assert.equal(ctx.state.base(ctx.folder.id).size, 0);
});

test("keeps distinct case-sensitive Cloud filenames on a filesystem that supports them", async (t) => {
  const ctx = setup(t);
  if (caseInsensitive(ctx.local)) { t.skip("requires a case-sensitive filesystem"); return; }
  ctx.cloud.put(ctx.folder.id, "Report.txt", "first");
  ctx.cloud.put(ctx.folder.id, "report.txt", "second");
  await fetchOutputs({ ...ctx, platform: "linux", freeBytes: () => 100 * 1024 ** 3,
    markDownloaded: async () => {}, trashItem: async () => { throw new Error("must not trash"); },
  });
  assert.equal(readFileSync(join(ctx.local, "Report.txt"), "utf8"), "first");
  assert.equal(readFileSync(join(ctx.local, "report.txt"), "utf8"), "second");
  assert.equal((await scanPc(ctx.local, ctx.state.base(ctx.folder.id))).entries.size, 2);
});
