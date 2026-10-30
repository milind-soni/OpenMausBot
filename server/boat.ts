// Boat (boat.dev) public API v1: https://docs.boat.dev/api/v1 (OpenAPI https://docs.boat.dev/openapi/boat-v1.yaml).
// Probed 2026-07-24, v1 2026-10-13: POST /sandboxes/{id}/commands runs shell synchronously (~0.2s); create answers 202
// and is ready in ~2s; stop→archived ~5s, resume→idle ~8s; disk persists, tmux does not. Stream tokens rotate on every
// state change and the dedicated IP across archive/resume, so never persist either.
import { createHash } from "node:crypto";

import { DATA_DIR, type AppConfig } from "./config.ts";
import { loadEnvironmentId } from "./environment.ts";
import { boatCredential, boatProviderApi, type ServiceCredential } from "./included-services.ts";
import { relayBody, relayPath } from "./boat-relay.ts";
import {
  blockedUntilBoatFinishes,
  boatDeletionOperation,
  deletionBlockedError,
  keptForNewerSnapshots,
  type BoatDeletionOperation,
} from "./boat-deletion.ts";
import {
  adoptResolvedBoat,
  beginBoatCreate,
  boatCreateRecoverySnapshot,
  discardBoatCreate,
  rememberCreatedBoat,
  resolveBoatCreate,
  retireDeletedBoatCreate,
  type BoatCreateRequest,
} from "./boat-create-idempotency.ts";
import {
  boatDeletionSnapshot,
  getBoatDeletion,
  hasPendingBoatDeletionForBot,
  markBoatDeletionAccepted,
  markBoatDeletionBlocked,
  prepareBoatDeletion,
  retireBoatDeletion,
  type BoatDeletionRecord,
} from "./boat-delete-journal.ts";

const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

export const MAX_REMOTE_COMMAND_LENGTH = 4_000;

/** Runs an owner-supplied console command without the boat's provider or account credentials in its environment. */
export function isolatedRemoteCommand(command: string): string {
  return [
    "exec env -i",
    'HOME="$HOME"',
    'USER="${USER:-$(id -un)}"',
    'LOGNAME="${LOGNAME:-${USER:-$(id -un)}}"',
    'PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"',
    'DISPLAY="${DISPLAY:-:0}"',
    'XAUTHORITY="${XAUTHORITY:-$HOME/.Xauthority}"',
    'XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"',
    'DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-}"',
    "/bin/bash -c",
    shellQuote(command),
  ].join(" ");
}

const READY = new Set(["idle", "ready", "running"]);
export const SLEEPING_BOAT_STATES = new Set(["archived", "archiving"]);
/** Never usable again: `cancelled` is a create that got no machine; its GET answers 404 next. */
const TERMINAL = new Set(["error", "cancelled"]);
const DEFAULT_BOAT_TTL_SECONDS = 8 * 60 * 60;
const TRIAL_BOAT_TTL_SECONDS = 2 * 60 * 60;
const BOAT_CREATE_IN_PROGRESS_RETRY_DELAYS_MS = [250, 750, 1_500] as const;
const BOAT_DELETE_OPERATION_POLL_DELAYS_MS = [0, 100, 250, 500, 1_000, 2_000] as const;
const BOAT_INVENTORY_PAGE_SIZE = 200;
// Bounded: a broken or adversarial cursor must not hold Settings open.
const MAX_BOAT_INVENTORY_PAGES = 10;
const LEGACY_MANAGED_BOAT_NAME = /^ogb-[a-z0-9]{1,8}-[a-f0-9]{6}$/;
const SCOPED_MANAGED_BOAT_NAME = /^ogb-[a-f0-9]{12}-[a-z0-9]{1,8}-[a-f0-9]{6}$/;
const BOAT_ID = /^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/;
/** Sandbox.state in v1, plus OpenMausBot's own `removing` for a sandbox whose deletion is under way. */
const BOAT_STATES = new Set([
  "init", "provisioning", "provisioned", "cloning", "ready", "idle", "running", "archiving", "archived", "error", "cancelled", "removing",
]);
// Names carry a hash of the local environment id, so another installation on the same account never claims these computers.
let scopedBoatPrefixCache: string | null = null;

/** Call only after startup has migrated the data dir and taken its writer lease. */
function scopedBoatPrefix(): string {
  if (scopedBoatPrefixCache) return scopedBoatPrefixCache;
  const scope = createHash("sha256")
    .update(loadEnvironmentId(DATA_DIR))
    .digest("hex")
    .slice(0, 12);
  scopedBoatPrefixCache = `ogb-${scope}-`;
  return scopedBoatPrefixCache;
}

export interface ManagedBoatOwner {
  botId: string;
  name: string;
  inUse: boolean;
}

export interface ManagedBoatInventoryInstance {
  boxId: string;
  name: string;
  state: string;
  ownerBotId: string | null;
  ownerName: string | null;
  orphaned: boolean;
  inUse: boolean;
}

export interface ManagedBoatInventory {
  configured: boolean;
  available: boolean;
  problem: string | null;
  credentialRejected?: boolean;
  instances: ManagedBoatInventoryInstance[];
}

export interface BoatIdentityInspection {
  available: boolean;
  identity: { boxId: string; name: string; state: string } | null;
  problem: string | null;
}

export type BoatTurnLifecycleAction = "attach" | "provision" | "wake";

export function boatTurnLifecycleAction(state: string | null): BoatTurnLifecycleAction {
  if (state && READY.has(state)) return "attach";
  return state ? "wake" : "provision";
}

export type ManagedBoatMutationClaim = (
  instance: ManagedBoatInventoryInstance,
) => (() => void) | void;

/** One credential for the whole operation, even if Settings swaps the config mid-request. */
function snapshotBoatConfig(cfg: AppConfig): AppConfig {
  return { box: cfg.box ? { token: cfg.box.token } : undefined };
}

/** An own token goes to Boat; Cloud Pro's included token only to its relay. */
function boatFetch(cfg: AppConfig, path: string, opts: RequestInit = {}) {
  const account = boatAccount(cfg);
  return fetch(`${account?.api ?? boatProviderApi()}${relayPath(account, path)}`, {
    ...opts,
    headers: {
      authorization: `Bearer ${account?.token}`,
      "content-type": "application/json",
      ...opts.headers,
    },
  });
}

async function boatJson(cfg: AppConfig, path: string, opts: RequestInit = {}) {
  const res = await boatFetch(cfg, path, opts);
  const body: any = relayBody(boatAccount(cfg), await res.json().catch(() => null));
  return { ok: res.ok && body?.ok !== false, status: res.status, body };
}

function boatDeleteProvedAbsent(result: Awaited<ReturnType<typeof boatJson>>): boolean {
  return result.status === 404 || result.status === 410;
}

/** Retire the create receipt before the deletion fence, so a failed write leaves the fence in place. */
function finishRecordedBoatDeletion(boxId: string): void {
  retireDeletedBoatCreate(boxId);
  forgetBoatId(boxId);
  retireBoatDeletion(boxId);
}

