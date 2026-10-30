import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { SyncPathError, insideFolder, syncRoot } from "./cloud-sync-paths.ts";
import { CloudSyncStore, syncedFolders } from "./cloud-sync-store.ts";

const PC = "3f9c2a4e-8b1d-4c6e-9a7f-2d5e8c1b0a93";
const OTHER = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const scratch: string[] = [];
const stores: CloudSyncStore[] = [];
function setup() {
  const home = mkdtempSync(join(tmpdir(), "omb-sync-store-"));
  scratch.push(home);
  const dataDir = join(home, ".openmausbot");
  mkdirSync(dataDir);
  const store = new CloudSyncStore({ dataDir, now: () => 1_000 });
  stores.push(store);
  return { home, dataDir, store };
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("puts synced folders beside the data folder unless OMB_SYNC_ROOT says otherwise", () => {
  expect(syncRoot("/data/.openmausbot", {})).toBe(join("/data", "Synced"));
  expect(syncRoot("/data/.openmausbot", { OMB_SYNC_ROOT: "/mnt/sync" })).toBe("/mnt/sync");
});

it("keeps a lent folder's copy in the data folder, out of bots' reach and the prompt; a copy kept before stays where it is", () => {
  const { home, dataDir, store } = setup();
  const lent = store.register({ computerId: PC, computerName: "Ash-MBP", pcPath: "/Users/ash/Notes", name: "Notes", lent: true });
  expect(lent.cloudPath).toBe(join(dataDir, "sync", "lent", "Ash-MBP", "Notes"));
  expect(lent.lent).toBe(true);
  const before = store.register({ computerId: PC, computerName: "Ash-MBP", pcPath: "/Users/ash/Clients", name: "Clients" });
  expect(before.cloudPath).toBe(join(home, "Synced", "Ash-MBP", "Clients"));
  expect(store.register({ computerId: PC, computerName: "Ash-MBP", pcPath: "/Users/ash/Clients", name: "Clients", lent: true }).id).toBe(before.id);
  expect(syncedFolders(dataDir).map((folder) => folder.cloudPath)).toEqual([before.cloudPath]);
  // Its copy gone, a lent folder is copied again where bots can't read it.
  rmSync(before.cloudPath, { recursive: true });
  expect(store.register({ computerId: PC, computerName: "Ash-MBP", pcPath: "/Users/ash/Clients", name: "Clients", lent: true }).cloudPath).toBe(join(dataDir, "sync", "lent", "Ash-MBP", "Clients"));
});

it("registers a PC folder once, under that computer's own folder, and creates it", () => {
  const { home, store } = setup();
  const first = store.register({ computerId: PC, computerName: "Ash-PC", pcPath: "C:\\Users\\Ash\\Documents\\PA", name: "PA" });
  expect(first.cloudPath).toBe(join(home, "Synced", "Ash-PC", "PA"));
  expect(existsSync(first.cloudPath)).toBe(true);
  expect(store.register({ computerId: PC, computerName: "Ash-PC", pcPath: "c:\\users\\ash\\documents\\pa", name: "PA" }).id).toBe(first.id);
  const second = store.register({ computerId: PC, computerName: "Ash-PC", pcPath: "D:\\Work\\PA", name: "PA" });
  expect(second.cloudPath).toBe(join(home, "Synced", "Ash-PC", "PA (2)"));
  const other = store.register({ computerId: OTHER, computerName: "Ash-PC", pcPath: "/Users/ash/PA", name: "PA" });
  expect(other.cloudPath).toBe(join(home, "Synced", "Ash-PC (2)", "PA"));
  expect(store.pcFolders().map((folder) => folder.id)).toEqual([first.id, second.id, other.id]);
  expect(syncedFolders(store.dataDir)).toEqual([
    { computerName: "Ash-PC", pcPath: "C:\\Users\\Ash\\Documents\\PA", cloudPath: first.cloudPath },
    { computerName: "Ash-PC", pcPath: "D:\\Work\\PA", cloudPath: second.cloudPath },
    { computerName: "Ash-PC", pcPath: "/Users/ash/PA", cloudPath: other.cloudPath },
  ]);
  expect(store.unregister(second.id)?.id).toBe(second.id);
  expect(store.folder(second.id)).toBeUndefined();
});

it("offers a bot's conversation folder only once it holds a file", () => {
  const { dataDir, store } = setup();
  mkdirSync(join(dataDir, "task-workspaces", "bot1", "thread1"), { recursive: true });
  mkdirSync(join(dataDir, "task-workspaces", "bot1", "thread2", "node_modules"), { recursive: true });
  writeFileSync(join(dataDir, "task-workspaces", "bot1", "thread2", "node_modules", "x.js"), "skipped");
  expect(store.botFolders()).toEqual([]);
  writeFileSync(join(dataDir, "task-workspaces", "bot1", "thread1", "report.md"), "# Report");
  expect(store.botFolders()).toEqual([{ id: "bot-bot1-thread1", kind: "bot", botId: "bot1", threadId: "thread1", cloudPath: join(dataDir, "task-workspaces", "bot1", "thread1"), newestMs: expect.any(Number) }]);
});

it("resolves a path only inside its folder, never through a link", () => {
  const { home } = setup();
  const folder = join(home, "f");
  mkdirSync(join(folder, "real"), { recursive: true });
  symlinkSync(home, join(folder, "link"));
  expect(insideFolder(folder, "real/a.txt")).toBe(join(folder, "real", "a.txt"));
  for (const bad of ["../x", "/etc/passwd", "a\\b", "link/a.txt"]) expect(() => insideFolder(folder, bad)).toThrow(SyncPathError);
});

it("lists a folder with hashes, hashing again only what changed", async () => {
  const { store } = setup();
  const folder = store.register({ computerId: PC, computerName: "Ash-PC", pcPath: "/Users/ash/PA", name: "PA" });
  mkdirSync(join(folder.cloudPath, "sub"));
  const file = join(folder.cloudPath, "sub", "a.txt");
  writeFileSync(file, "one");
  utimesSync(file, new Date(1_000), new Date(1_000));
  writeFileSync(join(folder.cloudPath, "Thumbs.db"), "litter");
  symlinkSync("/etc/hosts", join(folder.cloudPath, "link.txt"));
  const [first] = await store.list(folder);
  expect(first).toMatchObject({ path: "sub/a.txt", size: 3, sha256: "7692c3ad3540bb803c020b3aee66cd8887123234ea0c6e7143c0add73ff431ed" });
  writeFileSync(file, "two");
  utimesSync(file, new Date(1_000), new Date(1_000));
  expect((await store.list(folder))[0]!.sha256).toBe(first!.sha256);
  utimesSync(file, new Date(5_000), new Date(5_000));
  expect((await store.list(folder))[0]!.sha256).not.toBe(first!.sha256);
  expect(store.bytesByKind()).toEqual({ pc: 3, bot: 0 });
});

it("keeps a removed file in the trash for 30 days", async () => {
  let now = 1_000;
  const home = mkdtempSync(join(tmpdir(), "omb-sync-trash-"));
  scratch.push(home);
  const store = new CloudSyncStore({ dataDir: join(home, ".openmausbot"), now: () => now });
  stores.push(store);
  const folder = store.register({ computerId: PC, computerName: "PC", pcPath: "/p", name: "P" });
  writeFileSync(join(folder.cloudPath, "a.txt"), "hello");
  await store.list(folder);
  const entry = store.toTrash(folder, "a.txt", join(folder.cloudPath, "a.txt"));
  expect(existsSync(join(folder.cloudPath, "a.txt"))).toBe(false);
  expect(store.trash()).toEqual([{ id: entry.id, folderId: folder.id, path: "a.txt", size: 5, deletedAt: 1_000 }]);
  expect(store.trashBytes()).toBe(5);
  expect(readFileSync(store.trashEntry(entry.id)!.file, "utf8")).toBe("hello");
  expect(await store.current(folder, "a.txt")).toBeNull();
  now += 29 * 86_400_000;
  store.sweepTrash();
  expect(store.trash()).toHaveLength(1);
  now += 2 * 86_400_000;
  store.sweepTrash();
  expect(store.trash()).toEqual([]);
  expect(store.trashBytes()).toBe(0);
});
