import { brokerRemoteMcp, type BrokerTurn } from "./bot-box/broker-mcp.ts";
import type { AppConfig } from "./config.ts";
import type { McpServerSpec, SendTurnInput } from "./contracts.ts";
import { parseStoredMcpServer } from "./mcp-registry.ts";

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
  if (!Object.keys(custom).length) return;
  integrations.custom = turn ? brokerRemoteMcp(custom, turn) : custom;
  const budgets = customMcpResultBudgets(cfg, Object.keys(custom));
  if (Object.keys(budgets).length) integrations.customResultBudgets = budgets;
}