function recordBoatDeletionOperation(boxId: string, operation: BoatDeletionOperation): BoatDeletionRecord | "confirmed" {
  if (operation.status === "blocked") {
    if (!blockedUntilBoatFinishes(operation)) return markBoatDeletionBlocked(boxId, operation);
  } else {
    const record = markBoatDeletionAccepted(boxId, operation);
    if (operation.status !== "completed") return record;
  }
  finishRecordedBoatDeletion(boxId);
  return "confirmed";
}

/** `kept`: blocked by data a fork or named snapshot still uses, reported only to the person's own delete. */
type BoatDeletionReconciliation = "confirmed" | "pending" | "blocked" | "kept";

/** Account LIST omission is never evidence: Boat's LIST is eventually consistent. */
async function reconcileRecordedBoatDeletion(
  cfg: AppConfig,
  initial: BoatDeletionRecord,
  pollDelaysMs: readonly number[] = [],
  reportKept = false,
): Promise<BoatDeletionReconciliation> {
  let record = initial;
  if (record.phase === "accepted" && record.status === "completed") {
    finishRecordedBoatDeletion(record.boxId);
    return "confirmed";
  }

  if (record.phase === "accepted" && record.operationId) {
    for (const delayMs of pollDelaysMs) {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      let polled: Awaited<ReturnType<typeof boatJson>>;
      try {
        polled = await boatJson(cfg, `/deletion-operations/${record.operationId}`, {
          signal: AbortSignal.timeout(20_000),
        });
      } catch {
        break;
      }
      if (!polled.ok) break;
      const operation = boatDeletionOperation(polled.body, record.boxId, record.operationId);
      if (!operation) break;
      const next = recordBoatDeletionOperation(record.boxId, operation);
      if (next === "confirmed") return next;
      record = next;
      // Boat's own word decides: the sandbox leaves every list as soon as the delete is accepted.
      if (reportKept && keptForNewerSnapshots(operation)) return "kept";
      if (record.phase === "blocked") break;
    }
  }

  // Only a direct 404/410 on the immutable id is alternate completion proof.
  const inspected = await inspectBoatIdentity(cfg, record.boxId);
  if (!inspected.available) return record.phase === "blocked" ? "blocked" : "pending";
  if (!inspected.identity) {
    finishRecordedBoatDeletion(record.boxId);
    return "confirmed";
  }
  if (inspected.identity.name !== record.name) {
    throw Object.assign(
      new Error("A cloud computer being deleted no longer has its remembered name — repair it in boat.dev before continuing"),
      { status: 503 },
    );
  }
  return record.phase === "blocked" ? "blocked" : "pending";
}

/** Before Settings swaps credentials: here a bare 404 is no proof, it may be a different account. */
export async function verifyBoatDeletionCredential(cfg: AppConfig): Promise<void> {
  cfg = snapshotBoatConfig(cfg);
  for (const initial of boatDeletionSnapshot()) {
    let record = initial;
    let operationAuthorized = false;
    if (record.phase === "accepted" && record.operationId) {
      let polled: Awaited<ReturnType<typeof boatJson>> | null = null;
      try {
        polled = await boatJson(cfg, `/deletion-operations/${record.operationId}`, {
          signal: AbortSignal.timeout(20_000),
        });
      } catch {
      }
      if (polled?.ok) {
        const operation = boatDeletionOperation(polled.body, record.boxId, record.operationId);
        if (operation) {
          operationAuthorized = true;
          const next = recordBoatDeletionOperation(record.boxId, operation);
          if (next === "confirmed") continue;
          record = next;
        }
      }
    }

    if (operationAuthorized) continue;

    const inspected = await inspectBoatIdentity(cfg, record.boxId);
    if (inspected.available && inspected.identity?.name === record.name) continue;
    if (!inspected.available) {
      throw Object.assign(
        new Error(`${inspected.problem ?? "a deleting cloud computer could not be verified"}. Retry with the Boat account that owns it`),
        { status: 503 },
      );
    }
    throw Object.assign(
      new Error("that Boat token cannot access the cloud computers whose deletion is still being reconciled"),
      { status: 409 },
    );
  }
}

async function confirmAcceptedBoatDeletion(
  cfg: AppConfig,
  record: BoatDeletionRecord,
  acceptedBody: any,
  pollDelaysMs: readonly number[] = BOAT_DELETE_OPERATION_POLL_DELAYS_MS,
): Promise<BoatDeletionReconciliation> {
  const operation = boatDeletionOperation(acceptedBody, record.boxId);
  if (!operation) {
    const inspected = await inspectBoatIdentity(cfg, record.boxId);
    if (inspected.available && !inspected.identity) {
      finishRecordedBoatDeletion(record.boxId);
      return "confirmed";
    }
    throw Object.assign(
      new Error(`boat.dev returned an invalid deletion receipt for ${record.boxId}; its deletion fence was kept`),
      { status: 503 },
    );
  }
  const next = recordBoatDeletionOperation(record.boxId, operation);
  if (next === "confirmed") return next;
  if (keptForNewerSnapshots(operation)) return "kept";
  return reconcileRecordedBoatDeletion(cfg, next, pollDelaysMs, true);
}

/** Send DELETE only after the immutable target is on disk. */
async function requestRecordedBoatDeletion(
  cfg: AppConfig,
  identity: { boxId: string; name: string; ownerBotId: string | null },
  pollDelaysMs: readonly number[] = BOAT_DELETE_OPERATION_POLL_DELAYS_MS,
): Promise<BoatDeletionReconciliation> {
  const deletion = prepareBoatDeletion(identity);
  let removed: Awaited<ReturnType<typeof boatJson>>;
  try {
    removed = await boatJson(cfg, `/sandboxes/${identity.boxId}`, {
      method: "DELETE",
      headers: { "X-Ascii-Confirm-Delete": identity.boxId },
    });
  } catch (error) {
    throw Object.assign(
      new Error("Could not confirm whether boat.dev accepted the delete. The computer was kept fenced; retry Delete to reconcile it"),
      { status: 503, cause: error },
    );
  }
  if (boatDeleteProvedAbsent(removed)) {
    finishRecordedBoatDeletion(identity.boxId);
    return "confirmed";
  }
  if (!removed.ok) {
    markBoatDeletionBlocked(identity.boxId);
    throw Object.assign(new Error(boatErrorMessage(removed.status, "boat delete", removed.body, usesIncludedBoat(cfg))), { status: removed.status });
  }
  const confirmation = await confirmAcceptedBoatDeletion(cfg, deletion, removed.body, pollDelaysMs);
  if (confirmation === "blocked" || confirmation === "kept") throw deletionBlockedError(identity.boxId, confirmation === "kept");
  return confirmation;
}

function boatBotNameParts(botId: string): { prefix: string; hash: string } {
  const prefix = botId.slice(0, 8).toLowerCase().replace(/[^a-z0-9]/g, "") || "bot";
  const hash = createHash("sha256").update(botId).digest("hex").slice(0, 6);
  return { prefix, hash };
}

