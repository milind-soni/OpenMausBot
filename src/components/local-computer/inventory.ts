import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";

export type Action = "pull" | "run" | "start" | "stop" | "remove" | "recreate";

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
  ownerBotId: string | null;
  ownerName: string | null;
  orphaned: boolean;
  inUse: boolean;
}

export interface VpsComputerInventoryPayload {
  configured: boolean;
  available: boolean;
  sshAlias: string | null;
  problem: string | null;
  instances: VpsComputerInventoryInstance[];
}

export const destinationLabelKeys: Record<LocalVmInventoryInstance["destination"], LocaleKey> = {
  auto: "vm.dest.auto",
  cloud: "vm.dest.cloud",
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

/** Box's account LIST is eventually consistent. Preserve the result of an
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

  // A transitioning Box can briefly disappear from LIST. Keep the last safe
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

/** An empty list proves deletion only when Box says the inventory read was
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

export function cloudComputerCanSleep(instance: CloudComputerInventoryInstance): boolean {
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

