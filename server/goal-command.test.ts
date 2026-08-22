import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { GoalCommandAdapter, parseGoalCommand } from "./goal-command.ts";

const context = { botId: "ada", threadId: "thread-1", model: "model-1", cwd: tmpdir() };

describe("OpenMaus /goal adapter", () => {
  it("parses attended goal commands without treating ordinary slashes as goals", () => {
    expect(parseGoalCommand("/goals no")).toBeNull();
    expect(parseGoalCommand("/goal")).toEqual({ action: "show" });
    expect(parseGoalCommand("/goal replace Finish the iOS app")).toEqual({
      action: "set",
      objective: "Finish the iOS app",
      replace: true,
    });
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

  it("fails missing portable goal controls without leaking paths or crashing on stdin", async () => {
    const missing = join(tmpdir(), "omb-missing-goal-control", "aos_goal_control.py");
    const adapter = new GoalCommandAdapter({ scriptPath: missing });
    const outcome = await adapter.execute("/goal Keep the bounded objective", context);
    expect(outcome).toMatchObject({ handled: true, ok: false, status: 409 });
    expect(outcome?.response).not.toContain(missing);
    expect(outcome?.response).not.toContain("/Users/gus/Desktop");
  });
});
