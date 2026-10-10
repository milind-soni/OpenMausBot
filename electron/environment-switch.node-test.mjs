import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DataDirLeaseError } from "./data-dir-lease.mjs";
import { switchLocalEnvironment, validateTargetDir } from "./environment-switch.mjs";

function realDir() {
  const dir = mkdtempSync(join(tmpdir(), "omb-switch-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function makeDeps(overrides = {}) {
  const calls = [];
  const args = {};
  let starts = 0;
  const record = (name) => (...rest) => {
    calls.push(name);
    (args[name] ??= []).push(rest);
  };
  const deps = {
    stopChild: record("stop"),
    releaseLease: record("release"),
    acquireLease: (dir) => {
      record("acquire")(dir);
      return { dir };
    },
    createDir: record("create"),
    startChild: (port) => {
      calls.push("start");
      (args.start ??= []).push([port]);
      starts += 1;
      return { pid: 4000 + starts, port };
    },
    probeReady: (port, pid) => {
      calls.push("probe");
      (args.probe ??= []).push([port, pid]);
      return "ready";
    },
    rollback: record("rollback"),
    persistActive: record("persist"),
    log: () => {},
  };
  return { calls, args, deps: Object.assign(deps, overrides) };
}

test("happy path: calls run in switch order and persistActive is last", async (t) => {
  const { dir, cleanup } = realDir();
  t.after(cleanup);
  const { calls, args, deps } = makeDeps();
  const result = await switchLocalEnvironment({ targetDir: dir, targetId: "env-2", port: 9000, deps });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, ["stop", "release", "acquire", "start", "probe", "persist"]);
  assert.deepEqual(args.acquire, [[dir]]);
  assert.deepEqual(args.start, [[9000]]);
  assert.deepEqual(args.probe, [[9000, 4001]]);
  assert.deepEqual(args.persist, [["env-2"]]);
  assert.equal(args.rollback, undefined);
});

test("missing parent dir: aborts with unavailable, rolls back, never persists", async (t) => {
  const { dir, cleanup } = realDir();
  t.after(cleanup);
  const { calls, args, deps } = makeDeps();
  const result = await switchLocalEnvironment({ targetDir: join(dir, "gone", ".openmausbot-x"), deps });
  assert.deepEqual(result, { ok: false, error: "unavailable", rolledBack: true });
  assert.deepEqual(calls, ["stop", "release", "rollback"]);
  assert.deepEqual(args.rollback, [[8799]]);
  assert.equal(args.persist, undefined);
  assert.equal(args.start, undefined);
});

test("lease held elsewhere: DataDirLeaseError becomes locked, old lease reacquired, no persist", async (t) => {
  const { dir, cleanup } = realDir();
  t.after(cleanup);
  const { calls, deps } = makeDeps({
    acquireLease: (targetDir) => {
      calls.push("acquire");
      throw new DataDirLeaseError(`OpenMausBot is already using this data directory (process 123). ${targetDir}`);
    },
  });
  const result = await switchLocalEnvironment({ targetDir: dir, targetId: "env-2", deps });
  assert.deepEqual(result, { ok: false, error: "locked", rolledBack: true });
  assert.deepEqual(calls, ["stop", "release", "acquire", "rollback"]);
  assert.ok(!calls.includes("persist"));
  assert.ok(!calls.includes("start"));
});

test("needsCreate target: createDir runs after release and before acquire", async (t) => {
  const { dir, cleanup } = realDir();
  t.after(cleanup);
  const { calls, args, deps } = makeDeps();
  const targetDir = join(dir, ".openmausbot-new");
  const result = await switchLocalEnvironment({ targetDir, targetId: "env-3", deps });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, ["stop", "release", "create", "acquire", "start", "probe", "persist"]);
  assert.deepEqual(args.create, [[targetDir]]);
});

test("probe reports exited: rollback restarts old child exactly once, no double start", async (t) => {
  const { dir, cleanup } = realDir();
  t.after(cleanup);
  let startCount = 0;
  let stopCount = 0;
  const calls = [];
  const deps = {
    stopChild: () => {
      calls.push("stop");
      stopCount += 1;
    },
    releaseLease: () => calls.push("release"),
    acquireLease: () => {
      calls.push("acquire");
      return {};
    },
    createDir: () => calls.push("create"),
    startChild: (port) => {
      calls.push("start");
      startCount += 1;
      return { pid: 5000 + startCount, port };
    },
    probeReady: () => {
      calls.push("probe");
      return "exited";
    },
    // The real rollback kills the failed child, reacquires the old lease and
    // restarts the old environment through the same start path.
    rollback: (port) => {
      calls.push("rollback");
      deps.startChild(port);
    },
    persistActive: () => calls.push("persist"),
    log: () => {},
  };
  const result = await switchLocalEnvironment({ targetDir: dir, targetId: "env-4", deps });
  assert.equal(result.ok, false);
  assert.equal(result.rolledBack, true);
  assert.ok(!calls.includes("persist"));
  assert.equal(startCount, 2);
  assert.equal(stopCount, 1);
  assert.deepEqual(calls, ["stop", "release", "acquire", "start", "probe", "rollback", "start"]);
});

