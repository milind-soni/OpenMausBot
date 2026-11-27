import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, execFile: vi.fn() };
});

const { execFile } = await import("node:child_process");
const { killCliTree } = await import("./procs.ts");

const platform = process.platform;
afterEach(() => {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  vi.mocked(execFile).mockReset();
});

/** A CLI on Windows: it exits when stopped, but a process left in its tree still holds the pipes it inherited, so "close" never comes. */
function windowsCli(pid: number): ChildProcess {
  const child = Object.assign(new EventEmitter(), { pid, exitCode: null as number | null, signalCode: null, kill: () => true });
  child.kill = () => {
    queueMicrotask(() => { child.exitCode = 1; child.emit("exit", 1, null); });
    return true;
  };
  return child as unknown as ChildProcess;
}

describe("stopping a CLI on Windows", () => {
  it("counts the CLI stopped once it exits, when taskkill fails for a process it cannot stop in the tree", async () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    // taskkill /T /F exits non-zero when any process in the tree could not be stopped (already gone, or access denied).
    vi.mocked(execFile).mockImplementation(((file: string, args: string[], _options: unknown, done: (error: Error | null) => void) => {
      expect(file).toBe("taskkill");
      expect(args).toEqual(["/PID", "4300", "/T", "/F"]);
      queueMicrotask(() => done(Object.assign(new Error("ERROR: The process with PID 4321 (child process of PID 4300) could not be terminated."), { code: 128 })));
      return {} as ChildProcess;
    }) as unknown as typeof execFile);
    const child = windowsCli(4300);
    const started = Date.now();
    await expect(killCliTree(child, 2_000)).resolves.toBe(true);
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it("counts the CLI stopped when it exits before taskkill reports the failure", async () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const child = windowsCli(4300);
    const raw = child as unknown as EventEmitter & { exitCode: number | null };
    // taskkill stopped the CLI itself, then failed on a process left in its tree.
    vi.mocked(execFile).mockImplementation(((file: string, args: string[], _options: unknown, done: (error: Error | null) => void) => {
      expect([file, ...args]).toEqual(["taskkill", "/PID", "4300", "/T", "/F"]);
      raw.exitCode = 1;
      raw.emit("exit", 1, null);
      setTimeout(() => done(Object.assign(new Error("ERROR: The process with PID 4321 (child process of PID 4300) could not be terminated."), { code: 128 })), 50);
      return {} as ChildProcess;
    }) as unknown as typeof execFile);
    const started = Date.now();
    await expect(killCliTree(child, 2_000)).resolves.toBe(true);
    expect(Date.now() - started).toBeLessThan(1_500);
  });
});
