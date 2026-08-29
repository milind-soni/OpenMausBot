import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { createWindowsCuaRuntime } from "./cua-windows-runtime.cjs";

function fakeChild(pid = 4321) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.stdin = {
    end: vi.fn(() => {
      child.exitCode = 0;
      queueMicrotask(() => child.emit("exit", 0, null));
    }),
  };
  child.kill = vi.fn();
  return child;
}

describe("Windows CUA runtime", () => {
  it("owns a private daemon without creating a visible Windows console", async () => {
    const child = fakeChild();
    const spawnProcess = vi.fn(() => child);
    const probe = vi.fn(async (_socketPath, expected) => ({
      pid: expected.childPid,
      driver_version: "0.22.1",
      contract_version: "0.7.0",
      tools_list_schema_version: "1",
      capability_version: "1",
      mcp_protocol_version: "2025-06-18",
      embedded: true,
      host_bundle_id: "com.openmausbot.app",
    }));
    const runtime = createWindowsCuaRuntime({
      spawnProcess,
      probe,
      identifier: () => "12345678-1234-1234-1234-123456789abc",
      processId: 31337,
      env: {
        SystemRoot: "C:\\Windows",
        TEMP: "C:\\Temp",
        OPENAI_API_KEY: "must-not-leak",
      },
    });

    const connection = await runtime.start("C:\\OpenMausBot\\cua-driver.exe");

    expect(spawnProcess).toHaveBeenCalledWith(
      "C:\\OpenMausBot\\cua-driver.exe",
      [
        "serve",
        "--embedded",
        "--parent-liveness-stdio",
        "--no-permissions-gate",
        "--socket",
        "\\\\.\\pipe\\cua-31337-123456781234",
        "--host-bundle-id",
        "com.openmausbot.app",
        "--permission-mode",
        "standard",
        "--grant",
        "existing-profile",
      ],
      expect.objectContaining({
        shell: false,
        stdio: ["pipe", "ignore", "ignore"],
        windowsHide: true,
      }),
    );
    const spawnEnvironment = spawnProcess.mock.calls[0][2].env;
    expect(spawnEnvironment).toMatchObject({
      SystemRoot: "C:\\Windows",
      TEMP: "C:\\Temp",
      CUA_DRIVER_RS_TELEMETRY_ENABLED: "0",
      CUA_DRIVER_RS_UPDATE_CHECK: "false",
    });
    expect(spawnEnvironment.OPENAI_API_KEY).toBeUndefined();
    expect(probe).toHaveBeenCalledWith("\\\\.\\pipe\\cua-31337-123456781234", {
      childPid: 4321,
      timeoutMs: 10_000,
    });
    expect(connection).toEqual({
      mode: "embedded",
      socketPath: "\\\\.\\pipe\\cua-31337-123456781234",
      generation: "12345678-1234-1234-1234-123456789abc",
      mcpCommand: "C:\\OpenMausBot\\cua-driver.exe",
      mcpArgs: [
        "mcp",
        "--embedded",
        "--socket",
        "\\\\.\\pipe\\cua-31337-123456781234",
        "--host-bundle-id",
        "com.openmausbot.app",
      ],
      mcpEnv: { CUA_DRIVER_RS_TELEMETRY_ENABLED: "0" },
    });

    await runtime.stop();
    expect(child.stdin.end).toHaveBeenCalledOnce();
  });
});