function legacyBoatNameFor(botId: string): string {
  const { prefix, hash } = boatBotNameParts(botId);
  return `ogb-${prefix}-${hash}`;
}

export async function boatNameFor(botId: string) {
  const { prefix, hash } = boatBotNameParts(botId);
  return `${scopedBoatPrefix()}${prefix}-${hash}`;
}

export async function boatNameMatchesBot(botId: string, name: string): Promise<boolean> {
  return name === await boatNameFor(botId) || name === legacyBoatNameFor(botId);
}

export async function runCommand(cfg: AppConfig, boxId: string, command: string, { timeoutMs = 120_000, signal }: { timeoutMs?: number; signal?: AbortSignal } = {}) {
  assertBoatNotDeleting(boxId);
  const res = await boatFetch(cfg, `/sandboxes/${boxId}/commands`, {
    method: "POST",
    body: JSON.stringify({ command }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
  });
  const body: any = await res.json().catch(() => null);
  return {
    ok: res.ok && body?.exitCode === 0,
    exitCode: body?.exitCode ?? null,
    stdout: body?.stdout ?? "",
    stderr: body?.stderr ?? "",
  };
}

// Boat desktop access: VNC (POST /desktop?vnc=1) first, a plain WebSocket that survives P2P-blocking networks and answers
// {provisioning:true} until ready; WebRTC (POST /desktop) is a STUN-only fallback that can hang. The sandbox's desktopUrl is not usable alone.
async function mintDesktopUrl(cfg: AppConfig, boxId: string, { vncBudgetMs = 60_000, requestMs = 30_000 } = {}) {
  assertBoatNotDeleting(boxId);
  const t0 = Date.now();
  while (Date.now() - t0 < vncBudgetMs) {
    assertBoatNotDeleting(boxId);
    const { body } = await boatJson(cfg, `/sandboxes/${boxId}/desktop?vnc=1`, { method: "POST", signal: AbortSignal.timeout(requestMs) });
    if (body?.desktopUrl) return body.desktopUrl;
    if (!body?.provisioning) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  const { body } = await boatJson(cfg, `/sandboxes/${boxId}/desktop`, { method: "POST", signal: AbortSignal.timeout(requestMs) });
  return body?.desktopUrl ?? null;
}

async function waitReady(cfg: AppConfig, boxId: string, budgetMs = 90_000) {
  assertBoatNotDeleting(boxId);
  const deadline = Date.now() + budgetMs;
  const untilDeadline = () => AbortSignal.timeout(Math.max(1, deadline - Date.now()));
  const outOfTime = (error: unknown) => error instanceof Error && error.name === "TimeoutError";
  let resumeFailure: Error | null = null;
  try {
    while (Date.now() < deadline) {
      assertBoatNotDeleting(boxId);
      const { body } = await boatJson(cfg, `/sandboxes/${boxId}`, { signal: untilDeadline() });
      const state = body?.sandbox?.state;
      if (READY.has(state)) return body.sandbox;
      if (TERMINAL.has(state)) return null;
      // Boat: an archiving sandbox resumes only after its snapshot lands; a 5xx is retried next poll; 409 races a wake under way.
      if (state === "archived") {
        const resumed = await boatJson(cfg, `/sandboxes/${boxId}/resume`, { method: "POST", signal: untilDeadline() });
        if (resumed.ok) resumeFailure = null;
        else if (resumed.status !== 409) {
          const refusal = boatRefusal(resumed.status, "waking the cloud computer", resumed.body, usesIncludedBoat(cfg));
          if (resumed.status < 500) throw refusal;
          resumeFailure = refusal;
        }
      }
      await new Promise((r) => setTimeout(r, Math.min(2500, Math.max(0, deadline - Date.now()))));
    }
  } catch (error) {
    if (!outOfTime(error)) throw error;
  }
  if (resumeFailure) throw resumeFailure;
  return null;
}

const boatIdCache = new Map<string, string>();

function boatInventoryProblem(status: number, body: any, included = false): string {
  if (status === 401 || status === 403) {
    return included ? INCLUDED_BOAT_UNAVAILABLE : "boat.dev rejected the Boat API key — update it in Settings → API keys";
  }
  const service = boatServiceName(included);
  if (status === 429) return `${service} is rate-limiting this account — wait a minute and refresh`;
  const message = typeof body?.message === "string" ? body.message.trim() : "";
  return message ? `${service} could not list cloud computers: ${message}` : `${service} could not list cloud computers (${status})`;
}

/** A read that fails on the network or times out is sent once more; any answer, even an error status, is final. */
function boatRead(cfg: AppConfig, path: string) {
  const read = () => boatJson(cfg, path, { signal: AbortSignal.timeout(20_000) });
  return read().catch(async () => { await new Promise((resolve) => setTimeout(resolve, 1_000)); return read(); });
}

function safeBoatState(value: unknown): string {
  if (typeof value !== "string") return "unknown";
  const state = value.toLowerCase();
  return BOAT_STATES.has(state) ? state : "unknown";
}

async function listBoatPages(
  cfg: AppConfig,
): Promise<{ ok: true; boats: any[] } | { ok: false; problem: string; credentialRejected?: boolean; unreachable?: boolean }> {
  const boats: any[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;

  for (let page = 0; page < MAX_BOAT_INVENTORY_PAGES; page += 1) {
    const path = `/sandboxes?limit=${BOAT_INVENTORY_PAGE_SIZE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    let listed: Awaited<ReturnType<typeof boatJson>>;
    try {
      listed = await boatRead(cfg, path);
    } catch {
      return { ok: false, unreachable: true, problem: `Could not reach ${boatServiceName(usesIncludedBoat(cfg))} to list cloud computers — check your connection and refresh` };
    }
    if (!listed.ok || !Array.isArray(listed.body?.sandboxes)) {
      const credentialRejected = listed.status === 401 || listed.status === 403;
      return { ok: false, problem: boatInventoryProblem(listed.status, listed.body, usesIncludedBoat(cfg)), credentialRejected };
    }
    boats.push(...listed.body.sandboxes);

    const next = listed.body?.pageInfo?.nextCursor;
    if (next === undefined || next === null || next === "") return { ok: true, boats };
    if (typeof next !== "string" || next.length > 4_096) {
      return { ok: false, problem: "boat.dev returned an invalid cloud computer page cursor" };
    }
    if (seenCursors.has(next)) {
      return { ok: false, problem: "boat.dev repeated a cloud computer page cursor — refresh and try again" };
    }
    seenCursors.add(next);
    cursor = next;
  }

  return { ok: false, problem: "boat.dev returned too many cloud computer pages — narrow the account inventory and refresh" };
}

/** Only rows with this installation's name shape leave, without provider links, IPs or env; foreign rows never become deletion targets. */
export async function listManagedBoats(
  cfg: AppConfig,
  owners: ManagedBoatOwner[],
  options: { adoptLegacy?: boolean } = {},
): Promise<ManagedBoatInventory> {
  cfg = snapshotBoatConfig(cfg);
  if (!boatConfigured(cfg)) {
    return { configured: false, available: false, problem: null, instances: [] };
  }

  const listed = await listBoatPages(cfg);
  if (!listed.ok) return { configured: true, available: false, problem: listed.problem, credentialRejected: listed.credentialRejected, instances: [] };

  const namedOwners = await Promise.all(owners.map(async (owner) => ({
    currentName: await boatNameFor(owner.botId),
    legacyName: legacyBoatNameFor(owner.botId),
    owner,
  })));
  const invalidInventory = (problem: string): ManagedBoatInventory => ({
    configured: true,
    available: false,
    problem,
    instances: [],
  });

  let candidates = [...listed.boats];
  if (options.adoptLegacy !== false) {
    const namedOwnerByBotId = new Map(namedOwners.map((entry) => [entry.owner.botId, entry] as const));
    let recoveries: ReturnType<typeof boatCreateRecoverySnapshot>;
    try {
      recoveries = boatCreateRecoverySnapshot();
    } catch {
      return invalidInventory("OpenMausBot could not safely read its cloud computer recovery records");
    }
    for (const recovery of recoveries) {
      if (!recovery.resolved || !recovery.boxId) continue;
      const namedOwner = namedOwnerByBotId.get(recovery.botId);
      if (!namedOwner) continue;

      const matchingRows = candidates.filter((candidate) => candidate?.id === recovery.boxId);
      if (matchingRows.length > 1) {
        return invalidInventory("boat.dev returned a conflicting id for an OpenMaus-managed cloud computer — refresh or repair it in boat.dev");
      }
      if (matchingRows.length === 1) {
        const listedName = typeof matchingRows[0]?.name === "string" ? matchingRows[0].name : "";
        if (listedName !== namedOwner.currentName && listedName !== namedOwner.legacyName) {
          return invalidInventory("A remembered cloud computer no longer has its OpenMausBot owner name — repair it in boat.dev before continuing");
        }
        continue;
      }

      const inspected = await inspectBoatIdentity(cfg, recovery.boxId);
      if (!inspected.available) {
        return invalidInventory(inspected.problem ?? "A remembered cloud computer could not be verified");
      }
      if (!inspected.identity) {
        candidates = candidates.filter((candidate) => candidate?.id !== recovery.boxId);
        retireDeletedBoatCreate(recovery.boxId);
        continue;
      }
      if (
        inspected.identity.name !== namedOwner.currentName
        && inspected.identity.name !== namedOwner.legacyName
      ) {
        return invalidInventory("A remembered cloud computer no longer has its OpenMausBot owner name — repair it in boat.dev before continuing");
      }
      const directCandidate = {
        id: inspected.identity.boxId,
        name: inspected.identity.name,
        state: inspected.identity.state,
      };
      candidates.push(directCandidate);
    }

    let deletions: BoatDeletionRecord[];
    try {
      deletions = boatDeletionSnapshot();
    } catch {
      return invalidInventory("OpenMausBot could not safely read its cloud computer deletion records");
    }
    for (const deletion of deletions) {
      let state: BoatDeletionReconciliation;
      try {
        state = await reconcileRecordedBoatDeletion(cfg, deletion, [0]);
      } catch (error) {
        return invalidInventory(error instanceof Error ? error.message : "A cloud computer deletion could not be verified");
      }
      if (state === "confirmed") {
        candidates = candidates.filter((candidate) => candidate?.id !== deletion.boxId);
        continue;
      }

      const matchingRows = candidates.filter((candidate) => candidate?.id === deletion.boxId);
      if (matchingRows.length > 1) {
        return invalidInventory("boat.dev returned a conflicting id for a cloud computer being deleted");
      }
      if (matchingRows.length === 1) {
        if (matchingRows[0]?.name !== deletion.name) {
          return invalidInventory("A cloud computer being deleted no longer has its remembered name — repair it in boat.dev before continuing");
        }
        if (getBoatDeletion(deletion.boxId)?.phase === "accepted") {
          matchingRows[0] = { ...matchingRows[0], state: "removing" };
          candidates = candidates.map((candidate) => candidate?.id === deletion.boxId ? matchingRows[0] : candidate);
        }
        continue;
      }

      const current = getBoatDeletion(deletion.boxId);
      if (!current) continue;
      if (current.phase === "accepted") {
        candidates.push({ id: current.boxId, name: current.name, state: "removing" });
        continue;
      }
      const inspected = await inspectBoatIdentity(cfg, current.boxId);
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
  const boatIdCounts = new Map<string, number>();
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const boxId = typeof candidate.id === "string" ? candidate.id : "";
    if (BOAT_ID.test(boxId)) boatIdCounts.set(boxId, (boatIdCounts.get(boxId) ?? 0) + 1);
  }
  const ownedBoatByBot = new Map<string, string>();
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const name = typeof candidate.name === "string" ? candidate.name : "";
    const owner = ownerByCurrentName.get(name) ?? ownerByLegacyName.get(name) ?? null;
    if (!owner) continue;
    const boxId = typeof candidate.id === "string" ? candidate.id : "";
    if (!BOAT_ID.test(boxId)) {
      return invalidInventory("boat.dev returned an invalid id for an OpenMaus-managed cloud computer — refresh or repair it in boat.dev");
    }
    const existing = ownedBoatByBot.get(owner.botId);
    if (existing && existing !== boxId) {
      return invalidInventory("boat.dev returned conflicting cloud computers for one OpenMaus bot — repair them in boat.dev before continuing");
    }
    ownedBoatByBot.set(owner.botId, boxId);
  }
  const instances: ManagedBoatInventoryInstance[] = [];
  const seenBoatIds = new Set<string>();
  const scopedPrefix = scopedBoatPrefix();
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const boxId = typeof candidate.id === "string" ? candidate.id : "";
    const name = typeof candidate.name === "string" ? candidate.name : "";
    let owner: ManagedBoatOwner | null = null;
    let legacyOwner = false;
    if (SCOPED_MANAGED_BOAT_NAME.test(name)) {
      if (!name.startsWith(scopedPrefix)) continue;
      owner = ownerByCurrentName.get(name) ?? null;
    } else if (LEGACY_MANAGED_BOAT_NAME.test(name)) {
      owner = ownerByLegacyName.get(name) ?? null;
      if (!owner) continue;
      legacyOwner = true;
    } else {
      continue;
    }
    // Throw, never skip: deletion must not mistake provider corruption for absence.
    if (!BOAT_ID.test(boxId)) {
      return invalidInventory("boat.dev returned an invalid id for an OpenMaus-managed cloud computer — refresh or repair it in boat.dev");
    }
    if ((boatIdCounts.get(boxId) ?? 0) !== 1 || seenBoatIds.has(boxId)) {
      return invalidInventory("boat.dev returned a conflicting id for an OpenMaus-managed cloud computer — refresh or repair it in boat.dev");
    }
    if (legacyOwner && owner && options.adoptLegacy !== false) {
      try {
        adoptResolvedBoat(owner.botId, boxId);
      } catch {
        return invalidInventory("OpenMausBot could not safely remember this legacy cloud computer's owner — repair it in boat.dev before continuing");
      }
    }
    seenBoatIds.add(boxId);
    instances.push({
      boxId,
      name,
      state: safeBoatState(candidate.state),
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

/** A direct read, not eventually consistent like LIST; only id, name and allowlisted state cross this boundary. */
export async function inspectBoatIdentity(cfg: AppConfig, boxId: string): Promise<BoatIdentityInspection> {
  cfg = snapshotBoatConfig(cfg);
  if (!BOAT_ID.test(boxId)) {
    return { available: false, identity: null, problem: "the remembered cloud computer id is invalid" };
  }
  let inspected: Awaited<ReturnType<typeof boatJson>>;
  try {
    inspected = await boatJson(cfg, `/sandboxes/${boxId}`, { signal: AbortSignal.timeout(20_000) });
  } catch {
    return {
      available: false,
      identity: null,
      problem: `Could not reach ${boatServiceName(usesIncludedBoat(cfg))} to verify a remembered cloud computer`,
    };
  }
  const candidate = inspected.body?.sandbox;
  const returnedId = typeof candidate?.id === "string" ? candidate.id : "";
  // A cancelled create got no machine: Boat reports it once, nameless, then 404s.
  if (inspected.status === 404 || inspected.status === 410 || (inspected.ok && returnedId === boxId && candidate.state === "cancelled")) {
    return { available: true, identity: null, problem: null };
  }
  if (!inspected.ok) {
    return { available: false, identity: null, problem: boatInventoryProblem(inspected.status, inspected.body, usesIncludedBoat(cfg)) };
  }
  const name = typeof candidate?.name === "string" ? candidate.name : "";
  if (returnedId !== boxId || name.length === 0 || name.length > 100 || /[\r\n]/.test(name)) {
    return { available: false, identity: null, problem: "boat.dev returned an invalid cloud computer identity" };
  }
  return { available: true, identity: { boxId, name, state: safeBoatState(candidate.state) }, problem: null };
}

function inventoryFailure(inventory: ManagedBoatInventory): Error & { status: number } {
  const error = new Error(
    inventory.configured
      ? (inventory.problem ?? "Cloud computer inventory is unavailable")
      : "Boat is not configured — add its API key in Settings → API keys",
  ) as Error & { status: number };
  error.status = inventory.configured ? 503 : 409;
  return error;
}

function deletionFenceError(): Error & { status: number } {
  return Object.assign(
    new Error("this cloud computer is being deleted — wait for it to finish, or retry Delete if it needs attention"),
    { status: 409 },
  );
}

function assertBoatNotDeleting(boxId: string): void {
  if (getBoatDeletion(boxId)) throw deletionFenceError();
}

function assertBotBoatNotDeleting(botId: string): void {
  if (hasPendingBoatDeletionForBot(botId)) throw deletionFenceError();
}

async function revalidateManagedBoat(
  cfg: AppConfig,
  owners: ManagedBoatOwner[],
  boxId: string,
): Promise<ManagedBoatInventoryInstance> {
  if (!BOAT_ID.test(boxId)) throw Object.assign(new Error("invalid cloud computer id"), { status: 400 });
  const inventory = await listManagedBoats(cfg, owners);
  if (!inventory.available) throw inventoryFailure(inventory);
  const instance = inventory.instances.find((candidate) => candidate.boxId === boxId);
  if (!instance) {
    throw Object.assign(new Error("that OpenMaus-managed cloud computer no longer exists"), { status: 404 });
  }
  return instance;
}

const QUIESCE_BROWSER = [
  'for name in chrome google-chrome chromium chromium-browser; do pid=$(pgrep -o -x "$name" 2>/dev/null || true); [ -z "$pid" ] || kill -TERM "$pid" 2>/dev/null || true; done',
  'for i in 1 2 3 4 5 6 7 8; do if ! pgrep -x chrome >/dev/null 2>&1 && ! pgrep -x google-chrome >/dev/null 2>&1 && ! pgrep -x chromium >/dev/null 2>&1 && ! pgrep -x chromium-browser >/dev/null 2>&1; then break; fi; sleep 0.25; done',
].join("; ");

async function stopBoat(cfg: AppConfig, boxId: string): Promise<void> {
  assertBoatNotDeleting(boxId);
  await runCommand(cfg, boxId, QUIESCE_BROWSER, { timeoutMs: 5_000 }).catch(() => null);
  const stopped = await boatJson(cfg, `/sandboxes/${boxId}/stop`, { method: "POST" });
  if (!stopped.ok) {
    throw Object.assign(new Error(boatErrorMessage(stopped.status, "boat sleep", stopped.body, usesIncludedBoat(cfg))), { status: stopped.status });
  }
}

function forgetBoatId(boxId: string): void {
  for (const [botId, cachedId] of boatIdCache) {
    if (cachedId === boxId) boatIdCache.delete(botId);
  }
}

export async function sleepManagedBoat(
  cfg: AppConfig,
  owners: ManagedBoatOwner[],
  boxId: string,
  claim?: ManagedBoatMutationClaim,
) {
  cfg = snapshotBoatConfig(cfg);
  assertBoatNotDeleting(boxId);
  const instance = await revalidateManagedBoat(cfg, owners, boxId);
  if (instance.inUse) {
    throw Object.assign(new Error("this cloud computer is in use — stop its bot's work first"), { status: 409 });
  }
  if (!SLEEPING_BOAT_STATES.has(instance.state) && !READY.has(instance.state)) {
    throw Object.assign(new Error(`this cloud computer cannot sleep while it is ${instance.state}`), { status: 409 });
  }
  const release = claim?.(instance);
  try {
    if (!SLEEPING_BOAT_STATES.has(instance.state)) await stopBoat(cfg, instance.boxId);
    forgetBoatId(instance.boxId);
    return { ok: true };
  } finally {
    release?.();
  }
}

/** The caller must echo the freshly listed name as well as the id; boat.dev requires the id in its confirmation header. */
export async function deleteManagedBoat(
  cfg: AppConfig,
  owners: ManagedBoatOwner[],
  boxId: string,
  confirmName: string,
  claim?: ManagedBoatMutationClaim,
  options: { pollDelaysMs?: readonly number[] } = {},
) {
  cfg = snapshotBoatConfig(cfg);
  const remembered = getBoatDeletion(boxId);
  if (remembered) {
    const reconciled = await reconcileRecordedBoatDeletion(cfg, remembered, [0]);
    if (reconciled === "confirmed") return { ok: true };
    // Retrying DELETE would create a second operation and weaken the only trustworthy receipt.
    const current = getBoatDeletion(boxId);
    if (current?.phase === "accepted") {
      return { ok: true, pending: true as const };
    }
  }
  const instance = await revalidateManagedBoat(cfg, owners, boxId);
  if (instance.inUse) {
    throw Object.assign(new Error("this cloud computer is in use — stop its bot's work first"), { status: 409 });
  }
  if (confirmName !== instance.name) {
    throw Object.assign(new Error("cloud computer confirmation no longer matches — refresh and try again"), { status: 409 });
  }
  const release = claim?.(instance);
  try {
    const confirmation = await requestRecordedBoatDeletion(cfg, {
      boxId: instance.boxId,
      name: instance.name,
      ownerBotId: instance.ownerBotId,
    }, options.pollDelaysMs);
    if (confirmation === "pending") {
      forgetBoatId(instance.boxId);
      return { ok: true, pending: true as const };
    }
    return { ok: true };
  } finally {
    release?.();
  }
}

export async function findBoat(cfg: AppConfig, botId: string) {
  cfg = snapshotBoatConfig(cfg);
  assertBotBoatNotDeleting(botId);
  const cachedId = boatIdCache.get(botId);
  if (cachedId) {
    let direct: Awaited<ReturnType<typeof boatJson>> | null = null;
    try {
      direct = await boatJson(cfg, `/sandboxes/${cachedId}`, { signal: AbortSignal.timeout(20_000) });
    } catch {
    }
    const directBoat = direct?.body?.sandbox;
    if (direct?.ok && directBoat?.id === cachedId && !TERMINAL.has(directBoat.state)) return directBoat;
    if (direct?.ok && directBoat?.id !== cachedId) {
      throw Object.assign(new Error("boat.dev returned an invalid cloud computer identity"), { status: 503 });
    }
    boatIdCache.delete(botId);
  }
  const name = await boatNameFor(botId);
  const legacyName = legacyBoatNameFor(botId);
  const listed = await listBoatPages(cfg);
  if (!listed.ok) {
    throw Object.assign(new Error(listed.problem), { status: 503, transient: listed.unreachable === true });
  }
  const expected = listed.boats.filter((candidate: any) => candidate?.name === name || candidate?.name === legacyName);
  if (expected.some((candidate: any) => !BOAT_ID.test(candidate?.id))) {
    throw Object.assign(new Error("boat.dev returned an invalid cloud computer identity"), { status: 503 });
  }
  const found = expected.find((candidate: any) => candidate.name === name && !TERMINAL.has(candidate.state))
    ?? expected.find((candidate: any) => candidate.name === legacyName && !TERMINAL.has(candidate.state))
    ?? null;
  if (found) {
    const duplicateId = listed.boats.filter((candidate: any) => candidate?.id === found.id).length !== 1;
    if (duplicateId) {
      throw Object.assign(new Error("boat.dev returned a conflicting cloud computer identity"), { status: 503 });
    }
    if (found.name === legacyName) adoptResolvedBoat(botId, found.id);
    boatIdCache.set(botId, found.id);
  }
  return found;
}

export async function readyBoat(cfg: AppConfig, botId: string, budgetMs = 60_000) {
  cfg = snapshotBoatConfig(cfg);
  const boat = await findBoat(cfg, botId);
  if (!boat) return null;
  if (READY.has(boat.state)) return boat;
  return waitReady(cfg, boat.id, budgetMs);
}

export function boatAccount(cfg: AppConfig): ServiceCredential | null {
  return boatCredential(cfg.box?.token);
}

export function boatConfigured(cfg: AppConfig) {
  return Boolean(boatAccount(cfg));
}

function usesIncludedBoat(cfg: AppConfig): boolean {
  return boatAccount(cfg)?.included === true;
}

/** Configured-or-not for Settings, never the token. */
export function describeBoatAccount(cfg: AppConfig): { configured: boolean; included?: true } {
  const account = boatAccount(cfg);
  return { configured: Boolean(account), ...(account?.included ? { included: true as const } : {}) };
}

export async function verifyToken(token: string): Promise<{ ok: true } | { ok: false; message: string; rejected?: true }> {
  try {
    const res = await fetch(`${boatProviderApi()}/sandboxes?limit=1`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.ok) return { ok: true };
    if (res.status === 401 || res.status === 403) {
      // Boat API keys are prefixed boat_ (box_ before v1).
      return {
        ok: false, rejected: true,
        message: /^(boat|box)_/.test(token)
          ? "boat.dev rejected that key — it may have been revoked or expired. Copy a fresh one from your boat.dev account."
          : "That doesn't look like a Boat API key: they start with boat_ (older ones with box_). Copy the API key from your boat.dev account (an account or session token won't work here).",
      };
    }
    return { ok: false, message: `boat.dev returned ${res.status} for that token — try again in a moment.` };
  } catch {
    return { ok: false, message: "Couldn't reach boat.dev to check that token — check your connection and retry." };
  }
}

const INCLUDED_BOAT_UNAVAILABLE = "The cloud computers included with your Cloud plan aren't available right now. Try again later.";
const boatServiceName = (included: boolean) => included ? "MausBot Cloud's computer service" : "boat.dev";

export function boatErrorMessage(status: number, what: string, body?: any, included = false): string {
  const theirs = typeof body?.message === "string" ? body.message.trim() : "";
  const link = typeof body?.error?.details?.billingUrl === "string" ? body.error.details.billingUrl : "";
  if (status === 402) {
    return [theirs || "boat.dev needs a paid Boat plan before it will create a computer.", link].filter(Boolean).join(" ");
  }
  if (status === 401 || status === 403) {
    if (included) return INCLUDED_BOAT_UNAVAILABLE;
    return "boat.dev rejected your Boat API key — paste a current one in Settings → API keys";
  }
  if (status === 429) {
    return theirs || "boat.dev is rate-limiting this account — wait a minute and try again";
  }
  return theirs ? `${what} failed: ${theirs}` : `${what} failed (${status})`;
}

export function boatRefusal(status: number, what: string, body?: any, included = false): Error & { boatStatus: number; boatCode?: string } {
  const code = body?.error?.code ?? body?.code;
  return Object.assign(new Error(boatErrorMessage(status, what, body, included)), {
    boatStatus: status, ...(typeof code === "string" && /^[a-z0-9_]{1,64}$/.test(code) ? { boatCode: code } : {}),
  });
}

/** boat.dev trial accounts refuse the eight-hour auto-stop with `trial_auto_stop_required`; retry once at the advertised maximum (documented: two hours). */
function trialBoatTtlSeconds(body: any): number | null {
  const code = body?.error?.code ?? body?.code;
  if (code !== "trial_auto_stop_required") return null;
  const details = body?.error?.details ?? body?.details ?? {};
  for (const value of [details.maxTtlSeconds, details.maximumTtlSeconds, details.maxAutoStopSeconds]) {
    if (Number.isInteger(value) && value > 0 && value <= DEFAULT_BOAT_TTL_SECONDS) return value;
  }
  return TRIAL_BOAT_TTL_SECONDS;
}

type BoatCreateResult = Awaited<ReturnType<typeof boatJson>> & {
  request: BoatCreateRequest;
  /** Auto-delete only a Boat this exact call created; a journal recovery may hold user data. */
  createdThisAttempt: boolean;
};

function idempotentCreateInProgress(result: Awaited<ReturnType<typeof boatJson>>): boolean {
  const code = result.body?.error?.code ?? result.body?.code;
  return result.status === 409 && code === "idempotency_in_progress";
}

async function requestBoatCreate(cfg: AppConfig, botId: string, ttlSeconds: number): Promise<BoatCreateResult> {
  // noEnv: no key this server holds ever reaches the computer. A trial-TTL retry needs a different idempotency key.
  const body = JSON.stringify({ ttlSeconds, noEnv: true });
  let attempt = beginBoatCreate(botId, body);
  let request = attempt.request;
  let createdThisAttempt = attempt.startedNow;

  // The previous process got the sandbox but died before naming it: never create again first; only proven absence frees the key.
  if (request.boxId) {
    const recovered = await boatJson(cfg, `/sandboxes/${request.boxId}`, {
      signal: AbortSignal.timeout(20_000),
    });
    if (recovered.status !== 404 && recovered.status !== 410) {
      return { ...recovered, request, createdThisAttempt: false };
    }
    discardBoatCreate(request);
    attempt = beginBoatCreate(botId, body);
    request = attempt.request;
    createdThisAttempt = attempt.startedNow;
  }

  let last: Awaited<ReturnType<typeof boatJson>> | null = null;
  let ambiguousRetries = 0;
  let inProgressRetries = 0;
  for (;;) {
    try {
      last = await boatJson(cfg, "/sandboxes", {
        method: "POST",
        headers: { "Idempotency-Key": request.idempotencyKey },
        signal: AbortSignal.timeout(45_000),
        body,
      });
    } catch (error) {
      // A dropped response is ambiguous: Boat may already have created the sandbox, and one retry with the same key recovers it.
      if (ambiguousRetries++ === 0) continue;
      throw error;
    }
    const boxId = last.body?.sandbox?.id;
    if (last.ok && typeof boxId === "string" && boxId) {
      request = rememberCreatedBoat(request, boxId);
      return { ...last, request, createdThisAttempt };
    }
    if (idempotentCreateInProgress(last)) {
      const delay = BOAT_CREATE_IN_PROGRESS_RETRY_DELAYS_MS[inProgressRetries++];
      if (delay !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      return { ...last, request, createdThisAttempt };
    }
    if ((last.status >= 500 || last.ok) && ambiguousRetries++ === 0) continue;
    // A 5xx or idempotency conflict can follow a provider-side create, so the key is kept for recovery.
    if (last.status < 500 && last.status !== 409 && !last.ok) discardBoatCreate(request);
    return { ...last, request, createdThisAttempt };
  }
}

async function createBoat(cfg: AppConfig, botId: string) {
  const first = await requestBoatCreate(cfg, botId, DEFAULT_BOAT_TTL_SECONDS);
  if (first.ok) return first;
  const trialTtl = trialBoatTtlSeconds(first.body);
  return trialTtl === null ? first : requestBoatCreate(cfg, botId, trialTtl);
}

/** A prior delete always wins: one click must never both erase and recreate a computer. */
async function finishPriorDeletionBeforeProvision(cfg: AppConfig, botId: string): Promise<void> {
  const remembered = boatDeletionSnapshot().filter((record) => record.ownerBotId === botId);
  if (!remembered.length) return;
  for (const deletion of remembered) {
    let state = await reconcileRecordedBoatDeletion(cfg, deletion, [0]);
    if (state !== "confirmed") {
      const current = getBoatDeletion(deletion.boxId);
      if (current?.phase === "prepared" || current?.phase === "blocked") {
        state = await requestRecordedBoatDeletion(cfg, {
          boxId: current.boxId,
          name: current.name,
          ownerBotId: current.ownerBotId,
        });
      }
    }
    if (state !== "confirmed") throw deletionFenceError();
  }
  throw Object.assign(
    new Error("the previous cloud computer deletion finished — retry to create a new computer"),
    { status: 409 },
  );
}

export async function boatStatus(cfg: AppConfig, botId: string) {
  cfg = snapshotBoatConfig(cfg);
  if (!boatConfigured(cfg)) return { configured: false, box: null };
  const boat = await findBoat(cfg, botId);
  return {
    configured: true,
    box: boat ? { boxId: boat.id, state: boat.state, desktopAvailable: boat.desktopAvailable ?? null } : null,
  };
}

export async function provisionBoat(cfg: AppConfig, botId: string, _botName: string) {
  cfg = snapshotBoatConfig(cfg);
  if (!boatConfigured(cfg)) {
    throw new Error("Boat is not configured — add its API key in Settings → API keys");
  }
  await finishPriorDeletionBeforeProvision(cfg, botId);
  const vmName = await boatNameFor(botId);
  let boat = await findBoat(cfg, botId);
  let created = false;
  let createRequest: BoatCreateRequest | null = null;
  try {
    if (!boat) {
      // Another process may have prepared a deletion since the lookup; never create a replacement before the fence is reconciled.
      assertBotBoatNotDeleting(botId);
      // Boat's TTL archives the computer if every stop path dies.
      const createRes = await createBoat(cfg, botId);
      if (!createRes.ok || !createRes.body?.sandbox?.id) {
        throw boatRefusal(createRes.status, "boat create", createRes.body, usesIncludedBoat(cfg));
      }
      boat = createRes.body.sandbox;
      createRequest = createRes.request;
      created = createRes.createdThisAttempt;
      // v1 create takes no name: the deterministic one is set right after.
      const rename = await boatJson(cfg, `/sandboxes/${boat.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: vmName }),
      });
      if (!rename.ok) throw new Error(boatErrorMessage(rename.status, "naming the cloud computer", rename.body, usesIncludedBoat(cfg)));
      if (createRequest) createRequest = resolveBoatCreate(createRequest);
    }
    const ready = await waitReady(cfg, boat.id);
    if (!ready) throw new Error("the cloud computer did not become ready within 90s — retry in a minute");

    // Nothing to install: every sandbox ships its own computer-use driver.
    const joinUrl = await mintDesktopUrl(cfg, boat.id);
    if (!joinUrl) throw new Error("the cloud computer's desktop link could not be created");
    return { boxId: boat.id, machineName: vmName, reused: !created, state: ready.state, joinUrl };
  } catch (error) {
    if (!created || !boat?.id) throw error;
    const originalMessage = error instanceof Error ? error.message : String(error);
    const inspected = await inspectBoatIdentity(cfg, boat.id);
    if (inspected.available && !inspected.identity) {
      retireDeletedBoatCreate(boat.id);
      boatIdCache.delete(botId);
      throw error;
    }
    let cleanupConfirmation: BoatDeletionReconciliation;
    try {
      cleanupConfirmation = await requestRecordedBoatDeletion(cfg, {
        boxId: boat.id,
        name: inspected.identity?.name ?? vmName,
        ownerBotId: botId,
      });
    } catch (cleanupError) {
      const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      throw new Error(`${originalMessage}. The new computer's deletion was not confirmed: ${cleanupMessage}. Check sandbox ${boat.id} in boat.dev.`);
    }
    if (cleanupConfirmation === "confirmed") throw error;
    boatIdCache.delete(botId);
    throw Object.assign(
      new Error(
        `${originalMessage}. boat.dev accepted deletion of the new computer, but it is still pending; `
        + `its recovery record was kept, along with its deletion fence. Check sandbox ${boat.id} in boat.dev.`,
        { cause: error },
      ),
      { status: 503 },
    );
  }
}

