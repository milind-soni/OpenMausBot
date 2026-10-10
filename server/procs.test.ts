import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

describe("spawn ENOENT", () => {
  const enoent = () => Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" });

  it("names a missing working folder instead of blaming the install (MOCA-309)", () => {
    const missing = join(mkdtempSync(join(tmpdir(), "omb-procs-")), "deleted-project");
    expect(describeSpawnFailure(enoent(), "/home/u/.openmausbot/tools/npm/bin/codex", missing)).toEqual({
      message: `This chat's working folder no longer exists: ${missing}. Choose another folder in the bot's settings, or create it again.`,
      setup: false,
    });
  });

  it("still reports a missing CLI when the working folder exists", () => {
    const failure = describeSpawnFailure(enoent(), "codex", tmpdir());
    expect(failure).toEqual({ message: "`codex` isn't installed, or isn't on this app's PATH", setup: true });
    expect(describeSpawnFailure(enoent(), "codex")).toEqual(failure);
  });

  it("really is what node reports for a missing cwd", async () => {
    const missing = join(mkdtempSync(join(tmpdir(), "omb-procs-")), "gone");
    const error = await new Promise<NodeJS.ErrnoException>((resolve) => {
      spawn(process.execPath, ["--version"], { cwd: missing }).once("error", resolve);
    });
    expect(error.code).toBe("ENOENT");
    expect(describeSpawnFailure(error, process.execPath, missing).setup).toBe(false);
  });
});
