import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createServerSupervisor } from "./server-supervisor.mjs";

test("main retires an unavailable window only after recovery navigation succeeds", () => {
  const source = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  assert.match(source, /void win\.loadURL\(`http:\/\/127\.0\.0\.1:\$\{SERVER_PORT\}`\)\.then\(\(\) => \{\s*serverUnavailableWindows\.delete\(win\);/);
  assert.doesNotMatch(source, /serverUnavailableWindows\.delete\(win\);\s*void win\.loadURL/);
});

function fixture(t, options = {}) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const events = [];
  const children = [];
  let clock = 0;
  const spawn = () => {
    const proc = new EventEmitter();
    children.push(proc);
    supervisor.watch(proc);
    return proc;
  };
  const supervisor = createServerSupervisor({
    restart: async () => ({ proc: spawn() }),
    stop: async (proc) => { events.push(["stop", proc]); proc?.emit("exit", 0); return true; },
    onReady: (proc) => events.push(["ready", proc]),
    onUnavailable: () => events.push(["unavailable"]),
    onExhausted: () => events.push(["exhausted"]),
    retryDelaysMs: [10, 20, 40],
    stableUptimeMs: 100,
    now: () => clock,
    ...options,
  });
  const tick = async (ms) => {
    clock += ms;
    t.mock.timers.tick(ms);
    await Promise.resolve();
  };
  return { supervisor, spawn, children, events, tick };
}

test("crash clears readiness immediately, backs off, and exhausts a bounded budget", async (t) => {
  const f = fixture(t);
  const first = f.spawn();
  f.supervisor.ready(first);
  first.emit("exit", 1);
  assert.equal(f.events.at(-1)[0], "unavailable");
  assert.equal(f.supervisor.isCurrent(first), false);
  for (const delay of [10, 20, 40]) {
    const count = f.children.length;
    await f.tick(delay - 1);
    assert.equal(f.children.length, count);
    await f.tick(1);
    assert.equal(f.children.length, count + 1);
    const replacement = f.children.at(-1);
    assert.deepEqual(f.events.at(-1), ["ready", replacement]);
    first.emit("exit", 9);
    assert.equal(f.supervisor.isCurrent(replacement), true, "an old exit cannot invalidate a new child");
    replacement.emit("exit", 1);
  }
  assert.deepEqual(f.events.at(-1), ["exhausted"]);
  await f.tick(1000);
  assert.equal(f.children.length, 4);
});

test("only a stable ready uptime resets the recovery budget", async (t) => {
  const f = fixture(t);
  f.supervisor.ready(f.spawn());
  f.children.at(-1).emit("exit", 1);
  await f.tick(10);
  await f.tick(100);
  f.children.at(-1).emit("exit", 1);
  await f.tick(10);
  assert.equal(f.children.length, 3, "stable child reset backoff to its first delay");
  f.children.at(-1).emit("exit", 1);
  await f.tick(10);
  assert.equal(f.children.length, 3, "an unstable child must not reset backoff");
  await f.tick(10);
  assert.equal(f.children.length, 4);
  await f.supervisor.shutdown();
});

test("quit cancels a queued retry and cannot be undone by a stale ready result", async (t) => {
  const f = fixture(t);
  const first = f.spawn();
  f.supervisor.ready(first);
  first.emit("exit", 1);
  await f.supervisor.shutdown();
  await f.tick(1000);
  assert.equal(f.children.length, 1);
  assert.equal(f.supervisor.ready(first), false);
  assert.throws(() => f.supervisor.watch(new EventEmitter()), /Cannot replace/);
});

test("quit reaps a replacement whose health probe is pending", async (t) => {
  let finishBoot;
  let replacement;
  const f = fixture(t, {
    restart: () => {
      replacement = f.spawn();
      return new Promise((resolve) => { finishBoot = resolve; });
    },
  });
  f.supervisor.ready(f.spawn());
  f.children[0].emit("exit", 1);
  await f.tick(10);
  assert.equal(f.supervisor.isCurrent(replacement), true);
  await f.supervisor.shutdown();
  finishBoot({ proc: replacement });
  await f.tick(1000);
  assert.ok(f.events.some(([event, proc]) => event === "stop" && proc === replacement));
  assert.equal(f.events.filter(([event]) => event === "ready").length, 1);
  assert.equal(f.children.length, 2);
});

test("failed probes retry once per budget entry; an unreaped child never gets a sibling", async (t) => {
  const f = fixture(t, {
    restart: async () => {
      const proc = f.spawn();
      if (f.children.length < 3) { proc.emit("exit", 1); return { proc: null }; }
      return { proc: null, abort: true };
    },
  });
  const first = f.spawn();
  assert.throws(() => f.spawn(), /Cannot replace/);
  f.children.pop();
  f.supervisor.ready(first);
  first.emit("exit", 1);
  await f.tick(10);
  await f.tick(20);
  assert.equal(f.children.length, 3);
  assert.deepEqual(f.events.at(-1), ["exhausted"]);
  await f.tick(1000);
  assert.equal(f.children.length, 3);
  await f.supervisor.shutdown();
});

test("a child that dies during initial startup is not also scheduled for runtime recovery", async (t) => {
  const f = fixture(t);
  const child = f.spawn();
  child.emit("exit", 1);
  assert.equal(f.supervisor.ready(child), false);
  await f.tick(1000);
  assert.equal(f.children.length, 1);
});

test("repeated quit requests join the exact same child cleanup", async (t) => {
  let finishStop;
  let stops = 0;
  const f = fixture(t, { stop: () => {
    stops += 1;
    return new Promise((resolve) => { finishStop = resolve; });
  } });
  const proc = f.spawn();
  f.supervisor.ready(proc);
  const first = f.supervisor.shutdown();
  assert.equal(f.supervisor.shutdown(), first);
  assert.equal(stops, 1);
  proc.emit("exit", 0);
  finishStop(true);
  assert.equal(await first, true);
  await f.tick(1000);
  assert.equal(f.children.length, 1);
});
