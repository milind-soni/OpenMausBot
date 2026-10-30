// What server/index.ts needs from the HighLevel integration, in one object so the host file gains only a few lines:
// the per-turn mount, the prompt part, the internal MCP handler (per-bot verdict, decision rows, write activity) and
// the Cloud health merge.
import { HIGHLEVEL_MCP_SERVER } from "../../shared/highlevel.ts";
import { appendDecision } from "../decision-log.ts";
import { harnessMcpTokenEnv } from "../harness-mcp-token.ts";
import { AGENTS_NODE_FLAG, SPAWNED_PROXIES } from "../proxy-paths.ts";
import { highlevelAccess, highlevelAllowedFor, highlevelSystemPrompt, type HighLevelBot } from "./access.ts";
import { highlevelRpc, type HighLevelToolsList } from "./rpc.ts";
import type { HighLevelService } from "./service.ts";
import { HIGHLEVEL_TOOLS, type HighLevelToolResult, type HighLevelWriteRecord } from "./tools.ts";

export interface HighLevelHostDeps {
  service: HighLevelService;
  dataDir: string;
  bot(id: string): (HighLevelBot & { color?: string }) | undefined | null;
  /** True when the thread is a room, so the activity row names its author. */
  inRoom(threadId: string): boolean;
  appendMessage(threadId: string, message: Record<string, unknown>): void;
}

export interface HighLevelHost {
  /** Connected, and this bot allowed to use it. */
  mounts(bot: HighLevelBot): boolean;
  integration(bot: HighLevelBot, mint: () => string, harnessUrl: string): { command: string; args: string[]; env: Record<string, string> } | null;
  prompt(bot: HighLevelBot): string;
  handle(body: unknown, capability: { botId: string; threadId: string }, assertActive: () => void): Promise<HighLevelToolsList | HighLevelToolResult>;
  /** The HIGHLEVEL_* names for the per-bot tool grants picker (/api/connectors/tools); null when the integration is unavailable. */
  toolListing(): { highlevel: Array<{ name: string; description: string }> } | null;
  /** Merges {highlevel:{connected}} into the Cloud health connectors report, only while a HighLevel connection is saved
   * (signed in, or needing sign-in again): a HighLevel never set up is not listed. */
  health(base: Promise<Record<string, { connected: boolean; pending?: boolean }>> | null): Promise<Record<string, { connected: boolean; pending?: boolean }>> | null;
}

/** "contact abc: email, tags": the record and the field names, never the values. */
export function writeSummary(record: HighLevelWriteRecord): string {
  return `${record.kind} ${record.recordId}: ${record.fields.join(", ")}`.slice(0, 240);
}

export function createHighLevelHost(deps: HighLevelHostDeps): HighLevelHost {
  const { service } = deps;
  const mounts = (bot: HighLevelBot) => service.connected() && highlevelAllowedFor(bot);
  return {
    mounts,
    integration(bot, mint, harnessUrl) {
      if (!mounts(bot)) return null;
      const token = mint();
      return {
        command: process.execPath, args: [SPAWNED_PROXIES.harnessMcp, HIGHLEVEL_MCP_SERVER],
        env: { ...AGENTS_NODE_FLAG, [harnessMcpTokenEnv("highlevel")]: token, OMB_HARNESS_URL: harnessUrl },
      };
    },
    prompt: (bot) => highlevelSystemPrompt(bot),
    toolListing: () => (service.status().state === "unavailable" ? null : { highlevel: HIGHLEVEL_TOOLS.map(({ name, description }) => ({ name, description })) }),
    async handle(body, capability, assertActive) {
      return highlevelRpc(body as { method?: unknown; params?: unknown }, {
        client: service.client,
        assertActive,
        // Re-read the live bot on every call, so a permission change wins over a request authenticated under the old one.
        authorize: (name) => {
          const bot = deps.bot(capability.botId);
          if (!bot) return { ok: false, text: "This bot no longer exists." };
          const verdict = highlevelAccess(bot, name);
          for (const row of verdict.rows) {
            appendDecision(deps.dataDir, { threadId: capability.threadId, botId: bot.id, botName: bot.name, tool: row.tool, decision: row.decision, source: "connector-scope", rule: row.rule, ...(row.summary ? { summary: row.summary } : {}) });
          }
          return verdict.ok ? { ok: true } : { ok: false, text: verdict.text };
        },
        onWrite: (record) => {
          const bot = deps.bot(capability.botId);
          deps.appendMessage(capability.threadId, {
            role: "bot", kind: "activity",
            tool: { name: `mcp__${HIGHLEVEL_MCP_SERVER}__${record.tool}`, ok: true, summary: writeSummary(record) },
            ...(bot && deps.inRoom(capability.threadId) ? { from: { botId: bot.id, name: bot.name, color: bot.color } } : {}),
          });
        },
      });
    },
    health(base) {
      const connection = service.store.get();
      if (!connection) return base;
      const highlevel = { connected: connection.state === "signed-in" };
      return (base ?? Promise.resolve({})).then((connectors) => ({ ...connectors, highlevel }), () => ({ highlevel }));
    },
  };
}
