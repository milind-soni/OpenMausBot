import { useEffect, useRef, useState } from "react";

import {
  MAX_TOOL_ERROR_CORRECTIVE_ROUNDS,
  parseToolErrorCorrectiveRounds,
} from "@/lib/tool-error-recovery";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { t } from "@/lib/i18n";

export function ToolErrorRecoverySettings() {
  const { state, dispatch } = useStore();
  const confirmedRounds = state.config?.toolErrors?.correctiveRounds ?? 0;
  const [value, setValue] = useState(String(confirmedRounds));
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const saveInFlight = useRef(false);

  useEffect(() => {
    if (!dirty) setValue(String(confirmedRounds));
  }, [confirmedRounds, dirty]);

  const save = async () => {
    if (!dirty || saveInFlight.current) return;
    const parsed = parseToolErrorCorrectiveRounds(value);
    if (!parsed.ok) {
      setError(t("settings.toolErrors.range"));
      return;
    }
    saveInFlight.current = true;
    setSaving(true);
    try {
      const config: ConfigStatus = await api("/api/config", {
        method: "PUT",
        body: JSON.stringify({ toolErrors: { correctiveRounds: parsed.rounds } }),
      });
      dispatch({ type: "configStatus", config });
      setValue(String(config.toolErrors.correctiveRounds));
      setDirty(false);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("settings.toolErrors.error"));
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor="tool-error-recovery" className="text-[13px] font-medium text-ink">
        {t("settings.toolErrors.label")}
      </label>
      <div
        className={`flex max-w-[220px] items-center rounded-lg border bg-inset ${
          error ? "border-danger/60" : "border-hairline/40 focus-within:border-focus"
        }`}
      >
        <input
          id="tool-error-recovery"
          type="number"
          min={0}
          max={MAX_TOOL_ERROR_CORRECTIVE_ROUNDS}
          step={1}
          inputMode="numeric"
          value={value}
          disabled={saving}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? "tool-error-recovery-error tool-error-recovery-help" : "tool-error-recovery-help"}
          onChange={(event) => {
            setValue(event.target.value);
            setDirty(true);
            setError("");
          }}
          onBlur={() => void save()}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          className="min-w-0 flex-1 bg-transparent px-3 py-2 text-[14px] tabular-nums text-ink focus:outline-none"
        />
        <span className="pr-3 text-[13px] text-ink-secondary">{t("settings.toolErrors.rounds")}</span>
      </div>
      <p id="tool-error-recovery-help" className="text-[12px] leading-relaxed text-ink-secondary">
        {t("settings.toolErrors.help")}
      </p>
      {error ? (
        <p id="tool-error-recovery-error" role="alert" className="text-[12px] text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
