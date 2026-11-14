import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), readdir: vi.fn(), read: vi.fn() }));
vi.mock("node:child_process", async (original) => ({ ...await original<typeof import("node:child_process")>(), spawn: mocks.spawn }));
vi.mock("node:fs", async (original) => ({ ...await original<typeof import("node:fs")>(), readdirSync: mocks.readdir, readFileSync: mocks.read }));

import { captureCliTree, killCliTree, spawnCli } from "./procs.ts";

let processes: Map<number, string>;
let denied: Set<number>;
let signal: ReturnType<typeof vi.fn>;

function stat(pid: number, parent: number, start: string, state = "S"): string {
  const fields = Array<string>(20).fill("0");
  fields[0] = state;
  fields[1] = String(parent);
  fields[2] = String(pid);
  fields[19] = start;
  return `${pid} (helper with ) in name) ${fields.join(" ")}`;
}

function root(): ChildProcess {
  const child = Object.assign(new EventEmitter(), {
    pid: 10001, exitCode: null, signalCode: null,
    stdin: new EventEmitter(), stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn(),
  });
  mocks.spawn.mockReturnValue(child);
  return spawnCli("node", [], { stdio: "pipe" });
}

beforeEach(() => {
  processes = new Map([[10001, stat(10001, 9000, "10")], [10002, stat(10002, 10001, "11")], [10003, stat(10003, 10002, "12")]]);
  denied = new Set();
  mocks.readdir.mockImplementation(() => [...processes.keys()].map(String));
  mocks.read.mockImplementation((path: string) => {
    const pid = Number(/^\/proc\/(\d+)\/stat$/.exec(path)?.[1]);
    if (denied.has(pid)) throw Object.assign(new Error("denied"), { code: "EPERM" });
    const value = processes.get(pid);
    if (!value) throw Object.assign(new Error("gone"), { code: "ENOENT" });
    return value;
  });
  signal = vi.fn((pid: number, value: number | string) => {
    if (pid < 0 || !processes.has(pid)) throw Object.assign(new Error("gone"), { code: "ESRCH" });
    if (value !== 0) processes.delete(pid);
    return true;
  });
  vi.stubGlobal("process", { ...process, pid: 9000, platform: "linux", kill: signal });
});
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("Linux CLI descendants", () => {
  it("retains detached descendant identities across protocol exit and reparenting", async () => {
    const child = root();
    captureCliTree(child);
    processes.delete(10001);
    processes.set(10002, stat(10002, 1, "11"));
    processes.set(10003, stat(10003, 1, "12"));
    Object.assign(child, { exitCode: 0 });

    await expect(killCliTree(child, 0)).resolves.toBe(true);
    expect(signal.mock.calls.filter(([pid, value]) => pid > 0 && value === "SIGTERM").map(([pid]) => pid)).toEqual([10003, 10002]);
    expect(processes.size).toBe(0);
  });

  it("does not signal a captured PID after its start time changes", async () => {
    const child = root();
    captureCliTree(child);
    processes.delete(10001);
    processes.delete(10002);
    processes.set(10003, stat(10003, 1, "99"));
    Object.assign(child, { exitCode: 0 });

    await expect(killCliTree(child, 0)).resolves.toBe(true);
    expect(signal).not.toHaveBeenCalledWith(10003, expect.anything());
    expect(processes.has(10003)).toBe(true);
  });

  it("does not signal a reused root group while cleaning its retained descendants", async () => {
    const child = root();
    captureCliTree(child);
    processes.set(10001, stat(10001, 1, "99"));
    processes.set(10002, stat(10002, 1, "11"));
    processes.set(10003, stat(10003, 1, "12"));
    Object.assign(child, { exitCode: 0 });

    await expect(killCliTree(child, 0)).resolves.toBe(true);
    expect(signal.mock.calls.some(([pid]) => pid === -10001 || pid === 10001)).toBe(false);
    expect(processes.has(10001)).toBe(true);
    expect(processes.has(10002)).toBe(false);
    expect(processes.has(10003)).toBe(false);
  });

  it("keeps the spawn identity when the root PID is reused before the first snapshot", async () => {
    const child = root();
    processes.clear();
    processes.set(10001, stat(10001, 1, "99"));
    Object.assign(child, { exitCode: 0 });

    await expect(killCliTree(child, 0)).resolves.toBe(true);
    expect(signal).not.toHaveBeenCalled();
    expect(processes.has(10001)).toBe(true);
  });

  it("does not signal an unidentified Linux root", async () => {
    denied.add(10001);
    const child = root();
    Object.assign(child, { exitCode: 0 });

    await expect(killCliTree(child, 0)).resolves.toBe(false);
    expect(signal).not.toHaveBeenCalled();
  });

  it("does not call unreadable captured descendants stopped", async () => {
    const child = root();
    captureCliTree(child);
    processes.delete(10001);
    processes.delete(10002);
    denied.add(10003);
    Object.assign(child, { exitCode: 0 });

    await expect(killCliTree(child, 0)).resolves.toBe(false);
    expect(signal).not.toHaveBeenCalledWith(10003, "SIGTERM");
    expect(signal).not.toHaveBeenCalledWith(10003, "SIGKILL");
  });
});
