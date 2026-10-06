import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { perBotLocalVmTarget, type LocalVmTarget } from "./container-computer.ts";
import { forgetCuaSpaceOwnership, recordCuaSpaceOwnership } from "./cua-space-ownership.ts";
import { cuaSpaceAction, cuaSpaceStatus, cuaSpaceTarget, existingCuaSpaces, type CuaDeps } from "./cua-spaces-computer.ts";
import { createLocalVmIdleTimer, restoreLocalVmIdleTargets } from "./local-vm-inventory.ts";
import type { LocalVmIdleTimer } from "./local-vm-idle.ts";
import { clearLocalVmSpaceIdleStop, localVmStopReason } from "./local-vm-stop-reason.ts";

const HOST = { platform: "darwin", macosSupported: true } as const;
const IDLE_MINUTES = 3;
const IDLE_MS = IDLE_MINUTES * 60_000;
let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "omb-cua-idle-"));
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(dataDir, { recursive: true, force: true });
});

/** Fake the user-installed CLI at its argv boundary, not the lifecycle
 * functions. Real status/ownership checks and stop/start arguments still run. */
function fakeCua(targets: LocalVmTarget[]) {
  const states = new Map(targets.map((target) => [target.space!.name, "running"]));
  const calls: string[][] = [];
  let reachable = true;
  const deps: CuaDeps = {
    cli: "/fake/cua",
    dataDir,
    run: async (_command, args) => {
      calls.push(args);
      if (args[0] === "--version") return { stdout: "cua 0.2.0" };
      if (args[0] === "sb" && args[1] === "ls") {
        if (!reachable) throw new Error("daemon unavailable");
        return { stdout: JSON.stringify([...states].map(([name, state]) => ({ name, state, status: state === "running" ? "ready" : "stopped" }))) };
      }
      if (args[0] === "spaces" && (args[1] === "stop" || args[1] === "start")) {
        const name = args[2].replace(/^local:/, "");
        if (!states.has(name)) throw new Error(`no such Space: ${name}`);
        states.set(name, args[1] === "stop" ? "stopped" : "running");
        return { stdout: "{}" };
      }
      throw new Error(`unexpected cua ${args.join(" ")}`);
    },
    exec: async () => { throw new Error("idle cleanup must not execute guest commands"); },
  };
  return { deps, calls, states, unreachable: () => { reachable = false; }, recover: () => { reachable = true; } };
}

function idleFor(target: LocalVmTarget, deps: CuaDeps, active: Set<string>, lifecycle: Set<string>) {
  return createLocalVmIdleTimer(target, {
    idleMs: IDLE_MS,
    busy: () => active.has(target.key) || lifecycle.has(target.key),
    claim: () => {
      lifecycle.add(target.key);
      return () => { lifecycle.delete(target.key); };
    },
    status: () => cuaSpaceStatus(target, deps, HOST),
    stop: () => cuaSpaceAction("stop", target, deps, HOST),
    dataDir,
  });
}

for (const os of ["linux", "macos"] as const) {
  describe(`${os} per-bot idle stop`, () => {
    it("stops through cua spaces stop at the configured inactivity deadline, preserving the Space", async () => {
      const target = cuaSpaceTarget(perBotLocalVmTarget(`idle-${os}`), os);
      recordCuaSpaceOwnership(target.space!.name, dataDir);
      const cua = fakeCua([target]);
      const lifecycle = new Set<string>();
      const idle = idleFor(target, cua.deps, new Set(), lifecycle);
      idle.touch();
      await vi.advanceTimersByTimeAsync(IDLE_MS - 1);
      expect(cua.calls).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(cua.calls.filter((args) => args[0] === "spaces")).toEqual([["spaces", "stop", `local:${target.space!.name}`, "--json"]]);
      expect(cua.states.get(target.space!.name)).toBe("stopped");
      expect(lifecycle.size).toBe(0);
      const stopped = await cuaSpaceStatus(target, cua.deps, HOST);
      expect(stopped.stopped_at).toBeNull();
      expect(localVmStopReason(target.key, stopped, dataDir)).toBe("idle");
      clearLocalVmSpaceIdleStop(target.key, dataDir);
      await cuaSpaceAction("start", target, cua.deps, HOST);
      // A later external stop is not the old idle receipt after OMB wakes it.
      cua.states.set(target.space!.name, "stopped");
      expect(localVmStopReason(target.key, await cuaSpaceStatus(target, cua.deps, HOST), dataDir)).toBeNull();
    });

    it("renews activity and defers a busy turn or lifecycle for another full idle window", async () => {
      const target = cuaSpaceTarget(perBotLocalVmTarget(`busy-${os}`), os);
      recordCuaSpaceOwnership(target.space!.name, dataDir);
      const cua = fakeCua([target]);
      const active = new Set<string>([target.key]);
      const lifecycle = new Set<string>();
      const idle = idleFor(target, cua.deps, active, lifecycle);
      idle.touch();
      await vi.advanceTimersByTimeAsync(IDLE_MS);
      expect(cua.calls).toEqual([]);
      active.clear();
      lifecycle.add(target.key);
      await vi.advanceTimersByTimeAsync(IDLE_MS);
      expect(cua.calls).toEqual([]);
      lifecycle.clear();
      await vi.advanceTimersByTimeAsync(IDLE_MS / 2);
      idle.touch();
      await vi.advanceTimersByTimeAsync(IDLE_MS - 1);
      expect(cua.calls).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(cua.calls.some((args) => args[0] === "spaces" && args[1] === "stop")).toBe(true);
    });
  });
}

