import type { ReactNode } from "react";
import { useStore, type Bot } from "@/state/store";
import type { EffortLevel } from "../../shared/wire";
import type { ModelVariantOption } from "../../shared/runtime-events";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { Select } from "./Select";
import { Switch } from "./SettingsPrimitives";
import { variantChoices } from "./model-picker-reasoning";

export function effortLabel(level: EffortLevel): string {
  return t(`model.effort.${level}` as Parameters<typeof t>[0]);
}

/**
 * Default (undefined) sends nothing and lets the engine decide; `none` is a level the engine is told to use. Only pi
 * offers both.
 */
export function EffortRow({
  bot,
  threadId,
  updateBotDefault,
  className,
  label,
  compact = false,
}: {
  bot: Bot;
  threadId?: string;
  updateBotDefault?: boolean;
  className?: string;
  label?: ReactNode;
  compact?: boolean;
}) {
  const { state, dispatch } = useStore();
  const selection = bot.modelSelection;
  const instance = state.instances.find((candidate) => candidate.instanceId === selection.instanceId);
  if (instance?.capabilities?.modelVariants) {
    return <ModelVariantRow bot={bot} threadId={threadId} updateBotDefault={updateBotDefault} className={className} label={label} compact={compact} quiet={compact} />;
  }
  const levels = instance?.capabilities?.effortLevels;
  if (!levels?.length) return null;

  if (compact) return (
    <label className={cn("flex items-center justify-between gap-3", className)}>
      {label}
      <Select size="sm" variant="quiet" className="max-w-[65%]" aria-label={t("model.effort.label")} value={selection.effort ?? ""}
        onChange={(event) => dispatch({ type: "setModel", botId: bot.id, threadId, ...(updateBotDefault ? { updateBotDefault: true } : {}),
          selection: { ...selection, effort: levels.find((level) => level === event.target.value) } })}>
        <option value="">{t("model.effort.default")}</option>
        {levels.map((level) => <option key={level} value={level}>{effortLabel(level)}</option>)}
      </Select>
    </label>
  );

  return (
    <div className={className}>
      {label}
      <div className="mt-2 flex flex-wrap gap-1" role="group" aria-label={t("model.effort.label")}>
        {[undefined, ...levels].map((level) => (
          <button
            key={level ?? "default"}
            type="button"
            aria-pressed={selection.effort === level}
            title={
              level === undefined
                ? t("model.effort.noLevel")
                : t("model.effort.ask", { level: effortLabel(level) })
            }
            onClick={() => dispatch({ type: "setModel", botId: bot.id, threadId, ...(updateBotDefault ? { updateBotDefault: true } : {}), selection: { ...selection, effort: level } })}
            className={cn(
              "rounded-full border px-2.5 py-1 text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
              selection.effort === level
                ? "border-accent/60 bg-control text-ink"
                : "border-hairline/40 text-ink-secondary hover:bg-control/60 hover:text-ink",
            )}
          >
            {level === undefined ? t("model.effort.default") : effortLabel(level)}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Renders nothing unless the bot's model can run fast. */
export function FastModeRow({ bot, threadId, updateBotDefault, className, label }: {
  bot: Bot;
  threadId?: string;
  updateBotDefault?: boolean;
  className?: string;
  label: ReactNode;
}) {
  const { state, dispatch } = useStore();
  const selection = bot.modelSelection;
  const instance = state.instances.find((candidate) => candidate.instanceId === selection.instanceId);
  if (!instance?.models.options.some((option) => option.id === selection.model && option.fastMode)) return null;
  const toggle = (fast: boolean) => {
    const { fast: _fast, ...rest } = selection;
    dispatch({ type: "setModel", botId: bot.id, threadId, ...(updateBotDefault ? { updateBotDefault: true } : {}), selection: { ...rest, ...(fast ? { fast: true as const } : {}) } });
  };
  return (
    <div data-fast-mode title={t("model.fast.help")} className={cn("flex items-center justify-between gap-3", className)}>
      {label}
      <Switch aria-label={t("model.fast.label")} disabled={bot.busy} checked={selection.fast === true} onClick={() => toggle(selection.fast !== true)} />
    </div>
  );
}

export const variantLabel = (option: ModelVariantOption, driverKind?: string): string =>
  option.id === "default" && driverKind === "opencodeGo" ? t("model.variant.openCodeDefault") : option.label;

export function ModelVariantRow({ bot, threadId, updateBotDefault, className, label, compact = false, wide = false, quiet = false }: {
  bot: Bot;
  threadId?: string;
  updateBotDefault?: boolean;
  className?: string;
  label?: ReactNode;
  compact?: boolean;
  wide?: boolean;
  quiet?: boolean;
}) {
  const { state, dispatch } = useStore();
  const selection = bot.modelSelection;
  const choices = variantChoices(state, selection, threadId ?? bot.threadId);
  if (!choices) return null;
  const { instance, reported, options } = choices;
  const missing = selection.variant !== undefined && !options.some((option) => option.id === selection.variant);
  const unavailable = missing && reported !== undefined;
  const current = reported?.currentValue;
  const choose = (variant?: string) => {
    const { effort: _effort, variant: _variant, ...model } = selection;
    dispatch({ type: "setModel", botId: bot.id, threadId, ...(updateBotDefault ? { updateBotDefault: true } : {}),
      selection: { ...model, ...(variant !== undefined ? { variant } : {}) } });
  };
  if (compact) return (
    <div className={className}>
      <label className="flex items-center justify-between gap-3">
        {label}
        <Select size="sm" variant={quiet ? "quiet" : "field"} aria-label={t("model.variant.label")} disabled={bot.busy} className={wide ? "flex-1" : "max-w-[65%]"}
          value={selection.variant === undefined ? "unset" : missing ? "missing" : String(options.findIndex((option) => option.id === selection.variant))}
          onChange={(event) => choose(options[Number(event.target.value)]?.id)}>
          <option value="unset">{t("model.variant.session")}</option>
          {missing && <option value="missing" disabled>{selection.variant} ({unavailable ? t("model.variant.unavailable") : t("model.variant.unverified")})</option>}
          {options.map((option, index) => <option key={option.id} value={String(index)}>{variantLabel(option, instance.driverKind)}</option>)}
        </Select>
      </label>
      {missing && <p className={cn("mt-1 text-ink-secondary", quiet ? "text-[12px] leading-4 text-ink-tertiary" : "text-[11px]")}>{unavailable ? t("model.variant.unavailableHelp") : t("model.variant.unverifiedHelp")}</p>}
    </div>
  );
  return (
    <div className={className}>
      {label}
      {(selection.variant === undefined || missing) && (
        <p className="mt-2 text-[12px] text-ink-secondary">
          {unavailable ? t("model.variant.unavailableChoice", { variant: selection.variant ?? "" })
            : missing ? t("model.variant.unverifiedChoice", { variant: selection.variant ?? "" }) : t("model.variant.none")}
          {current !== undefined && ` ${t("model.variant.sessionValue", { variant: variantLabel(options.find((option) => option.id === current) ?? { id: current, label: current }, instance.driverKind) })}`}
        </p>
      )}
      {selection.variant !== undefined && (
        <button type="button" disabled={bot.busy} onClick={() => choose()}
          title={t("model.variant.clearHint")}
          className="mt-2 block text-[12px] text-ink-secondary underline underline-offset-2 hover:text-ink disabled:opacity-50">
          {t("model.variant.clear")}
        </button>
      )}
      {options.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1" role="group" aria-label={t("model.variant.label")}>
          {options.map((option) => (
            <button
              key={option.id}
              type="button"
              disabled={bot.busy}
              aria-pressed={selection.variant === option.id}
              title={t("model.variant.use", { variant: variantLabel(option, instance.driverKind) })}
              onClick={() => choose(option.id)}
              className={cn(
                "rounded-full border px-2.5 py-1 text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 disabled:opacity-50",
                selection.variant === option.id ? "border-accent/60 bg-control text-ink" : "border-hairline/40 text-ink-secondary hover:bg-control/60 hover:text-ink",
              )}
            >
              {variantLabel(option, instance.driverKind)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
