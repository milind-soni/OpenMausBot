import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function runBridge(
  entrypoint: string,
  args: string[],
  env: { OMB_CONTROL_URL?: string; OMB_CONTROL_TOKEN?: string },
) {
  return new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const childEnv: NodeJS.ProcessEnv = { ...process.env, NODE_NO_WARNINGS: "1" };
    delete childEnv.OMB_CONTROL_URL;
    delete childEnv.OMB_CONTROL_TOKEN;
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL(`./${entrypoint}`, import.meta.url)), ...args],
      { env: { ...childEnv, ...env }, stdio: ["pipe", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr }));
    child.stdin.on("error", () => {});
    child.stdin.end();
  });
}

describe("Existing VM MCP bridge", () => {
  it.each([
    {
      entrypoint: "existing-vm-mcp.ts",
      args: ["test-vm"],
      label: "Existing VM",
    },
    {
      entrypoint: "container-mcp.ts",
      args: ["docker", "openmausbot-computer", "/run/user/1000/openmausbot-cua.sock"],
      label: "Local VM",
    },
    {
      entrypoint: "vps-container-mcp.ts",
      args: ["test-vps", "openmausbot-computer"],
      label: "VPS",
    },
  ])("rejects partial control configuration for $label", async ({ entrypoint, args, label }) => {
    const result = await runBridge(entrypoint, args, { OMB_CONTROL_URL: "http://127.0.0.1:1/control" });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(`incomplete ${label} control configuration`);
  });
});
