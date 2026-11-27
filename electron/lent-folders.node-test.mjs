import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCloudFilesService } from "./cloud-sync.mjs";
import { fakeCloud, sha } from "./fixtures/cloud-sync-fake-cloud.mjs";
import { COPY_MAX_BYTES, folderKey, lendingForFiles, lentReport, planLentCopies, reconcileLent, sameFolderOn } from "./lent-folders.mjs";

const GB = 1024 ** 3;
const AT = new Date(2026, 9, 27, 12).getTime();
const folder = (name, write = false) => ({ id: randomUUID(), path: `/Users/ash/${name}`, name, write });
const checked = (bytes, more = {}) => ({ refusal: null, partial: false, bytes, files: 1, ...more });
const same = (a, b) => a === b;

test("a lent folder gets a copy when Files may share it, it is a few GB at most, and it fits the room the plan's disk grows to", () => {
  const notes = folder("Notes"), photos = folder("Photos"), home = folder("ash"), huge = folder("Videos"), counted = folder("Archive");
  const checks = new Map([[notes.id, checked(GB)], [photos.id, checked(COPY_MAX_BYTES + 1)], [home.id, checked(0, { refusal: "too-broad" })],
    [huge.id, checked(GB, { partial: true })], [counted.id, checked(2 * GB)]]);
  // 10 GB volume, 3 GB used, growing to 20 GB: 20 − 3 − 3 (the 15% My Cloud keeps free) = 14 GB of room.
  const plan = planLentCopies({ folders: [notes, photos, home, huge, counted], checks, copied: new Set(), disk: { totalBytes: 10 * GB, freeBytes: 7 * GB }, planDisk: { maxBytes: 20 * GB } });
  assert.deepEqual(plan.get(notes.id), { copy: true });
  assert.deepEqual(plan.get(counted.id), { copy: true });
  assert.deepEqual(plan.get(photos.id), { copy: false, live: "too-big" }, "over the per-folder limit");
  assert.deepEqual(plan.get(huge.id), { copy: false, live: "too-big" }, "too many files to count in a moment");
  assert.deepEqual(plan.get(home.id), { copy: false, live: "refused" }, "Files' own refusals hold: never the home folder");
});

test("the room left goes to the smallest folders first, and a folder copied already keeps its copy", () => {
  const a = folder("A"), b = folder("B"), c = folder("C"), kept = folder("Kept");
  const checks = new Map([[a.id, checked(2 * GB)], [b.id, checked(GB)], [c.id, checked(1.5 * GB)]]);
  // A 10 GB disk with no plan size known: 10 − 5 used − 2 kept free = 3 GB of room.
  const plan = planLentCopies({ folders: [a, b, c, kept], checks, copied: new Set([kept.id]), disk: { totalBytes: 10 * GB, freeBytes: 5 * GB } });
  assert.equal(plan.get(b.id).copy, true);
  assert.equal(plan.get(c.id).copy, true);
  assert.deepEqual(plan.get(a.id), { copy: false, live: "too-big" });
  assert.equal(plan.get(kept.id).copy, true);
});

test("Files' list follows lending: a folder shared from the Files page becomes the lent one, an unlent one goes", () => {
  const notes = folder("Notes", true), clients = folder("Clients"), gone = { key: "k-gone", id: "pc-9", pcPath: "/Users/ash/Old", name: "Old", lentId: randomUUID() };
  const legacy = { key: "k-1", id: "pc-1", pcPath: "/Users/ash/Clients", name: "Clients", deletes: null };
  const solo = { key: "k-2", id: "pc-2", pcPath: "/Users/ash/Taxes", name: "Taxes", deletes: null };
  const plan = new Map([[notes.id, { copy: true }], [clients.id, { copy: true }]]);
  const { shared, dropped } = reconcileLent({ shared: [legacy, solo, gone], folders: [notes, clients], plan, sameFolder: same, now: AT, newKey: () => "k-new" });
  assert.deepEqual(shared, [
    { ...legacy, lentId: clients.id, write: false },
    solo,
    { key: "k-new", id: null, pcPath: notes.path, name: "Notes", lentId: notes.id, write: true, deletes: null, addedAt: AT },
  ]);
  assert.deepEqual(dropped, [gone]);
  assert.deepEqual(lentReport({ computerId: "c", lendingId: "l", name: "Ash-MBP", platform: "darwin", folders: [notes, clients, folder("Big")], plan: new Map([...plan, ["x", {}]]), shared }).folders.map(({ name, syncId, live }) => ({ name, syncId, live })),
    [{ name: "Notes", syncId: null, live: undefined }, { name: "Clients", syncId: "pc-1", live: undefined }, { name: "Big", syncId: null, live: undefined }]);
});

