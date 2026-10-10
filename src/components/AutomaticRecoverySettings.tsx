import { useRef, useState } from "react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { t } from "@/lib/i18n";
import { Card, Switch } from "./SettingsPrimitives";

type Recovery = NonNullable<ConfigStatus["automaticRecovery"]>;

export function AutomaticRecoverySettings() {
  const { state, dispatch } = useStore();
  const [draft, setDraft] = useState<Recovery | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const value = draft ?? state.config?.automaticRecovery ?? { enabled: false };
  const engines = state.instances.filter((instance) => instance.snapshot.state === "available" && !instance.policy);
  const engine = engines.find((instance) => instance.instanceId === value.backup?.instanceId);
  const models = engine?.models.options.filter((model) => engine.snapshot.authenticated !== false || model.custom) ?? [];
  const ready = models.some((model) => model.id === value.backup?.model);
  const change = (next: Recovery) => { setDraft(next); setError(""); };
  const save = async () => {
    if (!draft || inFlight.current || (value.enabled && !ready)) return;
    inFlight.current = true;
    setSaving(true);
    setError("");
    try {
      const config = await api<ConfigStatus>("/api/config", {
        method: "PUT",
        body: JSON.stringify({ automaticRecovery: { enabled: draft.enabled, ...(draft.backup?.model ? { backup: draft.backup } : {}) } }),
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
  return (
    <Card title={t("settings.recovery.title")}>
      <div className="flex items-center justify-between gap-4">
        <label htmlFor="automatic-recovery-enabled" className="text-[13px] font-medium text-ink">{t("settings.recovery.enable")}</label>
        <Switch id="automatic-recovery-enabled" checked={value.enabled} disabled={saving || !state.config}
          aria-describedby="automatic-recovery-help automatic-recovery-scope"
          onClick={() => change({ ...value, enabled: !value.enabled })} />
      </div>
      <p id="automatic-recovery-help" className="mt-2 text-[12px] leading-relaxed text-ink-secondary">{t("settings.recovery.help")}</p>
      <p id="automatic-recovery-scope" className="mt-2 text-[12px] leading-relaxed text-ink-secondary">{t("settings.recovery.scope")}</p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="min-w-0">
          <label htmlFor="automatic-recovery-engine" className="block text-[13px] font-medium text-ink">{t("settings.recovery.engine")}</label>
          <select id="automatic-recovery-engine" value={value.backup?.instanceId ?? ""} disabled={saving || !value.enabled}
            onChange={(event) => change({ enabled: value.enabled, ...(event.target.value ? { backup: { instanceId: event.target.value, model: "" } } : {}) })}
            className="mt-2 w-full min-w-0 cursor-pointer rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink disabled:opacity-50">
            <option value="">{t("settings.recovery.chooseEngine")}</option>
            {value.backup && !engine && <option value={value.backup.instanceId} disabled>{t("settings.recovery.unavailable", { name: value.backup.instanceId })}</option>}
            {engines.map((instance) => <option key={instance.instanceId} value={instance.instanceId}
              disabled={!instance.models.options.some((model) => instance.snapshot.authenticated !== false || model.custom)}>{instance.displayName}</option>)}
          </select>
        </div>
        <div className="min-w-0">
          <label htmlFor="automatic-recovery-model" className="block text-[13px] font-medium text-ink">{t("settings.recovery.model")}</label>
          <select id="automatic-recovery-model" value={value.backup?.model ?? ""} disabled={saving || !value.enabled || !engine}
            onChange={(event) => change({ enabled: value.enabled, backup: { instanceId: engine!.instanceId, model: event.target.value } })}
            className="mt-2 w-full min-w-0 cursor-pointer rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink disabled:opacity-50">
            <option value="">{t("settings.recovery.chooseModel")}</option>
            {value.backup?.model && !ready && <option value={value.backup.model} disabled>{t("settings.recovery.unavailable", { name: value.backup.model })}</option>}
            {models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
          </select>
        </div>
      </div>
      <p className="mt-2 text-[12px] leading-relaxed text-ink-secondary">{t("settings.recovery.charges")}</p>
      {value.enabled && !ready && <p className="mt-2 text-[12px] text-ink-secondary">{t("settings.recovery.required")}</p>}
      <button type="button" disabled={!draft || saving || (value.enabled && !ready)} onClick={() => void save()}
        className="mt-3 cursor-pointer rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-white disabled:opacity-50">{saving ? t("settings.threads.saving") : t("common.save")}</button>
      {saving && <span role="status" className="sr-only">{t("settings.threads.saving")}</span>}
      {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
    </Card>
  );
}
