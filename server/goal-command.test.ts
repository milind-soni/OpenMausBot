import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GoalCommandAdapter,
  configuredGoalControlPath,
  goalPythonExecutable,
  parseGoalCommand,
  writeGoalInput,
} from "./goal-command.ts";

const context = { botId: "ada", threadId: "thread-1", model: "model-1", cwd: tmpdir() };

describe("OpenMaus /goal adapter", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("parses attended goal commands without treating ordinary slashes as goals", () => {
    expect(parseGoalCommand("/goals no")).toBeNull();
    expect(parseGoalCommand("/goal")).toEqual({ action: "show" });
    expect(parseGoalCommand("/goal replace Finish the iOS app")).toEqual({
      action: "set",
      objective: "Finish the iOS app",
      replace: true,
    });
    expect(() => parseGoalCommand("/goal pause later")).toThrow(
      "/goal pause does not accept extra arguments",
    );
  });

  it("shows before mutation and identifies the OpenMaus lane", async () => {
    const calls: Array<{ args: string[]; input?: string }> = [];
    const adapter = new GoalCommandAdapter({
      run: async (args, options) => {
        calls.push({ args, input: options.input });
        return {
          exitCode: 0,
          stdout: JSON.stringify({ goal_id: "goal-1234567890abcdef12345678", objective: "Finish it", status: "ACTIVE" }),
          stderr: "",
        };
      },
    });
    const outcome = await adapter.execute("/goal Finish it", context);
    expect(outcome).toMatchObject({ ok: true, status: 200 });
    expect(calls[0]?.args).toEqual(["show"]);
    expect(calls[1]?.args.slice(calls[1]!.args.indexOf("--surface"), calls[1]!.args.indexOf("--surface") + 2)).toEqual([
      "--surface",
      "codex",
    ]);
    expect(calls[1]?.args).toContain("openmaus-ada");
    expect(calls[1]?.input).toBe("Finish it");
  });

  it("requires an existing absolute proof before completing", async () => {
    const root = mkdtempSync(join(tmpdir(), "omb-goal-proof-"));
    const proof = join(root, "receipt.json");
    writeFileSync(proof, "{}\n");
    const calls: string[][] = [];
    const adapter = new GoalCommandAdapter({
      run: async (args) => {
        calls.push(args);
        return { exitCode: 0, stdout: JSON.stringify({ goal_id: "goal-1", status: "COMPLETE" }), stderr: "" };
      },
    });
    expect((await adapter.execute(`/goal done --proof ${proof}`, context))?.ok).toBe(true);
    expect(calls.at(-1)).toEqual(["complete", "--proof", proof]);
    expect((await adapter.execute("/goal done --proof relative.json", context))?.response).toContain("absolute file path");
  });

  it("never starts an unattended continuation loop", async () => {
    const adapter = new GoalCommandAdapter({
      run: async () => ({ exitCode: 0, stdout: "{}", stderr: "" }),
    });
    const outcome = await adapter.execute("/goal status", context);
    expect(outcome?.response).toBe("No shared goal is active.");
  });

  it("stays disabled until the host configures the shared goal script", async () => {
    vi.stubEnv("OMB_GOAL_CONTROL_PATH", "");
    const adapter = new GoalCommandAdapter();
    const outcome = await adapter.execute("/goal status", context);
    expect(outcome).toMatchObject({
      ok: false,
      status: 409,
      response: "Shared goal command is not configured. Set OMB_GOAL_CONTROL_PATH on this host.",
    });
  });

  it("resolves Python through host configuration or the platform PATH", () => {
    expect(goalPythonExecutable({ OMB_PYTHON: "  custom-python  " }, "linux")).toBe("custom-python");
    expect(goalPythonExecutable({}, "win32")).toBe("python");
    expect(goalPythonExecutable({}, "darwin")).toBe("python3");
  });

  it("preserves the explicit host goal-control path without shipping a fallback", () => {
    expect(configuredGoalControlPath({ OMB_GOAL_CONTROL_PATH: "  C:\\fleet\\goal.py  " })).toBe("C:\\fleet\\goal.py");
    expect(configuredGoalControlPath({})).toBeNull();
  });

  it("handles stdin errors before writing a goal objective", () => {
    const writes: Array<{ input: string; errorListeners: number }> = [];
    const stdin = new Writable({
      write(input, _encoding, callback) {
        writes.push({ input: input.toString(), errorListeners: this.listenerCount("error") });
        this.emit("error", new Error("EPIPE"));
        callback();
      },
    });

    expect(() => writeGoalInput(stdin, "Finish it")).not.toThrow();
    expect(writes).toEqual([{ input: "Finish it", errorListeners: 1 }]);
  });

  it("does not expose unexpected runner failure paths", async () => {
    const adapter = new GoalCommandAdapter({
      run: async () => {
        throw new Error("spawn failed at /Users/developer/private/goal.py");
      },
    });
    const outcome = await adapter.execute("/goal status", context);
    expect(outcome?.response).toBe("Shared goal command failed.");
    expect(outcome?.response).not.toContain("/Users/");
  });

  it("does not expose control-script paths from structured failures", async () => {
    const adapter = new GoalCommandAdapter({
      run: async () => ({
        exitCode: 1,
        stdout: "",
        stderr: JSON.stringify({ status: "blocked", error: "unable_to_load:/Users/developer/private/goal.py" }),
      }),
    });
    const outcome = await adapter.execute("/goal status", context);
    expect(outcome?.response).toBe("Shared goal command was blocked: goal authority rejected the request.");
    expect(outcome?.response).not.toContain("/Users/");
  });
});
