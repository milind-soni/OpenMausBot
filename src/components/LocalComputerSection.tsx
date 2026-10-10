// One-place setup for the isolated Local VM image and its shared/per-bot policy.
import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "@/lib/i18n";
import { waitForLocalVmReady } from "@/lib/local-vm-readiness";
import type { LocaleKey } from "@/locales";
import {
  AlertTriangle,
  Check,
  Circle,
  Cloud,
  ExternalLink,
  Loader2,
  Moon,
  RefreshCw,
  RotateCcw,
  Server,
  Square,
  Trash2,
} from "lucide-react";
import { Card, CommandLine } from "./SettingsPrimitives";
import { MacLocalControl } from "./MacLocalControl";
import { cn } from "@/lib/cn";
import { useStore } from "@/state/store";

type Action = "pull" | "run" | "start" | "stop" | "remove" | "recreate";

interface ManagedStatus {
  source: "managed";
  platform: string;
  runtime: string | null;
  available: string[];
  daemonUp: boolean;
  image: boolean;
  imageMatches: boolean;
  managed: boolean;
  container: "running" | "stopped" | "missing";
  network: "loopback" | "unsafe" | "unknown";
  security: "hardened" | "unsafe" | "unknown";
  persistence: "durable" | "unsafe" | "unknown";
  desktopReady: boolean;
  ready: boolean;
  problem: string | null;
  image_ref: string;
  base_image_ref: string;
  driver_version: string;
  container_name: string;
  workspace_path: string;
  workspace_guest_path: string;
  viewer_url: string;
  idle_timeout_ms: number;
  stop_reason?: "idle" | null;
  mode: "shared" | "per-bot" | "pool";
  max_instances: number;
  commands: {
    install: string | null;
    runtimeStart: string | null;
    pull: string | null;
    run: string | null;
    start: string | null;
    stop: string | null;
    remove: string | null;
    view: string;
  };
}

interface ExistingStatus {
  source: "existing";
  configured: boolean;
  sshAlias: string | null;
  ssh: "not-configured" | "connected" | "unreachable";
  os: "unknown" | "linux" | "unsupported";
  driver: "unknown" | "compatible" | "missing" | "incompatible";
  mcp: "unknown" | "ready" | "failed";
  tools: string[];
  desktopReady: boolean;
  ready: boolean;
  problem: string | null;
  errorCode: string | null;
  driver_version: string;
  viewer_url: "";
  watch_only: true;
}

type Status = ManagedStatus | ExistingStatus;
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

interface LocalVmInventoryPayload {
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

type CloudAction = "sleep" | "delete";
type PendingCloudAction = { boxId: string; action: CloudAction } | null;
export type CloudPostActionOverride = "deleted" | "deleting" | "sleeping";
export type CloudPostActionOverrides = Record<string, CloudPostActionOverride>;

const PENDING_CLOUD_DELETE_REFRESH_DELAYS_MS = [1_000, 2_000, 4_000] as const;

function waitForCloudDeleteRefresh(delayMs: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, delayMs));
}

export interface VpsComputerInventoryInstance {
  name: string;
  state: "created" | "restarting" | "running" | "removing" | "paused" | "exited" | "dead" | "unknown";
  ownerBotId: string | null;
  ownerName: string | null;
  orphaned: boolean;
  inUse: boolean;
}

interface VpsComputerInventoryPayload {
  configured: boolean;
  available: boolean;
  sshAlias: string | null;
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

/** The badge's colour is decided by the kind, never by the label: a
 * translated label would silently stop matching `=== "Running"`. */
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
  if (["archived", "stopped"].includes(instance.state)) return "sleeping";
  if (["archiving", "stopping"].includes(instance.state)) return "going-to-sleep";
  if (["idle", "ready", "running"].includes(instance.state)) return "running";
  if (["init", "provisioning", "provisioned", "cloning", "starting"].includes(instance.state)) return "starting";
  return "attention";
}

export function cloudComputerInventoryState(instance: CloudComputerInventoryInstance): string {
  return computerStateLabel(cloudComputerInventoryStateKind(instance));
}

/** Boat's account LIST is eventually consistent. Preserve the result of an
 * action the provider accepted instead of letting an older snapshot make a
 * confirmed deletion reappear, a pending deletion disappear, or a sleeping
 * computer look awake. */
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
    if (["archived", "stopped"].includes(instance.state)) {
      delete nextOverrides[instance.boxId];
      return [instance];
    }
    return [{ ...instance, state: "archived" }];
  });

  // A transitioning Boat can briefly disappear from LIST. Keep the last safe
  // row until LIST returns the terminal sleeping state.
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

/** An empty list proves deletion only when Boat says the inventory read was
 * authoritative. Provider outages and disconnected accounts must not erase
 * the last known row or settle a pending deletion as successful. */
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

type ComputerInventoryRequest = "status" | "local-vms" | "cloud" | "vps";
type ComputerApiRequest = [url: string, init: RequestInit];
export interface ComputerActionPlan {
  confirmation: string | null;
  request: ComputerApiRequest;
}

const computerInventoryPaths: Record<ComputerInventoryRequest, string> = {
  status: "/api/local-computer",
  "local-vms": "/api/local-computer/instances",
  cloud: "/api/computers/boxes",
  vps: "/api/computers/vps",
};

/** Keep the observation-only Settings reads explicit and independently
 * testable: opening Computers must never provision or wake anything. */
export function computerInventoryRequest(
  inventory: ComputerInventoryRequest,
  signal?: AbortSignal,
): ComputerApiRequest {
  return [computerInventoryPaths[inventory], { signal }];
}

function jsonPostRequest(url: string, body: unknown): ComputerApiRequest {
  return [url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }];
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

