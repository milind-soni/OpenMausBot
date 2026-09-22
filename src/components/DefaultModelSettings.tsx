import { useRef, useState } from "react";
import { api, useStore, type Bot, type ConfigStatus, type ModelSelection } from "@/state/store";
import { t } from "@/lib/i18n";
import { Card } from "./SettingsPrimitives";
import { EffortRow, ModelPicker } from "./ModelPicker";

export function DefaultModelSettings() {
  const { state, dispatch } = useStore();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const available = state.instances.filter((instance) => instance.snapshot.state === "available");
  const fallback = available.find((instance) => instance.driverKind === "claudeAgent") ?? available[0];
  const selection = state.config?.defaultModelSelection ?? {
    instanceId: fallback?.instanceId ?? "", model: fallback?.models.default ?? "",
  };
  const instance = state.instances.find((candidate) => candidate.instanceId === selection.instanceId);
  // The controlled picker never dispatches a mutation for this presentation-only bot.
  const bot: Bot = {
    id: "new-bot-default", threadId: "new-bot-default", name: "", title: "", description: "",
    notifications: false, color: "green", unread: false, messages: [], modelSelection: selection, busy: saving,
  };
  const save = async (next: ModelSelection) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true); setSaved(false); setError("");
    try {
      const config: ConfigStatus = await api("/api/config", {
        method: "PATCH", body: JSON.stringify({ defaultModelSelection: next }),
      });
      dispatch({ type: "configStatus", config });
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("settings.defaultModel.error"));
    } finally {
      inFlight.current = false; setSaving(false);
    }
  };
  return <Card title={t("settings.defaultModel.title")} subtitle={t("settings.defaultModel.hint")}>
    <ModelPicker bot={bot} contained onSelectionChange={(next) => void save(next)} selectionHint={t("settings.defaultModel.hint")} />
    <EffortRow bot={bot} onSelectionChange={(next) => void save(next)} className="mt-3"
      label={<span className="text-[13px] font-medium text-ink">{t(instance?.capabilities?.modelVariants ? "settings.defaultModel.reasoning" : "settings.defaultModel.effort")}</span>} />
    {(saving || saved) && <p role="status" className="mt-2 text-[12px] text-ink-secondary">{t(saving ? "settings.defaultModel.saving" : "settings.defaultModel.saved")}</p>}
    {error && <p role="alert" className="mt-2 text-[13px] text-danger">{error}</p>}
  </Card>;
}
