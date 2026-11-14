import { useStore, type Bot } from "@/state/store";
import { t } from "@/lib/i18n";
import { EFFORT_LEVELS, isEffortLevel } from "../../../shared/wire";
import { modelEffortLevels } from "../../../shared/model-effort";
import { effortLabel } from "../effort-label";
import { Select } from "../Select";
import { SettingRow, Switch } from "../SettingsPrimitives";
import type { BotPatch } from "./useBotSettingsDerived";

export function AutoEffortSettings({ bot, patch }: { bot: Bot; patch: (patch: BotPatch) => void }) {
  const { state } = useStore();
  const engine = state.instances.find((instance) => instance.instanceId === bot.modelSelection.instanceId);
  const offered = engine ? modelEffortLevels(bot.modelSelection.model, engine) : [];
  const levels = EFFORT_LEVELS.filter((level) => offered.includes(level));
  if (!levels.length && !bot.autoEffort) return null;
  const settings = bot.autoEffort ?? {};
  const update = (change: NonNullable<Bot["autoEffort"]>) => patch({ autoEffort: { ...settings, ...change } });
  return (
    <div data-auto-effort-settings className="flex flex-col gap-3">
      <p className="text-[13px] text-ink-secondary">{t("botSettings.autoEffort.detail")}</p>
      {(["min", "max"] as const).map((bound) => (
        <SettingRow key={bound} title={t(bound === "min" ? "botSettings.autoEffort.min" : "botSettings.autoEffort.max")}>
          <Select aria-label={t(bound === "min" ? "botSettings.autoEffort.min" : "botSettings.autoEffort.max")} value={settings[bound] ?? ""}
            onChange={(event) => update({ [bound]: isEffortLevel(event.target.value) ? event.target.value : undefined })}>
            <option value="">{t("botSettings.autoEffort.unrestricted")}</option>
            {[...new Set([...levels, ...(settings[bound] ? [settings[bound]] : [])])].map((level) => (
              <option key={level} value={level} disabled={!offered.includes(level) || (bound === "min"
                ? Boolean(settings.max && EFFORT_LEVELS.indexOf(level) > EFFORT_LEVELS.indexOf(settings.max))
                : Boolean(settings.min && EFFORT_LEVELS.indexOf(level) < EFFORT_LEVELS.indexOf(settings.min)))}>{effortLabel(level)}</option>
            ))}
          </Select>
        </SettingRow>
      ))}
      <SettingRow title={t("botSettings.autoEffort.automated")} subtitle={t("botSettings.autoEffort.automatedDetail")}>
        <Switch aria-label={t("botSettings.autoEffort.automated")} checked={settings.automated === true} onClick={() => update({ automated: !settings.automated })} />
      </SettingRow>
    </div>
  );
}
