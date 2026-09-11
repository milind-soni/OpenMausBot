// Turning a bot's own MCP server into a gated one.
//
// Shared by every driver that mounts external MCP servers, so the rule about
// what a tool may put into a model's context is written once. The gate itself
// is mcp-gate.ts; the policy it applies is mcp-trim.ts.
import { join } from "node:path";

import { DATA_DIR } from "./config.ts";
import { DEFAULT_RESULT_BUDGET } from "./mcp-trim.ts";
import { SPAWNED_PROXIES } from "./proxy-paths.ts";

/** Characters of a single tool result allowed into context, or 0 to mount
 * bot servers directly as before. `OMB_MCP_RESULT_BUDGET=0` is the escape
 * hatch for a bot that genuinely needs whole payloads in the conversation. */
export function resultBudget(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.OMB_MCP_RESULT_BUDGET;
  if (raw === undefined || raw === "") return DEFAULT_RESULT_BUDGET;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : DEFAULT_RESULT_BUDGET;
}

/** Where a thread's oversized results are kept so the bot can read them back.
 * Under the app's data directory, not the user's project folder: these are
 * the harness's spill, and it sweeps them after a day. */
export function spillDir(threadId: string): string {
  return join(DATA_DIR, "tool-results", threadId.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 80) || "thread");
}

export interface StdioServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  [key: string]: unknown;
}

/** The gated form of one bot-owned server, or null to mount it unchanged.
 *
 * Only a stdio server can be gated: the gate stands between two processes,
 * and there is no process to stand between for an http/sse entry. Those are
 * mounted as they were — a known gap, not a silent one.
 *
 * The upstream spec travels in the gate's `env`, which means it travels inside
 * the same 0600 MCP config file the driver already writes for exactly this
 * reason: a server's credentials must never reach argv, where `ps` shows them
 * to every process on the machine. */
export function gateServer(input: {
  name: string;
  server: unknown;
  threadId: string;
  budget: number;
  /** node flags the harness spawns its own helpers with */
  nodeEnv?: Record<string, string>;
  execPath?: string;
}): { command: string; args: string[]; env: Record<string, string> } | null {
  const { name, server, budget } = input;
  if (budget <= 0) return null;
  if (!server || typeof server !== "object" || Array.isArray(server)) return null;
  const spec = server as StdioServer;
  if (typeof spec.command !== "string" || !spec.command) return null;
  return {
    command: input.execPath ?? process.execPath,
    args: [SPAWNED_PROXIES.mcpGate],
    env: {
      ...input.nodeEnv,
      OMB_GATE_NAME: name,
      OMB_GATE_UPSTREAM: JSON.stringify({ command: spec.command, args: spec.args ?? [], env: spec.env ?? {} }),
      OMB_GATE_SPILL_DIR: spillDir(input.threadId),
      OMB_GATE_BUDGET: String(budget),
    },
  };
}
