// One-place setup for the isolated Local VM image and its shared/per-bot policy.
import { useCallback, useEffect, useRef, useState } from "react";
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
import { cn } from "@/lib/cn";

type Action = "pull" | "run" | "start" | "stop" | "remove" | "recreate";

interface Status {
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
  mode: "shared" | "per-bot";
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

export interface LocalVmInventoryInstance {
  botId: string;
  name: string;
  destination: "auto" | "cloud" | "vm" | "local" | "worker" | "browser" | "off";
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

interface CloudComputerInventoryPayload {
  configured: boolean;
  available: boolean;
  problem: string | null;
  instances: CloudComputerInventoryInstance[];
}

type CloudAction = "sleep" | "delete";
type PendingCloudAction = { boxId: string; action: CloudAction } | null;
export type CloudPostActionOverride = "deleted" | "sleeping";
export type CloudPostActionOverrides = Record<string, CloudPostActionOverride>;

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

const destinationLabels: Record<LocalVmInventoryInstance["destination"], string> = {
  auto: "Auto",
  cloud: "Cloud",
  vm: "Local VM",
  local: "This computer",
  worker: "Worker",
  browser: "Browser",
  off: "Off",
};

export function localVmInventoryState(instance: LocalVmInventoryInstance): string {
  if (!instance.managed) return "Not managed";
  if (instance.inUse) return "In use";
  if (instance.container === "stopped") return "Stopped";
  if (instance.ready) return "Running";
  return "Needs attention";
}

export function cloudComputerInventoryState(instance: CloudComputerInventoryInstance): string {
  if (instance.inUse) return "In use";
  if (["archived", "stopped"].includes(instance.state)) return "Sleeping";
  if (["archiving", "stopping"].includes(instance.state)) return "Going to sleep";
  if (["idle", "ready", "running"].includes(instance.state)) return "Running";
  if (["init", "provisioning", "provisioned", "cloning", "starting"].includes(instance.state)) return "Starting";
  return "Needs attention";
}

/** Box's account LIST is eventually consistent. Preserve the result of an
 * action the person just completed instead of letting an older provider
 * snapshot make a deleted computer reappear or a sleeping one look awake. */
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
    if (override !== "sleeping") return [instance];
    if (["archived", "stopped"].includes(instance.state)) {
      delete nextOverrides[instance.boxId];
      return [instance];
    }
    return [{ ...instance, state: "archived" }];
  });

  // A transitioning Box can briefly disappear from LIST. Keep the last safe
  // row until LIST returns the terminal sleeping state.
  for (const instance of previous) {
    if (overrides[instance.boxId] !== "sleeping" || incomingIds.has(instance.boxId)) continue;
    instances.push({ ...instance, state: "archived" });
  }
  return { instances, overrides: nextOverrides };
}

function cloudComputerCanSleep(instance: CloudComputerInventoryInstance): boolean {
  return ["idle", "ready", "running"].includes(instance.state);
}

export function vpsComputerInventoryState(instance: VpsComputerInventoryInstance): string {
  if (instance.inUse) return "In use";
  if (instance.state === "running") return "Running";
  if (instance.state === "restarting") return "Restarting";
  if (instance.state === "removing") return "Removing";
  if (["created", "exited"].includes(instance.state)) return "Stopped";
  if (instance.state === "paused") return "Paused";
  return "Needs attention";
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
    confirmation: `Delete ${instance.name}'s Local VM? Its durable workspace files will remain.`,
    request: jsonPostRequest(`/api/bots/${instance.botId}/local-computer/remove`, {}),
  };
}

