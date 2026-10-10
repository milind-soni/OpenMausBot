import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import { switchLocalEnvironment } from "./environment-switch.mjs";
import { createServerSupervisor } from "./server-supervisor.mjs";

const require = createRequire(import.meta.url);
const env = require("./environments.cjs");
const MAIN_SOURCE = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
// vm realms have their own Object/Array prototypes: bring results home before strict-comparing.
const plain = (value) => (value === undefined || value === null ? value : Array.isArray(value) ? value.map(plain) : typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)])) : value);

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

test("a pause publishes the outage but schedules no restart; resume re-arms later exits", async (t) => {
  const f = fixture(t);
  const first = f.spawn();
  f.supervisor.ready(first);
  f.supervisor.pause();
  first.emit("exit", 1);
  assert.deepEqual(f.events.at(-1), ["unavailable"], "a paused outage still publishes");
  await f.tick(1000);
  assert.equal(f.children.length, 1, "an exit during pause must not fork a replacement");
  const second = f.spawn();
  f.supervisor.ready(second);
  f.supervisor.resume();
  second.emit("exit", 1);
  await f.tick(10);
  assert.equal(f.children.length, 3, "resume re-arms recovery for a later crash");
  await f.supervisor.shutdown();
});

test("pause cancels an already-queued restart and resume does not resurrect it", async (t) => {
  const f = fixture(t);
  const first = f.spawn();
  f.supervisor.ready(first);
  first.emit("exit", 1);
  f.supervisor.pause();
  await f.tick(1000);
  assert.equal(f.children.length, 1, "pause must drop the queued restart");
  f.supervisor.resume();
  await f.tick(1000);
  assert.equal(f.children.length, 1, "resume must not revive the cancelled restart");
  await f.supervisor.shutdown();
});

