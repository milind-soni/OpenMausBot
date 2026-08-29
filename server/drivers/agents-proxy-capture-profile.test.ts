import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PROXY = join(dirname(fileURLToPath(import.meta.url)), "agents-proxy.ts");
let child: ReturnType<typeof spawn>;
const pending = new Map<number, (message: any) => void>();
let nextId = 1;

function rpc(method: string, params?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${method} timed out`));
    }, 5_000).unref?.();
  });
}

beforeAll(() => {
  child = spawn(process.execPath, [PROXY], {
    env: { ...process.env, OMB_AGENTS_TOOL_PROFILE: "capture" },
    stdio: ["pipe", "pipe", "inherit"],
  });
  let buffer = "";
  child.stdout!.on("data", (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim()) {
        const message = JSON.parse(line);
        pending.get(message.id)?.(message);
        pending.delete(message.id);
      }
      newline = buffer.indexOf("\n");
    }
  });
});

afterAll(() => child?.kill());

describe("agents-proxy delegated Capture profile", () => {
  it("exposes the durable capture surface without recursive coordination tools", async () => {
    await rpc("initialize", { protocolVersion: "2024-11-05" });
    const response = await rpc("tools/list");
    const names = response.result.tools.map((tool: { name: string }) => tool.name);

    expect(names).toContain("capture_begin");
    expect(names).toContain("capture_status");
    expect(names).toContain("capture_finish");
    expect(names).toContain("capture_read_browser_receipts");
    expect(names).toContain("capture_world_assert");
    expect(names).toContain("world_model_resolve");
    expect(names).toContain("record_task_evidence");
    expect(names).not.toContain("ask_bot");
    expect(names).not.toContain("delegate_bot");
    expect(names).not.toContain("create_bot");
    expect(names).not.toContain("request_credential");
  });
});
