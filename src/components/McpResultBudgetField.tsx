import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";

export interface McpMessage {
  key: LocaleKey;
  params?: Record<string, string | number>;
}

export interface McpResultBudgetListing {
  resultBudget?: number;
}

export interface McpResultBudgetDraft {
  resultBudget: string;
}

export const MAX_MCP_RESULT_BUDGET = 2_000_000;

/** Digit grouping is accepted only as whole groups of three, so a decimal (12.5, 1,5) is refused, not read ten times larger. */
export function parseMcpResultBudget(value: string): { ok: true; value: number | undefined } | { ok: false; error: McpMessage } {
  const trimmed = value.trim();
  const grouped = /^\d{1,3}([\s,._  '])\d{3}(?:\1\d{3})*$/.test(trimmed);
  const digits = grouped ? trimmed.replace(/\D/g, "") : trimmed;
  if (!digits) return { ok: true, value: undefined };
  if (!/^\d+$/.test(digits) || Number(digits) > MAX_MCP_RESULT_BUDGET) return { ok: false, error: { key: "mcp.err.resultBudget" } };
  return { ok: true, value: Number(digits) };
}

export function resultBudgetDraft(server: McpResultBudgetListing): string {
  return server.resultBudget === undefined ? "" : String(server.resultBudget);
}

export function withResultBudget<E extends { ok: false; error: McpMessage }>(
  value: string,
  build: () => { ok: true; body: Record<string, unknown> } | E,
): { ok: true; body: Record<string, unknown> } | E | { ok: false; error: McpMessage } {
  const budget = parseMcpResultBudget(value);
  if (!budget.ok) return budget;
  const built = build();
  if (!built.ok || budget.value === undefined) return built;
  return { ok: true, body: { ...built.body, resultBudget: budget.value } };
}

export function McpResultBudgetField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <label className="block">
      <span className="text-[12px] font-medium text-ink-secondary">{t("mcp.field.resultBudget")}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        inputMode="numeric"
        placeholder="8000"
        className="mt-1.5 w-full rounded-lg border border-hairline/60 bg-raised px-3 py-2.5 text-[13px] text-ink outline-none focus:border-accent"
      />
      <span className="mt-1.5 block text-[11px] text-ink-secondary">{t("mcp.resultBudgetHint")}</span>
    </label>
  );
}
