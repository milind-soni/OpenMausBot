// Box inventory — bounded account-wide paging plus the managed-box
// listing Settings and the deletion guards rely on.

import {
  adoptResolvedBox,
  boxCreateRecoverySnapshot,
  retireDeletedBoxCreate,
} from "../box-create-idempotency.ts";
import {
  boxDeletionSnapshot,
  getBoxDeletion,
  type BoxDeletionRecord,
} from "../box-delete-journal.ts";
import type { AppConfig } from "../config.ts";
import {
  BOX_ID,
  boxConfigured,
  boxInventoryProblem,
  boxJson,
  inspectBoxIdentity,
  safeBoxState,
  snapshotBoxConfig,
} from "./api.ts";
import {
  reconcileRecordedBoxDeletion,
  type BoxDeletionReconciliation,
} from "./deletion.ts";
import {
  boxNameFor,
  legacyBoxNameFor,
  LEGACY_MANAGED_BOX_NAME,
  SCOPED_MANAGED_BOX_NAME,
  scopedBoxPrefix,
} from "./naming.ts";

const BOX_INVENTORY_PAGE_SIZE = 200;

// Current self-serve accounts top out below 2,000 boxes. Keep the walk
// bounded anyway: a broken or adversarial cursor must not hold Settings open.
const MAX_BOX_INVENTORY_PAGES = 10;

export interface ManagedBoxOwner {
  botId: string;
  name: string;
  inUse: boolean;
}

export interface ManagedBoxInventoryInstance {
  boxId: string;
  name: string;
  state: string;
  ownerBotId: string | null;
  ownerName: string | null;
  orphaned: boolean;
  inUse: boolean;
}

export interface ManagedBoxInventory {
  configured: boolean;
  available: boolean;
  problem: string | null;
  instances: ManagedBoxInventoryInstance[];
}

