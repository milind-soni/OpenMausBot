import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";
import { useStore, type Bot } from "@/state/store";
import { t } from "@/lib/i18n";
import { botUsage, costCaption, formatTokens, formatUsd, hasFiniteCost, headlineTokens, tokensColumnLabel, usageDetail } from "@/lib/usage";

export function UsageSection({ bot, bare = false }: { bot: Bot; bare?: boolean }) {
  const { state, dispatch } = useStore();
  const usage = botUsage(bot);
  const instance = state.instances.find((i) => i.instanceId === bot.modelSelection.instanceId);

  if (usage.turns === 0) {
    return (
      <div className={cn(bare ? "" : "rounded-xl bg-card p-4", "text-[13px] text-ink-secondary")}>
        {t("usage.bot.empty")}
      </div>
    );
  }

  return (
    <div className={bare ? undefined : "rounded-xl bg-card p-4"}>
      {!bare && <div className="flex items-baseline justify-between">
        <div className="text-[15px] font-medium text-ink">{t("usage.title")}</div>
        <button
          onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: "usage" })}
          className="text-[12px] text-ink-secondary hover:text-ink"
        >
          {t("usage.allBots")} <ChevronRight size={14} aria-hidden="true" className="inline align-[-2px] rtl:-scale-x-100" />
        </button>
      </div>}
      <div className={cn("grid grid-cols-3 gap-3 text-[13px]", !bare && "mt-3")}>
        <div>
          <div className="text-[12px] uppercase tracking-wide text-ink-secondary">{t("usage.colTurns")}</div>
          <div className="mt-0.5 tabular-nums text-ink">{usage.turns}</div>
        </div>
        <div>
          <div className="text-[12px] uppercase tracking-wide text-ink-secondary">{tokensColumnLabel(usage)}</div>
          <div
            className="mt-0.5 tabular-nums text-ink"
            title={usageDetail(usage)}
          >
            {formatTokens(headlineTokens(usage))}
          </div>
        </div>
        <div>
          <div className="text-[12px] uppercase tracking-wide text-ink-secondary">{t("usage.colCost")}</div>
          <div className="mt-0.5 tabular-nums text-ink">
            {hasFiniteCost(usage.costUsd) ? formatUsd(usage.costUsd) : "—"}
          </div>
        </div>
      </div>
      <div className="mt-2 text-[12px] text-ink-secondary">
        {hasFiniteCost(usage.costUsd)
          ? t("usage.costLine", { caption: costCaption(instance?.snapshot.billing) })
          : t("usage.bot.unpriced")}
      </div>
    </div>
  );
}