test("lending for Files lends a folder read only on top of what is lent, and stops lending when it was all", async () => {
  const env = { id: "cloud", origin: "https://omb-u-aaaaaaaaaaaa.fly.dev" };
  let state = { enabled: true, folders: [folder("Documents")], screen: true, internet: true, chrome: false, terminal: false };
  const saved = [], revoked = [];
  const sharing = { cloudState: () => state, saveCloud: async (_env, input) => { saved.push(input); state = { ...state, ...input, enabled: true }; return state; }, revoke: () => { revoked.push(true); state = { ...state, enabled: false }; }, lentToCloud: () => ({ off: true }) };
  const lending = lendingForFiles({ environment: () => env, sharing: () => sharing, validate: async ([entry]) => [{ ...entry, name: entry.path.split("/").at(-1) }] });
  const lent = await lending.lend("/Users/ash/Clients");
  assert.equal(lent.write, false);
  assert.deepEqual(saved.at(-1), { folders: [state.folders[0], lent], screen: true, internet: true, chrome: false, terminal: false });
  assert.equal(await lending.lend("/Users/ash/Clients").then((again) => again.id), lent.id, "lent already: nothing changes");
  assert.equal(saved.length, 1);
  await lending.unlend(lent.id);
  assert.deepEqual(saved.at(-1).folders.map((entry) => entry.name), ["Documents"]);
  state = { enabled: true, folders: [lent], screen: false, internet: false, chrome: false, terminal: false };
  await lending.unlend(lent.id);
  assert.equal(revoked.length, 1, "nothing else was lent: lending stops");
  // Off: a folder added from the Files page lends just it.
  state = { enabled: false, folders: [folder("Old")], screen: true, internet: true, chrome: false, terminal: false };
  await lending.lend("/Users/ash/Clients");
  assert.deepEqual(saved.at(-1).folders.map((entry) => entry.name), ["Clients"]);
  assert.equal(saved.at(-1).screen, undefined);
});

function setup(t) {
  // The native real path, as lending stores a lent folder's (see lent-staged.node-test.mjs).
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "omb-lent-folders-")));
  const home = join(dir, "home");
  const notes = join(home, "Notes");
  mkdirSync(notes, { recursive: true });
  writeFileSync(join(notes, "plan.md"), "the plan");
  utimesSync(join(notes, "plan.md"), new Date(AT), new Date(AT));
  const cloud = fakeCloud();
  const lent = { now: { lendingId: randomUUID(), folders: [{ id: randomUUID(), path: notes, name: "Notes", write: true }], protectedPaths: [] } };
  const lending = { now: () => lent.now, lend: async (where) => { const entry = { id: randomUUID(), path: where, name: where.split("/").at(-1), write: false }; lent.now = { ...lent.now, folders: [...lent.now.folders, entry] }; return entry; }, unlend: async () => {} };
  const trashed = [];
  const clock = { now: AT + 60_000 };
  const service = createCloudFilesService({
    settingsFile: join(dir, "user", "settings.json"), stateFile: join(dir, "user", "state.db"),
    documentsDir: join(home, "Documents"), localDataDir: join(home, ".openmausbot"), homeDir: home,
    platform: process.platform, hostname: "Ash-MBP", cloudOrigin: () => "https://omb-u-aaaaaaaaaaaa.fly.dev", fetch: async () => { throw new Error("no network in tests"); },
    trashItem: async (file) => { trashed.push(readFileSync(file, "utf8")); rmSync(file); }, markDownloaded: async () => {},
    createClient: () => cloud.client, watch: () => () => {}, freeBytes: () => 100 * GB, now: () => clock.now, lending, planDisk: () => ({ maxBytes: 20 * GB }),
  });
  t.after(() => { service.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, home, notes, cloud, lent, service, trashed, clock };
}

