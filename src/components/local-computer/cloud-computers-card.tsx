import { AlertTriangle, Cloud, Loader2, Moon, RefreshCw, Trash2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { Card } from "../SettingsPrimitives";
import {
  cloudComputerCanSleep,
  cloudComputerInventoryStateKind,
  computerStateLabel,
  type CloudComputerInventoryInstance,
  type PendingCloudAction,
} from "./inventory";

export function CloudComputersCard({
  instances,
  configured,
  loading,
  pending,
  error,
  unavailableReason,
  onRefresh,
  onSleep,
  onDelete,
}: {
  instances: CloudComputerInventoryInstance[];
  configured: boolean | null;
  loading: boolean;
  pending: PendingCloudAction;
  error: string | null;
  unavailableReason: string | null;
  onRefresh: () => void;
  onSleep: (instance: CloudComputerInventoryInstance) => void;
  onDelete: (instance: CloudComputerInventoryInstance) => void;
}) {
  return (
    <Card
      title={t("vm.cloud.title")}
      subtitle={t("vm.cloud.subtitle")}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="text-[12px] text-ink-secondary">
          {configured === true
            ? t("vm.cloud.includesOrphans")
            : configured === false
              ? t("vm.cloud.needsKey")
              : t("vm.cloud.refreshHint")}
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading || pending !== null}
          aria-label={t("vm.cloud.refreshAria")}
          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-hairline/40 px-2.5 py-1.5 text-[12px] text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-40"
        >
          <RefreshCw size={12} className={cn(loading && "animate-spin")} /> {t("vm.refresh")}
        </button>
      </div>

      {error && <div role="alert" className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</div>}

      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {loading
          ? t("vm.cloud.checking")
          : unavailableReason
            ? t("vm.cloud.unavailable", { reason: unavailableReason })
            : configured === false
              ? t("vm.cloud.notConnected")
              : instances.length === 1
                ? t("vm.cloud.foundOne")
                : t("vm.cloud.foundMany", { count: instances.length })}
      </p>

      <div
        aria-busy={loading || pending !== null}
        className="mt-3 overflow-hidden rounded-xl border border-hairline/40"
      >
        {loading && instances.length === 0 ? (
          <div className="flex items-center gap-2 px-3 py-4 text-[13px] text-ink-secondary">
            <Loader2 size={13} className="animate-spin" /> {t("vm.cloud.checkingList")}
          </div>
        ) : unavailableReason ? (
          <div className="flex items-center gap-2 px-3 py-4 text-[13px] text-ink-secondary">
            <AlertTriangle size={14} className="shrink-0 text-warning" /> {unavailableReason}
          </div>
        ) : configured === false ? (
          <div className="flex items-center gap-2 px-3 py-4 text-[13px] text-ink-secondary">
            <Cloud size={14} className="shrink-0" /> {t("vm.cloud.notConnected")}
          </div>
        ) : instances.length === 0 ? (
          <div className="px-3 py-4 text-[13px] text-ink-secondary">{t("vm.cloud.noneFound")}</div>
        ) : instances.map((instance, index) => {
          const kind = cloudComputerInventoryStateKind(instance);
          const state = computerStateLabel(kind);
          const isPending = pending?.boxId === instance.boxId;
          const canSleep = cloudComputerCanSleep(instance);
          const isRemoving = kind === "removing";
          return (
            <div
              key={instance.boxId}
              className={cn(
                "flex items-start justify-between gap-3 px-3 py-3",
                index > 0 && "border-t border-hairline/35",
              )}
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-[13.5px] font-medium text-ink">
                    {instance.orphaned ? t("vm.cloud.orphan") : instance.ownerName}
                  </span>
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-[11px]",
                      instance.inUse || kind === "running"
                        ? "bg-success/15 text-success"
                        : kind === "sleeping" || kind === "going-to-sleep"
                          ? "bg-control text-ink-secondary"
                          : "bg-warning/15 text-warning",
                    )}
                  >
                    {state}
                  </span>
                </div>
                <div className="mt-1 break-all text-[11.5px] text-ink-secondary">
                  {instance.orphaned ? t("vm.owner.gone") : t("vm.owner.owned")} · {instance.name}
                </div>
                {instance.inUse && (
                  <div className="mt-1 text-[11.5px] text-ink-secondary">{t("vm.cloud.stopFirst")}</div>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => onSleep(instance)}
                  disabled={loading || instance.inUse || pending !== null || !canSleep}
                  aria-busy={isPending && pending?.action === "sleep" ? true : undefined}
                  title={canSleep ? t("vm.cloud.sleepTitle") : t("vm.cloud.sleepBlocked", { state: state.toLowerCase() })}
                  className="flex items-center gap-1.5 rounded-lg border border-hairline/40 px-2.5 py-1.5 text-[12px] text-ink-secondary hover:bg-control hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {isPending && pending?.action === "sleep" ? <Loader2 size={12} className="animate-spin" /> : <Moon size={12} />}
                  {t("vm.cloud.sleep")}
                </button>
                <button
                  type="button"
                  onClick={() => onDelete(instance)}
                  disabled={loading || instance.inUse || pending !== null || isRemoving}
                  aria-busy={isPending && pending?.action === "delete" ? true : undefined}
                  title={t("vm.cloud.deleteTitle")}
                  className="flex items-center gap-1.5 rounded-lg bg-danger/10 px-2.5 py-1.5 text-[12px] font-medium text-danger hover:bg-danger/15 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {isPending && pending?.action === "delete" ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                  {t("common.delete")}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

