import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DaemonFSM } from "../src/fsm.mjs";
import { acquireLock, releaseLock, isProcessAlive } from "../src/repo.mjs";
import { parseCliArgs } from "../src/config.mjs";

test("DaemonFSM transitions through states deterministically", () => {
  const fsm = new DaemonFSM();
  assert.equal(fsm.state, "BOOTSTRAPPING");

  fsm.transition("RECONCILING", "Lock acquired");
  assert.equal(fsm.state, "RECONCILING");

  fsm.transition("EVALUATING_POOL", "Evaluating account pool");
  assert.equal(fsm.state, "EVALUATING_POOL");

  fsm.transition("WATCHING", "Pool healthy and aligned");
  assert.equal(fsm.state, "WATCHING");

  fsm.transition("DEBOUNCING", "File change detected");
  assert.equal(fsm.state, "DEBOUNCING");

  fsm.transition("EVALUATING_POOL", "Debounce quiet timer elapsed");
  assert.equal(fsm.state, "EVALUATING_POOL");

  fsm.transition("WAITING_QUIESCENT", "Pending sync for active bots");
  assert.equal(fsm.state, "WAITING_QUIESCENT");

  fsm.transition("SYNCING_ATOMIC", "Bots idle");
  assert.equal(fsm.state, "SYNCING_ATOMIC");

  fsm.transition("VERIFYING", "Files written");
  assert.equal(fsm.state, "VERIFYING");

  fsm.transition("WATCHING", "Verified token on disk");
  assert.equal(fsm.state, "WATCHING");

  fsm.transition("SHUTTING_DOWN", "Signal received");
  assert.equal(fsm.state, "SHUTTING_DOWN");
});

test("DaemonFSM rejects invalid transitions", () => {
  const fsm = new DaemonFSM();
  assert.throws(() => {
    fsm.transition("SYNCING_ATOMIC", "Illegal jump");
  }, /Invalid state transition/);
});

test("acquireLock and releaseLock maintain singleton invariant", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-test-lock-"));
  const lockPath = path.join(tmpDir, "daemon.lock");

  // Acquire lock
  const lock1 = acquireLock(lockPath);
  assert.equal(lock1.acquired, true);
  assert.equal(fs.existsSync(lockPath), true);

  // Try acquire again -> should fail because lock is held by current process
  const lock2 = acquireLock(lockPath);
  assert.equal(lock2.acquired, false);
  assert.equal(lock2.isCurrentProcess, true);

  // Release lock
  const released = releaseLock(lockPath);
  assert.equal(released, true);
  assert.equal(fs.existsSync(lockPath), false);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("parseCliArgs parses all required daemon flags", () => {
  const args1 = ["--status", "--json"];
  const parsed1 = parseCliArgs(args1);
  assert.equal(parsed1.mode, "status");
  assert.equal(parsed1.json, true);

  const args2 = ["--sync-now", "--force"];
  const parsed2 = parseCliArgs(args2);
  assert.equal(parsed2.mode, "sync-now");
  assert.equal(parsed2.force, true);

  const args3 = ["--dry-run"];
  const parsed3 = parseCliArgs(args3);
  assert.equal(parsed3.mode, "dry-run");

  const args4 = ["--install-autostart"];
  const parsed4 = parseCliArgs(args4);
  assert.equal(parsed4.mode, "install-autostart");

  const args5 = ["--uninstall-autostart"];
  const parsed5 = parseCliArgs(args5);
  assert.equal(parsed5.mode, "uninstall-autostart");
});

test("DaemonFSM supports batch transitions across multiple decisions", () => {
  const fsm = new DaemonFSM();
  fsm.transition("RECONCILING", "start");
  fsm.transition("EVALUATING_POOL", "evaluating");

  // Decision 1
  fsm.transition("WAITING_QUIESCENT", "dec 1 wait");
  fsm.transition("SYNCING_ATOMIC", "dec 1 sync");
  fsm.transition("VERIFYING", "dec 1 verify");

  // Decision 2 (consecutive batch item)
  fsm.transition("WAITING_QUIESCENT", "dec 2 wait");
  fsm.transition("SYNCING_ATOMIC", "dec 2 sync");
  fsm.transition("VERIFYING", "dec 2 verify");

  // Finish batch
  fsm.transition("WATCHING", "all done");
  assert.equal(fsm.state, "WATCHING");
});
test("DaemonFSM supports DEBOUNCING to RECONCILING and COOLDOWN_BACKOFF transitions", () => {
  const fsm1 = new DaemonFSM("WATCHING");
  fsm1.transition("DEBOUNCING", "file changed");
  assert.equal(fsm1.state, "DEBOUNCING");
  fsm1.transition("RECONCILING", "debounce timer fired");
  assert.equal(fsm1.state, "RECONCILING");

  const fsm2 = new DaemonFSM("WATCHING");
  fsm2.transition("DEBOUNCING", "file changed");
  fsm2.transition("COOLDOWN_BACKOFF", "debounce sync failure");
  assert.equal(fsm2.state, "COOLDOWN_BACKOFF");
});