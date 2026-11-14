import type { AppState, Bot } from "@/state/store";
import { keepWarmLine } from "./cache-keepwarm";
import { t } from "./i18n";
import { contextChip, contextDetail, contextShare, costCaption, formatUsd, hasFiniteCost, lastTurnDetail, usageChip, usageDetail } from "./usage";

export function usageSummary(bot: Bot, instances: AppState["instances"]): { short: string; detail: string; tone?: "danger" | "warning" } | null {
  const task = bot.tasks?.find((t) => t.threadId === bot.threadId);
  const usage = task?.usage;
  if (!usage || !usageChip(usage)) return null;
  const billing = instances.find((i) => i.instanceId === bot.modelSelection.instanceId)?.snapshot.billing;
  const share = contextShare(usage);
  const detail = [
    usage.turns === 1 ? t("chat.usage.turnsOne") : t("chat.usage.turnsMany", { count: usage.turns }),
    usageDetail(usage),
    lastTurnDetail(usage),
    contextDetail(usage),
    share?.tone === "danger" ? t("chat.usage.contextNudge") : null,
    keepWarmLine(task?.cacheKeepWarm),
    hasFiniteCost(usage.costUsd) ? `${formatUsd(usage.costUsd)} ${costCaption(billing)}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  const short = usageChip(usage);
  const ctx = contextChip(usage);
  return { short: ctx ? `${short} · ${ctx}` : short, detail, tone: share?.tone === "danger" ? "danger" : share?.tone === "warning" ? "warning" : undefined };
}
