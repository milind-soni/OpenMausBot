import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompanyBackupSchedule } from "./company-backup-schedule.mjs";

const DAY = 24 * 60 * 60_000, HOUR = DAY / 24;
const ENABLE = { enabled: true, confirmation: "BACK UP THIS WORKSPACE DAILY" };
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
function fixture(saved = null) {
  const f = { now: 1_800_000_000_000, scope: { key: "fixture-portal:org:email:device:workspace", generation: 1 },
    saved, calls: [], states: [], writes: [], timers: new Map(), failWrite: false, blockWrite: null,
    run: async () => {}, read: async () => f.saved };
  let nextTimer = 0, tail = Promise.resolve();
  f.scheduler = createCompanyBackupSchedule({
    store: { read: () => f.read(), write: value => {
      const copy = structuredClone(value), block = f.blockWrite; f.blockWrite = null;
      const operation = tail.catch(() => {}).then(async () => {
        if (block) await block.promise;
        if (f.failWrite) throw new Error("fixture secret should never escape");
        f.saved = copy; f.writes.push(copy);
      });
      tail = operation; return operation;
    } },
    scope: () => f.scope, now: () => f.now,
    run: (...args) => { f.calls.push(args); return f.run(...args); },
    onState: state => f.states.push(state),
    setTimer: (callback, delay) => { const id = ++nextTimer; f.timers.set(id, { callback, delay }); return id; },
    clearTimer: id => f.timers.delete(id),
  });
  f.fire = async (advance = 0) => {
    f.now += advance;
    assert.equal(f.timers.size, 1, "one scheduled wakeup only");
    const [id, timer] = [...f.timers][0]; f.timers.delete(id);
    await timer.callback();
  };
  return f;
}

test("fresh/personal startup is off, reads only, and never creates a timer or backup", async () => {
  const f = fixture(); f.scope = null;
  assert.deepEqual(await f.scheduler.start(), { enabled: false, status: "off" });
  assert.equal(f.writes.length, 0); assert.equal(f.timers.size, 0); assert.equal(f.calls.length, 0);
});

test("exact consent is required and first backup waits a full day", async () => {
  const f = fixture(); await f.scheduler.start();
  for (const input of [{ enabled: true }, { ...ENABLE, confirmation: "yes" }, { ...ENABLE, password: "short" }, { ...ENABLE, interval: 1 }]) {
    await assert.rejects(f.scheduler.configure(input));
  }
  const state = await f.scheduler.configure(ENABLE);
  assert.equal(state.nextBackupAt, f.now + DAY); assert.equal(f.calls.length, 0);
  assert.equal(Object.hasOwn(f.saved, "password"), false);
  await f.fire(DAY - 1); assert.equal(f.calls.length, 0);
  await f.fire(1); assert.equal(f.calls.length, 1);
  assert.equal(f.scheduler.state().lastBackupAt, f.now);
  assert.equal(f.saved.nextBackupAt, f.now + DAY);
});

test("restart catches up one missed daily snapshot, not every missed day", async () => {
  const original = fixture(); await original.scheduler.configure(ENABLE);
  const f = fixture(original.saved); f.now += 10 * DAY;
  await f.scheduler.start();
  assert.equal(f.calls.length, 1); assert.equal(f.saved.nextBackupAt, f.now + DAY);
  await f.fire(); assert.equal(f.calls.length, 1);
});

test("a failed transfer persists an hourly retry before dispatch; refresh cannot accelerate it", async () => {
  const f = fixture(); await f.scheduler.configure(ENABLE);
  f.run = async () => { assert.equal(f.saved.nextBackupAt, f.now + HOUR); throw new Error("fixture private failure"); };
  await f.fire(DAY);
  assert.equal(f.scheduler.state().status, "error");
  assert(!JSON.stringify(f.states).includes("fixture private failure"));
  for (let i = 0; i < 5; i++) { f.scheduler.reconcile(); await f.fire(); }
  assert.equal(f.calls.length, 1);
  const restarted = fixture(f.saved); restarted.now = f.now;
  await restarted.scheduler.start(); assert.equal(restarted.calls.length, 0);
});

