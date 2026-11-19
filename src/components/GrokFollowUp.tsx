import { useState } from "react";
import { t } from "@/lib/i18n";
import { api, type InstanceInfo } from "@/state/store";
import { useStoreActions } from "@/state/store-select";
import { MENU_SEPARATOR } from "./menu-recipe";
import { SettingRow, Switch } from "./SettingsPrimitives";

export function GrokFollowUp({ instance, compact = false }: { instance?: InstanceInfo; compact?: boolean }) {
  const { refreshInstances } = useStoreActions();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  if (instance?.driverKind !== "grokAgent" || instance.readOnly || instance.snapshot.authenticated !== true || instance.followUpBehavior === undefined) return null;
  const label = t("engines.grokSteering");
  const description = t("engines.grokFollowUp");
  const checked = instance.followUpBehavior === "steer";
  const unavailable = instance.followUpBehavior === "unreadable";

  const instanceId = instance.instanceId;

  async function save() {
    setSaving(true);
    setError(false);
    try {
      await api(`/api/instances/${encodeURIComponent(instanceId)}`, {
        method: "PATCH",
        body: JSON.stringify({ followUpBehavior: checked ? "queue" : "steer" }),
      });
    } catch {
      setError(true);
    } finally {
      try {
        await refreshInstances({ reportErrors: true });
      } catch {
        setError(true);
      }
      setSaving(false);
    }
  }

  const status = (error || unavailable) && <span role="status" className="text-ink-secondary">{t("serverError.instance.grokFollowUpUnavailable")}</span>;
  const toggle = <Switch
    aria-label={label}
    checked={checked}
    compact={compact}
    disabled={saving || unavailable}
    data-menu-row={compact ? "" : undefined}
    onClick={save}
  />;
  return compact ? (
    <>
      <div role="separator" className={MENU_SEPARATOR} />
      <div className="flex shrink-0 items-center gap-3 px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="text-[13px] text-ink">{label}</p>
          <p className="text-[12px] text-ink-secondary">{description}</p>
          {status && <p className="mt-1 text-[12px]">{status}</p>}
        </div>
        {toggle}
      </div>
    </>
  ) : (
    <SettingRow title={label} subtitle={description} message={status}>{toggle}</SettingRow>
  );
}
