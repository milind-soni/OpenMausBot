import { useState } from "react";

import { shareLearnedSkillsMode, skillAuthoringEnabled, skillsLibraryEnabled } from "@/lib/feature-flags";
import { t } from "@/lib/i18n";
import { api, type ConfigStatus } from "@/state/store";
import { SkillReviewSettings } from "./SkillReviewSettings";
import { MoreText, Segmented, SettingRow } from "./SettingsPrimitives";
import { sameFields, useStoreDispatch, useStoreSelector } from "@/state/store-select";

const MODES = [
  { value: "off", label: "settings.experimental.shareSkillsOff" },
  { value: "ask", label: "settings.experimental.shareSkillsAsk" },
  { value: "auto", label: "settings.experimental.shareSkillsAuto" },
] as const;

export function ShareLearnedSkillsSettings() {
  const state = useStoreSelector((s) => ({ config: s.config }), sameFields), dispatch = useStoreDispatch();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  if (!skillsLibraryEnabled(state.config)) return null;
  const authoring = skillAuthoringEnabled(state.config);
  const mode = shareLearnedSkillsMode(state.config);

  const choose = async (next: (typeof MODES)[number]["value"]) => {
    if (saving || next === mode) return;
    setSaving(true);
    setError("");
    try {
      const config: ConfigStatus = await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify({ features: { shareLearnedSkills: next } }),
      });
      dispatch({ type: "configStatus", config });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("settings.experimental.error"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div data-testid="share-learned-skills-settings" className="contents">
      <SettingRow title={t("settings.experimental.shareSkills")} tag={t("settings.early.tag")}
        subtitle={authoring ? <MoreText short={t("settings.experimental.shareSkillsShort")} long={t("settings.experimental.shareSkillsDetail")} /> : t("settings.experimental.shareSkillsNeedsAuthoring")}
        message={error ? <span role="alert" className="text-danger">{error}</span> : undefined}>
        <Segmented value={mode} label={t("settings.experimental.shareSkillsAria")} disabled={saving || !authoring} onChange={(next) => void choose(next)}
          options={MODES.map((option) => ({ value: option.value, label: t(option.label) }))} />
      </SettingRow>
    </div>
  );
}

export function LearnedSkillsSettings() {
  return (
    <>
      <SkillReviewSettings />
      <ShareLearnedSkillsSettings />
    </>
  );
}