test("busy workspace defers rather than marking success", async () => {
  const f = fixture(); await f.scheduler.configure(ENABLE);
  f.run = async () => { throw Object.assign(new Error("busy"), { code: "workspace_busy" }); };
  await f.fire(DAY);
  assert.equal(f.scheduler.state().status, "paused"); assert.equal(f.saved.lastBackupAt, undefined);
  assert.equal(f.saved.nextBackupAt, f.now + HOUR);
});

test("missing connection pauses and account/workspace changes forget the encrypted secret", async () => {
  const f = fixture(); await f.scheduler.configure(ENABLE);
  const scope = f.scope; f.scope = null;
  await f.fire(DAY); assert.equal(f.calls.length, 0); assert.equal(f.scheduler.state().status, "paused");
  f.scope = { ...scope, key: "another-account-or-workspace" };
  f.scheduler.reconcile(); await turn();
  assert.equal(f.saved, null); assert.equal(f.scheduler.state().enabled, false); assert.equal(f.timers.size, 0);
});

test("disable cancels its in-flight transfer and late completion cannot restore secret or success", async () => {
  const f = fixture(), completion = deferred(), started = deferred();
  f.run = (signal) => { started.resolve(signal); return completion.promise; };
  await f.scheduler.configure(ENABLE); const operation = f.fire(DAY); const signal = await started.promise;
  await f.scheduler.configure({ enabled: false }); assert.equal(signal.aborted, true);
  completion.resolve(); await operation;
  assert.equal(f.saved, null); assert.deepEqual(f.scheduler.state(), { enabled: false, status: "off" }); assert.equal(f.timers.size, 0);
});

test("disable while enabling is pending wins the serialized durable write", async () => {
  const f = fixture(), blocked = deferred(); f.blockWrite = blocked;
  const enabling = f.scheduler.configure(ENABLE);
  const disabling = f.scheduler.configure({ enabled: false });
  blocked.resolve(); await Promise.all([enabling, disabling]);
  assert.equal(f.saved, null); assert.equal(f.scheduler.state().enabled, false); assert.equal(f.timers.size, 0);
});

test("disable while the pre-transfer reservation is pending prevents all transfer work", async () => {
  const f = fixture(), blocked = deferred(); await f.scheduler.configure(ENABLE); f.blockWrite = blocked;
  const firing = f.fire(DAY); const disabling = f.scheduler.configure({ enabled: false });
  blocked.resolve(); await Promise.all([firing, disabling]);
  assert.equal(f.saved, null); assert.equal(f.calls.length, 0);
});

test("connection generation changes during password-store await prevent old transfer", async () => {
  const f = fixture(), blocked = deferred(); await f.scheduler.configure(ENABLE); f.blockWrite = blocked;
  const firing = f.fire(DAY); f.scope.generation++; blocked.resolve(); await firing;
  assert.equal(f.calls.length, 0);
});

test("late startup read cannot resurrect a disabled record", async () => {
  const f = fixture(), loading = deferred(); await f.scheduler.configure(ENABLE); const saved = f.saved;
  const next = fixture(saved); next.read = () => loading.promise;
  const starting = next.scheduler.start(); await next.scheduler.configure({ enabled: false });
  loading.resolve(saved); await starting;
  assert.equal(next.saved, null); assert.equal(next.scheduler.state().enabled, false); assert.equal(next.timers.size, 0);
});

test("locked or malformed storage is fail-closed and secret-free", async () => {
  for (const saved of [{ version: 1 }, { version: 1, scope: "scope", password: "synthetic old password", nextBackupAt: -1 }]) {
    const f = fixture(saved); await f.scheduler.start(); assert.equal(f.scheduler.state().status, "error"); assert.equal(f.calls.length, 0);
  }
  const f = fixture(); f.failWrite = true;
  await assert.rejects(f.scheduler.configure(ENABLE));
  assert.equal(f.scheduler.state().enabled, false); assert.equal(f.timers.size, 0);
});

test("existing daily consent migrates without retaining the old archive password", async () => {
  const f = fixture(); await f.scheduler.configure(ENABLE);
  const next = fixture({ ...f.saved, version: 1, password: "old synthetic secret" });
  await next.scheduler.start();
  assert.equal(next.scheduler.state().enabled, true);
  assert.equal(next.saved.version, 2);
  assert.equal(Object.hasOwn(next.saved, "password"), false);
  assert.equal(next.calls.length, 0);
});

