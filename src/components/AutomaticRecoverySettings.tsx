import { useRef, useState } from "react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { t } from "@/lib/i18n";
import { LearnMore, SettingRow, SettingsRows, Switch } from "./SettingsPrimitives";
import { Select } from "./Select";

type Recovery = NonNullable<ConfigStatus["automaticRecovery"]>;

/** Backup model: one card of rows. It saves as you go (§6.11): turning it off saves at once, and turning it on saves as
 * soon as a model is chosen; until then the model row says what is missing. The provider and model rows show only while
 * the switch is on. */
export function AutomaticRecoverySettings() {
  const { state, dispatch } = useStore();
  const [draft, setDraft] = useState<Recovery | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [more, setMore] = useState(false);
  const inFlight = useRef(false);
  const value = draft ?? state.config?.automaticRecovery ?? { enabled: false };
  const engines = state.instances.filter((instance) => instance.snapshot.state === "available" && !instance.policy);
  const engineOf = (next: Recovery) => engines.find((instance) => instance.instanceId === next.backup?.instanceId);
  const modelsOf = (next: Recovery) => {
    const found = engineOf(next);
    return found?.models.options.filter((model) => !model.orgBlocked && !model.needsCliUpdate && (found.snapshot.authenticated !== false || model.custom)) ?? [];
  };
  const engine = engineOf(value);
  const models = modelsOf(value);
  const ready = models.some((model) => model.id === value.backup?.model);
  const save = async (next: Recovery) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setError("");
    try {
      const config = await api<ConfigStatus>("/api/config", {
        method: "PUT",
        body: JSON.stringify({ automaticRecovery: { enabled: next.enabled, ...(next.backup?.model ? { backup: next.backup } : {}) } }),
      });
      dispatch({ type: "configStatus", config });
      setDraft(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("settings.recovery.error"));
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };
  const change = (next: Recovery) => {
    setDraft(next);
    setError("");
    const complete = !next.enabled || modelsOf(next).some((model) => model.id === next.backup?.model);
    if (complete) void save(next);
  };
  const status = error ? <span role="alert" className="text-danger">{error}</span>
    : saving ? <span role="status">{t("settings.threads.saving")}</span>
    : value.enabled && !ready ? t("settings.recovery.required") : undefined;
  return (
    <SettingsRows selectWidth={200}>
      <SettingRow title={t("settings.recovery.enable")}
        subtitle={<span id="automatic-recovery-help">{t("settings.recovery.short")}{" "}<LearnMore onClick={() => setMore((open) => !open)} /></span>}
        message={more || (!value.enabled && error) ? <span data-recovery-more="" className="flex flex-col gap-1">
          {more && <>
            <span id="automatic-recovery-scope">{t("settings.recovery.help")}</span>
            <span>{t("settings.recovery.scopeHanded")}</span>
            <span id="automatic-recovery-own">{t("settings.recovery.ownBackups")}</span>
            <span>{t("settings.recovery.charges")}</span>
          </>}
          {!value.enabled && error && <span role="alert" className="text-danger">{error}</span>}
        </span> : undefined}>
        <Switch id="automatic-recovery-enabled" checked={value.enabled} disabled={saving || !state.config} aria-label={t("settings.recovery.enable")}
          aria-describedby="automatic-recovery-help" onClick={() => change({ ...value, enabled: !value.enabled })} />
      </SettingRow>
      {value.enabled && <SettingRow title={t("settings.recovery.engine")}>
        <Select id="automatic-recovery-engine" aria-label={t("settings.recovery.engine")} value={value.backup?.instanceId ?? ""} disabled={saving}
          onChange={(event) => change({ enabled: value.enabled, ...(event.target.value ? { backup: { instanceId: event.target.value, model: "" } } : {}) })}>
          <option value="">{t("settings.recovery.chooseEngine")}</option>
          {value.backup && !engine && <option value={value.backup.instanceId} disabled>{t("settings.recovery.unavailable", { name: value.backup.instanceId })}</option>}
          {engines.map((instance) => <option key={instance.instanceId} value={instance.instanceId}
            disabled={!instance.models.options.some((model) => instance.snapshot.authenticated !== false || model.custom)}>{instance.displayName}</option>)}
        </Select>
      </SettingRow>}
      {value.enabled && <SettingRow title={t("settings.recovery.model")} message={status}>
        <Select id="automatic-recovery-model" aria-label={t("settings.recovery.model")} value={value.backup?.model ?? ""} disabled={saving || !engine}
          onChange={(event) => change({ enabled: value.enabled, backup: { instanceId: engine!.instanceId, model: event.target.value } })}>
          <option value="">{t("settings.recovery.chooseModel")}</option>
          {value.backup?.model && !ready && <option value={value.backup.model} disabled>{t("settings.recovery.unavailable", { name: value.backup.model })}</option>}
          {models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
        </Select>
      </SettingRow>}
    </SettingsRows>
  );
}
