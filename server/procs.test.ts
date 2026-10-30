import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { hostTimeout } from "./testing/host-timeout.ts";
import {
  assertSafeCliArgv,
  cliVersionReader,
  describeSpawnFailure,
  estimatedWindowsCommandLineChars,
  execCli,
  killCliTree,
  spawnCli,
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

describe("execCli timeout", () => {
  it.skipIf(process.platform === "win32")("calls back when the CLI traps SIGTERM and outlives its timeout", async () => {
    const started = Date.now();
    const err = await new Promise<Error | null>((resolve) => {
      execCli(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { timeout: hostTimeout(2_000) }, (error) => resolve(error));
    });
    // Without the escalation a child that trapped SIGTERM would hold this callback past the test's own timeout.
    expect(err).toMatchObject({ killed: true });
    expect(Date.now() - started).toBeLessThan(hostTimeout(15_000));
  }, hostTimeout(20_000));
});

describe("out of memory", () => {
  it.runIf(process.platform === "linux")("a bot's engine is the first the kernel stops, and anything else keeps its score", async () => {
    const forever = ["-e", "setInterval(() => {}, 1000)"];
    const engine = spawnCli(process.execPath, forever, { stdio: ["pipe", "pipe", "pipe"] }, "bot");
    const other = spawnCli(process.execPath, forever, { stdio: ["pipe", "pipe", "pipe"] });
    try {
      expect(readFileSync(`/proc/${engine.pid}/oom_score_adj`, "utf8").trim()).toBe("1000");
      expect(readFileSync(`/proc/${other.pid}/oom_score_adj`, "utf8").trim()).toBe(readFileSync("/proc/self/oom_score_adj", "utf8").trim());
    } finally {
      await Promise.all([killCliTree(engine), killCliTree(other)]);
    }
  });
});

describe("CLI version probes", () => {
  it("keeps the last version through a timed-out probe and names the timeout without one", async () => {
    const timedOut = await new Promise<Error | null>((resolve) => {
      execCli(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeout: 200 }, (error) => resolve(error));
    });
    expect(cliVersionReader("claude")(timedOut, "")).toEqual({ reason: expect.stringContaining("took longer than 8 seconds") });
    const read = cliVersionReader("claude");
    expect(read(null, " 2.1.302\n")).toEqual({ version: "2.1.302" });
    expect(read(timedOut, "")).toEqual({ version: "2.1.302" });
    const trapped = await new Promise<Error | null>((resolve) => {
      execCli(process.execPath, ["-e", "process.on('SIGTERM', () => process.exit(1)); setInterval(() => {}, 1000)"], { timeout: 200 }, (error) => resolve(error));
    });
    expect(read(trapped, "")).toEqual({ version: "2.1.302" });
    expect(read(Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }), "")).toEqual({ reason: "`claude` CLI not found" });
  }, hostTimeout(20_000));
});