test("every lent folder that fits gets a copy by itself, and My Cloud hears what is lent and where each copy is", async (t) => {
  const s = setup(t);
  await s.service.pass();
  const [entry] = s.service.state().shared;
  assert.equal(entry.lent, true);
  assert.equal(entry.status, "synced");
  assert.equal(s.cloud.get(entry.id, "plan.md"), "the plan");
  const report = s.cloud.lent.reports.at(-1);
  assert.deepEqual(report, { computerId: report.computerId, lendingId: s.lent.now.lendingId, name: "Ash-MBP", ...(["darwin", "win32", "linux"].includes(process.platform) ? { platform: process.platform } : {}),
    folders: [{ id: s.lent.now.folders[0].id, name: "Notes", write: true, syncId: entry.id }] });
  assert.equal(s.cloud.lent.synced.get(entry.id), 1, "a pass in step says how fresh the copy is");
  // No longer lent: its copy goes to My Cloud's trash, nothing here changes.
  s.lent.now = { off: true };
  await s.service.pass();
  assert.deepEqual(s.service.state().shared, []);
  assert.ok(s.cloud.calls.some(([call, id, keep]) => call === "unregister" && id === entry.id && keep === false));
  assert.equal(readFileSync(join(s.notes, "plan.md"), "utf8"), "the plan");
  assert.deepEqual(s.cloud.lent.reports.at(-1).folders, []);
});

test("a folder shared from the Files page joins lending, read only, and keeps its copy", async (t) => {
  const s = setup(t);
  const clients = join(s.home, "Clients");
  mkdirSync(clients);
  writeFileSync(join(clients, "brief.md"), "brief");
  utimesSync(join(clients, "brief.md"), new Date(AT), new Date(AT));
  s.lent.now = { off: true };
  await s.service.share(clients);
  const before = s.service.state().shared.find((entry) => entry.name === "Clients");
  assert.equal(before.lent, false, "lending was off: it keeps working as it did");
  const uploads = s.cloud.calls.filter(([call]) => call === "upload").length;
  s.lent.now = { lendingId: randomUUID(), folders: [], protectedPaths: [] };
  await s.service.pass();
  const after = s.service.state().shared.find((entry) => entry.name === "Clients");
  assert.equal(after.lent, true);
  assert.equal(after.id, before.id, "the same copy on My Cloud");
  assert.equal(s.lent.now.folders[0].write, false);
  assert.equal(s.cloud.calls.filter(([call]) => call === "upload").length, uploads, "nothing sent again");
});

