import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", async () => ({
  ...(await vi.importActual<typeof import("node:child_process")>("node:child_process")),
  spawn: spawnMock,
}));

import { defaultRunner } from "./vps-computer.ts";
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
  beforeEach(() => {
    spawnMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
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
    });
  });

  it("turns stdin EPIPE into a rejected command instead of an unhandled error", async () => {
    const child = fakeChild();
    const result = defaultRunner(["build", "-"], { input: "Dockerfile" });

    child.stdin.emit("error", new Error("write EPIPE"));

    await expect(result).rejects.toThrow("Docker-over-SSH stdin failed: write EPIPE");
    child.emit("close", 1, null);
  });

  it("escalates a timed-out command from SIGTERM to SIGKILL", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const result = defaultRunner(["info"], { timeoutMs: 100 });
    const rejection = expect(result).rejects.toThrow("Docker-over-SSH command timed out");

    await vi.advanceTimersByTimeAsync(100);
    expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");

    // the WAN-sized grace window: ssh + docker get 5s to tear down cleanly
    await vi.advanceTimersByTimeAsync(5_000);
    await rejection;
    expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
  });
});