export async function joinBoat(cfg: AppConfig, botId: string) {
  cfg = snapshotBoatConfig(cfg);
  const boat = await findBoat(cfg, botId);
  if (!boat) throw new Error("no computer yet — provision it first");
  const ready = await waitReady(cfg, boat.id);
  if (!ready) throw new Error("the cloud computer did not wake in time — try again");
  // Archive/resume keeps disk but not processes; the sandbox restarts its own driver daemon.
  return { joinUrl: await mintDesktopUrl(cfg, boat.id), state: ready.state ?? null };
}

/** The only join path allowed while a bot turn is active: no lifecycle or guest-process change. */
export async function joinReadyBoat(cfg: AppConfig, botId: string) {
  cfg = snapshotBoatConfig(cfg);
  const boat = await findBoat(cfg, botId);
  if (!boat) throw Object.assign(new Error("no computer yet — provision it first"), { status: 409 });
  if (!READY.has(boat.state)) {
    throw Object.assign(
      new Error("the cloud computer is sleeping or starting — interrupt the bot before waking it"),
      { status: 409 },
    );
  }
  return { joinUrl: await mintDesktopUrl(cfg, boat.id), state: boat.state ?? null };
}

export async function sleepBoat(cfg: AppConfig, botId: string) {
  cfg = snapshotBoatConfig(cfg);
  const boat = await findBoat(cfg, botId);
  if (!boat) throw new Error("no computer for this bot");
  await stopBoat(cfg, boat.id);
  forgetBoatId(boat.id);
  return { ok: true };
}

