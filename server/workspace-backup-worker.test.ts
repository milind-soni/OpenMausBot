import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { createWorkspaceBackup } from "./workspace-backup.ts";

// Capture the real worker to exercise an abrupt exit, not a simulated result.
const running = vi.hoisted(() => ({ worker: undefined as import("node:worker_threads").Worker | undefined }));
vi.mock("node:worker_threads", async importOriginal => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  return { ...actual, Worker: class extends actual.Worker {
    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      super(...args);
      running.worker = this;
    }
  } };
});

// Real encrypted backups of 800+ files: about 3 s on Linux and macOS but about
// 25 s on the Windows runners, so a 30 s limit there timed out under load.
const TIMEOUT_MS = 120_000;

it("keeps the request loop running during the snapshot copy, not just encryption", async () => {
  const directory = mkdtempSync(join(tmpdir(), "omb-backup-worker-"));
  const first = "file-0000.txt", last = "file-0319.txt";
  for (let i = 0; i < 320; i++) writeFileSync(join(directory, `file-${String(i).padStart(4, "0")}.txt`), "synthetic");
  let observedCopy = false;
  const timer = setInterval(() => {
    const root = join(directory, ".backups");
    if (!existsSync(root)) return;
    for (const job of readdirSync(root)) {
      const snapshot = join(root, job, "snapshot", "data");
      if (existsSync(join(snapshot, first)) && !existsSync(join(snapshot, last))) observedCopy = true;
    }
  }, 1);
  try {
    const result = await createWorkspaceBackup(directory, { password: "fixture-backup-password-only" });
    expect(result.summary.files).toBe(320);
    expect(existsSync(result.path)).toBe(true);
    expect(observedCopy).toBe(true);
  } finally {
    clearInterval(timer);
    rmSync(directory, { recursive: true, force: true });
  }
}, TIMEOUT_MS);

// A copy's status poll (GET /api/cloud-move counts chats in the live message
// database) opens its own connection while the restore's backup snapshots that
// database, and the busy moment of that connection opening or closing used to
// fail the snapshot outright ("database is locked", or Node's "not an error").
it("waits for another connection's moment on the message database instead of failing the snapshot", async () => {
  const directory = mkdtempSync(join(tmpdir(), "omb-backup-worker-busy-"));
  const database = join(directory, "messages.db");
  const store = new DatabaseSync(database);
  store.exec("PRAGMA journal_mode = WAL");
  store.exec("CREATE TABLE messages (thread_id TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY (thread_id, id)); CREATE TABLE thread_state (thread_id TEXT PRIMARY KEY)");
  const insert = store.prepare("INSERT INTO messages VALUES (?, ?, '{}')");
  for (let i = 0; i < 40; i++) insert.run(`thread-${i % 3}`, `message-${i}`);
  store.close();
  // The other connection holds the database the way that busy moment does:
  // in WAL mode, only exclusive locking mode keeps another reader out.
  const holder = new DatabaseSync(database);
  holder.exec("PRAGMA locking_mode = EXCLUSIVE");
  holder.exec("BEGIN EXCLUSIVE");
  let held = true;
  const release = () => { if (held) { held = false; holder.exec("COMMIT"); holder.close(); } };
  let settled = false;
  const pending = createWorkspaceBackup(directory, { password: "fixture-backup-password-only" })
    .then(result => ({ result, error: undefined }), (error: unknown) => ({ result: undefined, error }))
    .finally(() => { settled = true; });
  try {
    // Hold it until the snapshot is reading it (its copy exists from then on), and a moment longer.
    const root = join(directory, ".backups");
    const reading = () => existsSync(root) && readdirSync(root).some(id => existsSync(join(root, id, "snapshot", "messages-snapshot.db")));
    await expect.poll(() => settled || reading(), { interval: 1, timeout: TIMEOUT_MS }).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 250));
    release();
    const { result, error } = await pending;
    expect(error).toBeUndefined();
    expect(result?.summary).toMatchObject({ messages: 40, threads: 3 });
  } finally {
    release();
    await pending;
    rmSync(directory, { recursive: true, force: true });
  }
}, TIMEOUT_MS);

it("removes only the failed worker's partial snapshot after an abrupt exit", async () => {
  const directory = mkdtempSync(join(tmpdir(), "omb-backup-worker-exit-"));
  let pending: Promise<{ error?: unknown }> | undefined;
  try {
    writeFileSync(join(directory, "existing.txt"), "synthetic earlier export");
    const earlier = await createWorkspaceBackup(directory, { password: "fixture-backup-password-only" });
    for (let i = 0; i < 800; i++) writeFileSync(join(directory, `file-${String(i).padStart(4, "0")}.txt`), "synthetic");
    pending = createWorkspaceBackup(directory, { password: "fixture-backup-password-only" })
      .then(() => ({}), error => ({ error }));
    const root = join(directory, ".backups");
    await expect.poll(() => readdirSync(root).some(id => id !== earlier.id &&
      existsSync(join(root, id, "snapshot", "data", "file-0000.txt"))), { interval: 1, timeout: 10_000 }).toBe(true);
    await running.worker!.terminate();
    expect((await pending).error).toMatchObject({ message: "The backup worker stopped before completing. Try again." });
    expect(readdirSync(root)).toEqual([earlier.id]);
    expect(existsSync(earlier.path)).toBe(true);
    expect(existsSync(join(directory, "file-0000.txt"))).toBe(true);
    const next = await createWorkspaceBackup(directory, { password: "fixture-backup-password-only" });
    expect(next.summary.files).toBe(801);
  } finally {
    await running.worker?.terminate();
    await pending;
    rmSync(directory, { recursive: true, force: true });
  }
}, TIMEOUT_MS);
