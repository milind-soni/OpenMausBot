import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  apply: vi.fn(), pending: vi.fn(), last: vi.fn(), committed: vi.fn(), load: vi.fn(), persist: vi.fn(), read: vi.fn(), restore: vi.fn(),
}));
vi.mock("./workspace-backup.ts", () => ({
  applyPendingWorkspaceRestore: hooks.apply, readPendingWorkspaceRestoreMetadata: hooks.pending, readLastWorkspaceRestore: hooks.last,
  isWorkspaceRestoreCommitted: hooks.committed,
}));
vi.mock("./workspace-backup-desktop.ts", () => ({
  loadWorkspaceBackupCredentials: hooks.load, persistWorkspaceBackupCredentials: hooks.persist,
  readDesktopBackupCredentials: hooks.read, restoreDesktopBackupCredentials: hooks.restore,
}));
import { restoreWorkspaceBackupOnStartup } from "./workspace-backup-startup.ts";

let dir: string;
const id = "00000000-0000-4000-8000-000000000001";
const old = { boxToken: "old-synthetic-key" };
const incoming = { boxToken: "incoming-synthetic-key" };
beforeEach(() => {
  vi.resetAllMocks();
  dir = mkdtempSync(join(tmpdir(), "omb-backup-startup-"));
  hooks.read.mockResolvedValue(old);
  hooks.pending.mockReturnValue(null);
  hooks.last.mockReturnValue(null);
  hooks.apply.mockReturnValue({ restored: false });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it("does not touch backup paths on a normal launch", async () => {
  expect(await restoreWorkspaceBackupOnStartup(dir)).toEqual({ restored: false });
  expect(hooks.pending).not.toHaveBeenCalled();
  expect(existsSync(join(dir, ".backups"))).toBe(false);
});

it("saves credential rollback before changing either store and preserves it on failed restore", async () => {
  mkdirSync(join(dir, ".backups"));
  hooks.pending.mockReturnValue({ id, credentials: incoming });
  hooks.restore.mockImplementation(async (credentials) => {
    if (credentials === incoming) expect(JSON.parse(readFileSync(join(dir, ".backups", "credential-rollback.json"), "utf8"))).toEqual({ id, credentials: old });
  });
  hooks.apply.mockImplementation((_dir, options) => {
    options.beforeCommit();
    throw new Error("files recovered");
  });
  await expect(restoreWorkspaceBackupOnStartup(dir)).rejects.toThrow("files recovered");
  expect(hooks.persist).toHaveBeenCalledWith(dir, incoming);
  expect(hooks.restore.mock.calls.map(([value]) => value)).toEqual([incoming, old]);
  expect(existsSync(join(dir, ".backups", "credential-rollback.json"))).toBe(true);
});

it("recovers old credentials after an interrupted filesystem rollback", async () => {
  mkdirSync(join(dir, ".backups"));
  writeFileSync(join(dir, ".backups", "credential-rollback.json"), JSON.stringify({ id, credentials: old }));
  hooks.apply.mockReturnValue({ restored: false, rolledBack: true, id });
  expect(await restoreWorkspaceBackupOnStartup(dir)).toMatchObject({ rolledBack: true });
  expect(hooks.restore).toHaveBeenCalledWith(old);
  expect(existsSync(join(dir, ".backups", "credential-rollback.json"))).toBe(false);
});

it("keeps incoming credentials if the durable commit precedes a failed receipt write", async () => {
  mkdirSync(join(dir, ".backups"));
  hooks.pending.mockReturnValue({ id, credentials: incoming });
  hooks.committed.mockReturnValue(true);
  hooks.apply.mockImplementation(() => { throw new Error("receipt write failed"); });
  await expect(restoreWorkspaceBackupOnStartup(dir)).rejects.toThrow("receipt write failed");
  expect(hooks.restore.mock.calls.map(([value]) => value)).toEqual([incoming]);
  expect(existsSync(join(dir, ".backups", "credential-rollback.json"))).toBe(true);
});

it("does not revert credentials when disk committed before the process exited", async () => {
  const safetyCopyPath = join(dir, ".backups", `safety-${id}`);
  mkdirSync(safetyCopyPath, { recursive: true });
  writeFileSync(join(dir, ".backups", "credential-rollback.json"), JSON.stringify({ id, credentials: old }));
  hooks.last.mockReturnValue({ restored: true, id, safetyCopyPath });
  expect(await restoreWorkspaceBackupOnStartup(dir)).toMatchObject({ restored: true, id });
  expect(hooks.restore).not.toHaveBeenCalled();
  expect(JSON.parse(readFileSync(join(safetyCopyPath, "credentials.json"), "utf8"))).toEqual(old);
});
