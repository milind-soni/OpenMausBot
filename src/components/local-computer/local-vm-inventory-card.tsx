import { AlertTriangle, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { Card } from "../SettingsPrimitives";
import {
  destinationLabelKeys,
  localVmInventoryState,
  type LocalVmInventoryInstance,
} from "./inventory";

export function LocalVmInventoryCard({
  instances,
  maxInstances,
  loading,
  deletingBotId,
  error,
  unavailableReason,
  onRefresh,
  onDelete,
}: {
  instances: LocalVmInventoryInstance[];
  maxInstances: number;
  loading: boolean;
  deletingBotId: string | null;
  error: string | null;
  unavailableReason: string | null;
  onRefresh: () => void;
  onDelete: (instance: LocalVmInventoryInstance) => void;
}) {
  return (
    <Card
      title={t("vm.perBot.title")}
      subtitle={t("vm.perBot.subtitle", {
        count: unavailableReason
          ? t("vm.perBot.inventoryUnavailable")
          : t("vm.perBot.created", { count: instances.length, max: maxInstances }),
      })}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="text-[12px] text-ink-secondary">
          {t("vm.perBot.deleteHint")}
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading || deletingBotId !== null}
          aria-label={t("vm.perBot.refreshAria")}
          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-hairline/40 px-2.5 py-1.5 text-[12px] text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-40"
        >
          <RefreshCw size={12} className={cn(loading && "animate-spin")} /> {t("vm.refresh")}
        </button>
      </div>

      {error && <div role="alert" className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</div>}

      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {loading
          ? t("vm.perBot.checking")
          : unavailableReason
            ? t("vm.perBot.unavailable", { reason: unavailableReason })
            : instances.length === 1
              ? t("vm.perBot.foundOne")
              : t("vm.perBot.foundMany", { count: instances.length })}
      </p>

      <div
        aria-busy={loading || deletingBotId !== null}
        className="mt-3 overflow-hidden rounded-xl border border-hairline/40"
      >
        {loading && instances.length === 0 ? (
          <div className="flex items-center gap-2 px-3 py-4 text-[13px] text-ink-secondary">
            <Loader2 size={13} className="animate-spin" /> {t("vm.perBot.checkingList")}
          </div>
        ) : unavailableReason ? (
          <div className="flex items-center gap-2 px-3 py-4 text-[13px] text-ink-secondary">
            <AlertTriangle size={14} className="shrink-0 text-warning" /> {unavailableReason}
          </div>
        ) : instances.length === 0 ? (
          <div className="px-3 py-4 text-[13px] text-ink-secondary">{t("vm.perBot.none")}</div>
        ) : instances.map((instance, index) => {
          const state = localVmInventoryState(instance);
          const deleting = deletingBotId === instance.botId;
          const managed = instance.managed === true;
          return (
            <div
              key={instance.botId}
              className={cn(
                "flex items-start justify-between gap-3 px-3 py-3",
                index > 0 && "border-t border-hairline/35",
              )}
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-[13.5px] font-medium text-ink">{instance.name}</span>
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-[11px]",
                      !managed
                        ? "bg-warning/15 text-warning"
                        : instance.inUse || instance.ready
                          ? "bg-success/15 text-success"
                          : instance.container === "stopped"
                            ? "bg-control text-ink-secondary"
                            : "bg-warning/15 text-warning",
                    )}
                  >
                    {state}
                  </span>
                </div>
                <div className="mt-1 text-[11.5px] text-ink-secondary">
                  {t("vm.perBot.destination", { destination: t(destinationLabelKeys[instance.destination]) })}
                </div>
                {!managed && (
                  <div className="mt-1 text-[11.5px] text-warning">
                    {t("vm.perBot.unmanaged")}
                  </div>
                )}
                {managed && instance.problem && !instance.inUse && (
                  <div className="mt-1 text-[11.5px] text-warning">{instance.problem}</div>
                )}
                {managed && instance.inUse && (
                  <div className="mt-1 text-[11.5px] text-ink-secondary">{t("vm.perBot.stopFirst")}</div>
                )}
              </div>
              {managed && <button
                type="button"
                onClick={() => onDelete(instance)}
                disabled={loading || instance.inUse || deletingBotId !== null}
                aria-busy={deleting || undefined}
                title={
                  instance.inUse
                    ? t("vm.perBot.deleteBlocked")
                    : t("vm.perBot.deleteTitle", { name: instance.name })
                }
                className="flex shrink-0 items-center gap-1.5 rounded-lg bg-danger/10 px-2.5 py-1.5 text-[12px] font-medium text-danger hover:bg-danger/15 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {deleting ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                {t("common.delete")}
              </button>}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

