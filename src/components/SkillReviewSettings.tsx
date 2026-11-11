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
import { Switch } from "./SettingsPrimitives";

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

  return (
    <div className="mt-4 scroll-mt-4 border-t border-hairline/30 pt-4" data-testid="skill-review-settings" data-settings-block="control-skillReview" tabIndex={-1}>
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[14px] font-medium text-ink">{t("settings.experimental.skillReview")}</div>
          <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">
            {t(authoring ? "settings.experimental.skillReviewDetail" : "settings.experimental.skillReviewNeedsAuthoring")}
          </div>
        </div>
        <Switch
          checked={enabled}
          aria-label={t("settings.experimental.skillReviewAria")}
          disabled={saving || !authoring}
          onClick={() => void save({ skillReview: !enabled })}
          className="disabled:cursor-not-allowed disabled:opacity-50"
        />
      </div>
      <SkillReviewEngineNote engines={unavailable} />
      <div className="mt-3 flex items-center gap-3" data-settings-block="control-skillReviewSteps" tabIndex={-1}>
          <label htmlFor="skill-review-steps" className="text-[13px] text-ink">
            {t("settings.experimental.skillReviewSteps")}
          </label>
          <div
            className={`flex w-[96px] items-center rounded-lg border bg-inset ${
              error ? "border-danger/60" : "border-hairline/40 focus-within:border-focus"
            }`}
          >
            <input
              id="skill-review-steps"
              type="number"
              min={MIN_SKILL_REVIEW_STEPS}
              max={MAX_SKILL_REVIEW_STEPS}
              step={1}
              inputMode="numeric"
              value={value}
              disabled={saving || !authoring || !enabled}
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
              className="min-w-0 flex-1 bg-transparent px-3 py-1.5 text-[14px] tabular-nums text-ink focus:outline-none"
            />
          </div>
      </div>
      {error ? <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p> : null}
    </div>
  );
}

export function SkillReviewEngineNote({ engines }: { engines: readonly string[] }) {
  if (!engines.length) return null;
  return (
    <p className="mt-2 text-[12px] leading-relaxed text-ink-secondary" data-testid="skill-review-engine-note">
      {t("settings.experimental.skillReviewNoEngine", { engines: engines.join(", ") })}
    </p>
  );
}