test("local switching in main rejects dev mode and overlaps, and adopts the rollback child", () => {
  const source = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  const start = source.indexOf("async function switchLocalEnvironmentTo(");
  const body = source.slice(start, source.indexOf("\nasync function switchEnvironment", start));
  assert.ok(start > 0 && body.length > 0, "the switch helper exists");
  assert.match(body, /if \(!app\.isPackaged\) return \{ ok: false, error: "dev" \};/);
  assert.match(body, /if \(localSwitchInFlight\) return \{ ok: false, error: "busy" \};/);
  assert.match(body, /if \(restored\.proc\) serverSupervisor\.ready\(restored\.proc\);/);
  const busyCheck = body.indexOf('if (localSwitchInFlight)');
  const flagSet = body.indexOf("localSwitchInFlight = true;");
  const pause = body.indexOf("serverSupervisor.pause();");
  assert.ok(busyCheck < flagSet && flagSet < pause, "a rejected switch must not pause the supervisor");
  const finallyBlock = body.slice(body.lastIndexOf("} finally {"));
  assert.match(finallyBlock, /localSwitchInFlight = false;\s*serverSupervisor\.resume\(\);/);
  assert.match(source, /function createLocalEnvironment\(name, dataDir\) \{\s*if \(!app\.isPackaged\) return \{ ok: false, error: "dev", state: environmentsState \};/);
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

const LOCAL_FIXTURE = { id: "l1", kind: "local", name: "Work", dataDir: "/Users/me/.openmausbot-work", missing: false };

function runForget(state) {
  const start = MAIN_SOURCE.indexOf("async function forgetEnvironment(");
  const end = MAIN_SOURCE.indexOf("function showContextMenu(", start);
  assert.ok(start > 0 && end > start, "the forget helper exists");
  const calls = { dialogs: [], shares: [], persisted: [], navigated: [], rm: [] };
  const rmOptions = [];
  const ctx = {
    environmentsState: state,
    localSwitchInFlight: false,
    runningDataDir: null,
    dialog: { showMessageBox: async (options) => { calls.dialogs.push(options); return { response: 0 }; } },
    sharingController: () => ({ forget: (entry) => calls.shares.push(entry.id) }),
    persistEnvironments: (next) => { calls.persisted.push(next); context.environmentsState = next; },
    withoutEnvironment: env.withoutEnvironment,
    navigateMainWindow: (url) => calls.navigated.push(url),
    activeOrigin: () => "http://127.0.0.1:8799",
    fs: {
      promises: { rm: async (dir, options) => { calls.rm.push(dir); rmOptions.push(options); if (ctx.__rmThrows) throw new Error("busy"); } },
      realpathSync: (dir) => dir,
    },
    path,
    AbortSignal,
    desktopDataDir: () => "/Users/me/.openmausbot",
    slog: () => {},
    session: { defaultSession: { fetch: async () => ({ ok: true }), clearStorageData: async () => {} } },
  };
  const context = vm.createContext(ctx);
  vm.runInContext(`${MAIN_SOURCE.slice(start, end)}; this.forgetEnvironment = forgetEnvironment;`, context);
  return { calls, context, rmOptions };
}

test("forgetting the ACTIVE local environment is refused with {error:active} and touches nothing", async () => {
  const { calls, context } = runForget({ environments: [LOCAL_FIXTURE], activeId: "l1" });
  assert.deepEqual(plain(await context.forgetEnvironment("l1", true)), { ok: false, error: "active" });
  assert.deepEqual(calls, { dialogs: [], shares: [], persisted: [], navigated: [], rm: [] });
});

test("forgetting a local environment asks nothing of the user, and a failed purge keeps the entry with {error:purge}", async () => {
  const { calls, context } = runForget({ environments: [LOCAL_FIXTURE], activeId: "local" });
  context.__rmThrows = true;
  assert.deepEqual(plain(await context.forgetEnvironment("l1", true)), { ok: false, error: "purge" });
  assert.equal(calls.dialogs.length, 0, "no remote-worded confirmation for a local entry");
  assert.deepEqual(calls.persisted, [], "a failed purge must not remove the entry from the registry");
});

test("forgetting a local environment with files kept or purged removes it and answers {ok:true}", async () => {
  const keep = runForget({ environments: [LOCAL_FIXTURE], activeId: "local" });
  assert.deepEqual(plain(await keep.context.forgetEnvironment("l1")), { ok: true });
  assert.deepEqual(keep.calls.shares, ["l1"]);
  assert.deepEqual(keep.calls.rm, []);
  assert.deepEqual(plain(keep.calls.persisted[0].environments), []);
  assert.equal(keep.calls.dialogs.length, 0);
  const purged = runForget({ environments: [LOCAL_FIXTURE], activeId: "local" });
  assert.deepEqual(plain(await purged.context.forgetEnvironment("l1", true)), { ok: true });
  // forgetEnvironment hands rm the path.resolve()d dir — drive-prefixed on Windows.
  assert.deepEqual(purged.calls.rm, [path.resolve(LOCAL_FIXTURE.dataDir)]);
  assert.deepEqual(plain(purged.calls.persisted[0].environments), []);
  assert.equal(purged.calls.dialogs.length, 0);
});

test("forgetting a remote environment keeps its sign-out confirmation and answers {ok:true}", async () => {
  const remote = { id: "r1", kind: "remote", name: "Office", origin: "https://box.example", missing: false };
  const { calls, context } = runForget({ environments: [remote], activeId: "r1" });
  assert.deepEqual(plain(await context.forgetEnvironment("r1")), { ok: true });
  assert.equal(calls.dialogs.length, 1, "the remote dialog stays");
  assert.match(calls.dialogs[0].detail, /signs out of that server/);
  assert.deepEqual(plain(calls.persisted[0].environments), []);
});

test("forgetting a local environment whose folder the server child uses is refused with {error:active}", async () => {
  // The window may show a remote server while the child still runs on this
  // folder (A → remote R); activeId alone is not the folder in use.
  const { calls, context } = runForget({ environments: [LOCAL_FIXTURE], activeId: "r-remote" });
  context.runningDataDir = LOCAL_FIXTURE.dataDir;
  assert.deepEqual(plain(await context.forgetEnvironment("l1", true)), { ok: false, error: "active" });
  assert.deepEqual(calls.rm, []);
  assert.deepEqual(calls.persisted, [], "the live entry stays in the registry");
});

test("forgetting a local environment while a switch is in flight is refused with {error:busy}", async () => {
  const { calls, context } = runForget({ environments: [LOCAL_FIXTURE], activeId: "local" });
  context.localSwitchInFlight = true;
  assert.deepEqual(plain(await context.forgetEnvironment("l1", true)), { ok: false, error: "busy" });
  assert.deepEqual(calls.rm, []);
});

test("a purge of a missing folder still removes the entry (rm runs with force)", async () => {
  const { calls, context, rmOptions } = runForget({ environments: [LOCAL_FIXTURE], activeId: "local" });
  assert.deepEqual(plain(await context.forgetEnvironment("l1", true)), { ok: true });
  assert.deepEqual(calls.rm, [path.resolve(LOCAL_FIXTURE.dataDir)]);
  assert.deepEqual(plain(rmOptions), [{ recursive: true, force: true }]);
});

function switchFixture(t, { startResults = [], releaseLeaseThrows = false, stopUtilityServer = async () => true } = {}) {
  const targetDir = mkdtempSync(join(tmpdir(), "omb-switch-fixture-"));
  t.after(() => rmSync(targetDir, { recursive: true, force: true }));
  const forks = [];
  let forkIndex = 0;
  const context = vm.createContext({
    app: { isPackaged: true },
    localSwitchInFlight: false,
    runningDataDir: null,
    serverProc: null,
    SERVER_PORT: 8799,
    serverSupervisor: {
      calls: [],
      pause() { this.calls.push("pause"); },
      resume() { this.calls.push("resume"); },
      ready(proc) { context.serverProc = proc; return true; },
      isCurrent: (proc) => proc !== null && proc === context.serverProc,
    },
    switchLocalEnvironment,
    stopUtilityServer,
    desktopDataDirLease: { release: () => { if (releaseLeaseThrows) throw new Error("lease release exploded"); } },
    acquireDataDirLease: () => ({ release: () => {} }),
    acquireDataDirLeaseFor: () => ({ release: () => {} }),
    fs: { promises: { mkdir: async () => {} } },
    startServerOn: async (...args) => {
      forks.push(args);
      const outcome = startResults[forkIndex++];
      return outcome === undefined ? { proc: { pid: 4000 + forkIndex } } : outcome;
    },
    environmentsState: { environments: [{ id: "l1", kind: "local", name: "Work", dataDir: targetDir }], activeId: "local" },
    desktopDataDir: () => "/Users/me/.openmausbot",
    startupEnvironmentDir: env.startupEnvironmentDir,
    withActive: env.withActive,
    persistEnvironments: (next) => { context.environmentsState = next; },
    navigateMainWindow: () => {},
    rendererOrigin: () => "http://127.0.0.1:8799",
    dialog: { showErrorBox: () => {} },
    slog: () => {},
  });
  const start = MAIN_SOURCE.indexOf("async function switchLocalEnvironmentTo(");
  const body = MAIN_SOURCE.slice(start, MAIN_SOURCE.indexOf("\nasync function switchEnvironment", start));
  assert.ok(start > 0 && body.length > 0, "the switch helper exists");
  vm.runInContext(`${body}; this.switchLocalEnvironmentTo = switchLocalEnvironmentTo;`, context);
  return { context, forks, targetDir };
}

test("a failed switch with no live child reforks the active environment once and adopts it", async (t) => {
  // releaseLease throws: the orchestrator rejects before any rollback, so
  // without the safety net nothing would be serving this environment again.
  const { context, forks, targetDir } = switchFixture(t, { releaseLeaseThrows: true });
  const result = await context.switchLocalEnvironmentTo(targetDir, "l1");
  assert.deepEqual(plain(result), { ok: false, error: "switch-failed" });
  assert.deepEqual(plain(forks), [[8799]], "exactly one safety-net re-fork on the active port");
  assert.equal(context.serverProc?.pid, 4001, "the re-forked child is adopted as ready");
});

test("a failed switch whose rollback restored a child does not re-fork", async (t) => {
  // startChild fails, rollback restarts the old environment: one fork for the
  // attempt, one for the rollback, none for the safety net.
  const { context, forks, targetDir } = switchFixture(t, { startResults: [{ proc: null }, { proc: { pid: 55 } }] });
  const result = await context.switchLocalEnvironmentTo(targetDir, "l1");
  assert.deepEqual(plain(result), { ok: false, error: "switch-failed" });
  assert.equal(forks.length, 2);
  assert.equal(context.serverProc?.pid, 55);
});

test("a successful switch never runs the safety net", async (t) => {
  const { context, forks, targetDir } = switchFixture(t);
  const result = await context.switchLocalEnvironmentTo(targetDir, "l1");
  assert.deepEqual(plain(result), { ok: true });
  assert.equal(forks.length, 1, "only the switch's own startChild fork");
});

test("a child that will not stop aborts the switch before its lease is handed away", async (t) => {
  const { context, forks, targetDir } = switchFixture(t, { stopUtilityServer: async () => false });
  context.serverProc = { pid: 1 };
  const result = await context.switchLocalEnvironmentTo(targetDir, "l1");
  assert.deepEqual(plain(result), { ok: false, error: "switch-failed" });
  assert.equal(forks.length, 0, "no target child starts behind a child that never stopped");
  assert.equal(context.environmentsState.activeId, "local", "the registry never moves");
});

test("boot reads the environment decision before the boot lease and never creates the missing dir", () => {
  const boot = MAIN_SOURCE.slice(MAIN_SOURCE.indexOf("environmentsState = readEnvironments();"), MAIN_SOURCE.indexOf("app.setAsDefaultProtocolClient"));
  const decision = boot.indexOf("bootEnvironmentDir(");
  const lease = boot.indexOf("acquireDataDirLease(");
  assert.ok(decision > 0 && decision < lease, "the missing-dir decision must precede the boot lease");
  assert.match(boot, /activeId: LOCAL_ID/);
  assert.match(boot, /showErrorBox\(\s*"[^"]*missing[^"]*"/i);
});
