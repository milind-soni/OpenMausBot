import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawned: Array<{ command: string; options: Record<string, unknown> }> = [];

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (command: string, _args: string[], options: Record<string, unknown>) => {
      spawned.push({ command, options });
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: () => true,
      });
      queueMicrotask(() => child.emit("close", 0));
      return child;
    },
  };
});

const { runLivenessProbe, spawnBridgeChild } = await import("./mcp-bridge.ts");

afterEach(() => { spawned.length = 0; });

describe("bridge child processes", () => {
  it("starts a console child (docker, podman) without a terminal window on Windows", () => {
    spawnBridgeChild("docker", ["exec", "-i", "omb-vm"], { PATH: "" }, true);
    expect(spawned).toEqual([{ command: "docker", options: expect.objectContaining({ shell: false, windowsHide: true }) }]);
  });

  it("leaves other children (the local desktop driver) as they start today", () => {
    spawnBridgeChild("cua-driver", ["mcp"], { PATH: "" }, false);
    expect(spawned).toEqual([{ command: "cua-driver", options: expect.objectContaining({ windowsHide: false }) }]);
  });

  it("starts the liveness probe without a console window", async () => {
    await expect(runLivenessProbe({ command: "docker", args: ["exec", "omb-vm", "true"] }, 1_000, { PATH: "" })).resolves.toBe(true);
    expect(spawned).toEqual([{ command: "docker", options: expect.objectContaining({ shell: false, windowsHide: true }) }]);
  });
});
