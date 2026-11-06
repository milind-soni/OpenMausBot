import { AlertTriangle, Cloud, Loader2, Moon, RefreshCw, Trash2 } from 'lucide-react';
import { t } from '@/lib/i18n';
import type { LocaleKey } from '@/locales';
import { cn } from '@/lib/cn';
import { localizeComputerProblem } from '@/lib/computer-messages';
import { jsonPostRequest, type ComputerApiRequest } from '@/lib/computer-requests';
import { Card } from './SettingsPrimitives';
import { KeysLink } from './keys/KeysLink';
export interface LocalVmInventoryInstance {
  botId: string;
  name: string;
  destination: "auto" | "cloud" | "vm" | "local" | "browser" | "off";
  container: "running" | "stopped";
  ready: boolean;
  managed: boolean;
  problem: string | null;
  inUse: boolean;
}

export interface LocalVmInventoryPayload {
  instances: LocalVmInventoryInstance[];
  maxInstances: number;
  available: boolean;
  problem: string | null;
}

export interface CloudComputerInventoryInstance {
  boxId: string;
  name: string;
  state: string;
  ownerBotId: string | null;
  ownerName: string | null;
  orphaned: boolean;
  inUse: boolean;
}

export interface CloudComputerInventoryPayload {
  configured: boolean;
  available: boolean;
  problem: string | null;
  instances: CloudComputerInventoryInstance[];
}

export type CloudAction = "sleep" | "delete";
export type PendingCloudAction = { boxId: string; action: CloudAction } | null;
export type CloudPostActionOverride = "deleted" | "deleting" | "sleeping";
export type CloudPostActionOverrides = Record<string, CloudPostActionOverride>;

export const PENDING_CLOUD_DELETE_REFRESH_DELAYS_MS = [1_000, 2_000, 4_000] as const;

export function waitForCloudDeleteRefresh(delayMs: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, delayMs));
}

export interface VpsComputerInventoryInstance {
  name: string;
  state: "created" | "restarting" | "running" | "removing" | "paused" | "exited" | "dead" | "unknown";
  /** The SSH alias whose host holds this computer. */
  vpsAlias: string;
  ownerBotId: string | null;
  ownerName: string | null;
  orphaned: boolean;
  inUse: boolean;
}

export interface VpsComputerInventoryPayload {
  configured: boolean;
  available: boolean;
  /** The default alias first, then each bot's own. */
  vpsAliases: string[];
  problem: string | null;
  instances: VpsComputerInventoryInstance[];
}

const destinationLabelKeys: Record<LocalVmInventoryInstance["destination"], LocaleKey> = {
  auto: "vm.dest.auto",
  cloud: "place.cloud",
  vm: "vm.dest.vm",
  local: "vm.dest.local",
  browser: "vm.dest.browser",
  off: "vm.dest.off",
};

export type ComputerStateKind =
  | "unmanaged"
  | "in-use"
  | "stopped"
  | "running"
  | "attention"
  | "sleeping"
  | "going-to-sleep"
  | "starting"
  | "restarting"
  | "removing"
  | "paused";

const stateLabelKeys: Record<ComputerStateKind, LocaleKey> = {
  unmanaged: "vm.state.notManaged",
  "in-use": "vm.state.inUse",
  stopped: "vm.state.stopped",
  running: "vm.state.running",
  attention: "vm.state.attention",
  sleeping: "vm.state.sleeping",
  "going-to-sleep": "vm.state.goingToSleep",
  starting: "vm.state.starting",
  restarting: "vm.state.restarting",
  removing: "vm.state.removing",
  paused: "vm.state.paused",
};

export function computerStateLabel(kind: ComputerStateKind): string {
  return t(stateLabelKeys[kind]);
}

export function localVmInventoryStateKind(instance: LocalVmInventoryInstance): ComputerStateKind {
  if (!instance.managed) return "unmanaged";
  if (instance.inUse) return "in-use";
  if (instance.container === "stopped") return "stopped";
  if (instance.ready) return "running";
  return "attention";
}

export function localVmInventoryState(instance: LocalVmInventoryInstance): string {
  return computerStateLabel(localVmInventoryStateKind(instance));
}

export function cloudComputerInventoryStateKind(
  instance: CloudComputerInventoryInstance,
): ComputerStateKind {
  if (instance.inUse) return "in-use";
  if (instance.state === "removing") return "removing";
  if (instance.state === "archived") return "sleeping";
  if (instance.state === "archiving") return "going-to-sleep";
  if (["idle", "ready", "running"].includes(instance.state)) return "running";
  if (["init", "provisioning", "provisioned", "cloning"].includes(instance.state)) return "starting";
  return "attention";
}

export function cloudComputerInventoryState(instance: CloudComputerInventoryInstance): string {
  return computerStateLabel(cloudComputerInventoryStateKind(instance));
}

/** Boat's account LIST is eventually consistent: an older snapshot must not undo an action the provider accepted. */
export function reconcileCloudInventorySnapshot(
  incoming: CloudComputerInventoryInstance[],
  previous: CloudComputerInventoryInstance[],
  overrides: CloudPostActionOverrides,
): { instances: CloudComputerInventoryInstance[]; overrides: CloudPostActionOverrides } {
  const nextOverrides = { ...overrides };
  const incomingIds = new Set(incoming.map((instance) => instance.boxId));
  const instances = incoming.flatMap((instance) => {
    const override = overrides[instance.boxId];
    if (override === "deleted") return [];
    if (override === "deleting") return [{ ...instance, state: "removing" }];
    if (override !== "sleeping") return [instance];
    if (instance.state === "archived") {
      delete nextOverrides[instance.boxId];
      return [instance];
    }
    return [{ ...instance, state: "archived" }];
  });

  // A transitioning Boat can briefly disappear from LIST.
  for (const instance of previous) {
    if (overrides[instance.boxId] !== "sleeping" || incomingIds.has(instance.boxId)) continue;
    instances.push({ ...instance, state: "archived" });
  }
  for (const [boxId, override] of Object.entries(overrides)) {
    if ((override === "deleted" || override === "deleting") && !incomingIds.has(boxId)) {
      delete nextOverrides[boxId];
    }
  }
  return { instances, overrides: nextOverrides };
}

