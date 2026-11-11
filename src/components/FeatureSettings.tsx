import { useRef, useState } from "react";
import { FEATURE_CATALOG, FEATURE_DOCS } from "@/lib/feature-catalog";
import { savedStepsHere, skillsLibraryEnabled, type FeatureFlagConfig } from "@/lib/feature-flags";
import { t } from "@/lib/i18n";
import { api, useStore, type AppSettingsSection, type ConfigStatus } from "@/state/store";
import { FEATURE_DEFAULTS, type FeatureConfig } from "../../shared/features";
import { AdminOnly } from "./AdminOnly";
import { Card, SettingRow, Switch } from "./SettingsPrimitives";
import { SkillsSection } from "./SkillsSection";
import { ClaudeCodeSwitches } from "./ClaudeCodeSwitches";
import { LearnedSkillsSettings } from "./ShareLearnedSkillsSettings";

type BooleanFeature = { [K in keyof FeatureConfig]-?: NonNullable<FeatureConfig[K]> extends boolean ? K : never }[keyof FeatureConfig];

export function featureControlDestination(feature: keyof FeatureConfig, config: FeatureFlagConfig | null | undefined): { section: AppSettingsSection; anchor: string } {
  const entry = FEATURE_CATALOG[feature];
  return entry.controlSection && !(feature === "savedSteps" && !savedStepsHere(config))
    ? { section: entry.controlSection, anchor: `control-${feature}` }
    : { section: "features", anchor: entry.anchor };
}

export function FeatureSwitch({ feature }: { feature: BooleanFeature }) {
  const { state, dispatch } = useStore();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const enabled = (state.config?.features?.[feature] ?? FEATURE_DEFAULTS[feature]) === true;
  const toggle = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setError("");
    try {
      const config: ConfigStatus = await api("/api/config", {
        method: "PATCH", body: JSON.stringify({ features: { [feature]: !enabled } }),
      });
      dispatch({ type: "configStatus", config });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("settings.experimental.error"));
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };
  return <div className="flex flex-col items-end gap-1">
    <Switch checked={enabled} disabled={saving || !state.config} aria-label={t(FEATURE_CATALOG[feature].labelKey)} onClick={() => void toggle()} />
    {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
  </div>;
}

export function FeaturesSettings({ onOpen }: { onOpen: (section: AppSettingsSection, anchor: string) => void }) {
  const { state } = useStore();
  return <AdminOnly><Card title={t("settings.section.features")} subtitle={t("settings.features.subtitle")}>
    <div className="divide-y divide-hairline/30">
      {(Object.keys(FEATURE_CATALOG) as Array<keyof FeatureConfig>).map((key) => {
        const entry = FEATURE_CATALOG[key];
        const target = featureControlDestination(key, state.config);
        return <div key={key} data-settings-block={entry.anchor} tabIndex={-1} className="scroll-mt-4 rounded-lg py-3 focus:outline-none focus:ring-2 focus:ring-focus">
          <SettingRow title={t(entry.labelKey)} subtitle={<>{t(entry.descriptionKey)} <a className="underline" href={entry.documentation} target="_blank" rel="noreferrer">{t("settings.features.documentation")}</a></>}>
            {entry.editable && key !== "skillReviewSteps" && key !== "shareLearnedSkills" ? <FeatureSwitch feature={key} />
              : target.anchor === entry.anchor ? null
              : <button type="button" className="ui-button" onClick={() => onOpen(target.section, target.anchor)}>{t("settings.features.openControl")}</button>}
          </SettingRow>
        </div>;
      })}
      <div data-settings-block="feature-loopGuard" tabIndex={-1} className="scroll-mt-4 py-3">
        <SettingRow title={t("settings.features.loopGuard.label")} subtitle={t("settings.features.loopGuard.description")}>
          <a className="ui-button" href={`${FEATURE_DOCS}#fields-that-are-not-stored-switches`} target="_blank" rel="noreferrer">{t("settings.features.documentation")}</a>
        </SettingRow>
      </div>
    </div>
    <ClaudeCodeSwitches />
  </Card></AdminOnly>;
}

export function SkillsSettings() {
  const { state } = useStore();
  const enabled = skillsLibraryEnabled(state.config);
  return <AdminOnly>
    <Card title={t("settings.features.skillsLibrary.label")} subtitle={t(enabled ? "settings.features.skillsEnabled" : "settings.features.skillsDisabled")}>
      <div data-settings-block="control-skillsLibrary" tabIndex={-1}><SettingRow title={t("settings.features.skillsLibrary.label")}><FeatureSwitch feature="skillsLibrary" /></SettingRow></div>
    </Card>
    {enabled ? <SkillsSection /> : null}
    <Card title={t("settings.experimental.title")}><LearnedSkillsSettings /></Card>
  </AdminOnly>;
}
