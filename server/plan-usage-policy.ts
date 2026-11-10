import type { PlanAccount } from "./plan-usage.ts";

export function claudePlanUsageDisabled(account: PlanAccount, env: NodeJS.ProcessEnv): boolean {
  return account.driver === "claude" && (env.OMB_CLAUDE_PLAN_USAGE === "0" || account.environment.OMB_CLAUDE_PLAN_USAGE === "0");
}

export function planUsageCacheKey(accounts: PlanAccount[], env: NodeJS.ProcessEnv): string {
  const accountsKey = accounts.map((account) => {
    const environment = Object.entries(account.environment)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([name, value]) => `${name}=${value}`)
      .join("\n");
    return [account.id, account.driver, account.name, account.configDir ?? "", environment].join("\u0000");
  }).join("\n");
  return `${accountsKey}\u0000${env.OMB_CLAUDE_PLAN_USAGE === "0" ? "claude-off" : "claude-on"}`;
}