function Step({ n, title, done, children }: { n: number; title: string; done: boolean; children?: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <div
        className={cn(
          "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-[11px]",
          done ? "bg-success/20 text-success" : "border border-hairline/50 text-ink-secondary",
        )}
      >
        {done ? <Check size={12} /> : n}
      </div>
      <div className="min-w-0 flex-1">
        <div className={cn("text-[14px]", done ? "text-ink-secondary line-through" : "text-ink")}>{title}</div>
        {!done && children && <div className="mt-2 flex flex-col items-start gap-2 [&>*]:max-w-full">{children}</div>}
      </div>
    </div>
  );
}

function ActionButton({
  action,
  pending,
  children,
  onClick,
  danger = false,
}: {
  action: Action;
  pending: Action | null;
  children: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      aria-busy={pending === action}
      disabled={pending !== null}
      className={cn(
        "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12.5px] font-medium disabled:opacity-50",
        danger ? "bg-danger/15 text-danger hover:bg-danger/20" : "bg-accent text-white hover:brightness-110",
      )}
    >
      {pending === action && <Loader2 size={13} className="animate-spin" />}
      {children}
    </button>
  );
}

// Mirrors localVm.idleTimeoutMinutes in server/config.ts; the server is the
// authority and rejects anything outside these bounds.
const MIN_LOCAL_VM_IDLE_TIMEOUT_MINUTES = 5;
const MAX_LOCAL_VM_IDLE_TIMEOUT_MINUTES = 1_440;
const DEFAULT_LOCAL_VM_IDLE_TIMEOUT_MINUTES = 480;

/** A whole number of minutes within the server's bounds, or null. */
export function parseLocalVmIdleTimeoutMinutes(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const minutes = Number(trimmed);
  return minutes >= MIN_LOCAL_VM_IDLE_TIMEOUT_MINUTES && minutes <= MAX_LOCAL_VM_IDLE_TIMEOUT_MINUTES ? minutes : null;
}

