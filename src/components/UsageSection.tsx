// App settings → Usage: what every bot has spent, so "which of my bots is
// costing me money" is answerable without a provider dashboard. Figures are
// banked per settled turn on each task (server/store.ts addTaskUsage) and
// summed here; nothing is fetched.
import { useStore } from "@/state/store";
import { BotAvatar } from "./Avatar";
import { Card } from "./SettingsPrimitives";
import { t } from "@/lib/i18n";
import { botUsage, cachedInput, costCaption, formatTokens, formatUsd, hasFiniteCost, sumUsage, usageDetail } from "@/lib/usage";

export function UsageSection() {
  const { state } = useStore();
  const rows = state.bots
    .filter((b) => !b.hidden)
    .map((bot) => {
      const usage = botUsage(bot);
      const instance = state.instances.find((i) => i.instanceId === bot.modelSelection.instanceId);
      return { bot, usage, billing: instance?.snapshot.billing };
    })
    .filter((r) => r.usage.turns > 0)
    // money first, then volume. Non-finite/missing costs sort last.
    .sort((a, b) => {
      const costOf = (value: number | null | undefined) =>
        hasFiniteCost(value) ? value : Number.NEGATIVE_INFINITY;
      return costOf(b.usage.costUsd) - costOf(a.usage.costUsd) || b.usage.input + b.usage.output - (a.usage.input + a.usage.output);
    });
  const total = sumUsage(rows.map((r) => r.usage));
  const billings = new Set(rows.map((r) => r.billing));

  return (
    <Card title={t("usage.title")} subtitle={t("usage.subtitle")}>
      {rows.length === 0 ? (
        <div className="text-[13px] text-ink-secondary">{t("usage.empty")}</div>
      ) : (
        <div className="flex flex-col">
          <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-5 border-b border-hairline/40 pb-2 text-[11.5px] font-medium uppercase tracking-wide text-ink-secondary">
            <span>{t("usage.colBot")}</span>
            <span className="text-right">{t("usage.colTurns")}</span>
            <span className="text-right">{t("usage.colTokens")}</span>
            <span className="text-right">{t("usage.colCost")}</span>
          </div>
          {rows.map(({ bot, usage }) => (
            <div key={bot.id} className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-x-5 border-b border-hairline/20 py-2 text-[13px]">
              <span className="flex min-w-0 items-center gap-2 text-ink">
                <BotAvatar bot={bot} state="idle" size={22} animated={false} />
                <span className="truncate">{bot.name}</span>
              </span>
              <span className="text-right tabular-nums text-ink-secondary">{usage.turns}</span>
              <span className="text-right tabular-nums text-ink" title={usageDetail(usage)}>
                {formatTokens(usage.input + usage.output)}
              </span>
              <span className="text-right tabular-nums text-ink">{hasFiniteCost(usage.costUsd) ? formatUsd(usage.costUsd) : <span className="text-ink-secondary">—</span>}</span>
            </div>
          ))}
          <div className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-x-5 pt-2.5 text-[13px] font-medium text-ink">
            <span>{t("usage.allBots")}</span>
            <span className="text-right tabular-nums">{total.turns}</span>
            <span className="text-right tabular-nums" title={usageDetail(total)}>{formatTokens(total.input + total.output)}</span>
            <span className="text-right tabular-nums">{hasFiniteCost(total.costUsd) ? formatUsd(total.costUsd) : "—"}</span>
          </div>
          {cachedInput(total) > 0 && (
            <div className="mt-3 text-[12px] leading-relaxed text-ink-secondary">
              {t("usage.cachedNote", { cached: formatTokens(cachedInput(total)) })}
            </div>
          )}
          {hasFiniteCost(total.costUsd) && (
            <div className="mt-3 text-[12px] leading-relaxed text-ink-secondary">
              {t("usage.costLine", {
                caption:
                  billings.size === 1 ? costCaption([...billings][0]) : t("usage.costMixed"),
              })}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
