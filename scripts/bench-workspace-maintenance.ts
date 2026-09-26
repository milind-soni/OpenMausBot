// Disposable fixtures only; never import config before isolating data.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import { setTimeout as delay, setImmediate } from "node:timers/promises";

const directory = mkdtempSync(join(tmpdir(), "omb-maintenance-probe-"));
const previousDataDir = process.env.OMB_DATA_DIR;
process.env.OMB_DATA_DIR = directory;
const db = await import("../server/message-db.ts");
const { Store } = await import("../server/store.ts");
const memory = await import("../server/workspace.ts");
const backups = await import("../server/workspace-backup.ts");
const inline = process.argv.includes("--in-process");
console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, inline,
  scope: "Synthetic file-backed method pressure, not HTTP throughput or production capacity." }));
const measure = async (name: string, action: () => void | Record<string, number> | Promise<void | Record<string, number>>) => {
  const lag = monitorEventLoopDelay({ resolution: 2 });
  lag.enable(); await delay(20);
  const start = performance.now();
  const result = await action();
  const elapsedMs = performance.now() - start;
  await delay(20); lag.disable();
  console.log(JSON.stringify({ name, elapsedMs: +elapsedMs.toFixed(2), loopMaxMs: +(lag.max / 1e6).toFixed(2), ...result }));
};
try {
  const text = "Synthetic memory and history pressure. ".repeat(26);
  for (let t = 0; t < 50; t++) {
    db.importThread(`thread-${t}`, Array.from({ length: 1000 }, (_, i) => ({
      id: `message-${i}`, parentId: i ? `message-${i - 1}` : null, at: i + 1, role: "user" as const, kind: "text" as const, text,
    })), "message-999");
    await setImmediate();
  }
  const checkpoint = new DatabaseSync(join(directory, "messages.db"));
  try { checkpoint.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } finally { checkpoint.close(); }
  await delay(1000);
  for (const size of [1, 10, 50]) {
    const store = new Store(() => ({ instanceId: "fixture", model: "synthetic" }));
    await measure(`tail-100-rows-${size}-threads`, () => {
      for (let t = 0; t < size; t++) {
        const page = store.messagesTail(`thread-${t}`, 100);
        assert.equal(page.messages.length, 100); assert.equal(page.hasMore, true);
      }
    });
    await measure(`full-1000-rows-${size}-threads`, () => {
      for (let t = 0; t < size; t++) assert.equal(store.messagesFor(`thread-${t}`).length, 1000);
    });
  }
  for (const size of [100, 1000]) {
    const id = `memory-${size}`, workspace = memory.ensureWorkspace(id);
    for (let i = 0; i < size; i++) writeFileSync(join(workspace, "memory", `topic-${i}.md`), text.repeat(4));
    await delay(1000);
    await measure(`memory-cold-${size}-files`, () => { memory.syncMemoryIndex(id); assert.equal(db.indexedMemoryFiles(id).length, size + 1); });
    await measure(`memory-warm-${size}-files`, () => { memory.syncMemoryIndex(id); assert.equal(db.indexedMemoryFiles(id).length, size + 1); });
  }
  mkdirSync(join(directory, "attachments"));
  writeFileSync(join(directory, "attachments", "synthetic.bin"), Buffer.alloc(1024 * 1024, 0x31));
  db.closeMessageDb(); await delay(1000);
  await measure("workspace-backup-50000-messages-1100-memory-files", async () => {
    const create = inline ? backups.createWorkspaceBackupSnapshot : backups.createWorkspaceBackup;
    const backup = await create(directory, { password: "synthetic benchmark password only", appVersion: "test" });
    assert.equal(backup.summary.messages, 50_000);
    return { files: backup.summary.files, bytes: backup.summary.bytes, messages: backup.summary.messages };
  });
} finally {
  db.closeMessageDb();
  if (previousDataDir === undefined) delete process.env.OMB_DATA_DIR;
  else process.env.OMB_DATA_DIR = previousDataDir;
  rmSync(directory, { recursive: true, force: true });
}
