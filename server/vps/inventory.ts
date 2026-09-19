// Read-only managed-container inventory for the Settings panel: a
// label-filtered container ls/inspect with identity revalidation before a
// container is shown as removable.

import { vpsSshAlias, type AppConfig } from "../config.ts";
import {
  CONTAINER_ID,
  FULL_CONTAINER_ID,
  MANAGED_VPS_CONTAINER_NAME,
  VPS_CONTAINER_LABEL,
  VPS_ENVIRONMENT_LABEL,
  VPS_MANAGED_LABEL,
  defaultRunner,
  snapshotVpsConfig,
  vpsContainerName,
  vpsDockerArgs,
  vpsEnvironmentId,
  type VpsCommandRunner,
} from "./cli.ts";

export interface ManagedVpsOwner {
  botId: string;
  name: string;
  inUse: boolean;
}

export interface ManagedVpsInventoryInstance {
  name: string;
  state: "created" | "restarting" | "running" | "removing" | "paused" | "exited" | "dead" | "unknown";
  ownerBotId: string | null;
  ownerName: string | null;
  orphaned: boolean;
  inUse: boolean;
}

export interface ManagedVpsInventory {
  configured: boolean;
  available: boolean;
  sshAlias: string | null;
  problem: string | null;
  instances: ManagedVpsInventoryInstance[];
}

const VPS_INVENTORY_LIMIT = 256;

const VPS_INVENTORY_STATES = new Set<ManagedVpsInventoryInstance["state"]>([
  "created",
  "restarting",
  "running",
  "removing",
  "paused",
  "exited",
  "dead",
]);

function inventoryFailure(alias: string, error: unknown): ManagedVpsInventory {
  const detail = (error instanceof Error ? error.message : String(error))
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, 200);
  return {
    configured: true,
    available: false,
    sshAlias: alias,
    problem: `Docker over SSH could not list managed computers${detail ? `: ${detail}` : ""}`,
    instances: [],
  };
}

function managedVpsState(value: unknown, running: unknown): ManagedVpsInventoryInstance["state"] {
  const state = typeof value === "string" ? value.toLowerCase() : "";
  if (VPS_INVENTORY_STATES.has(state as ManagedVpsInventoryInstance["state"])) {
    return state as ManagedVpsInventoryInstance["state"];
  }
  if (running === true) return "running";
  if (running === false) return "exited";
  return "unknown";
}

/** Read-only account inventory for Settings. This intentionally uses only
 * `container ls` and `container inspect`: opening Settings must never create,
 * start, stop, or probe a desktop. The second managed label and deterministic
 * name are both revalidated before a container is shown as removable. */
export async function scanManagedVpsComputers(
  cfg: AppConfig,
  owners: ManagedVpsOwner[],
  runner: VpsCommandRunner = defaultRunner,
): Promise<{ inventory: ManagedVpsInventory; containerIds: Map<string, string> }> {
  const alias = vpsSshAlias(cfg);
  if (!alias) {
    return {
      inventory: { configured: false, available: false, sshAlias: null, problem: null, instances: [] },
      containerIds: new Map(),
    };
  }

  try {
    const listed = await runner(vpsDockerArgs(alias, [
      "container",
      "ls",
      "--all",
      "--filter",
      `label=${VPS_MANAGED_LABEL}=1`,
      "--format",
      "{{.ID}}",
    ]), { timeoutMs: 20_000 });
    const ids = [...new Set(listed.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))];
    if (ids.length > VPS_INVENTORY_LIMIT || ids.some((id) => !CONTAINER_ID.test(id))) {
      throw new Error("the VPS returned an invalid or unexpectedly large managed-container list");
    }
    if (ids.length === 0) {
      return {
        inventory: { configured: true, available: true, sshAlias: alias, problem: null, instances: [] },
        containerIds: new Map(),
      };
    }

    const inspected = await runner(
      vpsDockerArgs(alias, ["container", "inspect", ...ids]),
      { timeoutMs: 20_000 },
    );
    const details = JSON.parse(inspected.stdout) as unknown;
    if (!Array.isArray(details) || details.length !== ids.length) {
      throw new Error("the VPS returned an incomplete managed-container inventory");
    }

    const ownerByName = new Map(owners.map((owner) => [vpsContainerName(owner.botId), owner]));
    const seenIds = new Set<string>();
    const seenNames = new Set<string>();
    const containerIds = new Map<string, string>();
    const instances: ManagedVpsInventoryInstance[] = [];
    for (const raw of details) {
      if (!raw || typeof raw !== "object") throw new Error("the VPS returned a malformed managed container");
      const detail = raw as {
        Id?: unknown;
        Name?: unknown;
        Config?: { Labels?: unknown };
        State?: { Status?: unknown; Running?: unknown };
      };
      const id = typeof detail.Id === "string" ? detail.Id.toLowerCase() : "";
      const name = typeof detail.Name === "string" ? detail.Name.replace(/^\//, "") : "";
      const labels = detail.Config?.Labels;
      const listedId = ids.find((candidate) => id.startsWith(candidate.toLowerCase()));
      if (
        !FULL_CONTAINER_ID.test(id) ||
        !listedId ||
        seenIds.has(listedId) ||
        !MANAGED_VPS_CONTAINER_NAME.test(name) ||
        seenNames.has(name) ||
        !labels ||
        typeof labels !== "object" ||
        (labels as Record<string, unknown>)[VPS_MANAGED_LABEL] !== "1" ||
        (labels as Record<string, unknown>)[VPS_CONTAINER_LABEL] !== name
      ) {
        throw new Error("the VPS returned a managed container whose identity could not be verified");
      }
      const owner = ownerByName.get(name);
      const environmentLabel = (labels as Record<string, unknown>)[VPS_ENVIRONMENT_LABEL];
      seenIds.add(listedId);
      seenNames.add(name);
      // A foreign installation can legitimately share this Docker daemon and
      // therefore appears in the label-filtered provider response. Count the
      // row as inspected, but never return an identifier that could make it
      // removable. Unlabelled pre-environment containers remain manageable
      // only while their deterministic name still maps to a local bot.
      if (environmentLabel !== vpsEnvironmentId() && !(environmentLabel === undefined && owner)) {
        continue;
      }
      containerIds.set(name, id);
      instances.push({
        name,
        state: managedVpsState(detail.State?.Status, detail.State?.Running),
        ownerBotId: owner?.botId ?? null,
        ownerName: owner?.name ?? null,
        orphaned: !owner,
        inUse: owner?.inUse === true,
      });
    }
    if (seenIds.size !== ids.length) {
      throw new Error("the VPS returned an incomplete managed-container inventory");
    }
    instances.sort((left, right) =>
      Number(left.orphaned) - Number(right.orphaned) ||
      (left.ownerName ?? left.name).localeCompare(right.ownerName ?? right.name),
    );
    return {
      inventory: { configured: true, available: true, sshAlias: alias, problem: null, instances },
      containerIds,
    };
  } catch (error) {
    return { inventory: inventoryFailure(alias, error), containerIds: new Map() };
  }
}

export async function listManagedVpsComputers(
  cfg: AppConfig,
  owners: ManagedVpsOwner[],
  runner: VpsCommandRunner = defaultRunner,
): Promise<ManagedVpsInventory> {
  cfg = snapshotVpsConfig(cfg);
  return (await scanManagedVpsComputers(cfg, owners, runner)).inventory;
}
