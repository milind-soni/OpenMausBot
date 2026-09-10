// Usage: what this bot has spent across its tasks. Moved verbatim from
// SettingsPanel.tsx's BotUsageCard (~40-77); its "All bots →" button keeps
// dispatching toggleAppSettings, which closes this dialog — intended, since
// the destination is the app-wide Usage settings, not a per-bot view.
//
// BotUsageCard used to render nothing at all for a bot with no turns yet,
// which was fine buried among a dozen other cards in the old aside; as this
// section's entire content it would otherwise leave the panel blank, so a
// short placeholder line is added for that case.
import { useStore, type Bot } from "@/state/store";
import { botUsage, costCaption, formatTokens, formatUsd, hasFiniteCost } from "@/lib/usage";
import { t } from "@/lib/i18n";

export function UsageSection({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const usage = botUsage(bot);
  const instance = state.instances.find((i) => i.instanceId === bot.modelSelection.instanceId);

  if (usage.turns === 0) {
    return (
      <div className="rounded-xl bg-card p-4 text-[13px] text-ink-secondary">
        {t("botSettings.usage.empty")}
      </div>
    );
  }

  return (
    <div className="rounded-xl bg-card p-4">
      <div className="flex items-baseline justify-between">
        <div className="text-[15px] font-medium text-ink">{t("botSettings.usage.title")}</div>
        <button
          onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: "usage" })}
          className="text-[12px] text-ink-secondary hover:text-ink"
        >
          {t("botSettings.usage.allBots")}
        </button>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-3 text-[13px]">
        <div>
          <div className="text-[11.5px] uppercase tracking-wide text-ink-secondary">{t("botSettings.usage.turns")}</div>
          <div className="mt-0.5 tabular-nums text-ink">{usage.turns}</div>
        </div>
        <div>
          <div className="text-[11.5px] uppercase tracking-wide text-ink-secondary">{t("botSettings.usage.tokens")}</div>
          <div
            className="mt-0.5 tabular-nums text-ink"
            title={t("botSettings.usage.tokenSplit", {
              input: formatTokens(usage.input),
              output: formatTokens(usage.output),
            })}
          >
            {formatTokens(usage.input + usage.output)}
          </div>
        </div>
        <div>
          <div className="text-[11.5px] uppercase tracking-wide text-ink-secondary">{t("botSettings.usage.cost")}</div>
          <div className="mt-0.5 tabular-nums text-ink">
            {hasFiniteCost(usage.costUsd) ? formatUsd(usage.costUsd) : "—"}
          </div>
        </div>
      </div>
      <div className="mt-2 text-[12px] text-ink-secondary">
        {hasFiniteCost(usage.costUsd)
          ? t("botSettings.usage.costCaption", { caption: costCaption(instance?.snapshot.billing) })
          : t("botSettings.usage.noPrice")}
      </div>
    </div>
  );
}
