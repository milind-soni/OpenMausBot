import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), readdir: vi.fn(), read: vi.fn(), exists: vi.fn() }));
vi.mock("node:child_process", async (original) => ({ ...await original<typeof import("node:child_process")>(), spawn: mocks.spawn }));
vi.mock("node:fs", async (original) => ({ ...await original<typeof import("node:fs")>(), readdirSync: mocks.readdir, readFileSync: mocks.read, existsSync: mocks.exists }));

import { captureCliTree, killCliTree, spawnCli } from "./procs.ts";

let processes: Map<number, string>;
let denied: Set<number>;
/** What a children file lists instead of the true children, as when Linux skips one. */
let listed: Map<number, string>;
let hiddenTasks: Set<number>;
/** Threads beyond each process's main one, and what each thread's children file reads. */
let threads: Map<number, string[]>;
let threadChildren: Map<string, string>;
let goneThreads: Set<number>;
let onTaskList: (pid: number) => void;
let signal: ReturnType<typeof vi.fn>;

function stat(pid: number, parent: number, start: string, state = "S"): string {
  const fields = Array<string>(20).fill("0");
  fields[0] = state;
  fields[1] = String(parent);
  fields[2] = String(pid);
  fields[19] = start;
  return `${pid} (helper with ) in name) ${fields.join(" ")}`;
}

function parentOf(value: string): string {
  return value.slice(value.lastIndexOf(")") + 2).split(" ")[1];
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
  listed = new Map();
  hiddenTasks = new Set();
  threads = new Map();
  threadChildren = new Map();
  goneThreads = new Set();
  onTaskList = () => {};
  const gone = () => Object.assign(new Error("gone"), { code: "ENOENT" });
  mocks.readdir.mockImplementation((path: string) => {
    if (path === "/proc") return [...processes.keys()].map(String);
    const pid = Number(/^\/proc\/(\d+)\/task$/.exec(path)?.[1]);
    onTaskList(pid);
    if (!processes.has(pid) || hiddenTasks.has(pid)) throw gone();
    return [String(pid), ...threads.get(pid) ?? []];
  });
  mocks.read.mockImplementation((path: string) => {
    const thread = /^\/proc\/(\d+)\/task\/(\d+)\/stat$/.exec(path);
    if (thread) {
      if (goneThreads.has(Number(thread[2]))) throw gone();
      const value = processes.get(Number(thread[1]));
      if (!value) throw gone();
      return value;
    }
    const children = /^\/proc\/(\d+)\/task\/(\d+)\/children$/.exec(path);
    if (children) {
      if (!processes.has(Number(children[1]))) throw gone();
      const ofThread = threadChildren.get(`${children[1]}/${children[2]}`);
      if (ofThread !== undefined) return ofThread;
      const instead = listed.get(Number(children[1]));
      if (instead !== undefined) return instead;
      return [...processes].filter(([, value]) => parentOf(value) === children[1]).map(([pid]) => `${pid} `).join("");
    }
    const pid = Number(/^\/proc\/(\d+)\/stat$/.exec(path)?.[1]);
    if (denied.has(pid)) throw Object.assign(new Error("denied"), { code: "EPERM" });
    const value = processes.get(pid);
    if (!value) throw gone();
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

describe.each([["children files", true], ["a read of every process", false]])("Linux CLI descendants, found through %s", (_, childrenFiles) => {
  beforeEach(() => { mocks.exists.mockImplementation((path: string) => childrenFiles && /^\/proc\/self\/task\/\d+\/children$/.test(path)); });

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

describe("Linux CLI descendants through children files that may be incomplete", () => {
  beforeEach(() => { mocks.exists.mockReturnValue(true); });
  const detach = (child: ChildProcess) => {
    processes.delete(10001);
    for (const [pid, value] of processes) processes.set(pid, stat(pid, 1, value.slice(value.lastIndexOf(" ") + 1)));
    Object.assign(child, { exitCode: 0 });
  };
  const terminated = () => signal.mock.calls.filter(([pid, value]) => pid > 0 && value === "SIGTERM").map(([pid]) => pid);

  it("reads every process when a child listed beside a skipped one has been reaped", async () => {
    processes.set(10003, stat(10003, 10001, "12"));
    listed.set(10001, "10009 10002 ");
    const child = root();
    captureCliTree(child);
    detach(child);

    await expect(killCliTree(child, 0)).resolves.toBe(true);
    expect(terminated().sort()).toEqual([10002, 10003]);
  });

  it("reads every process when a live parent's thread list is hidden", async () => {
    hiddenTasks.add(10001);
    const child = root();
    captureCliTree(child);
    detach(child);

    await expect(killCliTree(child, 0)).resolves.toBe(true);
    expect(terminated()).toEqual([10003, 10002]);
  });

  it("keeps a descendant it found when the root exits before the walk is done", async () => {
    const child = root();
    onTaskList = (pid) => {
      if (pid !== 10002) return;
      processes.delete(10001);
      processes.set(10002, stat(10002, 1, "11"));
      hiddenTasks.add(10002);
    };
    captureCliTree(child);
    onTaskList = () => {};
    Object.assign(child, { exitCode: 0 });

    await expect(killCliTree(child, 0)).resolves.toBe(true);
    expect(terminated()).toEqual([10003, 10002]);
  });

  it("reads every process when a thread exits after handing its child to a thread already read", async () => {
    threads.set(10001, ["20001"]);
    threadChildren.set("10001/10001", "");
    threadChildren.set("10001/20001", "");
    goneThreads.add(20001);
    const child = root();
    captureCliTree(child);
    detach(child);

    await expect(killCliTree(child, 0)).resolves.toBe(true);
    expect(terminated()).toEqual([10003, 10002]);
  });

  it("never adopts the children of a process that took a parent's PID during the walk", async () => {
    processes.delete(10003);
    const child = root();
    onTaskList = (pid) => {
      if (pid !== 10002) return;
      processes.set(10002, stat(10002, 1, "99"));
      processes.set(10005, stat(10005, 10002, "15"));
    };
    captureCliTree(child);
    onTaskList = () => {};
    processes.delete(10001);
    Object.assign(child, { exitCode: 0 });

    await expect(killCliTree(child, 0)).resolves.toBe(true);
    expect(signal).not.toHaveBeenCalledWith(10005, expect.anything());
    expect(signal).not.toHaveBeenCalledWith(10002, expect.anything());
  });
});
