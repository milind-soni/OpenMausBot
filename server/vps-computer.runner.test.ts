import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock, stopMock, masterMock } = vi.hoisted(() => ({ spawnMock: vi.fn(), stopMock: vi.fn(), masterMock: vi.fn() }));

vi.mock("node:child_process", async () => ({
  ...(await vi.importActual<typeof import("node:child_process")>("node:child_process")),
  spawn: spawnMock,
}));
vi.mock("./procs.ts", async () => ({
  ...(await vi.importActual<typeof import("./procs.ts")>("./procs.ts")),
  killCliTree: stopMock,
}));
vi.mock("./vps-ssh.ts", async () => ({
  ...(await vi.importActual<typeof import("./vps-ssh.ts")>("./vps-ssh.ts")),
  ensureVpsSshMaster: masterMock,
}));

import { defaultRunner, dockerCliInstallCommand } from "./vps-computer.ts";
import { resolveCliSpawn } from "./env-path.ts";

type FakeChild = EventEmitter & {
  stdin: Writable;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
};

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new Writable({ write: (_chunk, _encoding, callback) => callback() });
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => true);
  spawnMock.mockReturnValue(child);
  return child;
}

describe("default VPS command runner", () => {
  let savedDockerHost: string | undefined;
  beforeEach(() => {
    spawnMock.mockReset();
    stopMock.mockReset().mockResolvedValue(true);
    masterMock.mockReset().mockResolvedValue(undefined);
    // These tests assert SSH-transport behavior; an inherited socket setting would reroute them.
    savedDockerHost = process.env.OMB_VPS_DOCKER_HOST;
    delete process.env.OMB_VPS_DOCKER_HOST;
  });

  afterEach(() => {
    vi.useRealTimers();
    if (savedDockerHost !== undefined) process.env.OMB_VPS_DOCKER_HOST = savedDockerHost;
    else delete process.env.OMB_VPS_DOCKER_HOST;
  });

  it("collects output and resolves after the child closes", async () => {
    const child = fakeChild();
    const result = defaultRunner(["info"], { input: "request" });

    child.stdout.write("out");
    child.stderr.write("err");
    child.emit("close", 0, null);

    await expect(result).resolves.toEqual({ stdout: "out", stderr: "err" });
    const resolved = resolveCliSpawn("docker", ["info"]);
    expect(spawnMock).toHaveBeenCalledWith(resolved.command, resolved.args, {
      shell: false,
      env: expect.objectContaining({ PATH: expect.any(String) }),
      stdio: ["pipe", "pipe", "pipe"],
      ...(process.platform === "win32" ? { windowsHide: true } : { detached: true }),
    });
  });

  it("turns stdin EPIPE into a rejected command instead of an unhandled error", async () => {
    const child = fakeChild();
    const result = defaultRunner(["build", "-"], { input: "Dockerfile" });

    child.stdin.emit("error", new Error("write EPIPE"));

    await expect(result).rejects.toThrow("Docker over SSH stdin failed: write EPIPE");
    expect(stopMock).toHaveBeenCalledWith(child, 5_000);
    expect(child.stdin.destroyed && child.stdout.destroyed && child.stderr.destroyed).toBe(true);
    child.emit("close", 1, null);
  });

  it("waits for owned-tree cleanup after timeout even when Docker closes first", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    let finishCleanup!: () => void;
    stopMock.mockReturnValue(new Promise<boolean>((resolve) => { finishCleanup = () => resolve(true); }));
    let settled = false;
    const result = defaultRunner(["info"], { timeoutMs: 100 });
    void result.then(() => { settled = true; }, () => { settled = true; });
    const rejection = expect(result).rejects.toThrow("Docker over SSH command timed out");

    await vi.advanceTimersByTimeAsync(100);
    expect(stopMock).toHaveBeenCalledWith(child, 5_000);
    child.emit("close", null, "SIGTERM");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(settled).toBe(false);
    finishCleanup();
    await rejection;
    expect(child.stdout.destroyed && child.stderr.destroyed).toBe(true);
  });

  it("holds the rejection briefly when tree termination is unconfirmed, so a retry cannot overlap the survivor", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    stopMock.mockResolvedValue(false);
    let settled = false;
    const result = defaultRunner(["info"], { timeoutMs: 100 });
    void result.then(() => { settled = true; }, () => { settled = true; });
    const rejection = expect(result).rejects.toThrow("Docker over SSH command timed out");

    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(4_900);
    expect(settled).toBe(false); // killCliTree answered false — the hold keeps the caller waiting
    await vi.advanceTimersByTimeAsync(200);
    await rejection;
    expect(child.stdout.destroyed && child.stderr.destroyed).toBe(true);
  });

  it("names the Docker CLI install line when the CLI is absent", async () => {
    const child = fakeChild();
    const result = defaultRunner(["info"]);
    child.emit("error", Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" }));
    const message = await result.catch((error: Error) => error.message);
    expect(message).toContain("Docker over SSH could not start: spawn docker ENOENT");
    expect(message).toContain(dockerCliInstallCommand(process.platform)!);
  });

  it("still runs Docker when the SSH warmup is rejected (a restricted key may allow only dial-stdio)", async () => {
    const child = fakeChild();
    spawnMock.mockImplementation(() => child);
    masterMock.mockRejectedValue(new Error("command not allowed"));
    const result = defaultRunner(["-H", "ssh://production-vps", "info"]);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled()); // let the warmup settle and spawn first
    child.stdout.end("ok");
    child.emit("close", 0, null);
    await expect(result).resolves.toEqual({ stdout: "ok", stderr: "" });
  });

  it("subtracts SSH warmup time from the Docker command budget", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    spawnMock.mockImplementation(() => child);
    stopMock.mockResolvedValue(true);
    masterMock.mockImplementation(async () => { await new Promise((resolve) => setTimeout(resolve, 40)); });
    let settled = false;
    const result = defaultRunner(["-H", "ssh://production-vps", "info"], { timeoutMs: 100 });
    void result.then(() => { settled = true; }, () => { settled = true; });
    const rejection = expect(result).rejects.toThrow("Docker over SSH command timed out");

    await vi.advanceTimersByTimeAsync(40); // warmup consumed 40ms of the budget
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(60); // exactly the remaining budget: the timer must fire
    await rejection;
    expect(settled).toBe(true);
  });

  it("abandons a stuck warmup after half the budget, so Docker still gets its turn", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    spawnMock.mockImplementation(() => child);
    // Simulate the real warmup's timeout: it rejects only once its own budget runs out.
    masterMock.mockImplementation(async (_ssh, _dest, ms: number) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      throw new Error("warmup timed out");
    });
    const result = defaultRunner(["-H", "ssh://production-vps", "info"], { timeoutMs: 100 });
    void result.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(49);
    expect(spawnMock).not.toHaveBeenCalled(); // still inside the warmup's half budget
    await vi.advanceTimersByTimeAsync(2);
    expect(spawnMock).toHaveBeenCalled(); // Docker spawned at the halfway mark, with time to spare
    child.stdout.end("ok");
    child.emit("close", 0, null);
    await expect(result).resolves.toEqual({ stdout: "ok", stderr: "" });
  });

  it.skipIf(process.platform === "win32").each(["timeout", "stdin"])("reaps real SSH-like grandchildren after %s without stopping an unrelated master", async (failure) => {
    const { spawn: realSpawn } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const { killCliTree: realStop } = await vi.importActual<typeof import("./procs.ts")>("./procs.ts");
    stopMock.mockImplementation(realStop);
    const idle = "setInterval(() => {}, 1000)";
    const helperCode = `process.on('SIGTERM', () => {}); console.log(process.pid); ${idle}`;
    const dockerCode = `const c = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(helperCode)}], { stdio: ['ignore', 'inherit', 'inherit'] }); ${idle}`;
    let docker!: ChildProcess;
    spawnMock.mockImplementation((_command, _args, options) => {
      docker = realSpawn(process.execPath, ["-e", dockerCode], options);
      return docker;
    });
    const master = realSpawn(process.execPath, ["-e", idle], { detached: true, stdio: "ignore" });
    const masterClosed = new Promise<void>((resolve) => master.once("close", () => resolve()));
    let helper = 0;
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const result = defaultRunner(["info"], { timeoutMs: failure === "timeout" ? 1_000 : 20_000 });
    const rejected = expect(result).rejects.toThrow(failure === "timeout" ? "command timed out" : "stdin failed");
    try {
      helper = Number(await new Promise<string>((resolve) => docker.stdout!.once("data", (chunk) => resolve(String(chunk).trim()))));
      expect(alive(helper)).toBe(true);
      if (failure === "stdin") docker.stdin!.emit("error", new Error("write EPIPE"));
      await rejected;
      expect(alive(helper)).toBe(false);
      expect(docker.exitCode !== null || docker.signalCode !== null).toBe(true);
      expect(docker.stdin!.destroyed && docker.stdout!.destroyed && docker.stderr!.destroyed).toBe(true);
      expect(alive(master.pid!)).toBe(true);
      spawnMock.mockImplementation((_command, _args, options) => realSpawn(process.execPath, ["-e", "console.log('recovered')"], options));
      await expect(defaultRunner(["info"], { timeoutMs: 2_000 })).resolves.toMatchObject({ stdout: "recovered\n" });
    } finally {
      await realStop(docker, 0);
      if (helper && alive(helper)) process.kill(helper, "SIGKILL");
      if (master.pid && alive(master.pid)) master.kill("SIGKILL");
      await masterClosed;
    }
  }, 15_000);
});