test("failed disable reports failure instead of claiming the persisted secret was forgotten", async () => {
  const f = fixture(); await f.scheduler.configure(ENABLE); f.failWrite = true;
  await assert.rejects(f.scheduler.configure({ enabled: false }));
  assert.equal(f.scheduler.state().status, "error"); assert.match(f.scheduler.state().message, /could not be cleared/);
  assert.equal(f.timers.size, 0);
});

test("shutdown cancels transfer/timers and prevents late writes", async () => {
  const f = fixture(), completion = deferred(), started = deferred();
  f.run = (signal) => { started.resolve(signal); return completion.promise; };
  await f.scheduler.configure(ENABLE); const firing = f.fire(DAY); const signal = await started.promise;
  const writes = f.writes.length; f.scheduler.close(); completion.resolve(); await firing;
  assert.equal(signal.aborted, true); assert.equal(f.writes.length, writes); assert.equal(f.timers.size, 0);
  await assert.rejects(f.scheduler.configure(ENABLE));
});

test("clock rollback never causes an early snapshot or an unbounded timer", async () => {
  const original = fixture(); await original.scheduler.configure(ENABLE);
  const f = fixture(original.saved); f.now -= DAY * 10; await f.scheduler.start();
  assert.equal(f.calls.length, 0);
  assert([...f.timers.values()].every(timer => timer.delay <= DAY && timer.delay >= 1000));
});

// Mirrors electron/main.mjs companyBackupScope: any deviceId, same person, organisation and folder.
const scopeFor = (org = "org", generation = 1) => ({ key: JSON.stringify(["portal", org, "email", "workspace"]), generation,
  adopts: saved => { try { const v = JSON.parse(saved); return Array.isArray(v) && v.length === 5 && v[0] === "portal" && v[1] === org && v[2] === "email" && v[4] === "workspace"; } catch { return false; } } });
const legacyKey = device => JSON.stringify(["portal", "org", "email", device, "workspace"]);

test("a schedule saved under an old device-scoped key survives the upgrade, even for an enrollment that has since expired", async () => {
  // Saved by v0.1.85 for device D1; D1 then expired and this computer re-enrolled as D2.
  const f = fixture({ version: 2, scope: legacyKey("device-1"), nextBackupAt: 1_800_000_000_000 + HOUR });
  f.scope = scopeFor();
  const state = await f.scheduler.start();
  assert.equal(state.enabled, true); assert.equal(state.status, "waiting");
  assert.equal(f.saved.scope, scopeFor().key, "the saved key is rewritten, not forgotten");
  // Losing the connection only pauses it.
  f.scope = null; f.scheduler.reconcile();
  assert.equal(f.scheduler.state().enabled, true);
  // A different organisation or account still clears it.
  f.scope = scopeFor("other-org", 3);
  f.scheduler.reconcile(); await turn(); await turn();
  assert.equal(f.saved, null); assert.equal(f.scheduler.state().enabled, false);
});

test("reconcile adopts an old key of the same person through the write queue", async () => {
  const f = fixture(); f.scope = { key: legacyKey("device-1"), generation: 1 };
  await f.scheduler.start(); await f.scheduler.configure(ENABLE);
  assert.equal(f.saved.scope, legacyKey("device-1"));
  f.scope = scopeFor("org", 2);
  f.scheduler.reconcile(); await turn(); await turn();
  assert.equal(f.saved.scope, scopeFor().key); assert.equal(f.scheduler.state().enabled, true);
});

test("an overdue backup waits after the company connection returns instead of uploading at once", async () => {
  const f = fixture({ version: 2, scope: scopeFor().key, nextBackupAt: 1_800_000_000_000 - DAY });
  f.scope = null;
  await f.scheduler.start();
  assert.equal(f.scheduler.state().status, "paused");
  f.scope = scopeFor(); f.scheduler.reconcile();
  const [, timer] = [...f.timers][0];
  assert.ok(timer.delay >= 15 * 60_000, `delay ${timer.delay}`);
  assert.equal(f.calls.length, 0);
});
