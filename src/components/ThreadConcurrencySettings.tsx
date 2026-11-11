import { useRef, useState } from "react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { t } from "@/lib/i18n";
import { SettingRow } from "./SettingsPrimitives";
import { Select } from "./Select";

export function ThreadConcurrencySettings() {
  const { state, dispatch } = useStore();
  const confirmed = state.config?.threads?.maxConcurrentPerBot ?? 3;
  const oneThreadPerBot = state.config?.cloudStarter === true;
  const [pending, setPending] = useState<number | null>(null);
  const [error, setError] = useState("");
  const saving = useRef(false);
  const save = async (limit: number) => {
    if (saving.current || limit === confirmed) return;
    saving.current = true;
    setPending(limit);
    setError("");
    try {
      const config: ConfigStatus = await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify({ threads: { maxConcurrentPerBot: limit } }),
      });
      dispatch({ type: "configStatus", config });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("settings.threads.error"));
    } finally {
      saving.current = false;
      setPending(null);
    }
  };
  return (
    <div data-settings-block="parallel" className="contents">
      <SettingRow title={t("settings.threads.title")} subtitle={oneThreadPerBot ? t("settings.threads.starterShort") : t("settings.threads.short")}
        message={pending !== null ? <span role="status">{t("settings.threads.saving")}</span> : error ? <span role="alert" className="text-danger">{error}</span> : undefined}>
        <Select id="thread-concurrency" aria-label={t("settings.threads.label")} title={t("settings.threads.helpHanded")} value={pending ?? confirmed} disabled={pending !== null || oneThreadPerBot}
          onChange={(event) => void save(Number(event.target.value))}>
          {Array.from({ length: 16 }, (_, i) => i + 1).map((limit) => <option key={limit} value={limit}>{limit}</option>)}
        </Select>
      </SettingRow>
    </div>
  );
}
