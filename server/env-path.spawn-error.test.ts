import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

// Under descriptor pressure (EMFILE) spawn returns a child without stdout and reports the failure later through "error".
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn(() => {
      const child = Object.assign(new EventEmitter(), { stdout: null, pid: undefined });
      process.nextTick(() => child.emit("error", Object.assign(new Error("spawn EMFILE"), { code: "EMFILE" })));
      return child;
    }),
  };
});

const { augmentedPath, resetPathCacheForTests } = await import("./env-path.ts");
const { spawn } = await import("node:child_process");

describe("login-shell PATH probe when spawn fails", () => {
  it.skipIf(process.platform === "win32")("treats a spawn without stdout as a failed probe, not a crash", async () => {
    const saved = { SHELL: process.env.SHELL, VITEST: process.env.VITEST };
    try {
      process.env.SHELL = "/bin/sh";
      delete process.env.VITEST;
      resetPathCacheForTests();

      expect(() => augmentedPath()).not.toThrow();
      expect(spawn).toHaveBeenCalledTimes(1);
      await new Promise((resolve) => process.nextTick(resolve));
      expect(augmentedPath()).toBeTruthy();
    } finally {
      if (saved.SHELL === undefined) delete process.env.SHELL;
      else process.env.SHELL = saved.SHELL;
      if (saved.VITEST === undefined) delete process.env.VITEST;
      else process.env.VITEST = saved.VITEST;
      resetPathCacheForTests();
    }
  });
});