/** An empty list proves deletion only when Boat says the read was authoritative. */
export function reconcileCloudInventoryPayload(
  payload: CloudComputerInventoryPayload,
  previous: CloudComputerInventoryInstance[],
  overrides: CloudPostActionOverrides,
): { instances: CloudComputerInventoryInstance[]; overrides: CloudPostActionOverrides } {
  if (payload.configured !== true || payload.available !== true) {
    return { instances: previous, overrides: { ...overrides } };
  }
  return reconcileCloudInventorySnapshot(
    Array.isArray(payload.instances) ? payload.instances : [],
    previous,
    overrides,
  );
}

function cloudComputerCanSleep(instance: CloudComputerInventoryInstance): boolean {
  return ["idle", "ready", "running"].includes(instance.state);
}

export function vpsComputerInventoryStateKind(
  instance: VpsComputerInventoryInstance,
): ComputerStateKind {
  if (instance.inUse) return "in-use";
  if (instance.state === "running") return "running";
  if (instance.state === "restarting") return "restarting";
  if (instance.state === "removing") return "removing";
  if (["created", "exited"].includes(instance.state)) return "stopped";
  if (instance.state === "paused") return "paused";
  return "attention";
}

export function vpsComputerInventoryState(instance: VpsComputerInventoryInstance): string {
  return computerStateLabel(vpsComputerInventoryStateKind(instance));
}

export function vpsComputerShortId(name: string): string {
  const suffix = /-([a-f0-9]{12})$/i.exec(name)?.[1];
  return suffix ? suffix.slice(-8).toLowerCase() : "unknown";
}

export interface ComputerActionPlan {
  confirmation: string | null;
  request: ComputerApiRequest;
}

export function perBotLocalVmDeletePlan(instance: LocalVmInventoryInstance): ComputerActionPlan {
  return {
    confirmation: t("vm.confirm.deleteBotVm", { name: instance.name }),
    request: jsonPostRequest(`/api/bots/${instance.botId}/local-computer/remove`, {}),
  };
}

export function cloudComputerActionPlan(
  action: CloudAction,
  instance: CloudComputerInventoryInstance,
): ComputerActionPlan {
  return {
    confirmation: action === "delete"
      ? t("vm.confirm.deleteCloud", {
          subject: instance.orphaned
            ? t("vm.confirm.orphanCloud")
            : t("vm.confirm.ownedCloud", { name: instance.ownerName ?? "" }),
        })
      : null,
    request: jsonPostRequest(
      `/api/computers/boxes/${encodeURIComponent(instance.boxId)}/${action}`,
      action === "delete" ? { confirmName: instance.name } : {},
    ),
  };
}

export function vpsComputerRemovePlan(instance: VpsComputerInventoryInstance): ComputerActionPlan {
  const shortId = vpsComputerShortId(instance.name);
  return {
    confirmation: t("vm.confirm.removeVps", {
      subject: instance.orphaned
        ? t("vm.confirm.orphanVps", { id: shortId })
        : t("vm.confirm.ownedVps", { name: instance.ownerName ?? "" }),
    }),
    request: jsonPostRequest(`/api/computers/vps/${encodeURIComponent(instance.name)}/remove`, {
      confirmName: instance.name,
      alias: instance.vpsAlias,
    }),
  };
}

export function confirmComputerAction(
  plan: ComputerActionPlan,
  confirm: (message: string) => boolean,
): ComputerApiRequest | null {
  if (plan.confirmation !== null && !confirm(plan.confirmation)) return null;
  return plan.request;
}

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
              ? <>{t("vm.cloud.needsKey")} <KeysLink id="box" /></>
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

      {!(configured === false && !loading && !unavailableReason) && <div
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
                  <span className="truncate text-[14px] font-medium text-ink">
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
                <div className="mt-1 break-all text-[12px] text-ink-secondary">
                  {instance.orphaned ? t("vm.owner.gone") : t("vm.owner.owned")} · {instance.name}
                </div>
                {instance.inUse && (
                  <div className="mt-1 text-[12px] text-ink-secondary">{t("vm.cloud.stopFirst")}</div>
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
      </div>}
    </Card>
  );
}

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
                  <span className="truncate text-[14px] font-medium text-ink">{instance.name}</span>
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
                <div className="mt-1 text-[12px] text-ink-secondary">
                  {t("vm.perBot.destination", { destination: t(destinationLabelKeys[instance.destination]) })}
                </div>
                {!managed && (
                  <div className="mt-1 text-[12px] text-warning">
                    {t("vm.perBot.unmanaged")}
                  </div>
                )}
                {managed && instance.problem && !instance.inUse && (
                  <div className="mt-1 text-[12px] text-warning">{localizeComputerProblem(instance.problem)}</div>
                )}
                {managed && instance.inUse && (
                  <div className="mt-1 text-[12px] text-ink-secondary">{t("vm.perBot.stopFirst")}</div>
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