it("startup discovery arms already-running owned Spaces, including both OSes, but never an unmanaged name collision", async () => {
  const linux = cuaSpaceTarget(perBotLocalVmTarget("startup-linux"), "linux");
  const macos = cuaSpaceTarget(perBotLocalVmTarget("startup-macos"), "macos");
  const foreign = cuaSpaceTarget(perBotLocalVmTarget("startup-foreign"), "linux");
  const targets = [linux, macos, foreign];
  for (const target of [linux, macos]) recordCuaSpaceOwnership(target.space!.name, dataDir);
  const cua = fakeCua(targets);
  const timers = new Map<string, LocalVmIdleTimer>();
  const active = new Set<string>();
  const lifecycle = new Set<string>();
  const seen: string[] = [];
  await restoreLocalVmIdleTargets(await existingCuaSpaces(targets, cua.deps), {
    status: (target) => cuaSpaceStatus(target, cua.deps, HOST),
    seen: (target, status) => { if (status?.managed) seen.push(target.key); },
    idle: (target) => {
      const idle = idleFor(target, cua.deps, active, lifecycle);
      timers.set(target.key, idle);
      return idle;
    },
  });
  expect(seen).toEqual([linux.key, macos.key]);
  expect([...timers.keys()]).toEqual([linux.key, macos.key]);
  await vi.advanceTimersByTimeAsync(IDLE_MS);
  expect(cua.calls.filter((args) => args[0] === "spaces" && args[1] === "stop").map((args) => args[2])).toEqual([
    `local:${linux.space!.name}`, `local:${macos.space!.name}`,
  ]);
  expect(cua.states.get(foreign.space!.name)).toBe("running");
});

it("rechecks ownership at expiry and never stops a Space whose ownership receipt was removed", async () => {
  const target = cuaSpaceTarget(perBotLocalVmTarget("unmanaged-expiry"), "linux");
  recordCuaSpaceOwnership(target.space!.name, dataDir);
  const cua = fakeCua([target]);
  const idle = idleFor(target, cua.deps, new Set(), new Set());
  idle.touch();
  forgetCuaSpaceOwnership(target.space!.name, dataDir);
  await vi.advanceTimersByTimeAsync(IDLE_MS);
  expect(cua.calls.some((args) => args[0] === "spaces" && args[1] === "stop")).toBe(false);
  expect(cua.states.get(target.space!.name)).toBe("running");
});

it("retries an unreachable Space daemon instead of permanently losing the idle backstop", async () => {
  const target = cuaSpaceTarget(perBotLocalVmTarget("idle-retry"), "linux");
  recordCuaSpaceOwnership(target.space!.name, dataDir);
  const cua = fakeCua([target]);
  const idle = idleFor(target, cua.deps, new Set(), new Set());
  idle.touch();
  cua.unreachable();
  await vi.advanceTimersByTimeAsync(IDLE_MS);
  expect(cua.states.get(target.space!.name)).toBe("running");
  cua.recover();
  await vi.advanceTimersByTimeAsync(IDLE_MS);
  expect(cua.calls.filter((args) => args[0] === "spaces" && args[1] === "stop")).toHaveLength(1);
});
