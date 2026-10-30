import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as files from "./cloud-sync-store.ts";
import { createCloudSync, type CloudSync } from "./cloud-sync.ts";

const PC = "3f9c2a4e-8b1d-4c6e-9a7f-2d5e8c1b0a93";
const GB = 1024 ** 3;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
let home: string, sync: CloudSync, folder: files.SyncFolder;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "omb-sync-concurrent-"));
  sync = createCloudSync({ dataDir: join(home, "data"), root: join(home, "Synced"), now: () => new Date(2026, 9, 15, 12).getTime(), statfs: () => ({ totalBytes: 10 * GB, freeBytes: 9 * GB }) });
  folder = sync.register({ computerId: PC, computerName: "PC", pcPath: "/project", name: "Project" });
});
afterEach(() => {
  vi.restoreAllMocks();
  sync.close();
  rmSync(home, { recursive: true, force: true });
});

async function upload(text: string, baseSha256: string | null, path = "a.txt", folderId = folder.id) {
  const { uploadId } = sync.beginUpload(folderId, { path, size: Buffer.byteLength(text), sha256: sha(text), baseSha256 });
  await sync.writePart(uploadId, 0, (async function* () { yield Buffer.from(text); })());
  return uploadId;
}

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function holdCurrent() {
  const entered = gate(), release = gate();
  const current = sync.store.current.bind(sync.store);
  vi.spyOn(sync.store, "current").mockImplementationOnce(async (...args) => {
    const file = await current(...args);
    entered.resolve();
    await release.promise;
    return file;
  });
  return { entered: entered.promise, release: release.resolve };
}

async function checkedCommit(uploadId: string) {
  const checked = gate();
  const hash = files.sha256File;
  const spy = vi.spyOn(files, "sha256File").mockImplementation(async (path) => {
    const result = await hash(path);
    if (path === join(sync.store.syncDir(), "uploads", `${uploadId}.part`)) checked.resolve();
    return result;
  });
  const outcome = Promise.allSettled([sync.commit(uploadId)]);
  await checked.promise;
  await setImmediate();
  spy.mockRestore();
  return { outcome };
}

it("accepts only one competing commit over the same uncached version", async () => {
  writeFileSync(join(folder.cloudPath, "a.txt"), "original");
  const firstId = await upload("first", sha("original")), secondId = await upload("second", sha("original"));
  const held = holdCurrent();
  const first = sync.commit(firstId);
  await held.entered;
  const second = await checkedCommit(secondId);
  held.release();
  expect(await first).toEqual({ sha256: sha("first") });
  expect(await second.outcome).toMatchObject([{ status: "rejected", reason: { status: 409, body: { current: { sha256: sha("first") } } } }]);
  expect(readFileSync(join(folder.cloudPath, "a.txt"), "utf8")).toBe("first");
  expect(sync.trash().entries).toHaveLength(1);
  expect(readFileSync(sync.store.trashEntry(sync.trash().entries[0]!.id)!.file, "utf8")).toBe("original");
  expect(await sync.commit(await upload("third", sha("first")))).toEqual({ sha256: sha("third") });
});

it.each(["\ud800.txt", "\ud801.txt", "\udc00.txt", "\udfff.txt"])("rejects a malformed Unicode alias %j while its file has a pending commit", async (path) => {
  const target = join(folder.cloudPath, "\ufffd.txt");
  writeFileSync(target, "original");
  const id = await upload("first", sha("original"), "\ufffd.txt");
  const held = holdCurrent();
  const committed = sync.commit(id);
  await held.entered;
  try {
    await expect(upload("second", sha("original"), path).then((id) => sync.commit(id))).rejects.toMatchObject({ status: 400 });
    expect(readFileSync(target, "utf8")).toBe("original");
  } finally { held.release(); await committed; }
  expect(readFileSync(target, "utf8")).toBe("first");
});

it("checks a competing delete against the committed version", async () => {
  writeFileSync(join(folder.cloudPath, "a.txt"), "original");
  const id = await upload("first", sha("original"));
  const held = holdCurrent();
  const committed = sync.commit(id);
  await held.entered;
  const deleted = sync.ops(folder.id, { ops: [{ op: "delete", path: "a.txt", baseSha256: sha("original") }] });
  await setImmediate();
  held.release();
  await committed;
  expect(await deleted).toMatchObject({ results: [{ conflict: true, current: { sha256: sha("first") } }] });
  expect(readFileSync(join(folder.cloudPath, "a.txt"), "utf8")).toBe("first");
});

it("rejects a competing commit after a delete removes its base version", async () => {
  writeFileSync(join(folder.cloudPath, "a.txt"), "original");
  const id = await upload("first", sha("original"));
  const held = holdCurrent();
  const deleted = sync.ops(folder.id, { ops: [{ op: "delete", path: "a.txt", baseSha256: sha("original") }] });
  await held.entered;
  const committed = await checkedCommit(id);
  held.release();
  expect(await deleted).toEqual({ results: [{ ok: true }] });
  expect(await committed.outcome).toMatchObject([{ status: "rejected", reason: { status: 409, body: { current: null } } }]);
  expect(existsSync(join(folder.cloudPath, "a.txt"))).toBe(false);
});

