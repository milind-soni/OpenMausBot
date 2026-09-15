import { describe, expect, it } from "vitest";

import {
  assertSafeCliArgv,
  describeSpawnFailure,
  estimatedWindowsCommandLineChars,
  WINDOWS_SAFE_COMMAND_LINE_CHARS,
} from "./procs.ts";

describe("Windows CLI argument safety", () => {
  it("accepts ordinary launches", () => {
    const resolved = { command: "agy.exe", args: ["--model", "gemini-3.1-pro-high"] };
    expect(estimatedWindowsCommandLineChars(resolved)).toBeLessThan(WINDOWS_SAFE_COMMAND_LINE_CHARS);
    expect(() => assertSafeCliArgv(resolved, "win32")).not.toThrow();
  });

  it("rejects a prompt-sized argv before CreateProcess can fail opaquely", () => {
    const resolved = { command: "agy.exe", args: ["--print", "x".repeat(40_000)] };
    expect(() => assertSafeCliArgv(resolved, "win32")).toThrow(
      /pass large prompts through stdin or a file/,
    );
    try {
      assertSafeCliArgv(resolved, "win32");
    } catch (error) {
      expect((error as NodeJS.ErrnoException).code).toBe("ENAMETOOLONG");
    }
  });

  it("does not impose the Windows limit on other platforms", () => {
    const resolved = { command: "agy", args: ["--print", "x".repeat(40_000)] };
    expect(() => assertSafeCliArgv(resolved, "linux")).not.toThrow();
  });

  it("turns ENAMETOOLONG into an actionable message without echoing argv", () => {
    const error = Object.assign(new Error("private prompt contents"), { code: "ENAMETOOLONG" });
    const failure = describeSpawnFailure(error, "agy");
    expect(failure).toEqual({
      message: "`agy` received too much launch data for Windows; update this provider or pass its prompt through stdin/a file",
      setup: false,
    });
    expect(failure.message).not.toContain("private prompt contents");
  });
});

describe("spawnCli process fuse", () => {
  it("refuses to spawn past the process cap with a typed error, and frees the slot when a child exits", async () => {
    const { setProcessCap, spawnCli, liveCliCount } = await import("./procs.ts");
    setProcessCap(2);
    const hold = () => spawnCli(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { stdio: ["pipe", "pipe", "pipe"] });
    const a = hold();
    const b = hold();
    try {
      expect(liveCliCount()).toBe(2);
      expect(() => hold()).toThrow(expect.objectContaining({ code: "launch_process_cap" }));
      a.kill();
      await new Promise((resolve) => a.once("close", resolve));
      expect(liveCliCount()).toBe(1);
      const c = hold();
      c.kill();
      await new Promise((resolve) => c.once("close", resolve));
    } finally {
      b.kill();
      await new Promise((resolve) => b.once("close", resolve));
      setProcessCap(null);
    }
  }, 15_000);
});
