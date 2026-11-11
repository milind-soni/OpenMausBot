import { useState } from "react";

import { cn } from "@/lib/cn";
import { shareLearnedSkillsMode, skillAuthoringEnabled, skillsLibraryEnabled } from "@/lib/feature-flags";
import { t } from "@/lib/i18n";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { SkillReviewSettings } from "./SkillReviewSettings";
import { MoreText, Segmented, SettingRow } from "./SettingsPrimitives";

const MODES = [
  { value: "off", label: "settings.experimental.shareSkillsOff" },
  { value: "ask", label: "settings.experimental.shareSkillsAsk" },
  { value: "auto", label: "settings.experimental.shareSkillsAuto" },
] as const;

export function ShareLearnedSkillsSettings() {
  const { state, dispatch } = useStore();
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
        <span className={cn("contents", (saving || !authoring) && "[&_button]:pointer-events-none [&_[role=radiogroup]]:opacity-40")}>
          <Segmented value={mode} label={t("settings.experimental.shareSkillsAria")} onChange={(next) => void choose(next)}
            options={MODES.map((option) => ({ value: option.value, label: t(option.label) }))} />
        </span>
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
