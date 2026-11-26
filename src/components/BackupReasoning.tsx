import { offeredEffortLevels } from "../../shared/wire";
import { t } from "@/lib/i18n";
import type { InstanceInfo, ModelSelection } from "@/state/store";
import { variantLabel } from "./model-picker-reasoning";
import { Select } from "./Select";

export function BackupReasoning({ instance, selection, onChange }: {
  instance?: InstanceInfo;
  selection: ModelSelection;
  onChange: (next: ModelSelection) => void;
}) {
  const { instanceId, model, variant, effort } = selection;
  const options = instance?.capabilities?.modelVariants
    ? (instance.models.options.find((option) => option.id === model)?.variants ?? [])
      .map((option) => ({ value: option.id, label: variantLabel(option, instance.driverKind), reasoning: { variant: option.id } }))
    : offeredEffortLevels(instance, model)
      .map((level) => ({ value: level, label: t(`model.effort.${level}`), reasoning: { effort: level } }));
  const value = variant ?? effort ?? "";
  if (!options.length && !value) return null;
  return (
    <Select size="sm" variant="quiet" className="min-w-0 max-w-[42%]" value={value}
      aria-label={`${t("model.simple.reasoning")} · ${model}`}
      onChange={(event) => onChange({ instanceId, model, ...options.find((option) => option.value === event.target.value)?.reasoning })}>
      <option value="">{t("settings.newBotEffort.default")}</option>
      {value && !options.some((option) => option.value === value) && <option value={value} disabled>{value}</option>}
      {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </Select>
  );
}