export async function execOnBoat(cfg: AppConfig, botId: string, command: string) {
  cfg = snapshotBoatConfig(cfg);
  if (command.length > MAX_REMOTE_COMMAND_LENGTH) {
    throw new RangeError(`command is too long (maximum ${MAX_REMOTE_COMMAND_LENGTH} characters)`);
  }
  const boat = await findBoat(cfg, botId);
  if (!boat) throw new Error("no computer for this bot yet");
  const ready = await waitReady(cfg, boat.id, 60_000);
  if (!ready) throw new Error("the cloud computer did not wake");
  const out = await runCommand(cfg, boat.id, isolatedRemoteCommand(command));
  return { exitCode: out.exitCode, stdout: out.stdout.slice(-4000), stderr: out.stderr.slice(-2000) };
}

// Base64 over command stdout is not reliable for full-size frames (probed 2026-08-12: corrupted length), so frames come over HTTP.
// X11 captures leave the pointer out by default, hence scrot --pointer and ffmpeg -draw_mouse.
const PANEL_PATH = "/tmp/ogb-panel.jpg";
export const PANEL_FRAME_WIDTH = 1920;
export const PANEL_FRAME_QUALITY = 85;
// ffmpeg's -q:v runs 2 (best) to 31; 3 lands near JPEG quality 85.
const PANEL_FRAME_FFMPEG_Q = 3;

