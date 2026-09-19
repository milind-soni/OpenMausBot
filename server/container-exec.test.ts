// containerExec: one shell command in a Local VM, as text, with a real time limit.
import { describe, expect, it } from "vitest";
import { clipExecOutput, containerExec, perBotLocalVmTarget } from "./container-computer.ts";

const target = perBotLocalVmTarget("bot-under-test");

function fakeExec(result: { stdout?: string; stderr?: string; code?: number } = {}) {
  const calls: Array<{ command: string; args: string[]; timeout: number }> = [];
  const exec = async (command: string, args: string[], options: { timeout: number }) => {
    calls.push({ command, args, timeout: options.timeout });
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: result.code ?? 0 };
  };
  return { calls, exec };
}

describe("containerExec", () => {
  it("runs as the desktop user in the durable workspace, with the limit enforced inside the container", async () => {
    const { calls, exec } = fakeExec({ stdout: "hello\n" });
    const result = await containerExec(target, "echo hello", { runtime: "podman", exec, timeoutSeconds: 30 });
    expect(result).toEqual({ exitCode: 0, stdout: "hello\n", stderr: "", timedOut: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe("podman");
    expect(calls[0]!.args).toEqual([
      "exec", "-u", "cua", "-w", "/home/cua/workspace", "-e", "HOME=/home/cua", "-e", "DISPLAY=:1",
      target.containerName, "timeout", "-k", "5", "30", "sh", "-lc", "echo hello",
    ]);
    // The client waits a little longer than the in-container limit.
    expect(calls[0]!.timeout).toBe(50_000);
  });

  it("returns a failing command's exit code and stderr instead of throwing", async () => {
    const { exec } = fakeExec({ stderr: "ModuleNotFoundError: No module named 'reportlab'\n", code: 1 });
    expect(await containerExec(target, "python3 make.py", { runtime: "docker", exec })).toMatchObject({
      exitCode: 1,
      stderr: "ModuleNotFoundError: No module named 'reportlab'\n",
      timedOut: false,
    });
  });

  it("reports a stopped command as timed out", async () => {
    for (const code of [124, 137]) {
      const { exec } = fakeExec({ code });
      expect(await containerExec(target, "sleep 999", { runtime: "podman", exec, timeoutSeconds: 1 })).toMatchObject({ timedOut: true, exitCode: code });
    }
  });

  it("bounds the time limit and rejects an empty or oversized command", async () => {
    const { calls, exec } = fakeExec();
    await containerExec(target, "true", { runtime: "podman", exec, timeoutSeconds: 99_999 });
    await containerExec(target, "true", { runtime: "podman", exec, timeoutSeconds: -5 });
    expect(calls.map((call) => call.args[calls[0]!.args.indexOf("-k") + 2])).toEqual(["300", "1"]);
    await expect(containerExec(target, "   ", { runtime: "podman", exec })).rejects.toMatchObject({ status: 400 });
    await expect(containerExec(target, "x".repeat(20_001), { runtime: "podman", exec })).rejects.toMatchObject({ status: 400 });
    expect(calls).toHaveLength(2);
  });

  it("keeps the start and the end of a long output, where the error usually is", () => {
    const long = `START${"x".repeat(50_000)}END`;
    const clipped = clipExecOutput(long);
    expect(clipped.length).toBeLessThan(20_100);
    expect(clipped.startsWith("START")).toBe(true);
    expect(clipped.endsWith("END")).toBe(true);
    expect(clipped).toContain("characters omitted");
    expect(clipExecOutput("short")).toBe("short");
  });
});