test("a bot's change from while this computer was away lands, and one that met the person's own edit keeps both", async (t) => {
  const s = setup(t);
  await s.service.pass();
  const [entry] = s.service.state().shared;
  writeFileSync(join(s.notes, "todo.md"), "mine");
  utimesSync(join(s.notes, "todo.md"), new Date(AT), new Date(AT));
  s.cloud.stage(entry.id, "plan.md", "the bot's plan", sha("the plan"));
  s.cloud.stage(entry.id, "drafts/new.md", "a new draft");
  s.cloud.stage(entry.id, "todo.md", "the bot's todo", sha("the old todo"));
  await s.service.pass();
  assert.equal(readFileSync(join(s.notes, "plan.md"), "utf8"), "the bot's plan");
  assert.deepEqual(s.trashed, ["the plan"], "the version it replaced went to the Recycle Bin");
  assert.equal(readFileSync(join(s.notes, "drafts", "new.md"), "utf8"), "a new draft");
  assert.equal(readFileSync(join(s.notes, "todo.md"), "utf8"), "mine", "the person's edit stays");
  const besides = readdirSync(s.notes).filter((name) => name.startsWith("todo (new from My Cloud"));
  assert.equal(besides.length, 1);
  assert.equal(readFileSync(join(s.notes, besides[0]), "utf8"), "the bot's todo");
  assert.equal(s.cloud.lent.staged.length, 0, "every change was answered");
  const shown = s.service.state().shared[0];
  assert.deepEqual(shown.kept.map(({ path, beside }) => ({ path, beside })), [{ path: "todo.md", beside: besides[0] }]);
  // Then they go up to the copy, once settled.
  s.clock.now = Date.now() + 60_000;
  await s.service.pass();
  assert.equal(s.cloud.get(entry.id, "plan.md"), "the bot's plan");
  assert.equal(s.cloud.get(entry.id, besides[0]), "the bot's todo");
  assert.ok(existsSync(join(s.notes, "drafts")));
});

test("while lending is paused, a bot's change made on My Cloud waits there; Resume lands it, and the copy is kept all along", async (t) => {
  const s = setup(t);
  await s.service.pass();
  const [entry] = s.service.state().shared;
  s.lent.now = { ...s.lent.now, paused: true };
  s.cloud.stage(entry.id, "plan.md", "the bot's plan", sha("the plan"));
  await s.service.pass();
  assert.equal(readFileSync(join(s.notes, "plan.md"), "utf8"), "the plan", "nothing lands here while paused");
  assert.equal(s.cloud.lent.staged.length, 1, "it waits on My Cloud");
  assert.equal(s.service.state().shared[0]?.id, entry.id, "the copy stays");
  const { paused: _paused, ...resumed } = s.lent.now;
  s.lent.now = resumed;
  await s.service.pass();
  assert.equal(readFileSync(join(s.notes, "plan.md"), "utf8"), "the bot's plan");
  assert.equal(s.cloud.lent.staged.length, 0);
});

test("a Cloud from before lent copies gets none: lending stays live only there, and nothing lands where every bot reads", async (t) => {
  const s = setup(t);
  s.cloud.state.lentCopies = false;
  await s.service.pass();
  assert.deepEqual(s.service.state().shared, []);
  assert.equal(s.cloud.calls.some(([call]) => call === "register" || call === "lent"), false);
});

test("a lent folder deleted from disk never stops lending or unlending the rest", async () => {
  const env = { id: "cloud", origin: "https://omb-u-aaaaaaaaaaaa.fly.dev" };
  const gone = folder("Gone"), kept = folder("Kept");
  let state = { enabled: true, folders: [gone, kept], screen: false, internet: true, chrome: false, terminal: false };
  const saved = [];
  const sharing = { cloudState: () => state, saveCloud: async (_env, input) => { saved.push(input); state = { ...state, ...input }; return state; }, revoke: () => {}, lentToCloud: () => ({ off: true }) };
  // As validateSharedFolders does: a folder no longer on disk rejects with ENOENT.
  const validate = async ([entry]) => { if (entry.path === gone.path) throw Object.assign(new Error("gone"), { code: "ENOENT" }); return [{ ...entry, name: entry.path.split("/").at(-1) }]; };
  const lending = lendingForFiles({ environment: () => env, sharing: () => sharing, validate });
  await lending.unlend(kept.id);
  assert.deepEqual(saved.at(-1).folders, []);
  state = { ...state, folders: [gone, kept] };
  await lending.lend("/Users/ash/New");
  assert.deepEqual(saved.at(-1).folders.map((entry) => entry.name), ["Kept", "New"]);
});