test("validateTargetDir: missing parent is unavailable", () => {
  const fsImpl = { existsSync: (p) => !p.includes("gone") };
  assert.deepEqual(validateTargetDir("/volumes/gone/.openmausbot-x", fsImpl), { ok: false, error: "unavailable" });
});

test("validateTargetDir: absent directory with live parent needs create", () => {
  const fsImpl = { existsSync: (p) => p === "/volumes/live" };
  assert.deepEqual(validateTargetDir("/volumes/live/.openmausbot-x", fsImpl), { ok: true, needsCreate: true });
});

test("validateTargetDir: existing directory needs no create", () => {
  const fsImpl = { existsSync: () => true };
  assert.deepEqual(validateTargetDir("/volumes/live/.openmausbot-x", fsImpl), { ok: true, needsCreate: false });
});

test("validateTargetDir: default fs sees real temp directories", (t) => {
  const { dir, cleanup } = realDir();
  t.after(cleanup);
  assert.deepEqual(validateTargetDir(dir), { ok: true, needsCreate: false });
  assert.deepEqual(validateTargetDir(join(dir, "child")), { ok: true, needsCreate: true });
  assert.deepEqual(validateTargetDir(join(dir, "gone", "child")), { ok: false, error: "unavailable" });
});

test("persistActive failure rolls back and reports persist-failed, never success", async (t) => {
  const { dir, cleanup } = realDir();
  t.after(cleanup);
  const calls = [];
  const deps = {
    stopChild: () => { calls.push("stop"); },
    releaseLease: () => { calls.push("release"); },
    acquireLease: () => { calls.push("acquire"); return {}; },
    createDir: () => { calls.push("create"); },
    startChild: () => { calls.push("start"); return { pid: 6001, port: 8799 }; },
    probeReady: () => { calls.push("probe"); return "ready"; },
    rollback: () => { calls.push("rollback"); },
    persistActive: () => { calls.push("persist"); throw new Error("disk full"); },
    log: () => {},
  };
  const result = await switchLocalEnvironment({ targetDir: dir, targetId: "env-5", deps });
  assert.deepEqual(result, { ok: false, error: "persist-failed", rolledBack: true });
  assert.deepEqual(calls, ["stop", "release", "acquire", "start", "probe", "persist", "rollback"]);
});

test("a rollback that fails reports rolledBack:false", async (t) => {
  const { dir, cleanup } = realDir();
  t.after(cleanup);
  const calls = [];
  const deps = {
    stopChild: () => { calls.push("stop"); },
    releaseLease: () => { calls.push("release"); },
    acquireLease: () => { calls.push("acquire"); throw new Error("held"); },
    createDir: () => { calls.push("create"); },
    startChild: () => { calls.push("start"); return { pid: 6002, port: 8799 }; },
    probeReady: () => { calls.push("probe"); return "ready"; },
    rollback: () => { calls.push("rollback"); throw new Error("rollback boom"); },
    persistActive: () => { calls.push("persist"); },
    log: () => {},
  };
  const result = await switchLocalEnvironment({ targetDir: dir, targetId: "env-6", deps });
  assert.deepEqual(result, { ok: false, error: "locked", rolledBack: false });
  assert.ok(calls.includes("rollback"));
  assert.ok(!calls.includes("persist"));
});

test("stopChild throwing aborts the switch before release or acquire", async (t) => {
  const { dir, cleanup } = realDir();
  t.after(cleanup);
  const calls = [];
  const deps = {
    stopChild: () => { calls.push("stop"); throw new Error("the server child did not stop"); },
    releaseLease: () => calls.push("release"),
    acquireLease: () => calls.push("acquire"),
    createDir: () => calls.push("create"),
    startChild: () => calls.push("start"),
    probeReady: () => calls.push("probe"),
    rollback: () => calls.push("rollback"),
    persistActive: () => calls.push("persist"),
    log: () => {},
  };
  await assert.rejects(() => switchLocalEnvironment({ targetDir: dir, targetId: "env-7", deps }), /did not stop/);
  assert.deepEqual(calls, ["stop"]);
});