export function cloudComputerActionPlan(
  action: CloudAction,
  instance: CloudComputerInventoryInstance,
): ComputerActionPlan {
  return {
    confirmation: action === "delete"
      ? `Permanently delete ${instance.orphaned ? "this orphaned cloud computer" : `${instance.ownerName}'s cloud computer`}? Its files and browser sign-ins will be erased. This cannot be undone.`
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
    confirmation: `Permanently remove ${instance.orphaned ? `orphaned VPS computer ID ${shortId}` : `${instance.ownerName}'s VPS computer`}? Its files and browser sign-ins will be erased. This cannot be undone.`,
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
      title="Self-hosted VPS computers"
      subtitle="Persistent OpenMaus-managed Docker desktops on your VPS. Removing one permanently erases its files and browser sign-ins."
    >
      <div className="flex items-center justify-between gap-3">
        <div className="text-[12px] text-ink-secondary">
          {configured === true
            ? `SSH host: ${sshAlias ?? "configured VPS"}. Old and orphaned computers stay visible here.`
            : configured === false
              ? "Add a VPS SSH alias in Connections to use self-hosted computers."
              : "Refresh to check OpenMaus-managed computers on your VPS."}
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading || removingName !== null}
          aria-label="Refresh VPS computers"
          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-hairline/40 px-2.5 py-1.5 text-[12px] text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-40"
        >
          <RefreshCw size={12} className={cn(loading && "animate-spin")} /> Refresh
        </button>
      </div>

      {error && <div role="alert" className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</div>}

      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {loading
          ? "Checking VPS computers."
          : unavailableReason
            ? `VPS computer inventory unavailable: ${unavailableReason}`
            : configured === false
              ? "VPS is not configured."
              : `${instances.length} VPS computer${instances.length === 1 ? "" : "s"} found.`}
      </p>

      <div
        aria-busy={loading || removingName !== null}
        className="mt-3 overflow-hidden rounded-xl border border-hairline/40"
      >
        {loading && instances.length === 0 ? (
          <div className="flex items-center gap-2 px-3 py-4 text-[13px] text-ink-secondary">
            <Loader2 size={13} className="animate-spin" /> Checking VPS computers…
          </div>
        ) : unavailableReason ? (
          <div className="flex items-center gap-2 px-3 py-4 text-[13px] text-ink-secondary">
            <AlertTriangle size={14} className="shrink-0 text-warning" /> {unavailableReason}
          </div>
        ) : configured === false ? (
          <div className="flex items-center gap-2 px-3 py-4 text-[13px] text-ink-secondary">
            <Server size={14} className="shrink-0" /> VPS is not configured.
          </div>
        ) : instances.length === 0 ? (
          <div className="px-3 py-4 text-[13px] text-ink-secondary">No OpenMaus-managed VPS computers found.</div>
        ) : instances.map((instance, index) => {
          const state = vpsComputerInventoryState(instance);
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
                    {instance.orphaned ? `Orphaned VPS computer · ID ${shortId}` : instance.ownerName}
                  </span>
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-[11px]",
                      instance.inUse || state === "Running"
                        ? "bg-success/15 text-success"
                        : state === "Stopped" || state === "Paused"
                          ? "bg-control text-ink-secondary"
                          : "bg-warning/15 text-warning",
                    )}
                  >
                    {state}
                  </span>
                </div>
                <div className="mt-1 text-[11.5px] text-ink-secondary">
                  {instance.orphaned ? "Its bot no longer exists" : "Owned by this bot"}
                </div>
                {instance.inUse && (
                  <div className="mt-1 text-[11.5px] text-ink-secondary">Stop this bot's work before removing its VPS computer.</div>
                )}
              </div>
              <button
                type="button"
                onClick={() => onRemove(instance)}
                disabled={loading || instance.inUse || removingName !== null}
                aria-busy={removing || undefined}
                title="Permanently remove this VPS computer"
                className="flex shrink-0 items-center gap-1.5 rounded-lg bg-danger/10 px-2.5 py-1.5 text-[12px] font-medium text-danger hover:bg-danger/15 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {removing ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                Remove
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
      title="Cloud computers"
      subtitle="Persistent OpenMaus-managed Box desktops. Sleeping pauses compute use; deleting permanently erases that desktop and its files."
    >
      <div className="flex items-center justify-between gap-3">
        <div className="text-[12px] text-ink-secondary">
          {configured === true
            ? "Includes computers left behind by deleted bots so they can still be cleaned up."
            : configured === false
              ? "Add a Box API key in Connections to create and manage cloud computers."
              : "Refresh to check the OpenMaus-managed computers in your Box account."}
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading || pending !== null}
          aria-label="Refresh cloud computers"
          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-hairline/40 px-2.5 py-1.5 text-[12px] text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-40"
        >
          <RefreshCw size={12} className={cn(loading && "animate-spin")} /> Refresh
        </button>
      </div>

      {error && <div role="alert" className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</div>}

      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {loading
          ? "Checking cloud computers."
          : unavailableReason
            ? `Cloud computer inventory unavailable: ${unavailableReason}`
            : configured === false
              ? "Box is not connected."
              : `${instances.length} cloud computer${instances.length === 1 ? "" : "s"} found.`}
      </p>

      <div
        aria-busy={loading || pending !== null}
        className="mt-3 overflow-hidden rounded-xl border border-hairline/40"
      >
        {loading && instances.length === 0 ? (
          <div className="flex items-center gap-2 px-3 py-4 text-[13px] text-ink-secondary">
            <Loader2 size={13} className="animate-spin" /> Checking cloud computers…
          </div>
        ) : unavailableReason ? (
          <div className="flex items-center gap-2 px-3 py-4 text-[13px] text-ink-secondary">
            <AlertTriangle size={14} className="shrink-0 text-warning" /> {unavailableReason}
          </div>
        ) : configured === false ? (
          <div className="flex items-center gap-2 px-3 py-4 text-[13px] text-ink-secondary">
            <Cloud size={14} className="shrink-0" /> Box is not connected.
          </div>
        ) : instances.length === 0 ? (
          <div className="px-3 py-4 text-[13px] text-ink-secondary">No OpenMaus-managed cloud computers found.</div>
        ) : instances.map((instance, index) => {
          const state = cloudComputerInventoryState(instance);
          const isPending = pending?.boxId === instance.boxId;
          const canSleep = cloudComputerCanSleep(instance);
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
                    {instance.orphaned ? "Orphaned computer" : instance.ownerName}
                  </span>
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-[11px]",
                      instance.inUse || state === "Running"
                        ? "bg-success/15 text-success"
                        : state === "Sleeping" || state === "Going to sleep"
                          ? "bg-control text-ink-secondary"
                          : "bg-warning/15 text-warning",
                    )}
                  >
                    {state}
                  </span>
                </div>
                <div className="mt-1 break-all text-[11.5px] text-ink-secondary">
                  {instance.orphaned ? "Its bot no longer exists" : "Owned by this bot"} · {instance.name}
                </div>
                {instance.inUse && (
                  <div className="mt-1 text-[11.5px] text-ink-secondary">Stop this bot's work before changing its computer.</div>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => onSleep(instance)}
                  disabled={loading || instance.inUse || pending !== null || !canSleep}
                  aria-busy={isPending && pending?.action === "sleep" ? true : undefined}
                  title={canSleep ? "Put this cloud computer to sleep" : `This cloud computer is ${state.toLowerCase()}`}
                  className="flex items-center gap-1.5 rounded-lg border border-hairline/40 px-2.5 py-1.5 text-[12px] text-ink-secondary hover:bg-control hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {isPending && pending?.action === "sleep" ? <Loader2 size={12} className="animate-spin" /> : <Moon size={12} />}
                  Sleep
                </button>
                <button
                  type="button"
                  onClick={() => onDelete(instance)}
                  disabled={loading || instance.inUse || pending !== null}
                  aria-busy={isPending && pending?.action === "delete" ? true : undefined}
                  title="Permanently delete this cloud computer"
                  className="flex items-center gap-1.5 rounded-lg bg-danger/10 px-2.5 py-1.5 text-[12px] font-medium text-danger hover:bg-danger/15 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {isPending && pending?.action === "delete" ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                  Delete
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
      title="Per-bot desktops"
      subtitle={`${unavailableReason ? "Inventory unavailable." : `${instances.length}/${maxInstances} created.`} This list includes old desktops even when their bot now uses another destination.`}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="text-[12px] text-ink-secondary">
          Delete OpenMaus-managed desktops you no longer need to free a slot. Durable workspace files remain.
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading || deletingBotId !== null}
          aria-label="Refresh per-bot desktops"
          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-hairline/40 px-2.5 py-1.5 text-[12px] text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-40"
        >
          <RefreshCw size={12} className={cn(loading && "animate-spin")} /> Refresh
        </button>
      </div>

      {error && <div role="alert" className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</div>}

      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {loading
          ? "Checking existing Local VM desktops."
          : unavailableReason
            ? `Local VM inventory unavailable: ${unavailableReason}`
            : `${instances.length} per-bot desktop${instances.length === 1 ? "" : "s"} found.`}
      </p>

      <div
        aria-busy={loading || deletingBotId !== null}
        className="mt-3 overflow-hidden rounded-xl border border-hairline/40"
      >
        {loading && instances.length === 0 ? (
          <div className="flex items-center gap-2 px-3 py-4 text-[13px] text-ink-secondary">
            <Loader2 size={13} className="animate-spin" /> Checking existing desktops…
          </div>
        ) : unavailableReason ? (
          <div className="flex items-center gap-2 px-3 py-4 text-[13px] text-ink-secondary">
            <AlertTriangle size={14} className="shrink-0 text-warning" /> {unavailableReason}
          </div>
        ) : instances.length === 0 ? (
          <div className="px-3 py-4 text-[13px] text-ink-secondary">No per-bot desktops have been created.</div>
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
                  Current destination: {destinationLabels[instance.destination]}
                </div>
                {!managed && (
                  <div className="mt-1 text-[11.5px] text-warning">
                    This container is not managed by OpenMausBot. Review and remove it directly in Docker or Podman.
                  </div>
                )}
                {managed && instance.problem && !instance.inUse && (
                  <div className="mt-1 text-[11.5px] text-warning">{instance.problem}</div>
                )}
                {managed && instance.inUse && (
                  <div className="mt-1 text-[11.5px] text-ink-secondary">Stop this bot's turn before deleting its desktop.</div>
                )}
              </div>
              {managed && <button
                type="button"
                onClick={() => onDelete(instance)}
                disabled={loading || instance.inUse || deletingBotId !== null}
                aria-busy={deleting || undefined}
                title={instance.inUse ? "Stop this bot's turn before deleting its Local VM" : `Delete ${instance.name}'s Local VM`}
                className="flex shrink-0 items-center gap-1.5 rounded-lg bg-danger/10 px-2.5 py-1.5 text-[12px] font-medium text-danger hover:bg-danger/15 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {deleting ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                Delete
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

export function LocalComputerSection() {
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [policyPending, setPolicyPending] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
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

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(...computerInventoryRequest("status", signal));
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error ?? `Status request failed (${response.status})`);
    setStatus(body as Status);
    setError(null);
  }, []);

  const refreshInventory = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(...computerInventoryRequest("local-vms", signal));
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error ?? `Inventory request failed (${response.status})`);
    const payload = body as LocalVmInventoryPayload;
    setInventory(payload.instances);
    setInventoryMax(payload.maxInstances);
    setInventoryUnavailableReason(payload.available ? null : (payload.problem ?? "Container runtime unavailable"));
    setInventoryError(null);
  }, []);

  const refreshCloudInventory = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(...computerInventoryRequest("cloud", signal));
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error ?? `Cloud inventory request failed (${response.status})`);
    const payload = body as CloudComputerInventoryPayload;
    const reconciled = reconcileCloudInventorySnapshot(
      Array.isArray(payload.instances) ? payload.instances : [],
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
        : (payload.problem ?? "Cloud computer inventory is unavailable"),
    );
    setCloudError(null);
  }, []);

  const refreshVpsInventory = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(...computerInventoryRequest("vps", signal));
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error ?? `VPS inventory request failed (${response.status})`);
    const payload = body as VpsComputerInventoryPayload;
    setVpsInventory(Array.isArray(payload.instances) ? payload.instances : []);
    setVpsConfigured(payload.configured === true);
    setVpsSshAlias(typeof payload.sshAlias === "string" ? payload.sshAlias : null);
    setVpsUnavailableReason(
      payload.available || !payload.configured
        ? null
        : (payload.problem ?? "VPS computer inventory is unavailable"),
    );
    setVpsError(null);
  }, []);

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    let controller: AbortController | undefined;
    const poll = async () => {
      controller = new AbortController();
      try {
        await refresh(controller.signal);
      } catch (e) {
        if (active && !(e instanceof DOMException && e.name === "AbortError")) {
          setStatus(null);
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (active) {
          setLoading(false);
          timer = window.setTimeout(() => void poll(), 5000);
        }
      }
    };
    void poll();
    return () => {
      active = false;
      controller?.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [refresh, refreshKey]);

  useEffect(() => {
    if (status?.mode !== "per-bot") {
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
  }, [inventoryRefreshKey, refreshInventory, status?.mode]);

  // Box account listing is deliberately not polled. It can be expensive and
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

  const post = async (action: Exclude<Action, "recreate">) => {
    const response = await fetch(`/api/local-computer/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error ?? `${action} failed`);
    setStatus(body as Status);
  };

  const act = async (action: Action) => {
    if (
      action === "remove" &&
      !window.confirm("Delete the Local VM? Files and browser sign-ins in its durable workspace will remain.")
    ) return;
    if (
      action === "recreate" &&
      !window.confirm("Replace the existing Local VM with the pinned image and safety limits? Files and browser sign-ins in its durable workspace will remain.")
    ) return;
    setPending(action);
    setError(null);
    try {
      if (action === "recreate") {
        await post("remove");
        await post("run");
      } else {
        await post(action);
      }
      // The desktop starts after the container process; keep the progress
      // state honest and let the regular poll mark it Ready a few seconds on.
      await refresh();
      setAnnouncement(`Local VM ${action === "remove" ? "deleted" : action === "stop" ? "stopped" : "updated"}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(null);
    }
  };

  const savePolicy = async (mode: Status["mode"], maxInstances: number) => {
    setPolicyPending(true);
    setError(null);
    try {
      const response = await fetch("/api/config", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ localVm: { mode, maxInstances } }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Could not save the Local VM isolation policy");
      setStatus((current) => current ? { ...current, mode, max_instances: maxInstances } : current);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPolicyPending(false);
    }
  };

  const deletePerBotVm = async (instance: LocalVmInventoryInstance) => {
    if (!instance.managed) {
      setInventoryError("This container is not managed by OpenMausBot and cannot be removed here.");
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
      if (!response.ok) throw new Error(body.error ?? "Could not delete this Local VM");
      await refreshInventory();
      setAnnouncement(`Deleted ${instance.name}'s Local VM.`);
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
      if (!response.ok) throw new Error(body.error ?? `Could not ${action} this cloud computer`);
      cloudOverridesRef.current = {
        ...cloudOverridesRef.current,
        [instance.boxId]: action === "delete" ? "deleted" : "sleeping",
      };
      const reconciled = reconcileCloudInventorySnapshot(
        cloudInventoryRef.current,
        cloudInventoryRef.current,
        cloudOverridesRef.current,
      );
      cloudOverridesRef.current = reconciled.overrides;
      cloudInventoryRef.current = reconciled.instances;
      setCloudInventory(reconciled.instances);
      const subject = instance.orphaned ? "Orphaned cloud computer" : `${instance.ownerName}'s cloud computer`;
      setAnnouncement(action === "delete" ? `${subject} deleted.` : `${subject} is sleeping.`);
      try {
        await refreshCloudInventory();
      } catch (refreshError) {
        const detail = refreshError instanceof Error ? refreshError.message : String(refreshError);
        setCloudError(`${subject} was ${action === "delete" ? "deleted" : "put to sleep"}, but the list could not refresh: ${detail}`);
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
      if (!response.ok) throw new Error(body.error ?? "Could not remove this VPS computer");
      await refreshVpsInventory();
      setAnnouncement(`${instance.orphaned ? `Orphaned VPS computer ${shortId}` : `${instance.ownerName}'s VPS computer`} removed.`);
    } catch (e) {
      setVpsError(e instanceof Error ? e.message : String(e));
    } finally {
      setVpsRemovingName(null);
    }
  };

  const c = status?.commands;
  const ready = status?.ready === true;
  const existing = status?.container !== "missing";
  const needsRecreate = Boolean(
    existing &&
      (status?.container === "stopped" ||
        !status?.imageMatches ||
        !status?.managed ||
        status?.network === "unsafe" ||
        status?.security === "unsafe" ||
        status?.persistence === "unsafe"),
  );
  const unavailable = !loading && !status;
  const host = status?.platform === "darwin" ? "Mac" : "computer";
  const perBot = status?.mode === "per-bot";
  const perBotRuntimeUnsupported = perBot && status?.runtime === "container";
  const headerReady = perBot ? Boolean(status?.daemonUp && status?.image && !perBotRuntimeUnsupported) : ready;

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

      <Card
        title="Local VM"
        subtitle={perBot
          ? `Private Cua Linux desktops on this ${host}, with one container and durable workspace per bot. Distinct bots can work concurrently and idle desktops stop after 8 hours.`
          : `A shared Cua Linux sandbox on this ${host} for bots to browse and work in — isolated, backed by one durable workspace, and automatically recycled after 8 hours without activity.`}
      >
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
              ? "Checking…"
              : unavailable
                ? "Status unavailable"
                : perBot && headerReady
                  ? "Ready for per-bot desktops"
                  : perBotRuntimeUnsupported
                    ? "Per-bot mode requires Docker or Podman"
                  : ready
                    ? "Ready"
                    : (status?.problem ?? "Not ready")}
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
            <RefreshCw size={12} /> Re-check
          </button>
          {ready && !perBot && (
            <a
              href={status?.viewer_url ?? c?.view}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1.5 rounded-lg border border-hairline/40 px-2.5 py-1 text-[12.5px] text-ink hover:bg-control"
            >
              <ExternalLink size={12} /> Watch screen
            </a>
          )}
        </div>
        {error && <div role="alert" className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</div>}
      </Card>

      <Card
        title="Isolation"
        subtitle="Shared keeps the original single-desktop behavior. Per bot gives each bot its own container, workspace, viewer port, lease, and idle timer."
      >
        <div className="flex overflow-hidden rounded-lg border border-hairline/40">
          {(["shared", "per-bot"] as const).map((mode, index) => (
            <button
              key={mode}
              type="button"
              disabled={!status || policyPending}
              onClick={() => void savePolicy(mode, status?.max_instances ?? 2)}
              className={cn(
                "flex-1 px-3 py-2 text-[13px] disabled:opacity-50",
                index > 0 && "border-l border-hairline/40",
                status?.mode === mode ? "bg-control text-ink" : "text-ink-secondary hover:text-ink",
              )}
            >
              {mode === "shared" ? "Shared" : "Per bot"}
            </button>
          ))}
        </div>
        <div className="mt-3 flex items-center justify-between gap-3">
          <div>
            <div className="text-[13px] text-ink">Maximum per-bot desktops</div>
            <div className="text-[11.5px] text-ink-secondary">Limits storage and host resource use; each running desktop may use up to 4 GB and 2 CPUs.</div>
          </div>
          <select
            aria-label="Maximum per-bot desktops"
            value={status?.max_instances ?? 2}
            disabled={!status || policyPending}
            onChange={(event) => void savePolicy(status?.mode ?? "shared", Number(event.target.value))}
            className="rounded-lg border border-hairline/40 bg-control px-2.5 py-1.5 text-[13px] text-ink disabled:opacity-50"
          >
            {[1, 2, 3, 4].map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </div>
        {policyPending && <div className="mt-2 flex items-center gap-1.5 text-[12px] text-ink-secondary"><Loader2 size={12} className="animate-spin" /> Saving…</div>}
      </Card>

      <Card title="Setup" subtitle="Once a container runtime is open, OpenMausBot prepares Cua and the VM for you.">
        <div className="flex flex-col gap-4">
          <Step n={1} title="Install a container runtime" done={Boolean(status?.runtime)}>
            <div className="text-[13px] leading-relaxed text-ink-secondary">
              Podman and Colima are free. Docker Desktop may require a paid licence for larger companies and government use.
            </div>
            {c?.install ? (
              <CommandLine command={c.install} />
            ) : (
              <a href="https://podman.io/docs/installation" target="_blank" rel="noreferrer" className="text-[13px] text-accent hover:underline">
                Open the Podman installation guide
              </a>
            )}
          </Step>

          <Step
            n={2}
            title={status?.runtime && !status.daemonUp ? `Open and start ${status.runtime}` : "Start the container runtime"}
            done={Boolean(status?.daemonUp)}
          >
            {!status?.runtime ? null : c?.runtimeStart ? (
              <CommandLine command={c.runtimeStart} />
            ) : (
              <div className="text-[13px] text-ink-secondary">Open the installed runtime and start its engine, then re-check.</div>
            )}
          </Step>

          <Step n={3} title="Prepare the Cua desktop (one-time download and build)" done={Boolean(status?.image)}>
            {status?.daemonUp && (
              <ActionButton action="pull" pending={pending} onClick={() => void act("pull")}>Prepare Cua desktop</ActionButton>
            )}
            {c?.pull && <details className="text-[12px] text-ink-secondary"><summary className="cursor-pointer">Show base-image download</summary><div className="mt-2"><CommandLine command={c.pull} /></div></details>}
          </Step>

          <Step
            n={4}
            title={perBot ? "Create a private desktop from each bot's Computer panel" : needsRecreate ? "Replace the older or unsafe VM" : "Create and start the Local VM"}
            done={!perBot && ready}
          >
            {perBot ? (
              <div className="text-[13px] leading-relaxed text-ink-secondary">
                {perBotRuntimeUnsupported
                  ? "Apple container requires an explicit host port, so OpenMausBot will not guess or expose one. Install or start Docker or Podman for safe per-bot dynamic loopback ports."
                  : <>
                      Choose <b className="text-ink">Local VM</b> for a bot, open that bot's Computer panel, then create its desktop there. OpenMausBot assigns a private workspace and an available loopback viewer port automatically.
                    </>}
              </div>
            ) : needsRecreate ? (
              <>
                <div className="flex gap-2 text-[13px] text-warning">
                  <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                  <span>{status?.problem}</span>
                </div>
                {status?.image ? (
                  <ActionButton action="recreate" pending={pending} onClick={() => void act("recreate")} danger>
                    <RotateCcw size={13} /> Delete and recreate
                  </ActionButton>
                ) : (
                  <div className="text-[13px] text-ink-secondary">Prepare the pinned Cua desktop above before replacing this VM.</div>
                )}
              </>
            ) : status?.container === "stopped" ? (
              <ActionButton action="start" pending={pending} onClick={() => void act("start")}>Start Local VM</ActionButton>
            ) : status?.container === "running" ? (
              <div className="flex items-center gap-2 text-[13px] text-ink-secondary"><Loader2 size={13} className="animate-spin" /> Waiting for the desktop…</div>
            ) : status?.image ? (
              <ActionButton action="run" pending={pending} onClick={() => void act("run")}>Create Local VM</ActionButton>
            ) : null}
            {c?.run && <details className="text-[12px] text-ink-secondary"><summary className="cursor-pointer">Show command</summary><div className="mt-2"><CommandLine command={c.run} /></div></details>}
          </Step>
        </div>
      </Card>

      {perBot && (
        <LocalVmInventoryCard
          instances={inventory}
          maxInstances={inventoryMax || status?.max_instances || 2}
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
            <span>OpenMausBot could not inspect the container runtime. Re-check, or review the app logs.</span>
          </div>
        </Card>
      )}

      <Card
        title="Safety and storage"
        subtitle={perBot
          ? `Cua Driver operates only each VM's desktop. Every bot gets a private host folder mounted at ${status?.workspace_guest_path ?? "/home/cua/workspace"}; its files and browser profile survive VM replacement. Viewers bind only to loopback, and exact bot-derived targets prevent one bot from attaching to another bot's container. Each VM keeps the existing 4 GB, 2 CPU, 512-process and dropped-capability limits. VMs can still reach the internet.`
          : `Cua Driver operates only the VM's desktop. Exactly one private host folder is mounted at ${status?.workspace_guest_path ?? "/home/cua/workspace"}; files and browser sign-ins there survive VM replacement, while everything elsewhere in the VM remains disposable. The password-protected viewer is available only on this machine. Docker and Podman runs are limited to 4 GB memory, 2 CPUs and 512 processes; all Linux capabilities are dropped except the two the desktop supervisor needs to switch to its unprivileged user. The VM can still reach the internet, and bots share it one at a time.`}
      >
        {existing && (
          <div className="flex flex-wrap gap-2">
            {status?.container === "running" && (
              <ActionButton action="stop" pending={pending} onClick={() => void act("stop")}>
                <Square size={12} /> Stop
              </ActionButton>
            )}
            <ActionButton action="remove" pending={pending} onClick={() => void act("remove")} danger>
              <Trash2 size={12} /> {perBot ? "Delete legacy shared VM" : "Delete VM"}
            </ActionButton>
          </div>
        )}
        <div className="mt-3 break-all text-[11px] text-ink-secondary">
          Durable workspace: {status?.workspace_path ?? "not created"} ·{" "}
          Cua Driver: {status?.driver_version ?? "0.20.0"} · Local image: {status?.image_ref ?? "not prepared"}
          {status?.base_image_ref ? <> · Base: {status.base_image_ref}</> : null}
        </div>
      </Card>
    </>
  );
}
