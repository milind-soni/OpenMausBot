import { describe, expect, it, vi } from "vitest";
import { VpsHostUnreachableError } from "./vps-command.ts";
import { vpsContainerExec } from "./vps-exec.ts";

const TARGET = { sshAlias: "my-vps", container: "openmausbot-vps-bot-abc" };

describe("vm_exec on a Self-hosted VPS desktop", () => {
  it("runs the command in the VPS container over the desktop's SSH connection", async () => {
    const runner = vi.fn().mockResolvedValue({ stdout: "hello\n", stderr: "" });
    await expect(vpsContainerExec(TARGET, "echo hello", { runner })).resolves.toEqual({ exitCode: 0, stdout: "hello\n", stderr: "", timedOut: false });
    const [args, options] = runner.mock.calls[0]!;
    expect(args.slice(0, 3)).toEqual(["-H", "ssh://my-vps", "exec"]);
    expect(args).toContain("openmausbot-vps-bot-abc");
    expect(args.slice(-7)).toEqual(["timeout", "-k", "5", "60", "sh", "-lc", "echo hello"]);
    expect(args).toEqual(expect.arrayContaining(["-u", "cua", "-w", "/home/cua/workspace"]));
    expect(options).toEqual({ timeoutMs: 80_000 });
  });

  it("returns a command's own failure as its exit code and output", async () => {
    const runner = vi.fn().mockRejectedValue(Object.assign(new Error("no such file"), { exitCode: 2, stdout: "", stderr: "no such file" }));
    await expect(vpsContainerExec(TARGET, "ls /missing", { runner })).resolves.toEqual({ exitCode: 2, stdout: "", stderr: "no such file", timedOut: false });
  });

  it("marks a command stopped by its time limit as timed out", async () => {
    const runner = vi.fn().mockRejectedValue(Object.assign(new Error("Docker-over-SSH exited 124"), { exitCode: 124, stdout: "", stderr: "" }));
    await expect(vpsContainerExec(TARGET, "sleep 999", { timeoutSeconds: 5, runner })).resolves.toMatchObject({ exitCode: 124, timedOut: true });
    expect(runner.mock.calls[0]![1]).toEqual({ timeoutMs: 25_000 });
  });

  it("reports a host it never reached as an error, not as the command's exit code", async () => {
    const runner = vi.fn().mockRejectedValue(Object.assign(new VpsHostUnreachableError("ssh: connect to host my-vps port 22: Connection refused"), { exitCode: 255 }));
    await expect(vpsContainerExec(TARGET, "true", { runner })).rejects.toMatchObject({ status: 502, message: expect.stringContaining("Connection refused") });
  });
});
