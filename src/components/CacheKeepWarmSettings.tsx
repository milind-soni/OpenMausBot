import { useRef, useState } from "react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { t } from "@/lib/i18n";
import { SettingRow, Switch } from "./SettingsPrimitives";
import { productName } from "@/lib/brand";
import { Select } from "./Select";

type KeepWarm = NonNullable<ConfigStatus["cacheKeepWarm"]>;

/** 3h matches Cache Tax's auto-warm window. */
export const KEEP_WARM_WINDOWS = [60, 120, 180, 360, 720] as const;

export function CacheKeepWarmSettings() {
  const { state, dispatch } = useStore();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const current = state.config?.cacheKeepWarm;
  if (!current) return null;
  const save = async (next: KeepWarm) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setError("");
    try {
      const config = await api<ConfigStatus>("/api/config", {
        method: "PUT",
        body: JSON.stringify({ cacheKeepWarm: { enabled: next.enabled, windowMinutes: next.windowMinutes } }),
      });
      dispatch({ type: "configStatus", config });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("settings.keepWarm.error"));
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };
  const windows: number[] = KEEP_WARM_WINDOWS.includes(current.windowMinutes as typeof KEEP_WARM_WINDOWS[number])
    ? [...KEEP_WARM_WINDOWS] : [...KEEP_WARM_WINDOWS, current.windowMinutes].sort((a, b) => a - b);
  return <>
    <SettingRow title={t("settings.keepWarm.title")} subtitle={t("settings.keepWarm.short")}
      message={error ? <span role="alert" className="text-danger">{error}</span> : saving ? <span role="status" className="sr-only">{t("settings.threads.saving")}</span> : undefined}>
      <Switch id="cache-keepwarm-enabled" checked={current.enabled} disabled={saving} aria-label={t("settings.keepWarm.enable")} title={`${t("settings.keepWarm.help", { app: productName() })} ${t("settings.keepWarm.cost")}`}
        onClick={() => void save({ ...current, enabled: !current.enabled })} />
    </SettingRow>
    {current.enabled && (
      <SettingRow title={t("settings.keepWarm.window")}>
        <Select id="cache-keepwarm-window" aria-label={t("settings.keepWarm.window")} value={current.windowMinutes} disabled={saving}
          onChange={(event) => void save({ ...current, windowMinutes: Number(event.target.value) })}>
          {windows.map((minutes) => (
            <option key={minutes} value={minutes}>{t("settings.keepWarm.hours", { hours: Number((minutes / 60).toFixed(2)) })}</option>
          ))}
        </Select>
      </SettingRow>
    )}
  </>;
}
