import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCloudFilesService } from "./cloud-sync.mjs";
import { fakeCloud } from "./fixtures/cloud-sync-fake-cloud.mjs";

const AT = new Date(2026, 9, 15, 12).getTime();
function setup(t, { origin = "https://omb-u-aaaaaaaaaaaa.fly.dev" } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "omb-files-service-")));
  const home = join(dir, "home");
  const project = join(home, "Clients");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "brief.md"), "the brief");
  utimesSync(join(project, "brief.md"), new Date(AT), new Date(AT));
  const cloud = fakeCloud();
  // The service builds its client per pass, so a test can point it at another Cloud by swapping holder.cloud.
  const holder = { cloud };
  const current = { origin };
  const clock = { now: AT + 60_000 };
  const service = createCloudFilesService({
    settingsFile: join(dir, "user", "settings.json"), stateFile: join(dir, "user", "state.db"),
    documentsDir: join(home, "Documents"), localDataDir: join(home, ".openmausbot"), homeDir: home,
    platform: process.platform, hostname: "Ash-PC", cloudOrigin: () => current.origin, fetch: async () => { throw new Error("no network in tests"); },
    trashItem: async (file) => rmSync(file), markDownloaded: async () => {},
    createClient: () => holder.cloud.client, watch: () => () => {}, freeBytes: () => 100 * 1024 ** 3, now: () => clock.now,
  });
  t.after(() => { service.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, home, project, cloud, holder, current, clock, service };
}

