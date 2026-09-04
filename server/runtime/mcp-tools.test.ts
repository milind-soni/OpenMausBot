// The MCP mount against a real stdio child: the fake server under
// server/testing, spawned per case. Every failure mode is a mode the fake
// supports, so nothing here depends on timing luck.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { MODEL_VISIBLE_RESULT_LIMIT, mountMcpServers, type McpServerSpec, type MountedMcp } from "./mcp-tools.ts";

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-mcp-server.ts");

const server = (env: Record<string, string> = {}): McpServerSpec => ({
  command: process.execPath,
  args: ["--experimental-strip-types", FAKE],
  env: { ...process.env as Record<string, string>, ...env },
});

let live: MountedMcp[] = [];
const mount = async (servers: Record<string, McpServerSpec>, options: Parameters<typeof mountMcpServers>[1] = { toolTimeoutMs: 5_000 }) => {
  const mounted = await mountMcpServers(servers, options);
  live.push(mounted);
  return mounted;
};

afterEach(async () => {
  await Promise.all(live.map((m) => m.close()));
  live = [];
});

describe("mountMcpServers", () => {
  it("starts a server, discovers its tools, and namespaces them by server", async () => {
    const mounted = await mount({ notes: server() });
    expect(mounted.failures.size).toBe(0);
    expect(mounted.tools.map((t) => t.name)).toEqual(["notes__read_notes"]);
    expect(mounted.routes.get("notes__read_notes")).toEqual({ server: "notes", tool: "read_notes" });
    expect(mounted.tools[0]!.parameters).toMatchObject({ type: "object", properties: { text: { type: "string" } } });
  });

  it("keeps two servers exposing the same tool name apart", async () => {
    const mounted = await mount({ a: server({ FAKE_MCP_TOOL_NAME: "search" }), b: server({ FAKE_MCP_TOOL_NAME: "search" }) });
    expect(mounted.tools.map((t) => t.name).sort()).toEqual(["a__search", "b__search"]);
    expect(mounted.routes.get("a__search")).toEqual({ server: "a", tool: "search" });
    expect(mounted.routes.get("b__search")).toEqual({ server: "b", tool: "search" });
  });

  it("calls a tool and returns its text", async () => {
    const mounted = await mount({ notes: server() });
    const result = await mounted.tools[0]!.execute("c1", { text: "hello" }, new AbortController().signal);
    expect(result).toMatchObject({ ok: true, text: "echoed: hello", observation: { name: "notes__read_notes", ok: true } });
  });

  it("reports a tool's own error as ok:false, not as a thrown failure", async () => {
    const mounted = await mount({ notes: server({ FAKE_MCP_MODE: "error" }) });
    const result = await mounted.tools[0]!.execute("c1", { text: "x" }, new AbortController().signal);
    expect(result.ok).toBe(false);
    expect(result.text).toContain("simulated tool failure");
  });

  it("records a server that speaks garbage and mounts its healthy sibling anyway", async () => {
    const mounted = await mount({ bad: server({ FAKE_MCP_MODE: "malformed" }), good: server() }, { toolTimeoutMs: 5_000, startupTimeoutMs: 3_000 });
    expect(mounted.failures.has("bad")).toBe(true);
    expect(mounted.tools.map((t) => t.name)).toEqual(["good__read_notes"]);
  });

  it("gives up on a server that never answers the handshake, on the startup timeout", async () => {
    const started = Date.now();
    const mounted = await mount({ mute: server({ FAKE_MCP_MODE: "silent" }) }, { toolTimeoutMs: 5_000, startupTimeoutMs: 500 });
    expect(mounted.failures.has("mute")).toBe(true);
    expect(mounted.tools).toHaveLength(0);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("does not hang on a server that exits right after the handshake", async () => {
    const mounted = await mount({ flaky: server({ FAKE_MCP_MODE: "exit-after-init" }) }, { toolTimeoutMs: 5_000, startupTimeoutMs: 2_000 });
    // either it listed before dying or it was recorded as failed — never a hang
    expect(mounted.failures.has("flaky") || mounted.tools.length === 1).toBe(true);
  });

  it("times out a tool call that takes too long", async () => {
    const mounted = await mount({ slow: server({ FAKE_MCP_MODE: "slow", FAKE_MCP_DELAY_MS: "3000" }) }, { toolTimeoutMs: 300 });
    await expect(mounted.tools[0]!.execute("c1", { text: "x" }, new AbortController().signal)).rejects.toThrow();
  });

  it("cancels a tool call when the signal aborts", async () => {
    const mounted = await mount({ slow: server({ FAKE_MCP_MODE: "slow", FAKE_MCP_DELAY_MS: "3000" }) }, { toolTimeoutMs: 10_000 });
    const abort = new AbortController();
    const call = mounted.tools[0]!.execute("c1", { text: "x" }, abort.signal);
    abort.abort();
    await expect(call).rejects.toThrow();
  });

  it("bounds what the model sees from a huge result", async () => {
    const mounted = await mount({ notes: server() });
    const text = "y".repeat(MODEL_VISIBLE_RESULT_LIMIT * 2);
    const result = await mounted.tools[0]!.execute("c1", { text }, new AbortController().signal);
    expect(result.text.length).toBeLessThanOrEqual(MODEL_VISIBLE_RESULT_LIMIT + 20);
    expect(result.text.endsWith("[truncated]")).toBe(true);
  });

  it("mounts several servers concurrently", async () => {
    const started = Date.now();
    const mounted = await mount({ a: server(), b: server(), c: server() });
    expect(mounted.tools).toHaveLength(3);
    // three sequential 20s startup budgets would be 60s; concurrent is one
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("closes idempotently", async () => {
    const mounted = await mount({ notes: server() });
    await mounted.close();
    await expect(mounted.close()).resolves.toBeUndefined();
  });
});
