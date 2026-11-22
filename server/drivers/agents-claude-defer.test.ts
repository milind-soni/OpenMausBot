import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WATCHER_OPTIONS_CARD_BOT_ID } from "../../shared/options-card.ts";
import { waitForExit } from "../testing/cleanup.ts";
import { TOOL_BRIDGE_ENV } from "./agents-bridge.ts";
import { ALWAYS_LOAD_META, CLAUDE_ALWAYS_LOADED_TOOL_NAMES, CLAUDE_CHIEF_ALWAYS_LOADED_TOOL_NAMES, DEFER_TOOLS_ENV, claudeUpFrontBytes } from "./agents-claude-defer.ts";
import { agentsToolList } from "./agents-mcp.ts";

const PROXY_SOURCE = join(dirname(fileURLToPath(import.meta.url)), "agents-proxy.ts");
const BASE = { OMB_BOT_ID: "bot-defer", OMB_CHIEF_OF_STAFF: "1", OMB_COMPUTER_SELECTION: "1", OMB_SKILL_AUTHORING_ENABLED: "0", OMB_SHARED_COMPUTERS_ENABLED: "0", OMB_VOICE_NOTES: "0" };
/** The catalog wire test's default and fullest profiles (both a Chief's), and a bot that is not a Chief. */
const PROFILES: Record<string, Record<string, string>> = {
  default: BASE,
  specialist: { ...BASE, OMB_CHIEF_OF_STAFF: "0" },
  fullest: {
    ...BASE, OMB_SKILL_AUTHORING_ENABLED: "1", OMB_SHARED_COMPUTERS_ENABLED: "1", OMB_VOICE_NOTES: "1", OMB_X_RESEARCH: "1", OMB_RESEARCH: "1",
    OMB_TEAM_PEOPLE: "1", OMB_IMAGE_GENERATION: "1", OMB_APP_HOSTING: "1",
  },
};
const DEFER = { [DEFER_TOOLS_ENV]: "1" };

/** Bytes Claude Code sends up front for the agents server when the budget was last set; each may move at most 2%. */
const UP_FRONT_BASELINE: Record<string, { whole: number; deferred: number }> = {
  default: { whole: 3855, deferred: 1278 },
  specialist: { whole: 1495, deferred: 1106 },
  fullest: { whole: 3855, deferred: 1615 },
};

const listed = (env: Record<string, string>) => agentsToolList(env).listed as Array<{ name: string; description: string; inputSchema: unknown; _meta?: Record<string, unknown> }>;
const marked = (tool: { _meta?: Record<string, unknown> }) => tool._meta?.[ALWAYS_LOAD_META] === false;

describe("agents tools deferred on a Claude turn", () => {
  it("marks every tool outside the always-loaded set, and nothing without the switch or behind the bridge", () => {
    for (const env of Object.values(PROFILES)) {
      const tools = listed({ ...env, ...DEFER });
      const loaded = env.OMB_CHIEF_OF_STAFF === "1" ? CLAUDE_CHIEF_ALWAYS_LOADED_TOOL_NAMES : CLAUDE_ALWAYS_LOADED_TOOL_NAMES;
      expect(tools.filter((tool) => !marked(tool)).map((tool) => tool.name).every((name) => loaded.has(name))).toBe(true);
      expect(tools.filter(marked).length).toBeGreaterThan(35);
      expect(tools.find((tool) => tool.name === "list_bots")?._meta, "a deferred list_bots loses to Claude Code's ListAgents").toBeUndefined();
      expect(marked(tools.find((tool) => tool.name === "coordinate_bots")!), "a Chief's hand-off needs no search first").toBe(env.OMB_CHIEF_OF_STAFF !== "1");
      for (const name of ["memory_update", "attach_file"]) expect(marked(tools.find((tool) => tool.name === name)!), name).toBe(true);
      expect(listed(env).some((tool) => tool._meta !== undefined)).toBe(false);
      expect(listed({ ...env, ...DEFER, [TOOL_BRIDGE_ENV]: "1" }).some((tool) => tool._meta !== undefined)).toBe(false);
    }
  });

  it("names only real catalog tools as always loaded", () => {
    const names = new Set([
      ...listed(PROFILES.fullest!).map((tool) => tool.name),
      ...listed({ ...BASE, OMB_BOT_ID: WATCHER_OPTIONS_CARD_BOT_ID }).map((tool) => tool.name),
    ]);
    expect([...CLAUDE_CHIEF_ALWAYS_LOADED_TOOL_NAMES].filter((name) => !names.has(name))).toEqual([]);
  });

  it("keeps what a Claude turn sends up front within its budget", () => {
    const measured = Object.fromEntries(Object.entries(PROFILES).map(([name, env]) => {
      const { whole, deferred } = claudeUpFrontBytes(listed({ ...env, ...DEFER }));
      return [name, { whole, deferred }];
    }));
    for (const [name, baseline] of Object.entries(UP_FRONT_BASELINE)) {
      for (const key of ["whole", "deferred"] as const) {
        const ratio = measured[name]![key] / baseline[key];
        expect(ratio, `${name} ${key}: ${measured[name]![key]} bytes against ${baseline[key]}`).toBeGreaterThanOrEqual(0.98);
        expect(ratio, `${name} ${key}: ${measured[name]![key]} bytes against ${baseline[key]}`).toBeLessThanOrEqual(1.02);
      }
      expect(measured[name]!.whole).toBeLessThan(8_000);
    }
  });

  it("puts the marks on the proxy's tools/list wire", async () => {
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("OMB_")));
    const child = spawn(process.execPath, [PROXY_SOURCE], {
      env: { ...inherited, OMB_HARNESS_URL: "http://127.0.0.1:9", OMB_COMMS_TOKEN: "unused", OMB_TURN_DEPTH: "0", ...BASE, ...DEFER },
      stdio: ["pipe", "pipe", "inherit"],
    });
    try {
      const line = await new Promise<string>((resolve, reject) => {
        let buffer = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          buffer += chunk;
          const newline = buffer.indexOf("\n");
          if (newline !== -1) resolve(buffer.slice(0, newline));
        });
        child.on("error", reject);
        child.on("exit", (code) => reject(new Error(`agents proxy exited (${code}) before answering tools/list`)));
        child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
      });
      const tools = (JSON.parse(line) as { result: { tools: Array<{ name: string; _meta?: Record<string, unknown> }> } }).result.tools;
      expect(tools.find((tool) => tool.name === "trigger")?._meta).toEqual({ [ALWAYS_LOAD_META]: false });
      expect(tools.find((tool) => tool.name === "memory_update")?._meta).toEqual({ [ALWAYS_LOAD_META]: false });
      expect(tools.find((tool) => tool.name === "list_bots")?._meta).toBeUndefined();
    } finally {
      await waitForExit(child, { signal: "SIGTERM" });
    }
  });
});