test("checks a folder before sharing: too broad, private, MausBot's own, or already shared are refused", async (t) => {
  const s = setup(t);
  mkdirSync(join(s.home, ".ssh"), { recursive: true });
  mkdirSync(join(s.home, ".openmausbot", "files"), { recursive: true });
  mkdirSync(join(s.home, "Documents", "MausBot"), { recursive: true });
  assert.equal((await s.service.check(s.home)).refusal, "too-broad");
  assert.equal((await s.service.check(join(s.home, ".ssh"))).refusal, "private");
  for (const cli of [".claude", ".codex", ".gemini", ".grok"]) {
    mkdirSync(join(s.home, cli, "skills"), { recursive: true });
    assert.equal((await s.service.check(join(s.home, cli))).refusal, "private");
    assert.equal((await s.service.check(join(s.home, cli, "skills"))).refusal, "private");
  }
  assert.equal((await s.service.check(join(s.home, ".openmausbot", "files"))).refusal, "app-data");
  assert.equal((await s.service.check(join(s.home, "Documents"))).refusal, "app-data");
  assert.equal((await s.service.check(join(s.home, "nope"))).refusal, "not-a-folder");
  assert.deepEqual(await s.service.check(s.project), { name: "Clients", pcPath: s.project, files: 1, bytes: 9, partial: false, refusal: null });
  await s.service.share(s.project);
  mkdirSync(join(s.project, "Acme"));
  assert.equal((await s.service.check(join(s.project, "Acme"))).refusal, "already-shared");
  await assert.rejects(s.service.share(s.home), /can't be shared/);
});

test("shares a folder: registered on My Cloud, copied there, and up to date", async (t) => {
  const s = setup(t);
  const state = await s.service.share(s.project);
  const [cloudFolder] = [...s.cloud.folders.values()].map((entry) => entry.folder);
  assert.equal(cloudFolder.pcPath, s.project);
  assert.equal(s.cloud.get(cloudFolder.id, "brief.md"), "the brief");
  assert.deepEqual(state.shared.map(({ id, name, status, files, done }) => ({ id, name, status, files, done })), [{ id: cloudFolder.id, name: "Clients", status: "synced", files: 1, done: 1 }]);
});

test("repeated upload failures become a folder problem and clear after a successful retry", async (t) => {
  const s = setup(t);
  const upload = s.cloud.client.upload;
  s.cloud.client.upload = async () => { throw new Error("The file is locked"); };
  await s.service.share(s.project);
  assert.equal(s.service.state().shared[0].status, "copying");
  await s.service.pass();
  assert.equal(s.service.state().shared[0].status, "copying");
  await s.service.pass();
  assert.equal(s.service.state().shared[0].status, "problem");
  assert.equal(s.service.state().shared[0].problem, "brief.md: The file is locked");
  s.cloud.client.upload = upload;
  await s.service.pass();
  assert.equal(s.service.state().shared[0].status, "synced");
  assert.equal(s.service.state().shared[0].problem, null);
});

test("repeated output failures reach the Files state and clear after a successful retry", async (t) => {
  const s = setup(t);
  s.cloud.setBots({ bots: [{ id: "owl", name: "Owl", tasks: [{ threadId: "t1", title: "Report" }] }], groups: [] });
  const folder = s.cloud.addFolder({ id: "bot-owl-t1", kind: "bot", botId: "owl", threadId: "t1", cloudPath: "/work/owl", newestMs: AT + 120_000 });
  s.cloud.put(folder.id, "report.md", "the report");
  const download = s.cloud.client.download;
  s.cloud.client.download = async () => { throw new Error("Could not write this file"); };
  await s.service.pass();
  assert.equal(s.service.state().outputs.problem, null);
  await s.service.pass();
  assert.equal(s.service.state().outputs.problem, null);
  await s.service.pass();
  assert.equal(s.service.state().outputs.problem, "report.md: Could not write this file");
  s.cloud.client.download = download;
  await s.service.pass();
  assert.equal(s.service.state().outputs.problem, null);
  assert.equal(readFileSync(join(s.home, "Documents", "MausBot", "Owl", "Report", "report.md"), "utf8"), "the report");
});

test("only a folder this computer shared is ever synced: one My Cloud names for it is never read or written", async (t) => {
  const s = setup(t);
  const ssh = join(s.home, ".ssh");
  mkdirSync(ssh, { recursive: true });
  writeFileSync(join(ssh, "id_ed25519"), "PRIVATE KEY");
  await s.service.share(s.project);
  const settings = JSON.parse(readFileSync(join(s.dir, "user", "settings.json"), "utf8"));
  // Anyone able to write My Cloud's folder list adds an entry for this computer pointing at its keys.
  const planted = s.cloud.addFolder({ id: "planted", kind: "pc", computerId: settings.computerId, pcPath: ssh, cloudPath: "/data/Synced/PC/keys" });
  s.cloud.put(planted.id, "authorized_keys", "attacker key");
  await s.service.pass();
  assert.deepEqual([...s.cloud.folders.get("planted").files.keys()], ["authorized_keys"]);
  assert.deepEqual(readdirSync(ssh), ["id_ed25519"]);
  assert.equal(s.service.state().shared.length, 1);
});

test("stop sharing: My Cloud's copy is removed there, even when My Cloud was out of reach at the time", async (t) => {
  const s = setup(t);
  await s.service.share(s.project);
  const id = s.service.state().shared[0].id;
  const unregister = s.cloud.client.unregister;
  s.cloud.client.unregister = async () => { throw Object.assign(new TypeError("fetch failed"), {}); };
  await s.service.stopSharing(id);
  await s.service.pass();
  assert.equal(s.service.state().shared.length, 0);
  assert.equal(s.cloud.folders.has(id), true);
  s.cloud.client.unregister = unregister;
  await s.service.pass();
  assert.equal(s.cloud.folders.has(id), false);
  assert.ok(existsSync(join(s.project, "brief.md")));
});

test("many files removed here wait for the person's answer, and the answer applies once", async (t) => {
  const s = setup(t);
  for (let n = 0; n < 12; n++) writeFileSync(join(s.project, `f${n}.txt`), `${n}`);
  for (let n = 0; n < 12; n++) utimesSync(join(s.project, `f${n}.txt`), new Date(AT), new Date(AT));
  await s.service.share(s.project);
  const id = s.service.state().shared[0].id;
  for (let n = 0; n < 12; n++) rmSync(join(s.project, `f${n}.txt`));
  await s.service.pass();
  assert.deepEqual(s.service.state().shared.map(({ status, pendingDeletes }) => ({ status, pendingDeletes })), [{ status: "confirm-deletes", pendingDeletes: 12 }]);
  await s.service.answerDeletes(id, true);
  assert.equal(s.cloud.get(id, "f3.txt"), undefined);
  assert.equal(s.service.state().shared[0].status, "synced");
});

test("a folder moved on this computer is missing until the person finds it; nothing on My Cloud changes meanwhile", async (t) => {
  const s = setup(t);
  await s.service.share(s.project);
  const id = s.service.state().shared[0].id;
  const moved = join(s.home, "Work", "Clients");
  mkdirSync(join(s.home, "Work"));
  // A rename keeps the modified times.
  (await import("node:fs")).renameSync(s.project, moved);
  await s.service.pass();
  assert.equal(s.service.state().shared[0].status, "missing");
  assert.equal(s.cloud.get(id, "brief.md"), "the brief");
  await s.service.relocate(id, moved);
  assert.deepEqual(s.service.state().shared.map(({ status, pcPath }) => ({ status, pcPath })), [{ status: "synced", pcPath: moved }]);
});

test("My Cloud's copy gone: the folder is shared again, and another My Cloud gets every shared folder afresh", async (t) => {
  const s = setup(t);
  await s.service.share(s.project);
  const first = s.service.state().shared[0].id;
  s.cloud.folders.delete(first);
  await s.service.pass();
  const second = s.service.state().shared[0].id;
  assert.notEqual(second, first);
  assert.equal(s.cloud.get(second, "brief.md"), "the brief");
  s.holder.cloud = fakeCloud();
  s.current.origin = "https://omb-u-bbbbbbbbbbbb.fly.dev";
  await s.service.pass();
  const [again] = [...s.holder.cloud.folders.values()].map((entry) => entry.folder);
  assert.equal(again.pcPath, s.project);
  assert.equal(s.holder.cloud.get(again.id, "brief.md"), "the brief");
});

test("bots' work from now on comes to Documents/MausBot/<bot>/<conversation>; older conversations and a switch turned off stay put", async (t) => {
  const s = setup(t);
  s.cloud.setBots({ bots: [{ id: "owl", name: "Owl", tasks: [{ threadId: "t1", title: "Q3: plan?" }, { threadId: "t0", title: "Old" }] }], groups: [] });
  const recent = s.cloud.addFolder({ id: "bot-owl-t1", kind: "bot", botId: "owl", threadId: "t1", cloudPath: "/data/.openmausbot/task-workspaces/owl/t1", newestMs: AT + 120_000 });
  const old = s.cloud.addFolder({ id: "bot-owl-t0", kind: "bot", botId: "owl", threadId: "t0", cloudPath: "/data/.openmausbot/task-workspaces/owl/t0", newestMs: AT - 86_400_000 });
  s.cloud.put(recent.id, "plan.md", "the plan");
  s.cloud.put(old.id, "old.md", "old work");
  await s.service.pass();
  const owl = join(s.home, "Documents", "MausBot", "Owl");
  assert.deepEqual(readdirSync(owl), ["Q3- plan-"]);
  assert.equal(readFileSync(join(owl, "Q3- plan-", "plan.md"), "utf8"), "the plan");
  assert.equal(s.service.state().outputs.folders, 1);
  await s.service.setOutputs(false);
  s.cloud.put(recent.id, "more.md", "later");
  await s.service.pass();
  assert.equal(existsSync(join(owl, "Q3- plan-", "more.md")), false);
});
