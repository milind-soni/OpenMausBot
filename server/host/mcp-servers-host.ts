// Which config.json MCP servers each bot's turns start: every bot's and the bot's own, minus any that does not start.
import { existsSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "../atomic.ts";
import type { AppConfig } from "../config.ts";
import { launcherOf } from "../cloud-connections.ts";
import { customMcpServers } from "../config.ts";
import type { McpServerSpec, StdioMcpSpec } from "../contracts.ts";
import { addBotMcpServer, claimBotMcpServers, keepForBot, withoutBotMcpServers, type BotKept, type BotMcpServerAdd } from "../mcp-bot-servers.ts";
import { MCP_RESTART_ENV } from "../mcp-app-catalog.ts";
import { createMcpHealth, nameList, toolLabel, type McpHealthDeps } from "../mcp-health.ts";
import { probeMcpServer } from "../mcp-probe.ts";
import { isRemoteMcpServer, parseStoredMcpServer, type StoredStdioMcpServer } from "../mcp-registry.ts";
import type { McpKeys } from "../vault/mcp-keys.ts";
import { canUseMcpServer } from "../../shared/tool-scope.ts";

type Bot = { id: string; name: string; mcpServers?: string[]; toolScope?: unknown };
/** A server left out of a bot's turns, with why; `key`: its Vault key is off, as against it not starting. */
export type McpServerOff = { name: string; error: string; key?: true };

export interface McpServersHostDeps {
  dataDir: string;
  cfg(): AppConfig;
  persist(next: Record<string, unknown>): void;
  bots(): readonly Bot[];
  /** The organisation's MCP policy over a bot's servers. */
  policy<T extends object>(servers: Record<string, T>): Record<string, T>;
  /** One plain line for the person about `bot`. */
  tell(text: string, bot: { id: string; name: string }): void;
  /** Whether this bot's AI starts config.json servers at all. */
  startsServers(botId: string): boolean;
  /** Whether bots' turns run boxed here, each seeing only its own folders. */
  boxed(): boolean;
  start?: McpHealthDeps["start"];
  /** A server's `vault:<id>` keys, read when it is launched or called. */
  keys?: McpKeys;
}

const CLAIMED_FILE = (dataDir: string) => join(dataDir, "mcp-bot-servers.json");

/** A package runner fetches its program the first time it starts, and later starts are quick: its check waits for that. */
const PACKAGE_RUNNERS: ReadonlySet<string> = new Set(["uvx", "npx", "bunx", "pipx", "pnpm", "uv"]);
const PACKAGE_START_MS = 120_000;
export const startCheckTimeout = (command: string): number | undefined => (PACKAGE_RUNNERS.has(launcherOf(command)) ? PACKAGE_START_MS : undefined);

/** What the person hears once when servers in one bot's folder became that bot's own. */
export function claimedNotice(botName: string, names: readonly string[]): string {
  const tools = names.toSorted().map(toolLabel);
  return tools.length === 1
    ? `The ${tools[0]} tool only works for ${botName}, so it's off for your other bots.`
    : `The ${nameList(tools)} tools only work for ${botName}, so they're off for your other bots.`;
}

/** The enabled command servers this computer starts, by name, with the bot each is for. */
export function enabledCommandServers(cfg: AppConfig): Record<string, StdioMcpSpec & { bot?: string }> {
  const out: Record<string, StdioMcpSpec & { bot?: string }> = {};
  for (const [name, raw] of Object.entries(cfg.mcpServers ?? {})) {
    const parsed = parseStoredMcpServer(name, raw);
    if (!parsed.ok || isRemoteMcpServer(parsed.server) || !parsed.server.enabled || parsed.server.runsOn) continue;
    const { command, args, env, bot } = parsed.server;
    out[name] = { command, args, env, ...(bot ? { bot } : {}) };
  }
  return out;
}

/** Whether this listed server's key is gone from the Vault: said beside it, so the person knows to give it a new one. */
function keyRemoved(keys: McpKeys, cfg: AppConfig, name: string): boolean {
  const parsed = parseStoredMcpServer(name, cfg.mcpServers?.[name]);
  if (!parsed.ok) return false;
  const resolved = keys.resolve(name, parsed.server);
  return !resolved.ok && resolved.reason === "removed";
}

/** An engine keeps a command server's process across turns and starts a new one only when its spec changes (Claude Code,
 * for its warm session), so a restart has to show in the spec. Counted since this server started: its processes go with it. */
function withRestarts(servers: Record<string, McpServerSpec>, restarts: ReadonlyMap<string, number>): Record<string, McpServerSpec> {
  return Object.fromEntries(Object.entries(servers).map(([name, server]) => {
    const count = restarts.get(name);
    return [name, count && "command" in server ? { ...server, env: { ...server.env, [MCP_RESTART_ENV]: String(count) } } : server];
  }));
}

export function createMcpServersHost(deps: McpServersHostDeps) {
  const configured = (bot: Bot): Record<string, McpServerSpec> => deps.policy(customMcpServers(deps.cfg(), bot.mcpServers, bot.id));
  /** The bot's servers with their Vault keys read, and those whose key it can't have now, with why. */
  const keyed = (bot: Bot): { servers: Record<string, McpServerSpec>; off: McpServerOff[] } => {
    const servers: Record<string, McpServerSpec> = {}, off: McpServerOff[] = [];
    for (const [name, server] of Object.entries(configured(bot))) {
      const resolved = deps.keys ? deps.keys.resolve(name, server, bot.id) : { ok: true as const, server };
      if (resolved.ok) servers[name] = resolved.server;
      else off.push({ name, error: resolved.why, key: true });
    }
    return { servers, off };
  };
  /** None on an AI that starts no servers, and only those its tool selection reaches. */
  const started = (bot: Bot): string[] => (deps.startsServers(bot.id) ? Object.keys(configured(bot)).filter((name) => canUseMcpServer(bot.toolScope, name)) : []);
  const asBot = (botId: string) => {
    const own = join(deps.dataDir, "workspaces", botId);
    return { id: botId, cwd: existsSync(own) ? own : deps.dataDir };
  };
  const start: McpHealthDeps["start"] = deps.start ?? (async (name, server, botId) => {
    await deps.keys?.warm(name, server);
    const keyedStart = deps.keys ? deps.keys.resolve(name, server) : { ok: true as const, server };
    if (!keyedStart.ok) return { ok: false, error: keyedStart.why };
    const result = await probeMcpServer({ ...keyedStart.server, enabled: true }, startCheckTimeout(server.command), undefined, { asBot: asBot(botId) });
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  });
  const checks = createMcpHealth({
    file: join(deps.dataDir, "mcp-health.json"),
    // A server whose Vault key is off is not started: it is off for that reason, not because it failed.
    servers: () => Object.fromEntries(Object.entries(enabledCommandServers(deps.cfg())).filter(([name, server]) => !deps.keys || deps.keys.resolve(name, server).ok)),
    users: (name) => deps.bots().filter((bot) => started(bot).includes(name)),
    start,
    tell: deps.tell,
  });
  const restarts = new Map<string, number>();
  const health = { ...checks, changed(name: string): void { restarts.set(name, (restarts.get(name) ?? 0) + 1); checks.changed(name); } };

  return {
    health,
    /** How Test starts a command server: as the turns of its bot, or of any bot. */
    probeAs: (server: { bot?: string }) => (server.bot ? asBot(server.bot) : {}),
    mounted: (bot: Bot): Record<string, McpServerSpec> => withRestarts(health.usable(bot.id, keyed(bot).servers), restarts),
    /** The servers set for this bot, started or not: who a change to one reaches. */
    given: (bot: Bot): string[] => Object.keys(configured(bot)),
    /** Before a turn: any Vault key its servers read from a linked password manager, and the first start checks. */
    prepare: async (bot: Bot): Promise<void> => {
      if (deps.keys) {
        for (const [name, raw] of Object.entries(deps.cfg().mcpServers ?? {})) {
          const parsed = bot.mcpServers && !bot.mcpServers.includes(name) ? null : parseStoredMcpServer(name, raw);
          if (parsed?.ok && parsed.server.enabled) await deps.keys.warm(name, parsed.server);
        }
      }
      await health.prepare(bot.id, started(bot));
    },
    off: (bot: Bot): McpServerOff[] => [...health.off(bot.id, started(bot)), ...keyed(bot).off.filter(({ name }) => canUseMcpServer(bot.toolScope, name))],
    listing: <T extends { name: string }>(server: T): T & { offFor?: string[]; keyOff?: true } => {
      const offFor = health.offFor(server.name);
      const keyGone = deps.keys ? keyRemoved(deps.keys, deps.cfg(), server.name) : false;
      return { ...server, ...(offFor.length ? { offFor } : {}), ...(keyGone ? { keyOff: true as const } : {}) };
    },
    /** A Vault item changed or went: every server it was given to is checked again. */
    keyChanged(item: string): void {
      for (const name of deps.keys?.usedBy(item) ?? []) health.changed(name);
    },
    botAdd: (current: Record<string, unknown>, body: unknown, botId: string): BotMcpServerAdd => addBotMcpServer(current, body, botId, deps.dataDir, deps.boxed()),
    botKeep: (server: StoredStdioMcpServer, botId: string): BotKept => keepForBot(server, botId, deps.dataDir, deps.boxed()),
    botDeleted(botId: string): void {
      const before = deps.cfg().mcpServers;
      const next = withoutBotMcpServers(before, botId);
      if (!next) return;
      deps.persist(next);
      for (const name of Object.keys(before ?? {})) if (!Object.hasOwn(next, name)) deps.keys?.forgetServer(name);
    },
    /** At start: the first time bots run boxed here, servers in one existing bot's folders become its own (said once);
     * then every server is checked. A server added after that stays as it was added. */
    boot(): void {
      if (deps.boxed() && !existsSync(CLAIMED_FILE(deps.dataDir))) {
        const bots = deps.bots();
        const claimed = claimBotMcpServers(deps.cfg().mcpServers, deps.dataDir, (botId) => bots.some((bot) => bot.id === botId));
        if (claimed) deps.persist(claimed.next);
        writeFileAtomic(CLAIMED_FILE(deps.dataDir), JSON.stringify({ claimedAt: Date.now() }), { mode: 0o600 });
        for (const [botId, names] of Object.entries(claimed?.claimed ?? {})) {
          const bot = bots.find((candidate) => candidate.id === botId);
          if (bot && bots.length > 1) deps.tell(claimedNotice(bot.name, names), bot);
        }
      }
      health.checkAll();
    },
  };
}

export type McpServersHost = ReturnType<typeof createMcpServersHost>;
