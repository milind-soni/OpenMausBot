// The probe itself, and (with OMB_ANTIGRAVITY_CLI_PROBE naming a native Antigravity CLI executable) what the real CLI
// shows its model: one budget for all of a session's tools, no limit for one tool.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { gateServer } from "../mcp-gate-config.ts";
import { definitionBytes } from "../tool-list-budget.ts";
import { readRecordedToolList, TOOL_LIST_RECORD_ENV, TOOL_LIST_SHARE_ENV } from "../tool-list-share.ts";
import { probeAntigravityCli, serveProbeMcp, toolOfBytes, type ProbeTool } from "./antigravity-cli-probe.ts";
import { workspaceAppsLikeCatalog } from "./workspace-apps-like-catalog.ts";

const REAL_CLI = process.env.OMB_ANTIGRAVITY_CLI_PROBE;

describe("the Antigravity CLI probe", () => {
  it("makes tools of exactly the definition size asked for", () => {
    for (const bytes of [200, 944, 965, 4_000, 56_000]) expect(definitionBytes(toolOfBytes("t", bytes))).toBe(bytes);
    expect(definitionBytes(toolOfBytes("t", 900, 5))).toBe(900);
    expect(() => toolOfBytes("t", 10)).toThrow();
  });

  it("serves each probe server's tools over MCP by its own path", async () => {
    const tools = [toolOfBytes("a", 300), toolOfBytes("b", 400)];
    const servers = await serveProbeMcp({ probe: tools, other: [] });
    try {
      const entry = servers.entries().find((server) => server.name === "probe")!;
      const post = (body: unknown) => fetch(entry.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((response) => response.json());
      expect(await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })).toMatchObject({ result: { serverInfo: { name: "probe" } } });
      expect(await post({ jsonrpc: "2.0", id: 2, method: "tools/list" })).toEqual({ jsonrpc: "2.0", id: 2, result: { tools } });
      expect(servers.listed.get("probe")).toBe(1);
    } finally {
      await servers.close();
    }
  });

  it.skipIf(!REAL_CLI)("real CLI: a 965-byte tool alone is shown, and past the budget the largest go first", { timeout: 120_000 }, async () => {
    const env = { ...process.env, HOME: mkdtempSync(join(tmpdir(), "agp-home-")) };
    const profile = () => mkdtempSync(join(tmpdir(), "agp-"));
    const alone = await probeAntigravityCli({ executable: REAL_CLI!, profile: profile(), env, servers: { probe: [toolOfBytes("one", 965)] }, prompt: true });
    expect(alone.session).toBe("ok");
    expect(alone.servers.probe!.map((tool) => tool.kept)).toEqual([true]);
    const graded = Array.from({ length: 80 }, (_, index) => toolOfBytes(`s${String(index).padStart(2, "0")}`, 800 + index * 10));
    const many = await probeAntigravityCli({ executable: REAL_CLI!, profile: profile(), env, servers: { probe: graded }, prompt: true });
    const kept = many.servers.probe!.filter((tool) => tool.kept), dropped = many.servers.probe!.filter((tool) => !tool.kept);
    expect(dropped.length).toBeGreaterThan(0);
    expect(Math.max(...kept.map((tool) => tool.bytes))).toBeLessThan(Math.min(...dropped.map((tool) => tool.bytes)));
    expect(many.servers.probe!.every((tool) => tool.written)).toBe(true);
  });

  it.skipIf(!REAL_CLI)("real CLI through the MCP gate: a share brings 74 connected-app tools from some shown to all shown, and is recorded", { timeout: 120_000 }, async () => {
    const folder = mkdtempSync(join(tmpdir(), "agp-gate-"));
    const catalog = workspaceAppsLikeCatalog() as ProbeTool[];
    writeFileSync(join(folder, "tools.json"), JSON.stringify(catalog));
    const gate = gateServer({ name: "workspace", server: { command: process.execPath, args: [join(import.meta.dirname, "probe-stdio-mcp-server.ts")], env: { PROBE_MCP_TOOLS_FILE: join(folder, "tools.json") } },
      threadId: "probe", budget: 0, schemaProfile: "gemini" })!;
    const env = { ...process.env, HOME: mkdtempSync(join(tmpdir(), "agp-home-")) };
    const shownWith = async (extra: Record<string, string>) => {
      const result = await probeAntigravityCli({ executable: REAL_CLI!, profile: mkdtempSync(join(tmpdir(), "agp-")), env, servers: {}, settleMs: 5_000, prompt: true,
        stdio: [{ name: "workspace", command: gate.command, args: gate.args, env: { ...gate.env, PATH: process.env.PATH ?? "", ...extra }, tools: catalog }] });
      return result.servers.workspace!.filter((tool) => tool.kept).length;
    };
    expect(await shownWith({})).toBeLessThan(catalog.length);
    const record = join(folder, "record.json");
    expect(await shownWith({ [TOOL_LIST_SHARE_ENV]: "26000", [TOOL_LIST_RECORD_ENV]: record })).toBe(catalog.length);
    expect(readRecordedToolList(record)?.map((tool) => tool.name)).toEqual(catalog.map((tool) => tool.name));
  });
});
