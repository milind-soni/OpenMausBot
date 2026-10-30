import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fakeCloud, sha } from "./fixtures/cloud-sync-fake-cloud.mjs";
import { applyStaged, renameWithRetry } from "./lent-staged.mjs";

const AT = new Date(2026, 9, 27, 12).getTime();
function setup(t, write = true) {
  // A lent folder's path is the native real path lending's own check stores (validateSharedFolders): on Windows the JS
  // realpathSync keeps a short name such as RUNNER~1 that the native one expands, and the two would never match.
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "omb-lent-staged-")));
  const root = join(dir, "Notes");
  mkdirSync(root);
  writeFileSync(join(root, "plan.md"), "the plan");
  const cloud = fakeCloud();
  const trashed = [];
  const apply = (more = {}) => applyStaged({ client: cloud.client, folderId: "pc-1", folder: { id: "lent-1", path: root, name: "Notes", write }, now: () => AT,
    trashItem: async (file) => { trashed.push(readFileSync(file, "utf8")); rmSync(file); }, ...more });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, root, cloud, trashed, apply };
}

test("an untouched file takes the bot's version, the old one to the Recycle Bin; a new file is created", async (t) => {
  const s = setup(t);
  s.cloud.stage("pc-1", "plan.md", "v2", sha("the plan"));
  s.cloud.stage("pc-1", "a/b/new.md", "new");
  const outcome = await s.apply();
  assert.deepEqual(outcome, { applied: 2, kept: [], problem: null });
  assert.equal(readFileSync(join(s.root, "plan.md"), "utf8"), "v2");
  assert.deepEqual(s.trashed, ["the plan"]);
  assert.equal(readFileSync(join(s.root, "a", "b", "new.md"), "utf8"), "new");
  assert.equal(s.cloud.lent.staged.length, 0);
});

test("a file the person changed, or removed, keeps theirs: the bot's version lands beside it", async (t) => {
  const s = setup(t);
  s.cloud.stage("pc-1", "plan.md", "the bot's plan", sha("an older plan"));
  s.cloud.stage("pc-1", "gone.md", "the bot's notes", sha("what was there"));
  const outcome = await s.apply();
  assert.equal(outcome.applied, 0);
  assert.deepEqual(outcome.kept, [
    { path: "plan.md", beside: "plan (new from My Cloud, 27 Oct 2026).md", at: AT },
    { path: "gone.md", beside: "gone (new from My Cloud, 27 Oct 2026).md", at: AT },
  ]);
  assert.equal(readFileSync(join(s.root, "plan.md"), "utf8"), "the plan");
  assert.equal(readFileSync(join(s.root, "plan (new from My Cloud, 27 Oct 2026).md"), "utf8"), "the bot's plan");
  assert.equal(existsSync(join(s.root, "gone.md")), false, "a file the person removed is not brought back under its name");
  assert.equal(readFileSync(join(s.root, "gone (new from My Cloud, 27 Oct 2026).md"), "utf8"), "the bot's notes");
  assert.deepEqual(s.trashed, [], "nothing of the person's is deleted");
});

test("already there is done; a folder no longer lent with editing keeps the change waiting", async (t) => {
  const s = setup(t);
  s.cloud.stage("pc-1", "plan.md", "the plan", sha("older"));
  assert.deepEqual(await s.apply(), { applied: 1, kept: [], problem: null });
  assert.deepEqual(s.trashed, []);
  const r = setup(t, false);
  r.cloud.stage("pc-1", "plan.md", "v2", sha("the plan"));
  assert.deepEqual(await r.apply(), { applied: 0, kept: [], problem: null });
  assert.equal(r.cloud.lent.staged.length, 1);
  assert.equal(readFileSync(join(r.root, "plan.md"), "utf8"), "the plan");
});

test("the live write's rules hold: never .git, never through a link, never a damaged download", async (t) => {
  const s = setup(t);
  mkdirSync(join(s.dir, "outside"));
  symlinkSync(join(s.dir, "outside"), join(s.root, "link"));
  s.cloud.stage("pc-1", ".git/hooks/pre-commit", "#!/bin/sh");
  s.cloud.stage("pc-1", "link/x.md", "through a link");
  const damaged = s.cloud.stage("pc-1", "plan.md", "v2", sha("the plan"));
  damaged.damaged = Buffer.from("not v2");
  const outcome = await s.apply();
  assert.equal(outcome.applied, 0);
  assert.match(outcome.problem, /^\.git\/hooks\/pre-commit: Files inside \.git/);
  assert.equal(existsSync(join(s.root, ".git")), false);
  assert.deepEqual(readdirSync(join(s.dir, "outside")), []);
  assert.equal(readFileSync(join(s.root, "plan.md"), "utf8"), "the plan");
  assert.deepEqual(readdirSync(s.root).sort(), ["link", "plan.md"], "no half-written file is left behind");
  assert.equal(s.cloud.lent.staged.length, 3, "none is answered, so none is lost");
  // A stopping error (signed out, offline) stops the whole pass.
  const offline = Object.assign(new Error("offline"), { name: "TimeoutError" });
  await assert.rejects(s.apply({ client: { ...s.cloud.client, stagedFile: async () => { throw offline; } }, stopper: (error) => error === offline }), /offline/);
});