it("accepts competing deletes without moving the same file twice", async () => {
  writeFileSync(join(folder.cloudPath, "a.txt"), "original");
  const held = holdCurrent();
  const ops = { ops: [{ op: "delete", path: "a.txt", baseSha256: sha("original") }] };
  const first = Promise.allSettled([sync.ops(folder.id, ops)]);
  await held.entered;
  const second = Promise.allSettled([sync.ops(folder.id, ops)]);
  await setImmediate();
  held.release();
  expect(await first).toMatchObject([{ status: "fulfilled", value: { results: [{ ok: true }] } }]);
  expect(await second).toMatchObject([{ status: "fulfilled", value: { results: [{ ok: true }] } }]);
  expect(sync.trash().entries).toHaveLength(1);
});

it("restores beside a commit that was checking an empty destination", async () => {
  writeFileSync(join(folder.cloudPath, "a.txt"), "original");
  await sync.ops(folder.id, { ops: [{ op: "delete", path: "a.txt", baseSha256: sha("original") }] });
  const entry = sync.trash().entries[0]!;
  const id = await upload("first", null);
  const held = holdCurrent();
  const committed = sync.commit(id);
  await held.entered;
  const restored = sync.restore(entry.id);
  await setImmediate();
  held.release();
  await committed;
  expect(await restored).toEqual({ folderId: folder.id, path: "a (restored, 15 Oct 2026).txt" });
  expect(readFileSync(join(folder.cloudPath, "a.txt"), "utf8")).toBe("first");
  expect(readFileSync(join(folder.cloudPath, "a (restored, 15 Oct 2026).txt"), "utf8")).toBe("original");
  expect(sync.trash().entries).toEqual([]);
});

it("restores after a competing delete frees the original path", async () => {
  writeFileSync(join(folder.cloudPath, "a.txt"), "original");
  await sync.ops(folder.id, { ops: [{ op: "delete", path: "a.txt", baseSha256: sha("original") }] });
  const entry = sync.trash().entries[0]!;
  writeFileSync(join(folder.cloudPath, "a.txt"), "new");
  const held = holdCurrent();
  const deleted = sync.ops(folder.id, { ops: [{ op: "delete", path: "a.txt", baseSha256: sha("new") }] });
  await held.entered;
  const restored = sync.restore(entry.id);
  await setImmediate();
  held.release();
  await deleted;
  expect(await restored).toEqual({ folderId: folder.id, path: "a.txt" });
  expect(readFileSync(join(folder.cloudPath, "a.txt"), "utf8")).toBe("original");
});

it("lets other paths and folders commit while one path is held", async () => {
  writeFileSync(join(folder.cloudPath, "a.txt"), "original");
  const id = await upload("first", sha("original"));
  const other = sync.register({ computerId: PC, computerName: "PC", pcPath: "/other", name: "Other" });
  const held = holdCurrent();
  const committed = sync.commit(id);
  await held.entered;
  try {
    await sync.commit(await upload("another path", null, "b.txt"));
    await sync.commit(await upload("another folder", null, "a.txt", other.id));
    expect(readFileSync(join(folder.cloudPath, "b.txt"), "utf8")).toBe("another path");
    expect(readFileSync(join(other.cloudPath, "a.txt"), "utf8")).toBe("another folder");
  } finally { held.release(); await committed; }
});

it("does not restore onto another commit's pending collision path", async () => {
  writeFileSync(join(folder.cloudPath, "a.txt"), "original");
  await sync.ops(folder.id, { ops: [{ op: "delete", path: "a.txt", baseSha256: sha("original") }] });
  const entry = sync.trash().entries[0]!;
  writeFileSync(join(folder.cloudPath, "a.txt"), "occupied");
  const path = "a (restored, 15 Oct 2026).txt";
  const id = await upload("first", null, path);
  const held = holdCurrent();
  const committed = sync.commit(id);
  await held.entered;
  const restored = sync.restore(entry.id);
  await setImmediate();
  held.release();
  await committed;
  expect(await restored).toEqual({ folderId: folder.id, path: "a (restored, 15 Oct 2026 2).txt" });
  expect(readFileSync(join(folder.cloudPath, path), "utf8")).toBe("first");
  expect(readFileSync(join(folder.cloudPath, "a (restored, 15 Oct 2026 2).txt"), "utf8")).toBe("original");
});

it("waits for a pending commit before deleting its whole folder", async () => {
  writeFileSync(join(folder.cloudPath, "a.txt"), "original");
  const id = await upload("first", sha("original"));
  const held = holdCurrent();
  const committed = sync.commit(id);
  await held.entered;
  const removed = sync.unregister(folder.id, false);
  await setImmediate();
  held.release();
  expect(await committed).toEqual({ sha256: sha("first") });
  await removed;
  expect(existsSync(folder.cloudPath)).toBe(false);
  const contents = sync.trash().entries.map((entry) => readFileSync(sync.store.trashEntry(entry.id)!.file, "utf8"));
  expect(contents.sort()).toEqual(["first", "original"]);
});
