import { brokerRemoteMcp, mcpConfigRevision, type BrokerTurn } from "./bot-box/broker-mcp.ts";
import type { AppConfig } from "./config.ts";
import type { McpServerSpec, SendTurnInput } from "./contracts.ts";
import { parseStoredMcpServer } from "./mcp-registry.ts";

export async function prepareCustomMcp(
  integrations: Parameters<typeof attachCustomMcp>[0],
  preparation: Promise<Record<string, McpServerSpec>>,
  cfg: AppConfig,
  turn: BrokerTurn,
): Promise<Record<string, McpServerSpec>> {
  const configRevision = mcpConfigRevision();
  const custom = await preparation;
  attachCustomMcp(integrations, custom, cfg, { ...turn, configRevision });
  return custom;
}

export function customMcpResultBudgets(cfg: AppConfig, names: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const name of names) {
    const raw = cfg.mcpServers?.[name];
    if (raw === undefined) continue;
    const parsed = parseStoredMcpServer(name, raw);
    if (parsed.ok && parsed.server.resultBudget !== undefined) out[name] = parsed.server.resultBudget;
  }
  return out;
}

/** Budgets ride beside the specs, so a server mounted ungated never carries a field its engine rejects. */
export function attachCustomMcp(
  integrations: Pick<NonNullable<SendTurnInput["integrations"]>, "custom" | "customResultBudgets">,
  custom: Record<string, McpServerSpec>,
  cfg: AppConfig,
  /** The turn, so a URL server's secret headers stay with the credential broker on a boxed Cloud home (server/bot-box). */
  turn?: BrokerTurn,
): void {
  const servers = turn ? brokerRemoteMcp(custom, turn) : custom;
  if (!Object.keys(servers).length) return;
  integrations.custom = servers;
  const budgets = customMcpResultBudgets(cfg, Object.keys(custom));
  if (Object.keys(budgets).length) integrations.customResultBudgets = budgets;
}
