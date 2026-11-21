import { levelLabel, reasoningHintLevel } from "@/lib/reasoning-hint";
import { t } from "@/lib/i18n";
import type { Bot } from "@/state/store";
import { useStoreSelector } from "@/state/store-select";

/** One quiet line under the reasoning control when the bot thinks less than its model offers. */
export function ReasoningHint({ bot, className }: { bot: Pick<Bot, "modelSelection">; className?: string }) {
  const instance = useStoreSelector((state) => state.instances.find((candidate) => candidate.instanceId === bot.modelSelection.instanceId));
  const level = reasoningHintLevel(bot.modelSelection, instance);
  if (!level) return null;
  return <p data-reasoning-hint={level} className={className ?? "text-[13px] text-ink-secondary"}>{t("model.reasoningHint", { level: levelLabel(level) })}</p>;
}
