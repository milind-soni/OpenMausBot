import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { workflowSchema } from "../../shared/skill-burger/format.ts";
import { containerExec, perBotLocalVmTarget } from "../container-computer.ts";
import { createExecutors, shellQuote, type ExecutorContext } from "./executors.ts";
import { startRun } from "./runner.ts";

const run = promisify(execFile);
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

type CommandRunner = (command: string) => Promise<{ stdout: string }>;

function harness(vm: (command: string, execute: CommandRunner) => ReturnType<ExecutorContext["internal"]>) {
  const cwd = mkdtempSync(join(tmpdir(), "burger-vm-fallback-"));
  roots.push(cwd);
  const attempts = join(cwd, "attempts.txt");
  const script = "require('node:fs').appendFileSync(process.argv[1], 'run\\n'); process.stdout.write('done');";
  const command = `${shellQuote(process.execPath)} -e ${shellQuote(script)} ${shellQuote(attempts)}`;
  const execute: CommandRunner = async (received) => {
    expect(received).toBe(command);
    return run(process.execPath, ["-e", script, attempts]);
  };
  const calls: string[] = [];
  const exec = createExecutors({
    botId: "b", cwd,
    async internal(_kind, path, body) {
      calls.push(path);
      if (path === "/api/internal/vm-exec") return vm((body as { command: string }).command, execute);
      const frame = body as { params: { name: string; arguments: { command: string } } };
      expect(path).toBe("/api/internal/computer/mcp");
      expect(frame.params.name).toBe("exec");
      const { stdout } = await execute(frame.params.arguments.command);
      return { ok: true, body: { result: { content: [{ type: "text", text: stdout }] } }, status: 200 };
    },
  });
  const workflow = workflowSchema.parse({
    version: 1, summary: "Run a command once", args: {}, steps: [
      { id: "s1", kind: "shell", label: "Run command", run: command, where: "vm" },
      { id: "s2", kind: "file", label: "Save receipt", path: "receipt.txt", content: { $step: "s1" } },
    ],
  });
  return {
    calls, attempts, receipt: join(cwd, "receipt.txt"),
    start: () => startRun({ name: "once", botId: "b", threadId: "t", sha256: "x", workflow }, { exec, events: { started() {}, ended() {} }, save() {} }),
  };
}

describe("a Skill Burger's VM command fallback", () => {
  it("does not repeat a command when the VM client fails after the command ran", async () => {
    const h = harness(async (command, execute) => {
      try {
        await containerExec(perBotLocalVmTarget("b"), command, {
          runtime: "docker",
          exec: async (_runtime, args) => {
            await execute(args.at(-1)!);
            throw Object.assign(new Error("the command client timed out"), { status: 502 });
          },
        });
        throw new Error("the VM client should have failed");
      } catch (error) {
        expect(error).toMatchObject({ status: 502 });
        return { ok: false, status: 502, body: { error: (error as Error).message } };
      }
    });
    const result = await h.start();
    expect(readFileSync(h.attempts, "utf8")).toBe("run\n");
    expect(result).toMatchObject({ ok: false, error: { type: "step_failed", step: "s1", message: expect.stringContaining("the command client timed out") } });
    expect(h.calls).toEqual(["/api/internal/vm-exec"]);
    expect(existsSync(h.receipt)).toBe(false);
  });

  it.each([
    "The Local VM is no longer available to this turn.",
    "You have no Local VM or Self-hosted VPS desktop in this turn, so there is nowhere to run a command.",
  ])("does not treat an unclassified 409 as permission to retry: %s", async (error) => {
    const h = harness(async () => ({ ok: false, status: 409, body: { error } }));
    expect(await h.start()).toMatchObject({ ok: false, error: { type: "step_failed", step: "s1", message: expect.stringContaining(error) } });
    expect(h.calls).toEqual(["/api/internal/vm-exec"]);
    expect(existsSync(h.attempts)).toBe(false);
    expect(existsSync(h.receipt)).toBe(false);
  });

  it("uses the cloud computer once when the server explicitly reports no VM for this turn", async () => {
    const h = harness(async () => ({ ok: false, status: 409, body: { code: "no_vm_for_turn", error: "No VM for this turn" } }));
    expect(await h.start()).toMatchObject({ ok: true, status: "ok" });
    expect(h.calls).toEqual(["/api/internal/vm-exec", "/api/internal/computer/mcp"]);
    expect(readFileSync(h.attempts, "utf8")).toBe("run\n");
    expect(readFileSync(h.receipt, "utf8")).toBe("done");
  });

  it("keeps a command's nonzero VM exit as a failure", async () => {
    const h = harness(async () => ({ ok: true, status: 200, body: { exitCode: 1, stderr: "command failed", stdout: "", timedOut: false } }));
    expect(await h.start()).toMatchObject({ ok: false, error: { type: "step_failed", step: "s1", message: expect.stringContaining("command failed") } });
    expect(h.calls).toEqual(["/api/internal/vm-exec"]);
    expect(existsSync(h.attempts)).toBe(false);
  });
});
