import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { execFile, spawn } = vi.hoisted(() => ({ execFile: vi.fn(), spawn: vi.fn() }));
vi.mock("node:child_process", async (original) => ({ ...await original<typeof import("node:child_process")>(), execFile, spawn }));

import { refreshTailnetName } from "../companion/src/listener.ts";
import { sh } from "./container-computer.ts";
import { StdioMcp } from "./drivers/pi-mcp-extension.ts";
import { rescueFirefoxProfile } from "./local-vm-profiles.ts";
import { runLivenessProbe, runMcpBridge } from "./mcp-bridge.ts";
import { tailscaleStatus } from "./tailscale.ts";

const fakeChild = () => Object.assign(new EventEmitter(), {
  stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
});
const optionsOfLast = (mock: typeof execFile | typeof spawn) => {
  const options = mock.mock.lastCall?.find((argument: unknown) => typeof argument === "object" && argument !== null && !Array.isArray(argument));
  return options as { windowsHide?: boolean } | undefined;
};

// The desktop server runs without a console, so Windows opens one for any console program started without this flag.
describe("programs started in the background on Windows", () => {
  beforeEach(() => {
    execFile.mockReset().mockImplementation((...args: unknown[]) => {
      (args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void)(null, "", "");
      return fakeChild();
    });
    spawn.mockReset().mockImplementation(() => {
      const child = fakeChild();
      queueMicrotask(() => { child.emit("exit", 0, null); child.emit("close", 0, null); });
      return child;
    });
  });

  it("hides a Docker or Podman check", async () => {
    await sh("docker", ["info"]);
    expect(optionsOfLast(execFile)?.windowsHide).toBe(true);
  });

  it("hides a copy out of a private desktop's container", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "omb-windows-hide-"));
    try {
      // The mocked copy leaves nothing behind, which the rescue then reports; only how it started matters here.
      await rescueFirefoxProfile("docker", { containerName: "omb-vm", workspaceDir } as Parameters<typeof rescueFirefoxProfile>[1]).catch(() => {});
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
    expect(execFile).toHaveBeenCalled();
    expect(optionsOfLast(execFile)?.windowsHide).toBe(true);
  });

  it("hides Tailscale, on the server and in the companion", async () => {
    await tailscaleStatus();
    expect(execFile).toHaveBeenCalled();
    expect(optionsOfLast(execFile)?.windowsHide).toBe(true);
    execFile.mockClear();
    await refreshTailnetName();
    expect(execFile).toHaveBeenCalled();
    expect(optionsOfLast(execFile)?.windowsHide).toBe(true);
  });

  it("hides a liveness probe and the MCP server behind the bridge", async () => {
    await runLivenessProbe({ command: "probe", args: [] });
    expect(optionsOfLast(spawn)?.windowsHide).toBe(true);
    const server = fakeChild();
    spawn.mockClear().mockImplementationOnce(() => server);
    const exitCode = process.exitCode;
    runMcpBridge({ command: "server", args: [], label: "test" });
    expect(optionsOfLast(spawn)?.windowsHide).toBe(true);
    // The bridge holds this process's stdin until its server is gone.
    server.emit("exit", 0, null);
    server.emit("close", 0, null);
    process.exitCode = exitCode;
  });

  it("hides an MCP server a Pi bot starts", () => {
    spawn.mockImplementationOnce(fakeChild);
    new StdioMcp({ command: "server", args: [] } as ConstructorParameters<typeof StdioMcp>[0]);
    expect(optionsOfLast(spawn)?.windowsHide).toBe(true);
  });
});
