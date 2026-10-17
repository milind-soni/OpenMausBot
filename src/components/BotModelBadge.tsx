import type { Bot, InstanceInfo } from "@/state/store";
import { t } from "@/lib/i18n";
import { InstanceProviderMark } from "./ProviderIcons";

export function botModel(bot: Pick<Bot, "modelSelection">, instances: InstanceInfo[]): { instance: InstanceInfo; label: string } | null {
  const instance = instances.find((item) => item.instanceId === bot.modelSelection.instanceId);
  if (!instance) return null;
  const id = bot.modelSelection.model || instance.models?.default || "";
  const label = instance.models?.options?.find((option) => option.id === id)?.label ?? id;
  return { instance, label: label || instance.displayName };
}

export function BotModelBadge({ bot, instances, avatarSize }: {
  bot: Pick<Bot, "modelSelection">;
  instances: InstanceInfo[];
  avatarSize: number;
}) {
  const model = botModel(bot, instances);
  if (!model) return null;
  const size = Math.max(14, Math.round(avatarSize * 0.4));
  const description = t("sidebar.bot.modelBadge", { model: model.label, engine: model.instance.displayName });
  return (
    <span data-testid="model-badge" role="img" aria-label={description} title={model.label}
      className="absolute -bottom-0.5 -left-0.5 flex items-center justify-center rounded-full border-2 border-panel bg-panel"
      style={{ width: size, height: size }}>
      <InstanceProviderMark instance={model.instance} size={size - 4} />
    </span>
  );
}

/** The engine's mark at the right end of a sidebar row's text; hovering it names the model. */
export function BotModelMark({ bot, instances }: { bot: Pick<Bot, "modelSelection">; instances: InstanceInfo[] }) {
  const model = botModel(bot, instances);
  if (!model) return null;
  const description = t("sidebar.bot.modelBadge", { model: model.label, engine: model.instance.displayName });
  return (
    <span data-testid="model-badge" role="img" aria-label={description} title={model.label}
      className="ml-auto flex shrink-0 items-center self-center text-ink-secondary">
      <InstanceProviderMark instance={model.instance} size={14} />
    </span>
  );
}
