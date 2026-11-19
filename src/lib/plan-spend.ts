import { activeLocale, t } from "./i18n";

export interface PlanSpend {
  usedMinor: number;
  limitMinor: number;
  currency: string;
  exponent: number;
}

function money(minor: number, currency: string, exponent: number): string {
  const amount = minor / 10 ** exponent;
  try {
    return new Intl.NumberFormat(activeLocale(), { style: "currency", currency, minimumFractionDigits: exponent, maximumFractionDigits: exponent }).format(amount);
  } catch {
    return `${amount.toFixed(Math.min(exponent, 100))} ${currency}`;
  }
}

/** A prepaid balance in its own currency, such as DeepSeek's. */
export interface PlanBalance {
  amount: number;
  currency: string;
}

/** "$51.30 left". */
export function formatPlanBalance(balance: PlanBalance): string {
  return t("planUsage.balanceLeft", { amount: money(Math.round(balance.amount * 100), balance.currency, 2) });
}

/** "$46.31 of $500.00 spent". */
export function formatPlanSpend(spend: PlanSpend): string {
  return t("planUsage.spendAmounts", { used: money(spend.usedMinor, spend.currency, spend.exponent), limit: money(spend.limitMinor, spend.currency, spend.exponent) });
}