test("a protected place inside a lent folder is never written", async (t) => {
  const s = setup(t);
  mkdirSync(join(s.root, "secrets"));
  s.cloud.stage("pc-1", "secrets/key.txt", "x");
  const outcome = await s.apply({ protectedPaths: [join(s.root, "secrets")] });
  assert.match(outcome.problem, /cannot be accessed/);
  assert.deepEqual(readdirSync(join(s.root, "secrets")), []);
});

test("a replaced file keeps its own permissions, as a live write in place does", { skip: process.platform === "win32" }, async (t) => {
  const s = setup(t);
  const { chmodSync, statSync } = await import("node:fs");
  writeFileSync(join(s.root, "run.sh"), "#!/bin/sh\necho one\n");
  chmodSync(join(s.root, "run.sh"), 0o755);
  s.cloud.stage("pc-1", "run.sh", "#!/bin/sh\necho two\n", sha("#!/bin/sh\necho one\n"));
  await s.apply();
  assert.equal(readFileSync(join(s.root, "run.sh"), "utf8"), "#!/bin/sh\necho two\n");
  assert.equal(statSync(join(s.root, "run.sh")).mode & 0o777, 0o755);
});

test("a name Windows can't hold waits instead of landing on a PC; the rest still lands", async (t) => {
  const s = setup(t);
  for (const name of ["con.txt", "notes.", "a:b.md", "aux/readme.md"]) s.cloud.stage("pc-1", name, "x");
  s.cloud.stage("pc-1", "fine.md", "fine");
  const outcome = await s.apply({ platform: "win32" });
  assert.equal(outcome.applied, 1);
  assert.match(outcome.problem, /^con\.txt: This computer can't hold that name\.$/);
  assert.equal(readFileSync(join(s.root, "fine.md"), "utf8"), "fine");
  assert.deepEqual(s.cloud.lent.staged.map((change) => change.path), ["con.txt", "notes.", "a:b.md", "aux/readme.md"], "none is lost");
});

test("a read-only file the bot changed stays read-only, and nothing read-only is left half-written", async (t) => {
  const s = setup(t);
  const { chmodSync, statSync } = await import("node:fs");
  chmodSync(join(s.root, "plan.md"), 0o444);
  t.after(() => { try { chmodSync(join(s.root, "plan.md"), 0o644); } catch {} });
  s.cloud.stage("pc-1", "plan.md", "v2", sha("the plan"));
  assert.equal((await s.apply()).applied, 1);
  assert.equal(readFileSync(join(s.root, "plan.md"), "utf8"), "v2");
  assert.equal(statSync(join(s.root, "plan.md")).mode & 0o222, 0, "still read-only");
  assert.deepEqual(readdirSync(s.root).filter((name) => name.includes(".omb-sync-")), []);
});

test("a rename Windows refuses for a moment is tried again; any other refusal is not", () => {
  const busy = (code) => Object.assign(new Error(code), { code });
  let calls = 0;
  const waits = [];
  renameWithRetry("a", "b", () => { if (++calls < 3) throw busy(calls === 1 ? "EPERM" : "EBUSY"); }, (ms) => waits.push(ms));
  assert.equal(calls, 3);
  assert.deepEqual(waits, [5, 10]);
  assert.throws(() => renameWithRetry("a", "b", () => { throw busy("ENOENT"); }, () => {}), /ENOENT/);
  let tries = 0;
  assert.throws(() => renameWithRetry("a", "b", () => { tries++; throw busy("EACCES"); }, () => {}), /EACCES/);
  assert.equal(tries, 6, "five more tries, then it gives up");
});

test("a lent folder spelled other than its real path (a short name on Windows, a link elsewhere) waits; it never writes", async (t) => {
  const s = setup(t);
  // Another spelling of the same folder: through a link to its parent, as RUNNER~1 is a short name for the runner's home.
  const alias = join(s.dir, "alias");
  symlinkSync(s.dir, alias, "junction");
  s.cloud.stage("pc-1", "plan.md", "v2", sha("the plan"));
  const outcome = await s.apply({ folder: { id: "lent-1", path: join(alias, "Notes"), name: "Notes", write: true } });
  assert.equal(outcome.applied, 0);
  assert.match(outcome.problem, /Shared folder moved/);
  assert.equal(readFileSync(join(s.root, "plan.md"), "utf8"), "the plan");
  assert.equal(s.cloud.lent.staged.length, 1);
});
