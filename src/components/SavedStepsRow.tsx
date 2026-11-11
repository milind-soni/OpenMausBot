import { useState } from "react";

import { savedStepsEnabled, savedStepsHere } from "@/lib/feature-flags";
import { t } from "@/lib/i18n";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { SettingRow, Switch } from "./SettingsPrimitives";

export function SavedStepsRow() {
  const { state, dispatch } = useStore();
  const on = savedStepsEnabled(state.config);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  if (!savedStepsHere(state.config)) return null;
  const toggle = async () => {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const config: ConfigStatus = await api("/api/config", { method: "PATCH", body: JSON.stringify({ features: { savedSteps: !on } }) });
      dispatch({ type: "configStatus", config });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("settings.savedSteps.error"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingRow title={t("settings.savedSteps.title")} subtitle={t("settings.savedSteps.subtitle")}>
      <div className="flex flex-col items-end gap-1">
        <Switch checked={on} disabled={saving} aria-label={t("settings.savedSteps.aria")} onClick={toggle} />
        {error && <span role="alert" className="text-[12px] text-danger">{error}</span>}
      </div>
    </SettingRow>
  );
}
