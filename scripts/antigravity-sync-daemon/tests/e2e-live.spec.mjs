import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { acquireLock, releaseLock, isProcessAlive } from "../src/repo.mjs";
import { verifyGatewayConfig } from "../src/gateway.mjs";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");
const OMB_DIR = path.join(os.homedir(), ".openmausbot");
const CONFIG_PATH = path.join(OMB_DIR, "config.json");
const BOTS_PATH = path.join(OMB_DIR, "bots.json");
const LOCK_PATH = path.join(OMB_DIR, "antigravity-sync-daemon.lock");
const CLI_PATH = path.join(PROJECT_ROOT, "antigravity-sync-daemon.mjs");

test("E2E-1: Live Antigravity local gateway responds on 127.0.0.1:8045 with valid models catalog", async () => {
  const start = Date.now();
  const res = await fetch("http://127.0.0.1:8045/v1/models", { signal: AbortSignal.timeout(3000) });
  const latency = Date.now() - start;

  assert.equal(res.status, 200, `Gateway HTTP status should be 200, got ${res.status}`);
  const json = await res.json();
  assert.ok(Array.isArray(json.data), "Expected json.data to be an array of models");
  assert.ok(json.data.length >= 10, `Expected at least 10 models, got ${json.data.length}`);

  const modelIds = json.data.map(m => m.id);
  assert.ok(modelIds.includes("claude-sonnet-4-6"), "Missing core model claude-sonnet-4-6");
  assert.ok(modelIds.includes("gemini-3.8-flash"), "Missing core model gemini-3.8-flash");
  assert.ok(latency < 1000, `Gateway response took ${latency}ms, exceeding 1000ms SLA`);
});

test("E2E-2: OpenMausBot config and bots integrity respects backup-only gateway contract", () => {
  assert.ok(fs.existsSync(CONFIG_PATH), "config.json must exist in OMB_DIR");
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  const bots = fs.existsSync(BOTS_PATH) ? JSON.parse(fs.readFileSync(BOTS_PATH, "utf8")) : [];

  const verification = verifyGatewayConfig(config, bots);
  assert.equal(verification.valid, true, `Config verification failed: ${verification.violations.join(", ")}`);
  assert.equal(verification.violations.length, 0, `Config contract violations detected: ${verification.violations.join(", ")}`);

  // Ensure gateway is registered
  assert.ok(config.instances && config.instances["antigravity-local-gateway"], "antigravity-local-gateway must be registered");
  // Ensure native ACP is present
  assert.ok(config.instances && config.instances["antigravity"], "native ACP instance must remain present");
});

test("E2E-3: CLI command --status --json outputs valid schema and confirms running daemon", () => {
  const raw = execFileSync(process.execPath, [CLI_PATH, "--status", "--json"], { cwd: PROJECT_ROOT, encoding: "utf8" });
  const status = JSON.parse(raw);

  assert.equal(typeof status.daemon, "object", "Missing status.daemon");
  assert.equal(status.daemon.running, true, "Expected status.daemon.running to be true");
  assert.ok(status.daemon.pid > 0, "Expected valid daemon PID");
  assert.equal(status.gateway.registered, true, "Expected status.gateway.registered to be true");
  assert.equal(status.gateway.healthy, true, "Expected status.gateway.healthy to be true");
  assert.ok(status.pool.totalAccounts >= 1, "Expected total accounts >= 1");
  assert.ok(status.pool.eligibleAccounts >= 1, "Expected eligible accounts >= 1");
});

test("E2E-4: CLI command --dry-run --json executes sync planner non-destructively", () => {
  const raw = execFileSync(process.execPath, [CLI_PATH, "--dry-run", "--json"], { cwd: PROJECT_ROOT, encoding: "utf8" });
  const result = JSON.parse(raw);

  assert.equal(result.dryRun, true, "Expected dryRun flag to be true");
  assert.ok(result.accountsFound >= 1, "Expected accountsFound >= 1");
  assert.ok(typeof result.decisionsCount === "number", "decisionsCount should be a number");
  assert.ok(Array.isArray(result.decisions), "decisions should be an array");
});

test("E2E-5: Live daemon lock conflict isolation and stale PID reclamation", () => {
  // 1. Verify conflict on active daemon lock
  if (fs.existsSync(LOCK_PATH)) {
    const lockAttempt = acquireLock(LOCK_PATH);
    assert.equal(lockAttempt.acquired, false, "Should not acquire lock when live daemon holds it");
    assert.ok(lockAttempt.pid > 0, "Holder PID should be identified");
  }

  // 2. Verify stale/dead PID reclamation in sandboxed directory
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-chaos-lock-"));
  const deadLockPath = path.join(tmpDir, "test.lock");
  // Write a non-existent PID (e.g. 9999999)
  fs.writeFileSync(deadLockPath, JSON.stringify({ pid: 9999999, timestamp: "2026-01-01T00:00:00.000Z" }));

  const reclaimAttempt = acquireLock(deadLockPath);
  assert.equal(reclaimAttempt.acquired, true, "Should successfully reclaim lock from dead PID");
  releaseLock(deadLockPath);

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
