import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  execFile: mocks.execFile,
}));

import { killCliTree } from "./procs.ts";

const windows = describe.skipIf(process.platform !== "win32");

function child(): ChildProcess {
  return Object.assign(new EventEmitter(), {
    pid: 12345,
    exitCode: null,
    signalCode: null,
    kill: vi.fn(),
  }) as unknown as ChildProcess;
}

afterEach(() => mocks.execFile.mockReset());

windows("Windows killCliTree", () => {
  it("accepts successful taskkill without waiting for a delayed close event", async () => {
    mocks.execFile.mockImplementation((_file, _args, _options, callback) => {
      queueMicrotask(() => callback(null, "", ""));
      return {} as ChildProcess;
    });

    await expect(killCliTree(child(), 50)).resolves.toBe(true);
  });

  it("still reports a genuine taskkill timeout", async () => {
    mocks.execFile.mockImplementation(() => ({} as ChildProcess));

    await expect(killCliTree(child(), 10)).resolves.toBe(false);
  });
});
