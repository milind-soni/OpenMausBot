// Turning a bot's own MCP server into a gated one.
//
// Shared by every driver that mounts external MCP servers, so the rule about
// what a tool may put into a model's context is written once. The gate itself
// is mcp-gate.ts; the policy it applies is mcp-trim.ts.
import { join } from "node:path";
import { parseToolScope, type ToolScope } from "../shared/tool-scope.ts";

import { DATA_DIR } from "./config.ts";
import { DEFAULT_RESULT_BUDGET } from "./mcp-trim.ts";
import { remoteMcpSpec } from "./mcp-http.ts";
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

/** Use the existing remote client when an engine requires a stdio descriptor. */
export function mcpStdioServer(server: unknown, options: { nodeEnv?: Record<string, string>; execPath?: string } = {}): StdioServer | null {
  if (!server || typeof server !== "object" || Array.isArray(server)) return null;
  const spec = server as StdioServer;
  if (typeof spec.command === "string" && spec.command) return spec;
  const remote = remoteMcpSpec(server);
  if (!remote) return null;
  return {
    command: options.execPath ?? process.execPath,
    args: [SPAWNED_PROXIES.mcpRemote],
    env: { ...options.nodeEnv, OMB_REMOTE_MCP_SERVER: JSON.stringify(remote) },
  };
}

/** The gated form of one bot-owned server, or null to mount it unchanged.
 *
 * An explicit selection also wraps remote servers in the stdio facade.
 * Unrestricted remote servers keep their existing native transport.
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
  toolScope?: ToolScope;
  /** node flags the harness spawns its own helpers with */
  nodeEnv?: Record<string, string>;
  execPath?: string;
  /** Private per-mount configuration for engines that share one child env. */
  configEnvName?: string;
}): { command: string; args: string[]; env: Record<string, string> } | null {
  const { name, server, budget } = input;
  const parsed = parseToolScope(input.toolScope);
  if (!parsed.ok) throw new Error(parsed.error);
  const scoped = parsed.scope !== undefined;
  if (budget <= 0 && !scoped) return null;
  if (!scoped && remoteMcpSpec(server)) return null;
  const spec = mcpStdioServer(server, input);
  if (!spec) {
    if (scoped) throw new Error("Tool selection requires a supported MCP server.");
    return null;
  }
  const env = {
    OMB_GATE_NAME: name,
    OMB_GATE_UPSTREAM: JSON.stringify({ command: spec.command, args: spec.args ?? [], env: spec.env ?? {} }),
    OMB_GATE_SPILL_DIR: spillDir(input.threadId),
    OMB_GATE_BUDGET: String(budget),
    ...(scoped ? { OMB_GATE_TOOL_SCOPE: JSON.stringify(parsed.scope) } : {}),
  };
  if (input.configEnvName && (!scoped || !/^OMB_GATE_CONFIG_[a-f0-9]{64}$/.test(input.configEnvName))) {
    throw new Error("Invalid private MCP gate configuration.");
  }
  return {
    command: input.execPath ?? process.execPath,
    args: [SPAWNED_PROXIES.mcpGate, ...(input.configEnvName ? ["--config-env", input.configEnvName] : [])],
    env: {
      ...input.nodeEnv,
      ...(input.configEnvName ? { [input.configEnvName]: JSON.stringify(env) } : env),
    },
  };
}
