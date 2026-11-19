// DeepSeek has no plan windows; its account answers with a prepaid balance per currency
// (GET https://api.deepseek.com/user/balance, documented at api-docs.deepseek.com/api/get-user-balance).

export const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";

/** Money left on a prepaid API account, in its own currency. */
export interface PlanBalance {
  amount: number;
  currency: string;
}

/** The USD balance when the account holds one, else the first currency it reports. */
export function parseDeepSeekBalance(body: unknown): PlanBalance | null {
  const infos = body && typeof body === "object" ? (body as Record<string, unknown>).balance_infos : undefined;
  if (!Array.isArray(infos)) return null;
  const balances = infos.flatMap((info): PlanBalance[] => {
    if (!info || typeof info !== "object") return [];
    const record = info as Record<string, unknown>;
    const amount = Number(record.total_balance);
    const currency = typeof record.currency === "string" ? record.currency.trim().toUpperCase() : "";
    return Number.isFinite(amount) && /^[A-Z]{3}$/.test(currency) ? [{ amount, currency }] : [];
  });
  return balances.find((balance) => balance.currency === "USD") ?? balances[0] ?? null;
}
