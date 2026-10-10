import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function runBridge(entrypoint: string, args: string[]) {
  return new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const childEnv: NodeJS.ProcessEnv = { ...process.env, NODE_NO_WARNINGS: "1" };
    delete childEnv.OMB_CONTROL_URL;
    delete childEnv.OMB_CONTROL_TOKEN;
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL(`./${entrypoint}`, import.meta.url)), ...args],
      { env: childEnv, stdio: ["pipe", "ignore", "pipe"] },
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
  it.each(["bad;alias", "-test-vm", ""])(
    "rejects an invalid SSH alias without starting the bridge: %j",
    async (alias) => {
      const result = await runBridge("existing-vm-mcp.ts", [alias]);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("invalid Existing VM SSH connection");
    },
  );
});
