// Per-turn MCP server assembly for the Claude driver: integrations,
// user-configured servers, the bot project's .mcp.json, and result-size
// gating. Split out of drivers/claude.ts.
import type { SendTurnInput } from "../../contracts.ts";
import { gateServer, resultBudget } from "../../mcp-gate-config.ts";
import { projectMcpServers } from "./env-auth.ts";
import { DWEB_PROXY_PATH, NODE_ENV_FLAG } from "./permission-broker.ts";

// integrations → MCP servers; pre-allow their tools (a headless
// acceptEdits run silently denies anything unlisted)
/** Build the MCP config's `mcpServers` table and the pre-allowed tool list
 *  for one turn. The caller owns the tables afterwards: the ogb broker mount
 *  and the fallback-socket rebind mutate `mcpServers`, and `allowed.push`
 *  continues after the broker is created. */
export function claudeTurnMcpServers(
  turn: SendTurnInput,
  opts: { threadId: string; turnEnvironment: NodeJS.ProcessEnv; controlsHost: boolean; isolated: boolean },
): { mcpServers: Record<string, unknown>; allowed: string[] } {
  const { threadId, turnEnvironment, controlsHost, isolated } = opts;
  const mcpServers: Record<string, unknown> = {};
  const allowed: string[] = [];
  if (turn.integrations?.composio) {
    mcpServers.composio = { ...turn.integrations.composio };
    allowed.push("mcp__composio");
  }
  if (turn.integrations?.localComputer) {
    const local = turn.integrations.localComputer;
    mcpServers.computer = {
      command: local.command,
      args: local.args,
      env: local.env,
    };
    // The isolated Local VM preserves the established pre-allow behavior.
    // Host tools always route through OpenMausBot's permission broker.
    if (!controlsHost) allowed.push("mcp__computer");
  }
  // peer-agent comms (list_bots/ask_bot) — the harness builds the whole
  // spawn contract (command/args/env incl. the boot token) in
  // agentsIntegration(); pre-allowing matters doubly here, or the CLI's
  // own ListAgents look-alike shadows it and "@Bot" asks go nowhere
  if (turn.integrations?.agents) {
    // Coordination is foundational, not an optional deferred lookup.
    // Claude waits for always-loaded tools before building the prompt.
    mcpServers.agents = { ...turn.integrations.agents, alwaysLoad: true };
    allowed.push("mcp__agents");
  }
  if (turn.integrations?.phone) {
    mcpServers.phone = { ...turn.integrations.phone };
    allowed.push("mcp__phone");
  }
  if (turn.integrations?.browser) {
    mcpServers.browser = { ...turn.integrations.browser };
    allowed.push("mcp__browser");
  }
  // dweb network daemon (status / repo / opencode model access) via
  // server/drivers/dweb-proxy.ts — points at the configured dweb instance
  if (turn.integrations?.dweb) {
    mcpServers.dweb = {
      command: process.execPath,
      args: [DWEB_PROXY_PATH],
      env: {
        ...NODE_ENV_FLAG,
        DWEB_URL: turn.integrations.dweb.url,
      },
    };
    allowed.push("mcp__dweb");
  }
  // user-configured servers mount like any integration but are NOT
  // pre-allowed: acceptEdits silently denies unlisted tools, which
  // routes every custom tool call through the ogb permission broker
  // into an Allow/Deny card. Reserved names were filtered upstream;
  // skip any residual collision instead of clobbering a built-in.
  // A remote entry ({type, url, headers}) is already in the CLI's own
  // shape and the CLI connects to it itself; header values ride in the
  // 0600 config file like every other credential here.
  // Bot-owned servers, gated below: they are the ones that answer for a
  // machine rather than for a context window.
  const botOwned = new Set<string>();
  for (const [name, server] of Object.entries(turn.integrations?.custom ?? {})) {
    if (Object.hasOwn(mcpServers, name)) continue;
    mcpServers[name] = { ...server };
    botOwned.add(name);
  }
  // --strict-mcp-config (above) makes this config the CLI's only source
  // of MCP servers, so a server the bot's OWN project declares would
  // otherwise vanish with the machine's. Merge it last: a project file
  // can add servers but never shadow a harness-owned mount.
  if (isolated && turn.cwd) {
    for (const [name, server] of Object.entries(projectMcpServers(turn.cwd))) {
      if (Object.hasOwn(mcpServers, name)) continue;
      mcpServers[name] = server;
      botOwned.add(name);
    }
  }
  // One tool call can put more into the conversation than the whole rest
  // of the session: a single product search measured 60-140 KB of JSON,
  // and the CLI re-reads it on every later model call. The harness never
  // sees these calls — the CLI runs the server itself — so the only place
  // to stand is between the two processes. Harness-owned mounts (the
  // permission broker, computer, browser, agents, dweb) are already
  // bounded and are deliberately left alone.
  const budget = resultBudget(turnEnvironment);
  for (const name of botOwned) {
    const gated = gateServer({ name, server: mcpServers[name], threadId, budget, nodeEnv: NODE_ENV_FLAG });
    if (gated) mcpServers[name] = gated;
  }
  return { mcpServers, allowed };
}
