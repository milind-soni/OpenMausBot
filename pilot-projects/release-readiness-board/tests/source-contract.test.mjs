import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const load = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("keeps the pilot deterministic, local, and free of credentials", async () => {
  const [board, hosting, manifestText] = await Promise.all([
    load("../app/release-board.tsx"),
    load("../.openai/hosting.json"),
    load("../PILOT_MANIFEST.json"),
  ]);
  const config = JSON.parse(hosting);
  const manifest = JSON.parse(manifestText);

  assert.equal(config.d1, null);
  assert.equal(config.r2, null);
  assert.deepEqual(manifest.writeScopes, ["app/**", "tests/**"]);
  assert.deepEqual(manifest.targetCommands.pilot.argv, [
    "node",
    "--test",
    "tests/source-contract.test.mjs",
  ]);
  assert.ok(manifest.denyScopes.includes("package.json"));
  assert.ok(manifest.denyScopes.includes(".openai/**"));
  assert.equal((board.match(/\bid: "/g) ?? []).length, 6);
  assert.doesNotMatch(board, /fetch\(|WebSocket|EventSource|process\.env|client[_-]?secret|access[_-]?token/i);
  assert.match(board, /const initialChecks:/);
});

test("keeps the primary interaction and accessibility contract", async () => {
  const [board, css] = await Promise.all([
    load("../app/release-board.tsx"),
    load("../app/globals.css"),
  ]);

  assert.match(board, /function addCheck/);
  assert.match(board, /function toggleReady/);
  assert.match(board, /aria-live="polite"/);
  assert.match(board, /aria-pressed=/);
  assert.match(board, /按状态筛选/);
  assert.match(board, /搜索检查项/);
  assert.match(css, /@media \(max-width: 680px\)/);
  assert.match(css, /prefers-reduced-motion: reduce/);
});
