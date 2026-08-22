import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ensureLaunchAgent, treeHash } from "./install-unattended-adapter.mjs";

function scratch(t) {
  const root = mkdtempSync(join(tmpdir(), "omb-unattended-installer-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("generation hashes exclude only receipt metadata and detect artifact drift", (t) => {
  const root = scratch(t);
  mkdirSync(join(root, "server"));
  writeFileSync(join(root, "server", "index.js"), "first");
  const expected = treeHash(root);

  writeFileSync(join(root, "receipt.json"), JSON.stringify({ artifact_sha256: expected }));
  assert.equal(treeHash(root, new Set(["receipt.json"])), expected);

  writeFileSync(join(root, "server", "index.js"), "second");
  assert.notEqual(treeHash(root, new Set(["receipt.json"])), expected);
});

test("existing LaunchAgent targets must be regular and are hardened before reuse", (t) => {
  const root = scratch(t);
  const target = join(root, "agent.plist");
  writeFileSync(target, "exact", { mode: 0o666 });

  ensureLaunchAgent(target, "exact");
  assert.equal(readFileSync(target, "utf8"), "exact");
  if (process.platform !== "win32") assert.equal(statSync(target).mode & 0o777, 0o600);
  assert.throws(() => ensureLaunchAgent(target, "different"), /does not match/);

  const directoryTarget = join(root, "directory.plist");
  mkdirSync(directoryTarget);
  assert.throws(() => ensureLaunchAgent(directoryTarget, "exact"), /regular file/);

  if (process.platform !== "win32") {
    const symlinkTarget = join(root, "symlink.plist");
    symlinkSync(target, symlinkTarget);
    assert.throws(() => ensureLaunchAgent(symlinkTarget, "exact"), /must not be a symlink/);
  }
});
