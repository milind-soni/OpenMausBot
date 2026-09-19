import { AlertTriangle, Loader2, RefreshCw, Server, Trash2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { Card } from "../SettingsPrimitives";
import {
  computerStateLabel,
  vpsComputerInventoryStateKind,
  vpsComputerShortId,
  type VpsComputerInventoryInstance,
} from "./inventory";

export function VpsComputersCard({
  instances,
  configured,
  sshAlias,
  loading,
  removingName,
  error,
  unavailableReason,
  onRefresh,
  onRemove,
}: {
  instances: VpsComputerInventoryInstance[];
  configured: boolean | null;
  sshAlias: string | null;
  loading: boolean;
  removingName: string | null;
  error: string | null;
  unavailableReason: string | null;
  onRefresh: () => void;
  onRemove: (instance: VpsComputerInventoryInstance) => void;
}) {
  return (
    <Card
      title={t("vm.vps.title")}
      subtitle={t("vm.vps.subtitle")}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="text-[12px] text-ink-secondary">
          {configured === true
            ? t("vm.vps.sshHost", { alias: sshAlias ?? t("vm.vps.configuredFallback") })
            : configured === false
              ? t("vm.vps.needsAlias")
              : t("vm.vps.refreshHint")}
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading || removingName !== null}
          aria-label={t("vm.vps.refreshAria")}
          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-hairline/40 px-2.5 py-1.5 text-[12px] text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-40"
        >
          <RefreshCw size={12} className={cn(loading && "animate-spin")} /> {t("vm.refresh")}
        </button>
      </div>

      {error && <div role="alert" className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</div>}

      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {loading
          ? t("vm.vps.checking")
          : unavailableReason
            ? t("vm.vps.unavailable", { reason: unavailableReason })
            : configured === false
              ? t("vm.vps.notConfigured")
              : instances.length === 1
                ? t("vm.vps.foundOne")
                : t("vm.vps.foundMany", { count: instances.length })}
      </p>

      <div
        aria-busy={loading || removingName !== null}
        className="mt-3 overflow-hidden rounded-xl border border-hairline/40"
      >
        {loading && instances.length === 0 ? (
          <div className="flex items-center gap-2 px-3 py-4 text-[13px] text-ink-secondary">
            <Loader2 size={13} className="animate-spin" /> {t("vm.vps.checkingList")}
          </div>
        ) : unavailableReason ? (
          <div className="flex items-center gap-2 px-3 py-4 text-[13px] text-ink-secondary">
            <AlertTriangle size={14} className="shrink-0 text-warning" /> {unavailableReason}
          </div>
        ) : configured === false ? (
          <div className="flex items-center gap-2 px-3 py-4 text-[13px] text-ink-secondary">
            <Server size={14} className="shrink-0" /> {t("vm.vps.notConfigured")}
          </div>
        ) : instances.length === 0 ? (
          <div className="px-3 py-4 text-[13px] text-ink-secondary">{t("vm.vps.noneFound")}</div>
        ) : instances.map((instance, index) => {
          const kind = vpsComputerInventoryStateKind(instance);
          const state = computerStateLabel(kind);
          const removing = removingName === instance.name;
          const shortId = vpsComputerShortId(instance.name);
          return (
            <div
              key={instance.name}
              className={cn(
                "flex items-start justify-between gap-3 px-3 py-3",
                index > 0 && "border-t border-hairline/35",
              )}
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-[13.5px] font-medium text-ink">
                    {instance.orphaned ? t("vm.vps.orphan", { id: shortId }) : instance.ownerName}
                  </span>
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-[11px]",
                      instance.inUse || kind === "running"
                        ? "bg-success/15 text-success"
                        : kind === "stopped" || kind === "paused"
                          ? "bg-control text-ink-secondary"
                          : "bg-warning/15 text-warning",
                    )}
                  >
                    {state}
                  </span>
                </div>
                <div className="mt-1 text-[11.5px] text-ink-secondary">
                  {instance.orphaned ? t("vm.owner.gone") : t("vm.owner.owned")}
                </div>
                {instance.inUse && (
                  <div className="mt-1 text-[11.5px] text-ink-secondary">{t("vm.vps.stopFirst")}</div>
                )}
              </div>
              <button
                type="button"
                onClick={() => onRemove(instance)}
                disabled={loading || instance.inUse || removingName !== null}
                aria-busy={removing || undefined}
                title={t("vm.vps.removeTitle")}
                className="flex shrink-0 items-center gap-1.5 rounded-lg bg-danger/10 px-2.5 py-1.5 text-[12px] font-medium text-danger hover:bg-danger/15 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {removing ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                {t("vm.vps.remove")}
              </button>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

