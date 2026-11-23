import { useEffect, useState } from "react";

import type { MemoryModelStatus } from "../../../shared/memory-model";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { fetchUpkeepStatus } from "@/lib/memory";
import { useMinuteTick } from "@/lib/minute-tick";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { api, type Bot } from "@/state/store";
import { useStoreSelector } from "@/state/store-select";
import { Select } from "../Select";

export function MemoryModelSetting({ bot, active = true, className = "px-3.5" }: { bot: Bot; active?: boolean; className?: string }) {
  const [setting, setSetting] = useState<MemoryModelStatus>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const minute = useMinuteTick();
  const canEdit = useOwnerOrAdmin();
  const botInstanceId = bot.modelSelection.instanceId;
  const models = useStoreSelector((state) => state.instances?.find((instance) => instance.instanceId === setting?.instanceId)?.models.options);

  useEffect(() => {
    if (!active || saving) return;
    let current = true;
    void fetchUpkeepStatus(bot.id).then(({ memoryModel }) => {
      if (current) setSetting(memoryModel);
    }).catch(() => {});
    return () => { current = false; };
  }, [active, bot.id, bot.busy, botInstanceId, minute, saving]);

  if (!setting) return null;
  const { instanceId } = setting;
  const showSavedChoice = Boolean(setting.model && !models?.some((model) => model.id === setting.model));
  const save = async (model: string) => {
    setSaving(true);
    setError("");
    try {
      await api(`/api/bots/${encodeURIComponent(bot.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ memoryModel: model ? { instanceId, model } : null }),
      });
      setSetting({ instanceId, ...(model ? { model } : {}) });
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : t("common.tryAgain"));
    } finally {
      setSaving(false);
    }
  };

  const last = setting.last;
  return (
    <div data-panel-row="memory-model" className={cn("border-t border-hairline/40 py-3", className)}>
      <label className="flex flex-wrap items-center justify-between gap-2 text-[13px] font-medium text-ink">
        {t("memory.upkeep.model")}
        <Select size="sm" className="max-w-full sm:max-w-[65%]" value={setting.model ?? ""} disabled={saving || canEdit !== true}
          onChange={(event) => void save(event.target.value)}>
          <option value="">{t("memory.upkeep.modelAuto")}</option>
          {showSavedChoice && <option value={setting.model}>{setting.model}</option>}
          {models?.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
        </Select>
      </label>
      {last?.state === "fallback" && (
        <p role="status" className="mt-2 break-words text-[12px] text-ink-secondary">
          {t("memory.upkeep.modelFallback", { model: last.model, used: last.used })}
        </p>
      )}
      {last?.state === "failed" && (
        <p role="status" className="mt-2 break-words text-[12px] text-ink-secondary">
          {t(`memory.upkeep.modelFailure.${last.reason}`, { model: last.model })}
        </p>
      )}
      {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
    </div>
  );
}
