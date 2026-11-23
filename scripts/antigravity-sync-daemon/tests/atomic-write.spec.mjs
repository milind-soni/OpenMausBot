import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { atomicWriteJson, createBackup, pruneBackups } from "../src/repo.mjs";

test("atomicWriteJson writes content atomically and creates backup", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-test-atomic-"));
  const targetFile = path.join(tmpDir, "acp_token.json");

  // Initial write
  const initialData = { refresh_token: "token-1", client_id: "client-1" };
  const res1 = await atomicWriteJson(targetFile, initialData);
  assert.equal(res1.written, true);
  assert.equal(fs.existsSync(targetFile), true);
  const read1 = JSON.parse(fs.readFileSync(targetFile, "utf8"));
  assert.equal(read1.refresh_token, "token-1");

  // Write identical content -> should skip
  const res2 = await atomicWriteJson(targetFile, initialData);
  assert.equal(res2.written, false);
  assert.equal(res2.skipped, true);

  // Write modified content -> should backup old and write new
  const modifiedData = { refresh_token: "token-2", client_id: "client-1" };
  const res3 = await atomicWriteJson(targetFile, modifiedData);
  assert.equal(res3.written, true);

  const read3 = JSON.parse(fs.readFileSync(targetFile, "utf8"));
  assert.equal(read3.refresh_token, "token-2");

  // Verify backup exists
  const files = fs.readdirSync(tmpDir);
  const backups = files.filter(f => f.includes("acp_token.json.bak."));
  assert.equal(backups.length, 1);

  // Clean up
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("pruneBackups preserves at most maxBackups newest files", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-test-prune-"));
  const baseName = "acp_token.json";

  // Create 8 fake backup files with staggered mtimes
  for (let i = 1; i <= 8; i++) {
    const fPath = path.join(tmpDir, `${baseName}.bak.20261119-00000${i}`);
    fs.writeFileSync(fPath, `backup-${i}`, "utf8");
  }

  assert.equal(fs.readdirSync(tmpDir).length, 8);

  const prunedCount = pruneBackups(tmpDir, baseName, 5);
  assert.equal(prunedCount, 3);

  const remaining = fs.readdirSync(tmpDir);
  assert.equal(remaining.length, 5);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
