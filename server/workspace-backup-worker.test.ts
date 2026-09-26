import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { createWorkspaceBackup } from "./workspace-backup.ts";

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