export function panelShotCommand({ width = PANEL_FRAME_WIDTH, quality = PANEL_FRAME_QUALITY, framePath = PANEL_PATH, nativeSize = false } = {}): string {
  return [
    "export DISPLAY=${DISPLAY:-:0}",
    `f=${shellQuote(framePath)}`,
    'rm -f "$f"',
    'w=$(xdotool getdisplaygeometry 2>/dev/null | cut -d" " -f1)',
    'case "$w" in ""|*[!0-9]*) w=0;; esac',
    `scrot -o -p -q ${quality} "$f" 2>/dev/null || import -window root -quality ${quality} "$f" 2>/dev/null || ffmpeg -y -f x11grab -draw_mouse 1 -i "$DISPLAY" -frames:v 1 -q:v ${PANEL_FRAME_FFMPEG_Q} "$f" >/dev/null 2>&1`,
    ...(nativeSize ? [] : [`if [ "$w" -gt ${width} ] 2>/dev/null && command -v convert >/dev/null 2>&1; then convert "$f" -resize ${width}x -quality ${quality} "$f" 2>/dev/null || true; fi`]),
    'test -s "$f" && echo captured',
  ].join("; ");
}
const SHOT_CMD = panelShotCommand();

// A compromised sandbox can answer with any size; cap what one frame may buffer.
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const FRAME_TOO_LARGE = "the cloud computer's frame exceeds the 8 MB limit";