test("a bot's change that can't land here shows on the folder; the copy is still as fresh as the computer", async (t) => {
  const s = setup(t);
  await s.service.pass();
  const [entry] = s.service.state().shared;
  const synced = s.cloud.lent.synced.get(entry.id);
  s.cloud.stage(entry.id, ".git/config", "[core]");
  await s.service.pass();
  const shown = s.service.state().shared[0];
  assert.equal(shown.status, "problem");
  assert.match(shown.problem, /^\.git\/config: Files inside \.git/);
  assert.equal(s.cloud.lent.synced.get(entry.id), synced + 1);
  assert.equal(s.cloud.lent.staged.length, 1, "it keeps waiting on My Cloud");
});

test("a lent GitHub repository's copy starts as My Cloud's clone: Files waits for it, then sends only what differs", async (t) => {
  const s = setup(t);
  const { execFileSync } = await import("node:child_process");
  const git = (...args) => execFileSync("git", ["-C", s.notes, "-c", "user.name=t", "-c", "user.email=t@example.test", ...args], { encoding: "utf8" }).trim();
  git("init", "--quiet", "--initial-branch", "main");
  git("remote", "add", "origin", "git@github.com:ash/notes.git");
  git("add", "plan.md");
  git("commit", "--quiet", "-m", "plan");
  writeFileSync(join(s.notes, ".env"), "TOKEN=local");
  utimesSync(join(s.notes, ".env"), new Date(AT), new Date(AT));
  s.cloud.state.clones = true;
  await s.service.pass();
  const [entry] = s.service.state().shared;
  const sent = () => s.cloud.calls.filter(([call]) => call === "upload").map(([, path]) => path);
  assert.deepEqual(sent(), [], "nothing sent while My Cloud clones");
  assert.equal(s.service.state().shared[0].status, "copying");
  const folder = s.cloud.folders.get(entry.id);
  assert.deepEqual(folder.git, { repo: "ash/notes", branch: "main", head: git("rev-parse", "HEAD") });
  assert.deepEqual(s.cloud.lent.reports.at(-1).folders[0].git, folder.git, "bots learn it is that repository");
  s.cloud.cloned(entry.id, { "plan.md": "the plan" });
  await s.service.pass();
  assert.deepEqual(sent(), [".env"], "only what GitHub doesn't have: the ignored config file");
  assert.equal(s.service.state().shared[0].status, "synced");
});

test("on Windows a folder is one folder whatever its slashes, trailing separator or case", () => {
  assert.equal(folderKey("C:\\Users\\Ash\\Clients\\", "win32"), "c:/users/ash/clients");
  assert.equal(folderKey("\\\\server\\share\\Docs", "win32"), "//server/share/docs");
  assert.equal(sameFolderOn("win32")("C:\\Users\\Ash\\Clients", "c:/users/ash/CLIENTS/"), true);
  assert.equal(sameFolderOn("darwin")("/Users/Ash/Clients", "/users/ash/clients"), true);
  assert.equal(sameFolderOn("linux")("/home/ash/Clients", "/home/ash/clients"), false, "Linux tells case apart");
  // The Files page shared C:\Users\Ash\Clients before; lending reports it with another spelling: one folder, one copy.
  const clients = { id: randomUUID(), path: "c:\\users\\ash\\Clients", name: "Clients", write: false };
  const legacy = { key: "k-1", id: "pc-1", pcPath: "C:\\Users\\Ash\\Clients", name: "Clients", deletes: null };
  const plan = new Map([[clients.id, { copy: true }]]);
  const { shared, dropped } = reconcileLent({ shared: [legacy], folders: [clients], plan, sameFolder: sameFolderOn("win32"), now: AT, newKey: () => "k-new" });
  assert.deepEqual(shared, [{ ...legacy, lentId: clients.id, write: false }]);
  assert.deepEqual(dropped, []);
  assert.equal(reconcileLent({ shared: [legacy], folders: [clients], plan, sameFolder: sameFolderOn("linux"), now: AT, newKey: () => "k-new" }).shared.length, 2);
});