export async function listBoxPages(
  cfg: AppConfig,
): Promise<{ ok: true; boxes: any[] } | { ok: false; problem: string }> {
  const boxes: any[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;

  for (let page = 0; page < MAX_BOX_INVENTORY_PAGES; page += 1) {
    const path = `/boxes?limit=${BOX_INVENTORY_PAGE_SIZE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    let listed: Awaited<ReturnType<typeof boxJson>>;
    try {
      listed = await boxJson(cfg, path, { signal: AbortSignal.timeout(20_000) });
    } catch {
      return { ok: false, problem: "Could not reach ascii.dev to list cloud computers — check your connection and refresh" };
    }
    if (!listed.ok || !Array.isArray(listed.body?.boxes)) {
      return { ok: false, problem: boxInventoryProblem(listed.status, listed.body) };
    }
    boxes.push(...listed.body.boxes);

    const next = listed.body?.pageInfo?.nextCursor;
    if (next === undefined || next === null || next === "") return { ok: true, boxes };
    if (typeof next !== "string" || next.length > 4_096) {
      return { ok: false, problem: "ascii.dev returned an invalid cloud computer page cursor" };
    }
    if (seenCursors.has(next)) {
      return { ok: false, problem: "ascii.dev repeated a cloud computer page cursor — refresh and try again" };
    }
    seenCursors.add(next);
    cursor = next;
  }

  return { ok: false, problem: "ascii.dev returned too many cloud computer pages — narrow the account inventory and refresh" };
}

/**
 * One account listing for Settings and deletion guards. Only boxes
 * carrying OpenMausBot's exact deterministic name shape leave this boundary;
 * provider desktop links, IPs, environment details and other raw fields never
 * reach the renderer. Only names scoped to this installation may become
 * ownerless rows. Legacy names are accepted solely when a current bot proves
 * ownership; foreign-install and ownerless legacy rows remain invisible and
 * therefore cannot become deletion targets.
 */
export async function listManagedBoxes(
  cfg: AppConfig,
  owners: ManagedBoxOwner[],
  options: { adoptLegacy?: boolean } = {},
): Promise<ManagedBoxInventory> {
  cfg = snapshotBoxConfig(cfg);
  if (!boxConfigured(cfg)) {
    return { configured: false, available: false, problem: null, instances: [] };
  }

  const listed = await listBoxPages(cfg);
  if (!listed.ok) {
    return {
      configured: true,
      available: false,
      problem: listed.problem,
      instances: [],
    };
  }

  const namedOwners = await Promise.all(owners.map(async (owner) => ({
    currentName: await boxNameFor(owner.botId),
    legacyName: legacyBoxNameFor(owner.botId),
    owner,
  })));
  const invalidInventory = (problem: string): ManagedBoxInventory => ({
    configured: true,
    available: false,
    problem,
    instances: [],
  });

  // A successful create is journaled before the account-wide LIST is
  // guaranteed to include it. Reconcile that durable identity with the
  // authoritative direct endpoint so Settings can still display and delete
  // the computer. Credential replacement probes deliberately opt out: their
  // token must be judged only by the account inventory it can list.
  let candidates = [...listed.boxes];
  if (options.adoptLegacy !== false) {
    const namedOwnerByBotId = new Map(namedOwners.map((entry) => [entry.owner.botId, entry] as const));
    let recoveries: ReturnType<typeof boxCreateRecoverySnapshot>;
    try {
      recoveries = boxCreateRecoverySnapshot();
    } catch {
      return invalidInventory("OpenMausBot could not safely read its cloud computer recovery records");
    }
    for (const recovery of recoveries) {
      if (!recovery.resolved || !recovery.boxId) continue;
      const namedOwner = namedOwnerByBotId.get(recovery.botId);
      if (!namedOwner) continue;

      const matchingRows = candidates.filter((candidate) => candidate?.id === recovery.boxId);
      if (matchingRows.length > 1) {
        return invalidInventory("ascii.dev returned a conflicting id for an OpenMaus-managed cloud computer — refresh or repair it in ascii.dev");
      }
      if (matchingRows.length === 1) {
        const listedName = typeof matchingRows[0]?.name === "string" ? matchingRows[0].name : "";
        if (listedName !== namedOwner.currentName && listedName !== namedOwner.legacyName) {
          return invalidInventory("A remembered cloud computer no longer has its OpenMausBot owner name — repair it in ascii.dev before continuing");
        }
        continue;
      }

      const inspected = await inspectBoxIdentity(cfg, recovery.boxId);
      if (!inspected.available) {
        return invalidInventory(inspected.problem ?? "A remembered cloud computer could not be verified");
      }
      if (!inspected.identity) {
        // Direct 404/410 is stronger than an eventually-consistent LIST row.
        candidates = candidates.filter((candidate) => candidate?.id !== recovery.boxId);
        retireDeletedBoxCreate(recovery.boxId);
        continue;
      }
      if (
        inspected.identity.name !== namedOwner.currentName
        && inspected.identity.name !== namedOwner.legacyName
      ) {
        return invalidInventory("A remembered cloud computer no longer has its OpenMausBot owner name — repair it in ascii.dev before continuing");
      }
      const directCandidate = {
        id: inspected.identity.boxId,
        name: inspected.identity.name,
        state: inspected.identity.state,
      };
      candidates.push(directCandidate);
    }

    let deletions: BoxDeletionRecord[];
    try {
      deletions = boxDeletionSnapshot();
    } catch {
      return invalidInventory("OpenMausBot could not safely read its cloud computer deletion records");
    }
    for (const deletion of deletions) {
      let state: BoxDeletionReconciliation;
      try {
        state = await reconcileRecordedBoxDeletion(cfg, deletion, [0]);
      } catch (error) {
        return invalidInventory(error instanceof Error ? error.message : "A cloud computer deletion could not be verified");
      }
      if (state === "confirmed") {
        // LIST may still contain a stale row after the exact operation/direct
        // endpoint proved deletion. Do not let it resurrect the computer.
        candidates = candidates.filter((candidate) => candidate?.id !== deletion.boxId);
        continue;
      }

      const matchingRows = candidates.filter((candidate) => candidate?.id === deletion.boxId);
      if (matchingRows.length > 1) {
        return invalidInventory("ascii.dev returned a conflicting id for a cloud computer being deleted");
      }
      if (matchingRows.length === 1) {
        if (matchingRows[0]?.name !== deletion.name) {
          return invalidInventory("A cloud computer being deleted no longer has its remembered name — repair it in ascii.dev before continuing");
        }
        if (getBoxDeletion(deletion.boxId)?.phase === "accepted") {
          matchingRows[0] = { ...matchingRows[0], state: "removing" };
          candidates = candidates.map((candidate) => candidate?.id === deletion.boxId ? matchingRows[0] : candidate);
        }
        continue;
      }

      const current = getBoxDeletion(deletion.boxId);
      if (!current) continue;
      if (current.phase === "accepted") {
        candidates.push({ id: current.boxId, name: current.name, state: "removing" });
        continue;
      }
      // A prepared request may have lost its response, and a blocked request
      // is retryable. Keep the exact row actionable only after a direct read.
      const inspected = await inspectBoxIdentity(cfg, current.boxId);
      if (!inspected.available || !inspected.identity || inspected.identity.name !== current.name) {
        return invalidInventory(inspected.problem ?? "A cloud computer deletion target could not be verified");
      }
      candidates.push({
        id: inspected.identity.boxId,
        name: inspected.identity.name,
        state: inspected.identity.state,
      });
    }
  }
  const ownerByCurrentName = new Map(namedOwners.map(({ currentName, owner }) => [currentName, owner] as const));
  const ownerByLegacyName = new Map(namedOwners.map(({ legacyName, owner }) => [legacyName, owner] as const));
  const boxIdCounts = new Map<string, number>();
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const boxId = typeof candidate.id === "string" ? candidate.id : "";
    if (BOX_ID.test(boxId)) boxIdCounts.set(boxId, (boxIdCounts.get(boxId) ?? 0) + 1);
  }
  const ownedBoxByBot = new Map<string, string>();
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const name = typeof candidate.name === "string" ? candidate.name : "";
    const owner = ownerByCurrentName.get(name) ?? ownerByLegacyName.get(name) ?? null;
    if (!owner) continue;
    const boxId = typeof candidate.id === "string" ? candidate.id : "";
    if (!BOX_ID.test(boxId)) {
      return invalidInventory("ascii.dev returned an invalid id for an OpenMaus-managed cloud computer — refresh or repair it in ascii.dev");
    }
    const existing = ownedBoxByBot.get(owner.botId);
    if (existing && existing !== boxId) {
      return invalidInventory("ascii.dev returned conflicting cloud computers for one OpenMaus bot — repair them in ascii.dev before continuing");
    }
    ownedBoxByBot.set(owner.botId, boxId);
  }
  const instances: ManagedBoxInventoryInstance[] = [];
  const seenBoxIds = new Set<string>();
  const scopedPrefix = scopedBoxPrefix();
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const boxId = typeof candidate.id === "string" ? candidate.id : "";
    const name = typeof candidate.name === "string" ? candidate.name : "";
    let owner: ManagedBoxOwner | null = null;
    let legacyOwner = false;
    if (SCOPED_MANAGED_BOX_NAME.test(name)) {
      // A valid OMB name for another environment is account-visible but not
      // ours to display or mutate.
      if (!name.startsWith(scopedPrefix)) continue;
      owner = ownerByCurrentName.get(name) ?? null;
    } else if (LEGACY_MANAGED_BOX_NAME.test(name)) {
      // Pre-scope names have no installation provenance. A live local bot is
      // the only safe ownership proof; unmatched legacy rows stay provider-
      // managed until the person handles them in ascii.dev directly.
      owner = ownerByLegacyName.get(name) ?? null;
      if (!owner) continue;
      legacyOwner = true;
    } else {
      continue;
    }
    // Once a row names this installation (or a live bot through its legacy
    // deterministic name), silently skipping a malformed/duplicated identity
    // could let bot deletion mistake provider corruption for absence.
    if (!BOX_ID.test(boxId)) {
      return invalidInventory("ascii.dev returned an invalid id for an OpenMaus-managed cloud computer — refresh or repair it in ascii.dev");
    }
    if ((boxIdCounts.get(boxId) ?? 0) !== 1 || seenBoxIds.has(boxId)) {
      return invalidInventory("ascii.dev returned a conflicting id for an OpenMaus-managed cloud computer — refresh or repair it in ascii.dev");
    }
    if (legacyOwner && owner && options.adoptLegacy !== false) {
      try {
        adoptResolvedBox(owner.botId, boxId);
      } catch {
        return invalidInventory("OpenMausBot could not safely remember this legacy cloud computer's owner — repair it in ascii.dev before continuing");
      }
    }
    seenBoxIds.add(boxId);
    instances.push({
      boxId,
      name,
      state: safeBoxState(candidate.state),
      ownerBotId: owner?.botId ?? null,
      ownerName: owner?.name ?? null,
      orphaned: owner === null,
      inUse: owner?.inUse ?? false,
    });
  }
  instances.sort((a, b) => {
    if (a.orphaned !== b.orphaned) return a.orphaned ? 1 : -1;
    return (a.ownerName ?? a.name).localeCompare(b.ownerName ?? b.name);
  });
  return { configured: true, available: true, problem: null, instances };
}

export function inventoryFailure(inventory: ManagedBoxInventory): Error & { status: number } {
  const error = new Error(
    inventory.configured
      ? (inventory.problem ?? "Cloud computer inventory is unavailable")
      : "Box is not configured — add its API key in Settings → Connections",
  ) as Error & { status: number };
  error.status = inventory.configured ? 503 : 409;
  return error;
}
