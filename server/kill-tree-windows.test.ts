import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  execFile: mocks.execFile,
}));

import { killCliTree } from "./procs.ts";

function child(): ChildProcess {
  return Object.assign(new EventEmitter(), {
    pid: 12345,
    exitCode: null,
    signalCode: null,
    kill: vi.fn(),
  }) as unknown as ChildProcess;
}

// This unit suite models Windows events on every host; the real Windows
// driver/CLI-stop fixtures in CI independently exercise actual processes.
beforeEach(() => vi.stubGlobal("process", { ...process, platform: "win32" }));
afterEach(() => { mocks.execFile.mockReset(); vi.unstubAllGlobals(); });

describe("Windows killCliTree", () => {
  it("accepts successful taskkill after a confirmed exit without waiting for pipe closure", async () => {
    const proc = child();
    mocks.execFile.mockImplementation((_file, _args, _options, callback) => {
      queueMicrotask(() => { Object.assign(proc, { exitCode: 0 }); callback(null, "", ""); });
      return {} as ChildProcess;
    });

    await expect(killCliTree(proc, 50)).resolves.toBe(true);
    expect(proc.listenerCount("exit")).toBe(0);
    expect(proc.listenerCount("close")).toBe(0);
  });

  it("does not resolve just because taskkill succeeded before the child exit", async () => {
    const proc = child();
    mocks.execFile.mockImplementation((_file, _args, _options, callback) => {
      queueMicrotask(() => callback(null, "", ""));
      return {} as ChildProcess;
    });
    const finished = vi.fn();
    const stopped = killCliTree(proc, 1000).then(finished);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(finished).not.toHaveBeenCalled();
    Object.assign(proc, { exitCode: 0 });
    proc.emit("exit", 0, null);
    await stopped;
    expect(finished).toHaveBeenCalledWith(true);
    expect(proc.listenerCount("exit")).toBe(0);
    expect(proc.listenerCount("close")).toBe(0);
  });

  it("reports uncertainty if taskkill succeeds but no exit is observed", async () => {
    const proc = child();
    mocks.execFile.mockImplementation((_file, _args, _options, callback) => {
      queueMicrotask(() => callback(null, "", ""));
      return {} as ChildProcess;
    });
    await expect(killCliTree(proc, 10)).resolves.toBe(false);
    expect(proc.listenerCount("exit")).toBe(0);
    expect(proc.listenerCount("close")).toBe(0);
  });

  it("still reports a genuine taskkill timeout", async () => {
    mocks.execFile.mockImplementation(() => ({} as ChildProcess));

    await expect(killCliTree(child(), 10)).resolves.toBe(false);
  });
});
