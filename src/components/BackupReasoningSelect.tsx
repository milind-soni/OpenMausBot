import { offeredEffortLevels, type ModelSelection } from "../../shared/wire";
import { t } from "@/lib/i18n";
import type { InstanceInfo } from "@/state/store";
import { effortLabel, variantLabel } from "./model-picker-reasoning";
import { Select } from "./Select";

/** Keeps compatible reasoning when changing the model on a backup row, or resets to provider default. */
export function withBackupModel(entry: ModelSelection, instance: InstanceInfo | undefined, model: string): ModelSelection {
  if (instance?.capabilities?.modelVariants) {
    const variants = instance.models.options.find((option) => option.id === model)?.variants ?? [];
    const keepVariant = entry.variant !== undefined && variants.some((option) => option.id === entry.variant);
    return { instanceId: entry.instanceId, model, ...(keepVariant ? { variant: entry.variant } : {}) };
  }
  const keepEffort = entry.effort !== undefined && offeredEffortLevels(instance, model).includes(entry.effort);
  return { instanceId: entry.instanceId, model, ...(keepEffort ? { effort: entry.effort } : {}) };
}

/** Optional per-backup-model reasoning selector (effort levels or model variants); hidden when unsupported and unset. */
export function BackupReasoningSelect({
  entry,
  instance,
  labelName,
  onChange,
  className,
  variant = "field",
}: {
  entry: ModelSelection;
  instance: InstanceInfo | undefined;
  labelName: string;
  onChange: (next: ModelSelection) => void;
  className?: string;
  variant?: "field" | "quiet";
}) {
  if (instance?.capabilities?.modelVariants || entry.variant !== undefined) {
    const options = instance?.models.options.find((option) => option.id === entry.model)?.variants ?? [];
    const missing = entry.variant !== undefined && !options.some((option) => option.id === entry.variant);
    if (!options.length && entry.variant === undefined) return null;
    const choose = (value: string) => {
      const { effort: _effort, variant: _variant, ...base } = entry;
      onChange(value ? { ...base, variant: value } : base);
    };
    return (
      <Select
        size="sm"
        variant={variant}
        className={className}
        aria-label={t("model.fallback.reasoning", { name: labelName })}
        value={entry.variant ?? ""}
        onChange={(event) => choose(event.target.value)}
      >
        <option value="">{t("model.fallback.reasoningDefault")}</option>
        {missing && entry.variant && (
          <option value={entry.variant}>
            {entry.variant} ({t(options.length ? "model.variant.unavailable" : "model.variant.unverified")})
          </option>
        )}
        {options.map((option) => (
          <option key={option.id} value={option.id}>{variantLabel(option, instance?.driverKind)}</option>
        ))}
      </Select>
    );
  }

  const levels = offeredEffortLevels(instance, entry.model);
  const missing = entry.effort !== undefined && !levels.includes(entry.effort);
  if (!levels.length && entry.effort === undefined) return null;
  const choose = (value: string) => {
    const { effort: _effort, variant: _variant, ...base } = entry;
    const picked = levels.find((level) => level === value) ?? (value === entry.effort ? entry.effort : undefined);
    onChange(picked ? { ...base, effort: picked } : base);
  };
  return (
    <Select
      size="sm"
      variant={variant}
      className={className}
      aria-label={t("model.fallback.reasoning", { name: labelName })}
      value={entry.effort ?? ""}
      onChange={(event) => choose(event.target.value)}
    >
      <option value="">{t("model.fallback.reasoningDefault")}</option>
      {missing && entry.effort && (
        <option value={entry.effort}>
          {effortLabel(entry.effort)} ({t(levels.length ? "model.variant.unavailable" : "model.variant.unverified")})
        </option>
      )}
      {levels.map((level) => (
        <option key={level} value={level}>{effortLabel(level)}</option>
      ))}
    </Select>
  );
}
