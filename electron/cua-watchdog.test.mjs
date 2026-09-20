// The watchdog's whole job is a decision about a socket, so it is pinned here
// with no daemon, no socket, and no Electron — the launch tests in
// cua-launch.test.mjs prove startCua/stopCua against a mocked Electron, but
// they only run on macOS, and a dead-pipe restart is not a macOS bug.
//
// The cases that matter are the ones this machine produced: an embedded host
// whose descriptor outlived it, a panel asking again, and a start that fails
// and must not be retried forever.
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { createCuaWatchdog, socketPathOf } = require("./cua-watchdog.cjs");

/** A watchdog over a mutable descriptor, with every dependency recorded. */
function fixture({ connection, alive = true, revive = async () => connection }) {
  let current = connection;
  const probes = [];
  const logs = [];
  const read = vi.fn(() => current);
  const isAlive = vi.fn(async (socketPath) => {
    probes.push(socketPath);
    return typeof alive === "function" ? alive(socketPath) : alive;
  });
  const restart = vi.fn(async () => {
    current = await revive();
    return current;
  });
  const dog = createCuaWatchdog({ read, isAlive, revive: restart, log: (line) => logs.push(line) });
  return {
    dog,
    probes,
    logs,
    isAlive,
    restart,
    get current() {
      return current;
    },
  };
}

describe("socketPathOf", () => {
  it("reads the socket a live descriptor promises", () => {
    expect(socketPathOf({ mode: "embedded", socketPath: "\\\\.\\pipe\\cua-22732-fc8c5401" }))
      .toBe("\\\\.\\pipe\\cua-22732-fc8c5401");
    expect(socketPathOf({ mode: "standalone", socketPath: "/tmp/cua-driver/cua-driver.sock" }))
      .toBe("/tmp/cua-driver/cua-driver.sock");
  });

  it("has nothing to say about a descriptor that promises no socket", () => {
    // A failed start, a mode whose lifetime belongs to another runtime, and a
    // live mode with no path are all "not my business" — not "dead". Reading
    // them as dead is how a watchdog turns into a restart loop.
    expect(socketPathOf({ mode: "unavailable", reason: "cua-driver binary not found" })).toBeNull();
    expect(socketPathOf({ mode: "unavailable", socketPath: "/tmp/gone.sock" })).toBeNull();
    expect(socketPathOf({ mode: "embedded" })).toBeNull();
    expect(socketPathOf({ mode: "embedded", socketPath: "" })).toBeNull();
    expect(socketPathOf(null)).toBeNull();
    expect(socketPathOf("embedded")).toBeNull();
  });
});

describe("CUA watchdog", () => {
  it("leaves a daemon that is still listening alone", async () => {
    const f = fixture({ connection: { mode: "embedded", socketPath: "/tmp/live.sock" } });
    await expect(f.dog.check()).resolves.toEqual({ status: "alive" });
    expect(f.probes).toEqual(["/tmp/live.sock"]);
    expect(f.restart).not.toHaveBeenCalled();
  });

  it("does not probe a descriptor that promises no socket", async () => {
    const f = fixture({ connection: { mode: "unavailable", reason: "cua-driver binary not found" } });
    await expect(f.dog.check()).resolves.toEqual({ status: "untracked" });
    expect(f.isAlive).not.toHaveBeenCalled();
    expect(f.restart).not.toHaveBeenCalled();
  });

  it("restarts the daemon when the socket it promised is gone", async () => {
    const revived = { mode: "embedded", socketPath: "/tmp/fresh.sock" };
    const f = fixture({
      connection: { mode: "embedded", socketPath: "/tmp/dead.sock" },
      alive: false,
      revive: async () => revived,
    });
    await expect(f.dog.check()).resolves.toEqual({ status: "revived", connection: revived });
    expect(f.restart).toHaveBeenCalledOnce();
    // the reason is logged with the socket that died, because that is the only
    // evidence of what happened after the fact
    expect(f.logs[0]).toContain("/tmp/dead.sock");
    expect(socketPathOf(f.current)).toBe("/tmp/fresh.sock");
  });

  it("revives once when the panel and the interval find the same dead socket", async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const f = fixture({
      connection: { mode: "standalone", socketPath: "/tmp/dead.sock" },
      alive: false,
      revive: async () => {
        await gate;
        return { mode: "standalone", socketPath: "/tmp/fresh.sock" };
      },
    });
    const checks = [f.dog.check(), f.dog.check(), f.dog.check()];
    release();
    const results = await Promise.all(checks);
    // a second start would tear down the replacement the first one just built
    expect(f.restart).toHaveBeenCalledOnce();
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
  });

  it("keeps trying after a restart that throws, instead of giving up", async () => {
    const f = fixture({
      connection: { mode: "embedded", socketPath: "/tmp/dead.sock" },
      alive: false,
      revive: async () => {
        throw new Error("host refused to start");
      },
    });
    await expect(f.dog.check()).resolves.toMatchObject({ status: "failed" });
    expect(f.logs.at(-1)).toContain("host refused to start");
    // the dead descriptor is still what is persisted, so the next check is a
    // real retry rather than a replay of the failure
    await f.dog.check();
    expect(f.restart).toHaveBeenCalledTimes(2);
  });

  it("settles instead of looping when the restart reports unavailable", async () => {
    const unavailable = { mode: "unavailable", reason: "embedded host failed: boom" };
    const f = fixture({
      connection: { mode: "embedded", socketPath: "/tmp/dead.sock" },
      alive: false,
      revive: async () => unavailable,
    });
    await expect(f.dog.check()).resolves.toEqual({ status: "unavailable", connection: unavailable });
    // the retry persisted `unavailable`, which promises no socket — so the
    // watchdog stops rather than restarting a driver that just refused
    await expect(f.dog.check()).resolves.toEqual({ status: "untracked" });
    expect(f.restart).toHaveBeenCalledOnce();
  });

  it("arms one interval, never holds the app open, and cancels on stop", () => {
    const scheduled = [];
    const cancelled = [];
    const dog = createCuaWatchdog({
      read: () => null,
      isAlive: async () => true,
      revive: async () => null,
      intervalMs: 1234,
      schedule: (fn, ms) => {
        const timer = { fn, ms, unref: vi.fn() };
        scheduled.push(timer);
        return timer;
      },
      cancel: (timer) => cancelled.push(timer),
    });

    expect(dog.running).toBe(false);
    dog.start();
    dog.start(); // a second successful start must not stack intervals
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].ms).toBe(1234);
    expect(scheduled[0].unref).toHaveBeenCalledOnce();
    expect(dog.running).toBe(true);

    dog.stop();
    dog.stop(); // and Stop during quit is called more than once
    expect(cancelled).toEqual([scheduled[0]]);
    expect(dog.running).toBe(false);
  });

  it("re-checks the descriptor every time the interval fires", async () => {
    const scheduled = [];
    let current = { mode: "standalone", socketPath: "/tmp/dead.sock" };
    const dog = createCuaWatchdog({
      read: () => current,
      isAlive: async () => false,
      revive: async () => {
        current = { mode: "standalone", socketPath: "/tmp/fresh.sock" };
        return current;
      },
      schedule: (fn) => {
        scheduled.push(fn);
        return { unref: () => {} };
      },
      cancel: () => {},
    });

    dog.start();
    scheduled[0]();
    await expect.poll(() => current.socketPath).toBe("/tmp/fresh.sock");
  });
});