export async function readFileBase64(cfg: AppConfig, boxId: string, path: string, signal?: AbortSignal): Promise<string | null> {
  let bytes: Buffer | null = null;
  let tooLarge = false;
  try {
    const res = await boatFetch(cfg, `/sandboxes/${boxId}/artifacts?path=${encodeURIComponent(path)}`, { signal });
    if (res.ok) {
      const declaredLength = res.headers.get("content-length");
      if (declaredLength !== null && Number(declaredLength) > MAX_FRAME_BYTES) tooLarge = true;
      else bytes = Buffer.from(await res.arrayBuffer());
    }
  } catch {
  }
  if (tooLarge || (bytes !== null && bytes.length > MAX_FRAME_BYTES)) {
    throw new Error(FRAME_TOO_LARGE);
  }
  if (bytes?.length) return bytes.toString("base64");
  signal?.throwIfAborted();
  const { ok, body } = await boatJson(cfg, `/sandboxes/${boxId}/files?path=${encodeURIComponent(path)}&encoding=base64`, { signal });
  const content = body?.content;
  if (ok && typeof content === "string" && content) {
    if (Buffer.byteLength(content, "base64") > MAX_FRAME_BYTES) throw new Error(FRAME_TOO_LARGE);
    return content;
  }
  return null;
}

export async function screenshotBoat(cfg: AppConfig, botId: string, knownBoatId?: string, options?: { signal?: AbortSignal; nativeSize?: boolean }) {
  cfg = snapshotBoatConfig(cfg);
  let boxId = knownBoatId;
  if (!boxId) {
    const boat = await findBoat(cfg, botId);
    if (!boat) throw new Error("no computer for this bot yet");
    if (!READY.has(boat.state)) throw new Error(`the cloud computer is ${boat.state}`);
    boxId = boat.id as string;
  }
  const framePath = options?.nativeSize ? PANEL_PATH + ".model.jpg" : PANEL_PATH;
  const out = await runCommand(cfg, boxId, options?.nativeSize ? panelShotCommand({ framePath, nativeSize: true }) : SHOT_CMD,
    { timeoutMs: 60_000, signal: options?.signal });
  if (!/captured/.test(out.stdout)) {
    throw new Error(out.stderr.slice(0, 200) || "screen capture failed on the cloud computer");
  }
  const data = await readFileBase64(cfg, boxId, framePath, options?.signal);
  if (!data) throw new Error("could not read the frame back from the cloud computer");
  return { png: data, format: "jpeg" };
}
