import assert from "node:assert/strict";
import { test } from "node:test";
import { createUpdateEverything, readUpdateResponse } from "./update-everything.mjs";

function fixture() {
  let time = 0;
  const targets = [{ id: "local", name: "Local", origin: "http://127.0.0.1:1234", local: true }, { id: "remote", name: "Remote", origin: "https://fixture.invalid", local: false }];
  const calls = [];
  const snapshots = Object.fromEntries(targets.map(t => [t.id, { environmentId: t.id, version: "1.0", idle: true,
    providers: [{ instanceId: "codex", name: "Codex", key: "npm:@openai/codex" }], app: { status: "downloaded", version: "2.0", installMode: "restart" } }]));
  let fail;
  let applyRestart = true;
  const coordinator = createUpdateEverything({ targets: () => targets, now: () => time, sleep: async ms => { time += ms; },
    request: async (target, suffix, body) => {
      calls.push([target.id, suffix, body]);
      if (fail?.(target, suffix)) throw new Error("fixture failure");
      if (suffix === "/install" && applyRestart) snapshots[target.id].version = body.version;
      return structuredClone(snapshots[target.id]);
    } });
  return { coordinator, calls, snapshots, targets, fail: fn => { fail = fn; }, noRestart: () => { applyRestart = false; }, tick: ms => { time += ms; } };
}

test("all providers finish before remote restart, reconnection, then local restart", async () => {
  const f = fixture();
  const plan = await f.coordinator.check();
  assert.equal(plan.rows.length, 2);
  const result = await f.coordinator.run(plan.planId);
  assert.deepEqual(f.calls.filter(c => ["/providers", "/install"].includes(c[1])).map(c => c.slice(0, 2)),
    [["local", "/providers"], ["remote", "/providers"], ["remote", "/install"], ["local", "/install"]]);
  assert.equal(result.expectedLocalVersion, "2.0");
  assert.equal(result.phase, "complete");
  await assert.rejects(f.coordinator.run(plan.planId), /Check for updates/);
});

test("provider failure prevents every restart and remains visible", async () => {
  const f = fixture(); const plan = await f.coordinator.check();
  f.fail((t, suffix) => t.id === "remote" && suffix === "/providers");
  assert.equal((await f.coordinator.run(plan.planId)).phase, "failed");
  assert.equal(f.calls.some(c => c[1] === "/install"), false);
});

test("busy and offline environments are explicitly skipped", async () => {
  const f = fixture(); f.snapshots.local.idle = false;
  f.fail(t => t.id === "remote");
  const plan = await f.coordinator.check();
  assert.deepEqual(plan.rows.map(r => r.status), ["skipped", "skipped"]);
  await f.coordinator.run(plan.planId);
  assert.equal(f.calls.some(c => c[1] === "/providers" || c[1] === "/install"), false);
});

test("operator servers update providers but are never restarted", async () => {
  const f = fixture(); f.snapshots.remote.app = { status: "operator" };
  const plan = await f.coordinator.check();
  assert.match(plan.rows[1].note, /operator-managed/);
  await f.coordinator.run(plan.planId);
  assert.equal(f.calls.some(c => c[0] === "remote" && c[1] === "/install"), false);
});

test("changed saved origin or environment identity cannot receive reviewed writes", async () => {
  for (const change of [f => { f.targets[0].origin = "https://other.invalid"; }, f => { f.snapshots.local.environmentId = "replacement"; }]) {
    const f = fixture(); const plan = await f.coordinator.check(); change(f);
    assert.equal((await f.coordinator.run(plan.planId)).phase, "failed");
    assert.equal(f.calls.some(c => c[1] === "/providers"), false);
  }
});

test("expired confirmation and duplicate clicks cannot start installers", async () => {
  const f = fixture(); const plan = await f.coordinator.check(); f.tick(300001);
  await assert.rejects(f.coordinator.run(plan.planId), /Check for updates/);
  const g = fixture(); const second = await g.coordinator.check();
  const pending = g.coordinator.run(second.planId);
  await assert.rejects(g.coordinator.run(second.planId), /already running/);
  await pending;
});

test("new launch verifies the target version without replaying commands", () => {
  const previous = { phase: "running", expectedLocalVersion: "2.0", rows: [] };
  const make = appVersion => createUpdateEverything({ targets: () => [], request: () => assert.fail(), previous, appVersion });
  assert.equal(make("2.0").state().phase, "complete");
  assert.equal(make("1.0").state().phase, "failed");
});

test("a changed app version prevents restart", async () => {
  const f = fixture(); const plan = await f.coordinator.check();
  f.snapshots.remote.app.version = "3.0";
  const result = await f.coordinator.run(plan.planId);
  assert.equal(result.phase, "failed");
  assert.equal(f.calls.some(c => c[1] === "/install"), false);
});

test("an accepted but failed restart times out without repeating the write or restarting local", async () => {
  const f = fixture(); const plan = await f.coordinator.check(); f.noRestart();
  assert.equal((await f.coordinator.run(plan.planId)).phase, "failed");
  assert.deepEqual(f.calls.filter(c => c[1] === "/install").map(c => c[0]), ["remote"]);
});

test("a provider changed after review cannot receive an install", async () => {
  const f = fixture(); const plan = await f.coordinator.check(); f.snapshots.local.providers[0].key = "npm:replacement";
  assert.equal((await f.coordinator.run(plan.planId)).phase, "failed");
  assert.equal(f.calls.some(c => c[1] === "/providers"), false);
});

test("progress revisions increase and callers cannot mutate native plans", async () => {
  const f = fixture(); const plan = await f.coordinator.check();
  const revision = plan.revision; plan.rows[0].providers.length = 0;
  assert.equal(f.coordinator.state().rows[0].providers.length, 1);
  assert.ok((await f.coordinator.run(plan.planId)).revision > revision);
});

test("remote JSON is bounded before parsing", async () => {
  assert.deepEqual(await readUpdateResponse(new Response('{"ok":true}')), { ok: true });
  await assert.rejects(readUpdateResponse(new Response(' '.repeat(65537))), /too large/);
  await assert.rejects(readUpdateResponse(new Response("bad")), /JSON/);
});

test("receipt failure refuses updates without leaving the coordinator locked", async () => {
  let fail = true;
  const coordinator = createUpdateEverything({ targets: () => [], request: () => assert.fail(), save: () => { if (fail) throw new Error("disk full"); } });
  await assert.rejects(coordinator.check(), /disk space/);
  assert.equal(coordinator.state().phase, "failed");
  fail = false;
  assert.equal((await coordinator.check()).phase, "ready");
});
