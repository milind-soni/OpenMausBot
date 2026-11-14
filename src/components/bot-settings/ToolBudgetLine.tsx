import { useEffect, useState } from "react";

import { activeLocale, t } from "@/lib/i18n";
import { api } from "@/state/store";
import type { ToolBudget } from "../../../shared/tool-budget";

export function ToolBudgetView({ budget }: { budget: ToolBudget }) {
  const searched = budget.servers.filter((server) => !server.direct).map((server) => server.name);
  return (
    <div data-tool-budget className="mt-3 text-[12px] text-ink-secondary">
      <div>{t("botAccess.tools.budget", { listed: budget.listed, limit: budget.limit })}</div>
      {searched.length > 0 && (
        <div data-tool-budget-searched className="mt-0.5">
          {t("botAccess.tools.budgetSearched", { names: new Intl.ListFormat(activeLocale(), { type: "conjunction" }).format(searched) })}
        </div>
      )}
    </div>
  );
}

/** The bot's last turn on an AI with a tool limit; nothing before one ran. Read again when a turn ends. */
export function ToolBudgetLine({ botId, busy }: { botId: string; busy: boolean }) {
  const [budget, setBudget] = useState<ToolBudget | null>(null);
  useEffect(() => {
    if (busy) return;
    let current = true;
    api(`/api/bots/${encodeURIComponent(botId)}/tool-budget`)
      .then((result: { budget?: ToolBudget | null }) => { if (current) setBudget(result.budget ?? null); })
      .catch(() => { if (current) setBudget(null); });
    return () => { current = false; };
  }, [botId, busy]);
  return budget ? <ToolBudgetView budget={budget} /> : null;
}
