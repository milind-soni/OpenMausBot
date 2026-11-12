import { useState } from "react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { t } from "@/lib/i18n";
import { quotaSwitchEnabled } from "@/lib/feature-flags";
import { SettingRow, SettingsRows, Switch } from "./SettingsPrimitives";

/** The automatic switch to another AI when a bot's AI reaches its usage limit. On unless turned off here; it saves at once. */
export function QuotaSwitchSetting() {
  const { state, dispatch } = useStore();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const on = quotaSwitchEnabled(state.config);
  const toggle = async () => {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const config = await api<ConfigStatus>("/api/config", { method: "PATCH", body: JSON.stringify({ features: { quotaSwitch: !on } }) });
      dispatch({ type: "configStatus", config });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("settings.quotaSwitch.error"));
    } finally {
      setSaving(false);
    }
  };
  return (
    <SettingsRows>
      <SettingRow title={t("settings.quotaSwitch.title")} subtitle={<span id="quota-switch-help">{t("settings.quotaSwitch.help")}</span>}
        message={error ? <span role="alert" className="text-danger">{error}</span> : undefined}>
        <Switch id="quota-switch-enabled" checked={on} disabled={saving || !state.config} aria-label={t("settings.quotaSwitch.title")}
          aria-describedby="quota-switch-help" onClick={() => void toggle()} />
      </SettingRow>
    </SettingsRows>
  );
}
