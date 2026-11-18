import { useEffect, useRef, useState } from "react";

import {
  MAX_SKILL_REVIEW_STEPS,
  MIN_SKILL_REVIEW_STEPS,
  parseSkillReviewSteps,
  skillAuthoringEnabled,
  skillReviewEnabled,
  skillReviewSteps,
  skillReviewUnavailableEngines,
} from "@/lib/feature-flags";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { t } from "@/lib/i18n";
import { MoreText, SETTINGS_INLINE_INPUT, SettingRow, Switch } from "./SettingsPrimitives";

export function SkillReviewSettings() {
  const { state, dispatch } = useStore();
  const authoring = skillAuthoringEnabled(state.config);
  const enabled = skillReviewEnabled(state.config);
  const confirmedSteps = skillReviewSteps(state.config);
  const unavailable = skillReviewUnavailableEngines(state.bots, state.instances);
  const [value, setValue] = useState(String(confirmedSteps));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);

  useEffect(() => {
    if (!dirty) setValue(String(confirmedSteps));
  }, [confirmedSteps, dirty]);

  const save = async (features: { skillReview?: boolean; skillReviewSteps?: number }) => {
    if (inFlight.current) return false;
    inFlight.current = true;
    setSaving(true);
    setError("");
    try {
      const config: ConfigStatus = await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify({ features }),
      });
      dispatch({ type: "configStatus", config });
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("settings.experimental.error"));
      return false;
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };

  const saveSteps = async () => {
    if (!dirty) return;
    const steps = parseSkillReviewSteps(value);
    if (steps === null) {
      setError(t("settings.experimental.skillReviewStepsRange", { min: MIN_SKILL_REVIEW_STEPS, max: MAX_SKILL_REVIEW_STEPS }));
      return;
    }
    if (await save({ skillReviewSteps: steps })) setDirty(false);
  };

  // Two card rows of the Early features card, in the one row design: the switch, then (while it is on) how many steps
  // come before a review, as an inline field with its unit, like Limits › Stop a group turn after.
  return (
    <div data-testid="skill-review-settings" className="contents">
      <SettingRow title={t("settings.experimental.skillReview")} tag={t("settings.early.tag")}
        subtitle={authoring ? <MoreText short={t("settings.experimental.skillReviewShort")} long={t("settings.experimental.skillReviewDetail")} /> : t("settings.experimental.skillReviewNeedsAuthoring")}
        message={unavailable.length ? <SkillReviewEngineNote engines={unavailable} /> : !enabled && error ? <span role="alert" className="text-danger">{error}</span> : undefined}>
        <Switch checked={enabled} aria-label={t("settings.experimental.skillReviewAria")} disabled={saving || !authoring}
          onClick={() => void save({ skillReview: !enabled })} />
      </SettingRow>
      {enabled ? (
        <SettingRow title={t("settings.experimental.skillReviewStepsTitle")}
          message={error ? <span role="alert" className="text-danger">{error}</span> : undefined}>
          <input
            id="skill-review-steps"
            type="number"
            aria-label={t("settings.experimental.skillReviewSteps")}
            min={MIN_SKILL_REVIEW_STEPS}
            max={MAX_SKILL_REVIEW_STEPS}
            step={1}
            inputMode="numeric"
            value={value}
            disabled={saving}
            aria-invalid={Boolean(error)}
            onChange={(event) => {
              setValue(event.target.value);
              setDirty(true);
              setError("");
            }}
            onBlur={() => void saveSteps()}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
            className={SETTINGS_INLINE_INPUT}
          />
          <span className="text-[13px] leading-5 text-ink-secondary">{t("settings.experimental.skillReviewStepsUnit")}</span>
        </SettingRow>
      ) : null}
    </div>
  );
}

export function SkillReviewEngineNote({ engines }: { engines: readonly string[] }) {
  if (!engines.length) return null;
  return (
    <span className="block" data-testid="skill-review-engine-note">
      {t("settings.experimental.skillReviewNoEngine", { engines: engines.join(", ") })}
    </span>
  );
}
