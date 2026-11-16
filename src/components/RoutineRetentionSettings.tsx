import { useRef, useState } from "react";
import { t } from "@/lib/i18n";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { SettingRow, SettingsGroup, SettingsRows, Switch } from "./SettingsPrimitives";

export function RoutineRetentionSettings() {
  const { state, dispatch } = useStore();
  const threads = state.config?.threads;
  const days = threads?.routineExecutionRetentionDays ?? null;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const saving = useRef(false);
  if (!threads?.routineExecutionRetentionSupported) return null;

  const toggle = async () => {
    if (saving.current) return;
    saving.current = true;
    setPending(true);
    setError("");
    try {
      const config: ConfigStatus = await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify({ routineExecutionRetentionDays: days === null ? 7 : null }),
      });
      dispatch({ type: "configStatus", config });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("settings.routineRetention.error"));
    } finally {
      saving.current = false;
      setPending(false);
    }
  };

  return <SettingsGroup label={t("settings.routineRetention.group")} block="routine-cleanup">
    <SettingsRows>
      <SettingRow title={t("settings.routineRetention.title")}
        subtitle={t("settings.routineRetention.description", { days: days ?? 7 })}
        message={pending ? <span role="status">{t("settings.threadCleanup.saving")}</span>
          : error ? <span role="alert" className="text-danger">{error}</span> : undefined}>
        <Switch id="routine-retention-enabled" checked={days !== null} disabled={pending}
          aria-label={t("settings.routineRetention.title")} onClick={() => void toggle()} />
      </SettingRow>
    </SettingsRows>
  </SettingsGroup>;
}
