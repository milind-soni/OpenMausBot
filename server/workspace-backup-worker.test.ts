import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
}, 30_000);

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
}, 30_000);
