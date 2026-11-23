import { useState } from "react";

import { t } from "@/lib/i18n";
import { useAdvancedMode } from "@/lib/interface-mode";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { api, type Bot } from "@/state/store";
import { useStoreSelector } from "@/state/store-select";
import { Select } from "../Select";
import { SettingRow } from "../SettingsPrimitives";
import type { useMemoryUpkeepStatus } from "./use-memory-upkeep-status";

export function MemoryModelSetting({ bot, upkeep, className }: {
  bot: Bot;
  upkeep: ReturnType<typeof useMemoryUpkeepStatus>;
  className?: string;
}) {
  const { status, readError, reload } = upkeep;
  const setting = status?.memoryModel;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const canEdit = useOwnerOrAdmin();
  const models = useStoreSelector((state) => state.instances?.find((instance) => instance.instanceId === setting?.instanceId)?.models.options);
  // Advanced only: Simple has no picker and no status line for it.
  const advanced = useAdvancedMode();

  if (!advanced || (!setting && readError === null)) return null;
  const showSavedChoice = Boolean(setting?.model && !models?.some((model) => model.id === setting.model));
  const save = async (model: string) => {
    if (!setting) return;
    setSaving(true);
    setError("");
    try {
      await api(`/api/bots/${encodeURIComponent(bot.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ memoryModel: model ? { instanceId: setting.instanceId, model } : null }),
      });
      await reload();
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : t("common.tryAgain"));
    } finally {
      setSaving(false);
    }
  };

  const last = setting?.last;
  const note = last?.state === "fallback" ? t("memory.upkeep.modelFallback", { model: last.model, used: last.used })
    : last?.state === "failed" ? t(`memory.upkeep.modelFailure.${last.reason}`, { model: last.model }) : null;
  const message = readError !== null
    ? <span role="alert" className="text-danger">{t("memory.upkeep.modelReadFailed", { detail: readError })}</span>
    : error ? <span role="alert" className="text-danger">{error}</span>
      : note ? <span role="status" className="break-words text-ink-secondary">{note}</span> : null;
  return (
    <div data-panel-row="memory-model" className={className}>
      <SettingRow title={t("memory.upkeep.model")} message={message} className="py-3">
        {readError !== null ? (
          <button type="button" className="ui-button h-8 px-3 text-[13px]" onClick={() => void reload()}>{t("common.tryAgain")}</button>
        ) : setting && (
          <Select size="sm" className="max-w-full" aria-label={t("memory.upkeep.model")} value={setting.model ?? ""}
            disabled={saving || canEdit !== true} onChange={(event) => void save(event.target.value)}>
            <option value="">{t("memory.upkeep.modelAuto")}</option>
            {showSavedChoice && <option value={setting.model}>{setting.model}</option>}
            {models?.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
          </Select>
        )}
      </SettingRow>
    </div>
  );
}
