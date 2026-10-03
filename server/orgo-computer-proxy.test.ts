import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createOrgoComputerProxy } from "./orgo-computer-proxy.ts";
import { ORGO_TOOLS, type OrgoLease } from "./orgo.ts";
import { createControlClient } from "./control-client.ts";

const lease: OrgoLease = { apiKey: "sk_fake_secret", workspaceId: "550e8400-e29b-41d4-a716-446655440000", computerId: "a3bb189e-8bf9-4888-9912-ace4e6543002", computerName: "openmausbot-orgo-123456789abc-123456789012345678901234" };
describe("Orgo per-turn MCP bridge", () => {
  it("exposes only leased computer operations, never provider credentials/lifecycle", () => {
    expect(ORGO_TOOLS.map((tool) => tool.name)).toEqual(["screenshot", "get_screen_size", "click", "move", "drag", "type_text", "key_press", "scroll", "open_url", "exec"]);
    expect(JSON.stringify(ORGO_TOOLS)).not.toMatch(/apiKey|vnc_password|provision|delete_computer/);
  });
  it("advertises flat provider-compatible schemas while retaining runtime argument validation", () => {
    expect(JSON.stringify(ORGO_TOOLS)).not.toMatch(/"(?:oneOf|anyOf|allOf|const|format|\$schema)":/);
    for (const tool of ORGO_TOOLS) expect(tool.inputSchema.type).toBe("object");
    expect(ORGO_TOOLS.find(tool => tool.name === "open_url")?.inputSchema.properties?.url).toMatchObject({ type: "string", pattern: /^https?:\/\//.source });
  });
  it("refuses actions when the turn control gate is absent, unavailable or held", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ held: true, helpOpen: false }), { status: 200 }));
    const control = createControlClient({ url: "http://127.0.0.1:1/control", token: "turn-capability", fetchImpl });
    expect(await createOrgoComputerProxy(lease, control).call("click", { x: 10, y: 20 })).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("NOT performed") }] });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    fetchImpl.mockImplementation(async () => new Response("expired", { status: 401 }));
    expect((await createOrgoComputerProxy(lease, control).call("exec", { command: "true" })).isError).toBe(true);
    const missing = createControlClient({ url: "", token: "", fetchImpl });
    expect(await createOrgoComputerProxy(lease, missing).call("screenshot", {})).toMatchObject({ isError: true, content: [{ text: "Orgo computer control gate missing" }] });
  });
  it("answers standard MCP initialization/list/ping without any network or secret output", () => {
    const requests = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "ping" },
    ];
    const result = spawnSync(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./orgo-computer-proxy.ts", import.meta.url))], {
      input: requests.map((r) => JSON.stringify(r)).join("\n") + "\n", encoding: "utf8", timeout: 10_000,
      env: { ...process.env, NODE_NO_WARNINGS: "1", ORGO_API_KEY: lease.apiKey },
    });
    expect(result.status).toBe(0);
    const responses = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
    expect(responses.map((response) => response.id)).toEqual([1, 2, 3]);
    expect(responses[0].result.serverInfo.name).toBe("openmausbot-orgo");
    expect(responses[1].result.tools.map((tool: { name: string }) => tool.name)).toContain("exec");
    expect(result.stdout + result.stderr).not.toContain(lease.apiKey);
  });
});