export function LocalVmIdleTimeoutSetting({
  minutes,
  disabled,
  onSave,
}: {
  minutes: number;
  disabled: boolean;
  onSave: (minutes: number) => Promise<void>;
}) {
  const [value, setValue] = useState(String(minutes));
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  // The status poll keeps refreshing the confirmed value; never overwrite
  // what the person is typing.
  useEffect(() => {
    if (!dirty) setValue(String(minutes));
  }, [minutes, dirty]);

  const save = async () => {
    if (!dirty || saving) return;
    const parsed = parseLocalVmIdleTimeoutMinutes(value);
    if (parsed === null) {
      setError(t("vm.idle.range"));
      return;
    }
    setSaving(true);
    try {
      await onSave(parsed);
      setValue(String(parsed));
      setDirty(false);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("vm.idle.error"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <label htmlFor="local-vm-idle-timeout" className="text-[13px] text-ink">{t("vm.idle.label")}</label>
          <div id="local-vm-idle-timeout-help" className="text-[11.5px] text-ink-secondary">{t("vm.idle.detail")}</div>
        </div>
        <div
          className={cn(
            "flex w-[150px] shrink-0 items-center rounded-lg border bg-control",
            error ? "border-danger/60" : "border-hairline/40 focus-within:border-focus",
          )}
        >
          <input
            id="local-vm-idle-timeout"
            type="number"
            min={MIN_LOCAL_VM_IDLE_TIMEOUT_MINUTES}
            max={MAX_LOCAL_VM_IDLE_TIMEOUT_MINUTES}
            step={1}
            inputMode="numeric"
            value={value}
            disabled={disabled || saving}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? "local-vm-idle-timeout-error local-vm-idle-timeout-help" : "local-vm-idle-timeout-help"}
            onChange={(event) => {
              setValue(event.target.value);
              setDirty(true);
              setError("");
            }}
            onBlur={() => void save()}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
            className="min-w-0 flex-1 bg-transparent px-2.5 py-1.5 text-[13px] tabular-nums text-ink focus:outline-none disabled:opacity-50"
          />
          <span className="pr-2.5 text-[12.5px] text-ink-secondary">{t("vm.idle.minutes")}</span>
        </div>
      </div>
      {error ? (
        <p id="local-vm-idle-timeout-error" role="alert" className="mt-1.5 text-[12px] text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function LocalComputerSection() {
  const { state, dispatch } = useStore();
  // An OMB Cloud home has no Local VM (shared/cloud-home.ts): it neither
  // checks for one nor explains how to set one up.
  const cloudHome = useStore().state.config?.cloudHome === true;
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<Action | null>(null);
  const actionController = useRef<AbortController | null>(null);
  useEffect(() => () => actionController.current?.abort(), []);
  const [error, setError] = useState<string | null>(null);
  const [policyPending, setPolicyPending] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [source, setSource] = useState<"managed" | "existing">("managed");
  const [alias, setAlias] = useState("");

  const refresh = useCallback(async (signal?: AbortSignal, _force = false) => {
    // _force is a leftover of the pre-merge refresh query: the server now
    // always returns fresh status, so callers' `true` is accepted but inert.
    const response = await fetch(...computerInventoryRequest("status", signal));
    const body = await response.json().catch(() => ({}));
    // The poll loop can be cleaned up mid-flight; a resolved-but-stale read
    // must never overwrite the state of whoever unmounted us.
    if (signal?.aborted) return;
    if (!response.ok) throw new Error(body.error ?? t("vm.err.status", { code: response.status }));
    let nextStatus: Status;
    if (body.source === "existing") {
      // SAFETY: the local-computer endpoint returns the discriminated ExistingStatus contract.
      nextStatus = body as ExistingStatus;
    } else {
      // SAFETY: the local-computer endpoint returns the managed status fields under this branch.
      nextStatus = { source: "managed", ...body } as ManagedStatus;
    }
    setStatus(nextStatus);
    setError(null);
    return nextStatus;
  }, []);
  const [inventory, setInventory] = useState<LocalVmInventoryInstance[]>([]);
  const [inventoryMax, setInventoryMax] = useState(2);
  const [inventoryLoading, setInventoryLoading] = useState(false);
  const [inventoryError, setInventoryError] = useState<string | null>(null);
  const [inventoryUnavailableReason, setInventoryUnavailableReason] = useState<string | null>(null);
  const [deletingBotId, setDeletingBotId] = useState<string | null>(null);
  const [inventoryRefreshKey, setInventoryRefreshKey] = useState(0);
  const [cloudInventory, setCloudInventory] = useState<CloudComputerInventoryInstance[]>([]);
  const [cloudConfigured, setCloudConfigured] = useState<boolean | null>(null);
  const [cloudLoading, setCloudLoading] = useState(true);
  const [cloudError, setCloudError] = useState<string | null>(null);
  const [cloudUnavailableReason, setCloudUnavailableReason] = useState<string | null>(null);
  const [cloudPending, setCloudPending] = useState<PendingCloudAction>(null);
  const [cloudRefreshKey, setCloudRefreshKey] = useState(0);
  const cloudInventoryRef = useRef<CloudComputerInventoryInstance[]>([]);
  const cloudOverridesRef = useRef<CloudPostActionOverrides>({});
  const [vpsInventory, setVpsInventory] = useState<VpsComputerInventoryInstance[]>([]);
  const [vpsConfigured, setVpsConfigured] = useState<boolean | null>(null);
  const [vpsSshAlias, setVpsSshAlias] = useState<string | null>(null);
  const [vpsLoading, setVpsLoading] = useState(true);
  const [vpsError, setVpsError] = useState<string | null>(null);
  const [vpsUnavailableReason, setVpsUnavailableReason] = useState<string | null>(null);
  const [vpsRemovingName, setVpsRemovingName] = useState<string | null>(null);
  const [vpsRefreshKey, setVpsRefreshKey] = useState(0);
  const [announcement, setAnnouncement] = useState("");

  const refreshInventory = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(...computerInventoryRequest("local-vms", signal));
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error ?? t("vm.err.inventory", { code: response.status }));
    const payload = body as LocalVmInventoryPayload;
    setInventory(payload.instances);
    setInventoryMax(payload.maxInstances);
    setInventoryUnavailableReason(payload.available ? null : (payload.problem ?? t("vm.err.runtimeUnavailable")));
    setInventoryError(null);
  }, []);

  const refreshCloudInventory = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(...computerInventoryRequest("cloud", signal));
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error ?? t("vm.err.cloudInventory", { code: response.status }));
    const payload = body as CloudComputerInventoryPayload;
    const reconciled = reconcileCloudInventoryPayload(
      payload,
      cloudInventoryRef.current,
      cloudOverridesRef.current,
    );
    cloudOverridesRef.current = reconciled.overrides;
    cloudInventoryRef.current = reconciled.instances;
    setCloudInventory(reconciled.instances);
    setCloudConfigured(payload.configured === true);
    setCloudUnavailableReason(
      payload.available || !payload.configured
        ? null
        : (payload.problem ?? t("vm.err.cloudUnavailable")),
    );
    setCloudError(null);
  }, []);

  const refreshVpsInventory = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(...computerInventoryRequest("vps", signal));
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error ?? t("vm.err.vpsInventory", { code: response.status }));
    const payload = body as VpsComputerInventoryPayload;
    setVpsInventory(Array.isArray(payload.instances) ? payload.instances : []);
    setVpsConfigured(payload.configured === true);
    setVpsSshAlias(typeof payload.sshAlias === "string" ? payload.sshAlias : null);
    setVpsUnavailableReason(
      payload.available || !payload.configured
        ? null
        : (payload.problem ?? t("vm.err.vpsUnavailable")),
    );
    setVpsError(null);
  }, []);

  useEffect(() => {
    const configuredSource = state.config?.localVm.source ?? status?.source;
    if (configuredSource) setSource(configuredSource);
  }, [state.config?.localVm.source, status?.source]);

  const existingStatusAlias = status?.source === "existing" ? status.sshAlias ?? "" : null;

  useEffect(() => {
    if (state.config?.localVm.sshAlias !== undefined) setAlias(state.config.localVm.sshAlias);
    else if (existingStatusAlias !== null) setAlias(existingStatusAlias);
  }, [state.config?.localVm.sshAlias, existingStatusAlias]);

  useEffect(() => {
    if (cloudHome) return;
    let active = true;
    let timer: number | undefined;
    let controller: AbortController | undefined;
    const poll = async (force = false) => {
      controller = new AbortController();
      try {
        await refresh(controller.signal, force);
      } catch (e) {
        if (active && !(e instanceof DOMException && e.name === "AbortError")) {
          setStatus(null);
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (active) {
          setLoading(false);
          timer = window.setTimeout(() => void poll(), source === "existing" ? 30_000 : 5000);
        }
      }
    };
    void poll(refreshKey > 0);
    return () => {
      active = false;
      controller?.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [refresh, refreshKey, source]);

  useEffect(() => {
    const managed = status?.source === "managed" ? status : null;
    if (managed?.mode !== "per-bot") {
      setInventory([]);
      setInventoryLoading(false);
      setInventoryError(null);
      setInventoryUnavailableReason(null);
      return;
    }
    const controller = new AbortController();
    setInventoryLoading(true);
    void refreshInventory(controller.signal)
      .catch((e) => {
        if (!(e instanceof DOMException && e.name === "AbortError")) {
          setInventoryError(e instanceof Error ? e.message : String(e));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setInventoryLoading(false);
      });
    return () => controller.abort();
  }, [inventoryRefreshKey, refreshInventory, status]);

  // Boat account listing is deliberately not polled. It can be expensive and
  // Settings must remain an observation-only surface until the person clicks
  // Sleep or Delete.
  useEffect(() => {
    const controller = new AbortController();
    setCloudLoading(true);
    void refreshCloudInventory(controller.signal)
      .catch((e) => {
        if (!(e instanceof DOMException && e.name === "AbortError")) {
          setCloudUnavailableReason(e instanceof Error ? e.message : String(e));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setCloudLoading(false);
      });
    return () => controller.abort();
  }, [cloudRefreshKey, refreshCloudInventory]);

  // Docker-over-SSH inventory is also manual/mount-only. A Settings view
  // must never become a hidden remote poller or wake a stopped container.
  useEffect(() => {
    const controller = new AbortController();
    setVpsLoading(true);
    void refreshVpsInventory(controller.signal)
      .catch((e) => {
        if (!(e instanceof DOMException && e.name === "AbortError")) {
          setVpsUnavailableReason(e instanceof Error ? e.message : String(e));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setVpsLoading(false);
      });
    return () => controller.abort();
  }, [refreshVpsInventory, vpsRefreshKey]);

  const post = async (action: Exclude<Action, "recreate">, signal: AbortSignal) => {
    const response = await fetch(`/api/local-computer/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error ?? `${action} failed`);
    // SAFETY: local-computer lifecycle endpoints return the same discriminated status contract as refresh().
    const errorKeys: Record<Exclude<Action, "recreate">, LocaleKey> = {
      pull: "vm.err.prepare",
      run: "vm.err.create",
      start: "vm.err.start",
      stop: "vm.err.stop",
      remove: "vm.deleteError",
    };
    if (!response.ok) throw new Error(body.error ?? t(errorKeys[action]));
    signal.throwIfAborted();
    // SAFETY: lifecycle routes serve the managed VM only (409 for an
    // Existing VM source), so the managed shape holds here.
    const next = body as ManagedStatus;
    setStatus(next);
    return next;
  };

  const confirmAction = (message: string) => window.ogb?.confirm ? window.ogb.confirm(message) : window.confirm(message);

  const act = async (action: Action) => {
    if (pending !== null || actionController.current) return;
    const controller = new AbortController();
    actionController.current = controller;
    setPending(action);
    setError(null);
    try {
      if (action === "remove" && !(await confirmAction(t("vm.confirm.deleteShared")))) return;
      if (action === "recreate" && !(await confirmAction(t("vm.confirm.recreate")))) return;
      let result: ManagedStatus;
      if (action === "recreate") {
        await post("remove", controller.signal);
        result = await post("run", controller.signal);
      } else {
        result = await post(action, controller.signal);
      }
      if (action === "run" || action === "start" || action === "recreate") {
        // SAFETY: lifecycle actions serve the managed VM only; refresh()
        // returns the discriminated union, and the existing branch 409s
        // server-side, so the managed shape holds here.
        result = await waitForLocalVmReady(
          result,
          async () => ((await refresh(controller.signal)) ?? result) as ManagedStatus,
          controller.signal,
        );
        if (!result.ready) throw new Error(result.problem ?? t("vm.err.start"));
      }
      await refresh();
      setAnnouncement(
        action === "remove"
          ? t("vm.announce.deleted")
          : action === "stop"
            ? t("vm.announce.stopped")
            : t("vm.announce.updated"),
      );
    } catch (e) {
      if (controller.signal.aborted) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      actionController.current = null;
      if (!controller.signal.aborted) setPending(null);
    }
  };

  const savePolicy = async (mode: ManagedStatus["mode"], maxInstances: number) => {
    setPolicyPending(true);
    setError(null);
    try {
      const response = await fetch("/api/config", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ localVm: { mode, maxInstances } }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? t("vm.policyError"));
      setStatus((current) => current ? { ...current, mode, max_instances: maxInstances } : current);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPolicyPending(false);
    }
  };

  const saveSource = async (nextSource: "managed" | "existing") => {
    if (policyPending || nextSource === source) return;
    setPolicyPending(true);
    setError(null);
    try {
      const response = await fetch("/api/config", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ localVm: { source: nextSource } }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Could not change the Local VM source");
      dispatch({ type: "configStatus", config: body });
      setSource(nextSource);
      await refresh(undefined, true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPolicyPending(false);
    }
  };

  const saveAlias = async () => {
    if (policyPending) return;
    setPolicyPending(true);
    setError(null);
    try {
      const response = await fetch("/api/config", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ localVm: { sshAlias: alias.trim() } }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Could not save the Existing VM SSH alias");
      dispatch({ type: "configStatus", config: body });
      setAlias(body.localVm?.sshAlias ?? alias.trim());
      await refresh(undefined, true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPolicyPending(false);
    }
  };

  const existingStatus = status?.source === "existing" ? status : null;
  if (source === "existing") {
    const savedAlias = Boolean(alias.trim() || existingStatus?.sshAlias);
    return (
      <>
        <Card
          title="Local VM"
          subtitle="Connect OpenMausBot to one Linux VM that you own through an SSH config alias. OpenMausBot never creates, starts, stops, replaces, or deletes this VM."
        >
          <div className="flex overflow-hidden rounded-lg border border-hairline/40">
            {(["managed", "existing"] as const).map((value, index) => (
              <button
                key={value}
                type="button"
                aria-pressed={source === value}
                disabled={policyPending}
                onClick={() => void saveSource(value)}
                className={cn(
                  "flex-1 px-3 py-2 text-[13px] disabled:opacity-50",
                  index > 0 && "border-l border-hairline/40",
                  source === value ? "bg-raised text-ink" : "text-ink-secondary hover:text-ink",
                )}
              >
                {value === "managed" ? "Managed VM" : "Existing VM"}
              </button>
            ))}
          </div>
          {error && <div className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</div>}
        </Card>

        <Card
          title="SSH connection"
          subtitle="Use a host entry from your normal SSH config and agent. Only the alias is saved; OpenMausBot does not store keys, passwords, options, or commands."
        >
          <div className="flex gap-2">
            <input
              type="text"
              value={alias}
              onChange={(event) => setAlias(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && void saveAlias()}
              placeholder="my-linux-vm"
              aria-label="Existing VM SSH config alias"
              autoComplete="off"
              className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
            />
            <button
              type="button"
              onClick={() => void saveAlias()}
              disabled={policyPending || (!alias.trim() && !savedAlias)}
              className={cn(
                "flex w-[72px] shrink-0 items-center justify-center gap-1.5 rounded-lg py-2 text-[13px] disabled:cursor-not-allowed disabled:opacity-50",
                !alias.trim() && savedAlias ? "bg-raised text-danger hover:bg-raised-hover" : "bg-raised text-ink hover:bg-raised-hover",
              )}
            >
              {policyPending ? <Loader2 size={13} className="animate-spin" /> : !alias.trim() && savedAlias ? "Clear" : <><Check size={13} />Save</>}
            </button>
          </div>
          <div className="mt-2 text-[11.5px] leading-relaxed text-ink-secondary">
            Alias names may contain letters, numbers, dots, dashes, and underscores. The remote command is fixed to <code>cua-driver mcp</code>.
          </div>
        </Card>

        <Card title="Existing VM readiness" subtitle="The VM is usable only after SSH, Linux, the pinned CUA Driver, MCP tools, and a complete desktop image all pass." >
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cn(
                "flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12.5px]",
                existingStatus?.ready ? "bg-success/15 text-success" : "bg-raised text-ink-secondary",
              )}
            >
              {loading ? <Loader2 size={12} className="animate-spin" /> : existingStatus?.ready ? <Check size={12} /> : <Circle size={9} />}
              {loading ? "Checking…" : existingStatus?.ready ? "Ready · watch-only preview" : existingStatus?.problem ?? "Not ready"}
            </span>
            <button
              type="button"
              onClick={() => {
                setLoading(true);
                setRefreshKey((key) => key + 1);
              }}
              disabled={loading || policyPending}
              className="flex items-center gap-1.5 rounded-lg border border-hairline/40 px-2.5 py-1 text-[12.5px] text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40"
            >
              <RefreshCw size={12} /> Re-check
            </button>
          </div>
          <div className="mt-4 flex flex-col gap-3">
            <Step n={1} title="SSH config alias saved" done={Boolean(existingStatus?.sshAlias)}>
              <div className="text-[12.5px] text-ink-secondary">Enter the alias for the Linux VM above, then save it.</div>
            </Step>
            <Step n={2} title="SSH connection" done={existingStatus?.ssh === "connected"}>
              {existingStatus?.errorCode === "ssh-missing" && (
                <div className="text-[12.5px] text-danger">Install OpenSSH so the <code>ssh</code> command is available in OpenMausBot&apos;s PATH, then re-check.</div>
              )}
              {existingStatus?.ssh === "unreachable" && existingStatus.errorCode !== "ssh-missing" && (
                <div className="text-[12.5px] text-danger">Check the SSH alias, host key, and SSH agent, then re-check.</div>
              )}
            </Step>
            <Step n={3} title="Linux guest" done={existingStatus?.os === "linux"}>
              {existingStatus?.os === "unsupported" && <div className="text-[12.5px] text-danger">The Existing VM must report Linux.</div>}
            </Step>
            <Step n={4} title={`CUA Driver ${existingStatus?.driver_version ?? "0.20.0"}`} done={existingStatus?.driver === "compatible"}>
              {existingStatus?.driver === "missing" && <div className="text-[12.5px] text-danger">Install the pinned CUA Driver in the VM and re-check.</div>}
              {existingStatus?.driver === "incompatible" && <div className="text-[12.5px] text-danger">The VM has a different CUA Driver version than this OpenMausBot build.</div>}
            </Step>
            <Step n={5} title="CUA MCP tools" done={existingStatus?.mcp === "ready"}>
              {existingStatus?.mcp === "failed" && <div className="text-[12.5px] text-danger">The CUA MCP bridge did not become ready.</div>}
            </Step>
            <Step n={6} title="Desktop capture" done={Boolean(existingStatus?.desktopReady)}>
              {existingStatus?.desktopReady === false && existingStatus?.mcp === "ready" && <div className="text-[12.5px] text-danger">CUA could not return a complete desktop image.</div>}
            </Step>
          </div>
          {existingStatus?.ready && (
            <div className="mt-4 rounded-lg bg-raised px-3 py-2 text-[12px] leading-relaxed text-ink-secondary">
              The bot Computer panel can show a watch-only preview. Live viewer access and Take Control are intentionally unavailable for an Existing VM.
            </div>
          )}
        </Card>
      </>
    );
  }

  const managedStatus = status?.source === "managed" ? status : null;
  const c = managedStatus?.commands;
  const ready = managedStatus?.ready === true;
  const existing = managedStatus?.container !== "missing";
  const needsRecreate = Boolean(
    existing &&
      (managedStatus?.container === "stopped" ||
        !managedStatus?.imageMatches ||
        !managedStatus?.managed ||
        managedStatus?.network === "unsafe" ||
        managedStatus?.security === "unsafe" ||
        managedStatus?.persistence === "unsafe"),
  );
  const unavailable = !loading && !status;
  const host = managedStatus?.platform === "darwin" ? t("vm.host.mac") : t("vm.host.computer");
  const perBot = managedStatus?.mode === "per-bot";
  const perBotRuntimeUnsupported = perBot && managedStatus?.runtime === "container";
  const headerReady = perBot ? Boolean(managedStatus?.daemonUp && managedStatus?.image && !perBotRuntimeUnsupported) : ready;
  const saveIdleTimeout = async (idleTimeoutMinutes: number) => {
    const response = await fetch("/api/config", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ localVm: { idleTimeoutMinutes } }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error ?? t("vm.idle.error"));
    setStatus((current) => current ? { ...current, idle_timeout_ms: idleTimeoutMinutes * 60_000 } : current);
  };

  const deletePerBotVm = async (instance: LocalVmInventoryInstance) => {
    if (!instance.managed) {
      setInventoryError(t("vm.unmanagedError"));
      return;
    }
    const request = confirmComputerAction(
      perBotLocalVmDeletePlan(instance),
      (message) => window.confirm(message),
    );
    if (!request) return;
    setDeletingBotId(instance.botId);
    setInventoryError(null);
    try {
      const response = await fetch(...request);
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? t("vm.deleteError"));
      await refreshInventory();
      setAnnouncement(t("vm.announce.deletedBot", { name: instance.name }));
    } catch (e) {
      setInventoryError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeletingBotId(null);
    }
  };

  const actOnCloudComputer = async (action: CloudAction, instance: CloudComputerInventoryInstance) => {
    const request = confirmComputerAction(
      cloudComputerActionPlan(action, instance),
      (message) => window.confirm(message),
    );
    if (!request) return;
    setCloudPending({ boxId: instance.boxId, action });
    setCloudError(null);
    setAnnouncement("");
    try {
      const response = await fetch(...request);
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? t(action === "delete" ? "vm.cloud.deleteError" : "vm.cloud.sleepError"));
      const deletionPending = action === "delete" && body?.pending === true;
      cloudOverridesRef.current = {
        ...cloudOverridesRef.current,
        [instance.boxId]: action === "delete"
          ? deletionPending ? "deleting" : "deleted"
          : "sleeping",
      };
      const reconciled = reconcileCloudInventorySnapshot(
        cloudInventoryRef.current,
        cloudInventoryRef.current,
        cloudOverridesRef.current,
      );
      cloudOverridesRef.current = reconciled.overrides;
      cloudInventoryRef.current = reconciled.instances;
      setCloudInventory(reconciled.instances);
      const subject = instance.orphaned
        ? t("vm.announce.orphanCloud")
        : t("vm.confirm.ownedCloud", { name: instance.ownerName ?? "" });
      setAnnouncement(
        deletionPending
          ? `${subject}: ${t("vm.state.removing")}.`
          : t(action === "delete" ? "vm.announce.cloudDeleted" : "vm.announce.cloudSleeping", { subject }),
      );

      if (deletionPending) {
        // Boat may accept a background operation before the computer is gone.
        // Keep the row visible as Removing while we check, then drop the
        // optimistic state if the provider still lists it so the person can
        // refresh or retry instead of being shown a false success forever.
        for (const delayMs of PENDING_CLOUD_DELETE_REFRESH_DELAYS_MS) {
          await waitForCloudDeleteRefresh(delayMs);
          try {
            await refreshCloudInventory();
          } catch {
            // A later bounded attempt can still establish the final state.
          }
          if (cloudOverridesRef.current[instance.boxId] !== "deleting") {
            setAnnouncement(t("vm.announce.cloudDeleted", { subject }));
            return;
          }
        }

        const nextOverrides = { ...cloudOverridesRef.current };
        delete nextOverrides[instance.boxId];
        cloudOverridesRef.current = nextOverrides;
        const restored = cloudInventoryRef.current.map((current) =>
          current.boxId === instance.boxId ? { ...current, state: instance.state } : current
        );
        cloudInventoryRef.current = restored;
        setCloudInventory(restored);
        try {
          await refreshCloudInventory();
          if (!cloudInventoryRef.current.some((current) => current.boxId === instance.boxId)) {
            setAnnouncement(t("vm.announce.cloudDeleted", { subject }));
          }
        } catch (refreshError) {
          const detail = refreshError instanceof Error ? refreshError.message : String(refreshError);
          setCloudError(`${subject}: ${t("vm.state.removing")}. ${detail}`);
        }
        return;
      }

      try {
        await refreshCloudInventory();
      } catch (refreshError) {
        const detail = refreshError instanceof Error ? refreshError.message : String(refreshError);
        setCloudError(t(action === "delete" ? "vm.cloud.deletedRefreshError" : "vm.cloud.sleepRefreshError", { subject, detail }));
      }
    } catch (e) {
      setCloudError(e instanceof Error ? e.message : String(e));
    } finally {
      setCloudPending(null);
    }
  };

  const removeVpsComputer = async (instance: VpsComputerInventoryInstance) => {
    const shortId = vpsComputerShortId(instance.name);
    const request = confirmComputerAction(
      vpsComputerRemovePlan(instance),
      (message) => window.confirm(message),
    );
    if (!request) return;
    setVpsRemovingName(instance.name);
    setVpsError(null);
    try {
      const response = await fetch(...request);
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? t("vm.vpsRemoveError"));
      await refreshVpsInventory();
      setAnnouncement(
        t("vm.announce.vpsRemoved", {
          subject: instance.orphaned
            ? t("vm.announce.orphanVps", { id: shortId })
            : t("vm.confirm.ownedVps", { name: instance.ownerName ?? "" }),
        }),
      );
    } catch (e) {
      setVpsError(e instanceof Error ? e.message : String(e));
    } finally {
      setVpsRemovingName(null);
    }
  };

  return (
    <>
      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">{announcement}</p>
      <CloudComputersCard
        instances={cloudInventory}
        configured={cloudConfigured}
        loading={cloudLoading}
        pending={cloudPending}
        error={cloudError}
        unavailableReason={cloudUnavailableReason}
        onRefresh={() => setCloudRefreshKey((key) => key + 1)}
        onSleep={(instance) => void actOnCloudComputer("sleep", instance)}
        onDelete={(instance) => void actOnCloudComputer("delete", instance)}
      />

      <VpsComputersCard
        instances={vpsInventory}
        configured={vpsConfigured}
        sshAlias={vpsSshAlias}
        loading={vpsLoading}
        removingName={vpsRemovingName}
        error={vpsError}
        unavailableReason={vpsUnavailableReason}
        onRefresh={() => setVpsRefreshKey((key) => key + 1)}
        onRemove={(instance) => void removeVpsComputer(instance)}
      />

      <MacLocalControl />

      {!cloudHome && <>
      <Card
        title={t("vm.main.title")}
        subtitle={perBot
          ? t("vm.main.perBotSubtitle", { host })
          : t("vm.main.sharedSubtitle", { host })}
      >
        <div className="mb-4 flex overflow-hidden rounded-lg border border-hairline/40">
          {(["managed", "existing"] as const).map((value, index) => (
            <button
              key={value}
              type="button"
              aria-pressed={source === value}
              disabled={policyPending || pending !== null}
              onClick={() => void saveSource(value)}
              className={cn(
                "flex-1 px-3 py-2 text-[13px] disabled:opacity-50",
                index > 0 && "border-l border-hairline/40",
                source === value ? "bg-raised text-ink" : "text-ink-secondary hover:text-ink",
              )}
            >
              {value === "managed" ? "Managed VM" : "Existing VM"}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span
            aria-live="polite"
            className={cn(
              "flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12.5px]",
              headerReady ? "bg-success/15 text-success" : "bg-control text-ink-secondary",
            )}
          >
            {loading ? <Loader2 size={12} className="animate-spin" /> : headerReady ? <Check size={12} /> : <Circle size={9} />}
            {loading
              ? t("common.checking")
              : unavailable
                ? t("vm.main.statusUnavailable")
                : perBot && headerReady
                  ? t("vm.main.readyPerBot")
                  : perBotRuntimeUnsupported
                    ? t("vm.main.perBotUnsupported")
                  : ready
                    ? t("vm.main.ready")
                    : (managedStatus?.problem ?? t("vm.main.notReady"))}
          </span>
          <button
            onClick={() => {
              setLoading(true);
              setRefreshKey((key) => key + 1);
              setInventoryRefreshKey((key) => key + 1);
            }}
            disabled={loading || pending !== null}
            className="flex items-center gap-1.5 rounded-lg border border-hairline/40 px-2.5 py-1 text-[12.5px] text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-40"
          >
            <RefreshCw size={12} /> {t("vm.main.recheck")}
          </button>
          {ready && !perBot && (
            <a
              href={managedStatus?.viewer_url ?? c?.view}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1.5 rounded-lg border border-hairline/40 px-2.5 py-1 text-[12.5px] text-ink hover:bg-control"
            >
              <ExternalLink size={12} /> {t("vm.main.watch")}
            </a>
          )}
        </div>
        {error && <div role="alert" className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</div>}
      </Card>

      <Card
        title={t("vm.isolation.title")}
        subtitle={t("vm.isolation.subtitle")}
      >
        <div className="flex overflow-hidden rounded-lg border border-hairline/40">
          {(["shared", "per-bot"] as const).map((mode, index) => (
            <button
              key={mode}
              type="button"
              disabled={!status || policyPending}
              aria-pressed={managedStatus?.mode === mode}
              onClick={() => void savePolicy(mode, managedStatus?.max_instances ?? 2)}
              className={cn(
                "flex-1 px-3 py-2 text-[13px] disabled:opacity-50",
                index > 0 && "border-l border-hairline/40",
                managedStatus?.mode === mode ? "bg-raised text-ink" : "text-ink-secondary hover:text-ink",
              )}
            >
              {mode === "shared" ? t("vm.isolation.shared") : t("vm.isolation.perBot")}
            </button>
          ))}
        </div>
        {/* The cap only applies to per-bot VMs; shared mode runs exactly one. */}
        {perBot && (
          <div className="mt-3 flex items-center justify-between gap-3">
            <div>
              <div className="text-[13px] text-ink">{t("vm.isolation.max")}</div>
              <div className="text-[11.5px] text-ink-secondary">{t("vm.isolation.maxDetail")}</div>
            </div>
            <select
              aria-label={t("vm.isolation.maxAria")}
              value={managedStatus?.max_instances ?? 2}
              disabled={!status || policyPending}
              onChange={(event) => void savePolicy(managedStatus?.mode ?? "shared", Number(event.target.value))}
              className="rounded-lg border border-hairline/40 bg-control px-2.5 py-1.5 text-[13px] text-ink disabled:opacity-50"
            >
              {[1, 2, 3, 4, 5, 6, 7, 8].map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </div>
        )}
        {policyPending && <div className="mt-2 flex items-center gap-1.5 text-[12px] text-ink-secondary"><Loader2 size={12} className="animate-spin" /> Saving…</div>}
        <LocalVmIdleTimeoutSetting
          minutes={managedStatus ? Math.round(managedStatus.idle_timeout_ms / 60_000) : DEFAULT_LOCAL_VM_IDLE_TIMEOUT_MINUTES}
          disabled={!status || policyPending}
          onSave={saveIdleTimeout}
        />
        {policyPending && <div className="mt-2 flex items-center gap-1.5 text-[12px] text-ink-secondary"><Loader2 size={12} className="animate-spin" /> {t("vm.saving")}</div>}
      </Card>

      <Card title={t("vm.setup.title")} subtitle={t("vm.setup.subtitle")}>
        <div className="flex flex-col gap-4">
          <Step n={1} title={t("vm.setup.step1")} done={Boolean(managedStatus?.runtime)}>
            <div className="text-[13px] leading-relaxed text-ink-secondary">
              {t("vm.setup.step1Detail")}
            </div>
            {c?.install ? (
              <CommandLine command={c.install} />
            ) : (
              <a href="https://podman.io/docs/installation" target="_blank" rel="noreferrer" className="text-[13px] text-accent hover:underline">
                {t("vm.setup.podmanGuide")}
              </a>
            )}
          </Step>

          <Step
            n={2}
            title={
              managedStatus?.runtime && !managedStatus.daemonUp
                ? t("vm.setup.step2Open", { runtime: managedStatus.runtime })
                : t("vm.setup.step2")
            }
            done={Boolean(managedStatus?.daemonUp)}
          >
            {!managedStatus?.runtime ? null : c?.runtimeStart ? (
              <CommandLine command={c.runtimeStart} />
            ) : (
              <div className="text-[13px] text-ink-secondary">{t("vm.setup.step2Detail")}</div>
            )}
          </Step>

          <Step n={3} title={t("vm.setup.step3")} done={Boolean(managedStatus?.image)}>
            {managedStatus?.daemonUp && (
              <ActionButton action="pull" pending={pending} onClick={() => void act("pull")}>{t("vm.setup.prepare")}</ActionButton>
            )}
            {c?.pull && <details className="text-[12px] text-ink-secondary"><summary className="cursor-pointer">{t("vm.setup.showPull")}</summary><div className="mt-2"><CommandLine command={c.pull} /></div></details>}
          </Step>

          <Step
            n={4}
            title={
              perBot
                ? t("vm.setup.step4PerBot")
                : needsRecreate
                  ? t("vm.setup.step4Recreate")
                  : t("vm.setup.step4")
            }
            done={!perBot && ready}
          >
            {perBot ? (
              <div className="text-[13px] leading-relaxed text-ink-secondary">
                {perBotRuntimeUnsupported
                  ? t("vm.setup.applePort")
                  : t("vm.setup.perBotHint")}
              </div>
            ) : needsRecreate ? (
              <>
                <div className="flex gap-2 text-[13px] text-warning">
                  <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                  <span>{managedStatus?.problem}</span>
                </div>
                {managedStatus?.image ? (
                  <ActionButton action="recreate" pending={pending} onClick={() => void act("recreate")} danger>
                    <RotateCcw size={13} /> {t("vm.setup.recreate")}
                  </ActionButton>
                ) : (
                  <div className="text-[13px] text-ink-secondary">{t("vm.setup.prepareFirst")}</div>
                )}
              </>
            ) : managedStatus?.container === "stopped" ? (
              <>
                <p className="text-[13px] text-ink-secondary">{t(managedStatus.stop_reason === "idle" ? "vm.stopped.idle" : "vm.stopped.detail")}</p>
                <ActionButton action="start" pending={pending} onClick={() => void act("start")}>{t("vm.setup.start")}</ActionButton>
              </>
            ) : managedStatus?.container === "running" ? (
              <div className="flex items-center gap-2 text-[13px] text-ink-secondary"><Loader2 size={13} className="animate-spin" /> {t("vm.setup.waiting")}</div>
            ) : managedStatus?.image ? (
              <>
                <ActionButton action="run" pending={pending} onClick={() => void act("run")}>{t("vm.setup.start")}</ActionButton>
                <p className="text-[13px] leading-relaxed text-ink-secondary">{t("vm.setup.idleHint")}</p>
              </>
            ) : null}
            {c?.run && <details className="text-[12px] text-ink-secondary"><summary className="cursor-pointer">{t("vm.setup.showCommand")}</summary><div className="mt-2"><CommandLine command={c.run} /></div></details>}
          </Step>
        </div>
      </Card>

      {perBot && (
        <LocalVmInventoryCard
          instances={inventory}
          maxInstances={inventoryMax || managedStatus?.max_instances || 2}
          loading={inventoryLoading}
          deletingBotId={deletingBotId}
          error={inventoryError}
          unavailableReason={inventoryUnavailableReason}
          onRefresh={() => setInventoryRefreshKey((key) => key + 1)}
          onDelete={(instance) => void deletePerBotVm(instance)}
        />
      )}

      {unavailable && (
        <Card>
          <div className="flex gap-2 text-[13px] text-ink-secondary">
            <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warning" />
            <span>{t("vm.inspectFailed")}</span>
          </div>
        </Card>
      )}

      <Card
        title={t("vm.safety.title")}
        subtitle={
          perBot
            ? t("vm.safety.perBot", { path: managedStatus?.workspace_guest_path ?? "/home/cua/workspace" })
            : t("vm.safety.shared", { path: managedStatus?.workspace_guest_path ?? "/home/cua/workspace" })
        }
      >
        {existing && (
          <div className="flex flex-wrap gap-2">
            {managedStatus?.container === "running" && (
              <ActionButton action="stop" pending={pending} onClick={() => void act("stop")}>
                <Square size={12} /> {t("vm.safety.stop")}
              </ActionButton>
            )}
            <ActionButton action="remove" pending={pending} onClick={() => void act("remove")} danger>
              <Trash2 size={12} /> {perBot ? t("vm.safety.deleteLegacy") : t("vm.safety.deleteVm")}
            </ActionButton>
          </div>
        )}
        <div className="mt-3 break-all text-[11px] text-ink-secondary">
          {t("vm.safety.workspace", {
            path: managedStatus?.workspace_path ?? t("vm.safety.notCreated"),
            driver: managedStatus?.driver_version ?? "0.20.0",
            image: managedStatus?.image_ref ?? t("vm.safety.notPrepared"),
          })}
          {managedStatus?.base_image_ref ? <> · {t("vm.safety.baseImage", { image: managedStatus.base_image_ref })}</> : null}
        </div>
      </Card>
      </>}
    </>
  );
}
