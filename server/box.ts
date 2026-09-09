// Box (box.ascii.dev) provider — the bot's cloud computer. Ported from
// agentcal-api src/providers/box.js, reshaped per-bot instead of
// per-customer: every bot gets one persistent box (deterministic name),
// stop pauses billing while the disk survives, and Join always mints a
// FRESH desktop URL (stream tokens rotate on every state change — never
// persist one).
//
// Substrate facts (probed by agentcal 2026-07-24 on a live box):
//   - REST only: POST /boxes/{id}/commands runs shell synchronously.
//   - stop→archived ~5s, resume→idle ~8s; disk persists, tmux does not.
//   - X11 desktop with Chrome + Ghostty; passwordless sudo; node 24.
//   - the dedicated IP rotates across archive/resume — never persist it.
import { createHash } from "node:crypto";

import { DATA_DIR, type AppConfig } from "./config.ts";
import { loadEnvironmentId } from "./environment.ts";
import {
  adoptResolvedBox,
  beginBoxCreate,
  discardBoxCreate,
  rememberCreatedBox,
  resolveBoxCreate,
  retireDeletedBoxCreate,
  type BoxCreateRequest,
} from "./box-create-idempotency.ts";
import {
  ensureRemoteCuaCommand,
  isolatedRemoteCommand,
  MAX_REMOTE_COMMAND_LENGTH,
  remoteComputerBootstrapCommand,
} from "./remote-computer.ts";

// overridable so tests can point at a stub instead of the live provider
const BOX_API = process.env.OMB_BOX_API || "https://ascii.dev/api/box/v1";
const READY = new Set(["idle", "ready", "running"]);
const SLEEPING = new Set(["archived", "archiving", "stopped", "stopping"]);
const DEFAULT_BOX_TTL_SECONDS = 8 * 60 * 60;
const TRIAL_BOX_TTL_SECONDS = 2 * 60 * 60;
const BOX_CREATE_IN_PROGRESS_RETRY_DELAYS_MS = [250, 750, 1_500] as const;
const BOX_DELETE_OPERATION_POLL_DELAYS_MS = [0, 100, 250, 500, 1_000, 2_000] as const;
const BOX_INVENTORY_PAGE_SIZE = 200;
// Current self-serve accounts top out below 2,000 boxes. Keep the walk
// bounded anyway: a broken or adversarial cursor must not hold Settings open.
const MAX_BOX_INVENTORY_PAGES = 10;
const LEGACY_MANAGED_BOX_NAME = /^ogb-[a-z0-9]{1,8}-[a-f0-9]{6}$/;
const SCOPED_MANAGED_BOX_NAME = /^ogb-[a-f0-9]{12}-[a-z0-9]{1,8}-[a-f0-9]{6}$/;
const BOX_ID = /^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/;
const BOX_DELETE_OPERATION_ID = /^bdop_[a-f0-9]{32}$/;
const BOX_DELETE_OPERATION_STATES = new Set(["pending", "processing", "blocked", "completed"]);
const BOX_STATES = new Set([
  "init",
  "idle",
  "ready",
  "running",
  "archived",
  "archiving",
  "stopped",
  "stopping",
  "provisioning",
  "provisioned",
  "cloning",
  "starting",
  "error",
]);
// Provider listings are account-wide. Hash the durable local environment id
// into every new name so another OpenMausBot installation using the same Box
// account cannot mistake this installation's computers for abandoned ones.
// The environment UUID itself never leaves the local data directory.
let scopedBoxPrefixCache: string | null = null;

/** Resolve only after server startup has migrated the legacy data directory
 * and acquired its writer lease. A static-import side effect here used to
 * create the new directory too early and suppress that migration. */
function scopedBoxPrefix(): string {
  if (scopedBoxPrefixCache) return scopedBoxPrefixCache;
  const scope = createHash("sha256")
    .update(loadEnvironmentId(DATA_DIR))
    .digest("hex")
    .slice(0, 12);
  scopedBoxPrefixCache = `ogb-${scope}-`;
  return scopedBoxPrefixCache;
}

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

export interface BoxIdentityInspection {
  available: boolean;
  identity: { boxId: string; name: string } | null;
  problem: string | null;
}

export type BoxTurnLifecycleAction = "attach" | "provision" | "wake" | "none";

/** Decide lifecycle work before a turn mounts Box. Auto may observe and
 * attach an already-ready Box, but only explicit Cloud may create or wake. */
export function boxTurnLifecycleAction({
  explicitCloud,
  canMount,
  state,
}: {
  explicitCloud: boolean;
  canMount: boolean;
  state: string | null;
}): BoxTurnLifecycleAction {
  if (!canMount) return "none";
  if (state && READY.has(state)) return "attach";
  if (!explicitCloud) return "none";
  return state ? "wake" : "provision";
}

export type ManagedBoxMutationClaim = (
  instance: ManagedBoxInventoryInstance,
) => (() => void) | void;

/** Keep one provider account for the whole logical operation. Settings may
 * replace the shared config object after an async request has started; every
 * follow-up (rename, readiness, cleanup, etc.) must keep using the credential
 * that selected or created the Box in the first place. */
function snapshotBoxConfig(cfg: AppConfig): AppConfig {
  return { box: cfg.box ? { token: cfg.box.token } : undefined };
}

function boxFetch(cfg: AppConfig, path: string, opts: RequestInit = {}) {
  return fetch(`${BOX_API}${path}`, {
    ...opts,
    headers: {
      authorization: `Bearer ${cfg.box?.token}`,
      "content-type": "application/json",
      ...opts.headers,
    },
  });
}

async function boxJson(cfg: AppConfig, path: string, opts: RequestInit = {}) {
  const res = await boxFetch(cfg, path, opts);
  const body: any = await res.json().catch(() => null);
  return { ok: res.ok && body?.ok !== false, status: res.status, body };
}

interface BoxDeletionOperation {
  id: string;
  status: "pending" | "processing" | "blocked" | "completed";
}

/** Accept only the immutable identity fields needed to follow a delete. Any
 * malformed success envelope falls back to a direct Box read instead of
 * authorizing journal retirement. */
function boxDeletionOperation(
  body: any,
  boxId: string,
  expectedOperationId?: string,
): BoxDeletionOperation | null {
  const operation = body?.operation;
  const id = typeof operation?.id === "string" ? operation.id : "";
  const status = typeof operation?.status === "string" ? operation.status : "";
  if (
    !BOX_DELETE_OPERATION_ID.test(id)
    || (expectedOperationId !== undefined && id !== expectedOperationId)
    || operation?.kind !== "box"
    || operation?.targetId !== boxId
    || !BOX_DELETE_OPERATION_STATES.has(status)
  ) return null;
  return { id, status: status as BoxDeletionOperation["status"] };
}

function deletionBlockedError(boxId: string): Error & { status: number } {
  return Object.assign(
    new Error(`ascii.dev accepted deletion of ${boxId}, but the deletion operation is blocked — check ascii.dev and retry`),
    { status: 409 },
  );
}

function boxDeleteProvedAbsent(result: Awaited<ReturnType<typeof boxJson>>): boolean {
  return result.status === 404 || result.status === 410;
}

/** DELETE /boxes only accepts background deletion. Keep the durable create
 * receipt until its operation completes. If operation polling is unavailable,
 * a direct 404/410 is the only alternate proof that this Box identity is gone. */
async function confirmAcceptedBoxDeletion(cfg: AppConfig, boxId: string, acceptedBody: any): Promise<void> {
  let operation = boxDeletionOperation(acceptedBody, boxId);
  if (operation?.status === "completed") return;
  if (operation?.status === "blocked") throw deletionBlockedError(boxId);

  if (operation) {
    for (const delayMs of BOX_DELETE_OPERATION_POLL_DELAYS_MS) {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      let polled: Awaited<ReturnType<typeof boxJson>>;
      try {
        polled = await boxJson(cfg, `/deletion-operations/${operation.id}`, {
          signal: AbortSignal.timeout(20_000),
        });
      } catch {
        break;
      }
      if (!polled.ok) break;
      const current = boxDeletionOperation(polled.body, boxId, operation.id);
      if (!current) break;
      operation = current;
      if (operation.status === "completed") return;
      if (operation.status === "blocked") throw deletionBlockedError(boxId);
    }
  }

  const inspected = await inspectBoxIdentity(cfg, boxId);
  if (!inspected.available) {
    throw Object.assign(
      new Error(`${inspected.problem ?? "the cloud computer deletion could not be verified"}; its recovery record was kept`),
      { status: 503 },
    );
  }
  if (inspected.identity) {
    throw Object.assign(
      new Error(`ascii.dev accepted deletion of ${boxId}, but it is not confirmed yet — retry after it finishes`),
      { status: 503 },
    );
  }
}

function boxBotNameParts(botId: string): { prefix: string; hash: string } {
  const prefix = botId.slice(0, 8).toLowerCase().replace(/[^a-z0-9]/g, "") || "bot";
  const hash = createHash("sha256").update(botId).digest("hex").slice(0, 6);
  return { prefix, hash };
}

function legacyBoxNameFor(botId: string): string {
  const { prefix, hash } = boxBotNameParts(botId);
  return `ogb-${prefix}-${hash}`;
}

// Deterministic per installation and bot. The bot hash kills truncated-id
// collisions; the environment scope prevents cross-install ownership claims.
export async function boxNameFor(botId: string) {
  const { prefix, hash } = boxBotNameParts(botId);
  return `${scopedBoxPrefix()}${prefix}-${hash}`;
}

/** Credential restoration must accept both current installation-scoped names
 * and durable pre-scope names that the ownership journal may have adopted. */
export async function boxNameMatchesBot(botId: string, name: string): Promise<boolean> {
  return name === await boxNameFor(botId) || name === legacyBoxNameFor(botId);
}

export async function runCommand(cfg: AppConfig, boxId: string, command: string, { timeoutMs = 120_000 } = {}) {
  const res = await boxFetch(cfg, `/boxes/${boxId}/commands`, {
    method: "POST",
    body: JSON.stringify({ command }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body: any = await res.json().catch(() => null);
  return {
    ok: res.ok && body?.exitCode === 0,
    exitCode: body?.exitCode ?? null,
    stdout: body?.stdout ?? "",
    stderr: body?.stderr ?? "",
  };
}

// Desktop access, in the order that actually works (agentcal probing):
//   1) VNC (POST /desktop?vnc=1) — plain WebSocket, survives P2P-blocking
//      networks; answers {provisioning:true} first, so poll for the URL.
//   2) WebRTC stream (POST /desktop) as fallback — STUN-only, can hang.
// The desktopUrl stored on the box object is NOT usable on its own.
async function mintDesktopUrl(cfg: AppConfig, boxId: string, { vncBudgetMs = 60_000 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < vncBudgetMs) {
    const { body } = await boxJson(cfg, `/boxes/${boxId}/desktop?vnc=1`, { method: "POST" });
    const url = body?.desktopUrl ?? body?.url;
    if (url) return url;
    if (!body?.provisioning) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  const { body } = await boxJson(cfg, `/boxes/${boxId}/desktop`, { method: "POST" });
  return body?.desktopUrl ?? body?.url ?? null;
}

async function waitReady(cfg: AppConfig, boxId: string, budgetMs = 90_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < budgetMs) {
    const { body } = await boxJson(cfg, `/boxes/${boxId}`);
    const state = body?.box?.state;
    if (READY.has(state)) return body.box;
    if (state === "error") return null;
    // an archiving box can't resume until the snapshot lands — nudge after
    if (state === "archived") await boxJson(cfg, `/boxes/${boxId}/resume`, { method: "POST" });
    await new Promise((r) => setTimeout(r, 2500));
  }
  return null;
}

// Resolving a bot's box means LISTing every box in the account, so it is
// the most expensive thing on any hot path. The name is deterministic, so
// once we know the id we can go straight at it — the cache is refreshed
// whenever the direct read fails (deleted/renamed box) and always carries
// the live state so callers can still see "archived".
const boxIdCache = new Map<string, string>();

function boxInventoryProblem(status: number, body: any): string {
  if (status === 401 || status === 403) {
    return "ascii.dev rejected the Box API key — update it in Settings → Connections";
  }
  if (status === 429) return "ascii.dev is rate-limiting this account — wait a minute and refresh";
  const message = typeof body?.message === "string" ? body.message.trim() : "";
  return message ? `ascii.dev could not list cloud computers: ${message}` : `ascii.dev could not list cloud computers (${status})`;
}

function safeBoxState(value: unknown): string {
  if (typeof value !== "string") return "unknown";
  const state = value.toLowerCase();
  return BOX_STATES.has(state) ? state : "unknown";
}

async function listBoxPages(
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
  const ownerByCurrentName = new Map(namedOwners.map(({ currentName, owner }) => [currentName, owner] as const));
  const ownerByLegacyName = new Map(namedOwners.map(({ legacyName, owner }) => [legacyName, owner] as const));
  const boxIdCounts = new Map<string, number>();
  for (const candidate of listed.boxes) {
    if (!candidate || typeof candidate !== "object") continue;
    const boxId = typeof candidate.id === "string" ? candidate.id : "";
    if (BOX_ID.test(boxId)) boxIdCounts.set(boxId, (boxIdCounts.get(boxId) ?? 0) + 1);
  }
  const invalidInventory = (problem: string): ManagedBoxInventory => ({
    configured: true,
    available: false,
    problem,
    instances: [],
  });
  const ownedBoxByBot = new Map<string, string>();
  for (const candidate of listed.boxes) {
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
  for (const candidate of listed.boxes) {
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

/** Direct identity proof for a Box remembered in the local create journal.
 * Unlike account LIST, this endpoint is not eventually consistent. Only the
 * immutable id and provider name cross this boundary. */
export async function inspectBoxIdentity(cfg: AppConfig, boxId: string): Promise<BoxIdentityInspection> {
  cfg = snapshotBoxConfig(cfg);
  if (!BOX_ID.test(boxId)) {
    return { available: false, identity: null, problem: "the remembered cloud computer id is invalid" };
  }
  let inspected: Awaited<ReturnType<typeof boxJson>>;
  try {
    inspected = await boxJson(cfg, `/boxes/${boxId}`, { signal: AbortSignal.timeout(20_000) });
  } catch {
    return {
      available: false,
      identity: null,
      problem: "Could not reach ascii.dev to verify a remembered cloud computer",
    };
  }
  if (inspected.status === 404 || inspected.status === 410) {
    return { available: true, identity: null, problem: null };
  }
  if (!inspected.ok) {
    return { available: false, identity: null, problem: boxInventoryProblem(inspected.status, inspected.body) };
  }
  const candidate = inspected.body?.box;
  const returnedId = typeof candidate?.id === "string" ? candidate.id : "";
  const name = typeof candidate?.name === "string" ? candidate.name : "";
  if (returnedId !== boxId || name.length === 0 || name.length > 100 || /[\r\n]/.test(name)) {
    return { available: false, identity: null, problem: "ascii.dev returned an invalid cloud computer identity" };
  }
  return { available: true, identity: { boxId, name }, problem: null };
}

function inventoryFailure(inventory: ManagedBoxInventory): Error & { status: number } {
  const error = new Error(
    inventory.configured
      ? (inventory.problem ?? "Cloud computer inventory is unavailable")
      : "Box is not configured — add its API key in Settings → Connections",
  ) as Error & { status: number };
  error.status = inventory.configured ? 503 : 409;
  return error;
}

async function revalidateManagedBox(
  cfg: AppConfig,
  owners: ManagedBoxOwner[],
  boxId: string,
): Promise<ManagedBoxInventoryInstance> {
  if (!BOX_ID.test(boxId)) throw Object.assign(new Error("invalid cloud computer id"), { status: 400 });
  const inventory = await listManagedBoxes(cfg, owners);
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

async function stopBox(cfg: AppConfig, boxId: string): Promise<void> {
  // Browser shutdown is best-effort, but the provider stop is not: Settings
  // must never say a computer is sleeping when ascii.dev rejected the action.
  await runCommand(cfg, boxId, QUIESCE_BROWSER, { timeoutMs: 5_000 }).catch(() => null);
  const stopped = await boxJson(cfg, `/boxes/${boxId}/stop`, { method: "POST" });
  if (!stopped.ok) throw Object.assign(new Error(boxErrorMessage(stopped.status, "box sleep", stopped.body)), { status: stopped.status });
}

function forgetBoxId(boxId: string): void {
  for (const [botId, cachedId] of boxIdCache) {
    if (cachedId === boxId) boxIdCache.delete(botId);
  }
}

/** Explicit Settings action. Re-listing prevents a stale row from targeting a
 * renamed or foreign provider resource. This never wakes or joins a Box. */
export async function sleepManagedBox(
  cfg: AppConfig,
  owners: ManagedBoxOwner[],
  boxId: string,
  claim?: ManagedBoxMutationClaim,
) {
  cfg = snapshotBoxConfig(cfg);
  const instance = await revalidateManagedBox(cfg, owners, boxId);
  if (instance.inUse) {
    throw Object.assign(new Error("this cloud computer is in use — stop its bot's work first"), { status: 409 });
  }
  if (!SLEEPING.has(instance.state) && !READY.has(instance.state)) {
    throw Object.assign(new Error(`this cloud computer cannot sleep while it is ${instance.state}`), { status: 409 });
  }
  const release = claim?.(instance);
  try {
    if (!SLEEPING.has(instance.state)) await stopBox(cfg, instance.boxId);
    forgetBoxId(instance.boxId);
    return { ok: true };
  } finally {
    release?.();
  }
}

/** Permanent Settings action. The caller must echo the exact freshly-listed
 * machine name as well as its id; ascii.dev independently requires the id in
 * its confirmation header. */
export async function deleteManagedBox(
  cfg: AppConfig,
  owners: ManagedBoxOwner[],
  boxId: string,
  confirmName: string,
  claim?: ManagedBoxMutationClaim,
) {
  cfg = snapshotBoxConfig(cfg);
  const instance = await revalidateManagedBox(cfg, owners, boxId);
  if (instance.inUse) {
    throw Object.assign(new Error("this cloud computer is in use — stop its bot's work first"), { status: 409 });
  }
  if (confirmName !== instance.name) {
    throw Object.assign(new Error("cloud computer confirmation no longer matches — refresh and try again"), { status: 409 });
  }
  const release = claim?.(instance);
  try {
    const removed = await boxJson(cfg, `/boxes/${instance.boxId}`, {
      method: "DELETE",
      headers: { "X-Ascii-Confirm-Delete": instance.boxId },
    });
    if (!removed.ok && !boxDeleteProvedAbsent(removed)) {
      throw Object.assign(new Error(boxErrorMessage(removed.status, "box delete", removed.body)), { status: removed.status });
    }
    if (removed.ok) await confirmAcceptedBoxDeletion(cfg, instance.boxId, removed.body);
    retireDeletedBoxCreate(instance.boxId);
    forgetBoxId(instance.boxId);
    return { ok: true };
  } finally {
    release?.();
  }
}

export async function findBox(cfg: AppConfig, botId: string) {
  cfg = snapshotBoxConfig(cfg);
  const cachedId = boxIdCache.get(botId);
  if (cachedId) {
    let direct: Awaited<ReturnType<typeof boxJson>> | null = null;
    try {
      direct = await boxJson(cfg, `/boxes/${cachedId}`);
    } catch {
      // A direct read can fail while the account listing still succeeds.
      // Fall through to the authoritative paginated lookup before deciding.
    }
    const directBox = direct?.body?.box;
    if (direct?.ok && directBox?.id === cachedId && directBox.state !== "error") return directBox;
    if (direct?.ok && directBox?.id !== cachedId) {
      throw Object.assign(new Error("ascii.dev returned an invalid cloud computer identity"), { status: 503 });
    }
    boxIdCache.delete(botId); // gone or broken — fall back to the listing
  }
  const name = await boxNameFor(botId);
  const legacyName = legacyBoxNameFor(botId);
  const listed = await listBoxPages(cfg);
  if (!listed.ok) {
    throw Object.assign(new Error(listed.problem), { status: 503 });
  }
  // Prefer the installation-scoped identity. A legacy name remains
  // discoverable only for this exact local bot id.
  const expected = listed.boxes.filter((candidate: any) => candidate?.name === name || candidate?.name === legacyName);
  if (expected.some((candidate: any) => !BOX_ID.test(candidate?.id))) {
    throw Object.assign(new Error("ascii.dev returned an invalid cloud computer identity"), { status: 503 });
  }
  const found = expected.find((candidate: any) => candidate.name === name && candidate.state !== "error")
    ?? expected.find((candidate: any) => candidate.name === legacyName && candidate.state !== "error")
    ?? null;
  if (found) {
    const duplicateId = listed.boxes.filter((candidate: any) => candidate?.id === found.id).length !== 1;
    if (duplicateId) {
      throw Object.assign(new Error("ascii.dev returned a conflicting cloud computer identity"), { status: 503 });
    }
    if (found.name === legacyName) adoptResolvedBox(botId, found.id);
    boxIdCache.set(botId, found.id);
  }
  return found;
}

/** Ready-or-null without the LIST when we already know the box. */
export async function readyBox(cfg: AppConfig, botId: string, budgetMs = 60_000) {
  cfg = snapshotBoxConfig(cfg);
  const box = await findBox(cfg, botId);
  if (!box) return null;
  if (READY.has(box.state)) return box;
  return waitReady(cfg, box.id, budgetMs);
}

export function boxConfigured(cfg: AppConfig) {
  return Boolean(cfg.box?.token);
}

/** Ask the provider whether a token is real, before we let someone save
 * it. Without this the paste "succeeds", and the first sign of trouble is
 * a 401 in a different panel minutes later, with nothing to act on. */
export async function verifyToken(token: string): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const res = await fetch(`${BOX_API}/boxes`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.ok) return { ok: true };
    if (res.status === 401 || res.status === 403) {
      // the common mistake is pasting some other credential entirely —
      // box API keys are prefixed, so say which thing is wrong
      return {
        ok: false,
        message: token.startsWith("box_")
          ? "ascii.dev rejected that token — it may have been revoked or expired. Copy a fresh one from your ascii.dev account."
          : "That doesn't look like a box API key: they start with box_. Copy the API key from your ascii.dev account (an account or session token won't work here).",
      };
    }
    return { ok: false, message: `ascii.dev returned ${res.status} for that token — try again in a moment.` };
  } catch {
    return { ok: false, message: "Couldn't reach ascii.dev to check that token — check your connection and retry." };
  }
}

/** Turn a provider refusal into something a person can act on. The
 * provider's own message is better than anything we can invent — it knows
 * the plan, the limit and the link — so prefer it and only fall back to
 * our own wording when it says nothing useful. */
export function boxErrorMessage(status: number, what: string, body?: any): string {
  const theirs = typeof body?.message === "string" ? body.message.trim() : "";
  const link = typeof body?.error?.details?.billingUrl === "string" ? body.error.details.billingUrl : "";
  if (status === 402) {
    // e.g. "Start the $20/month Box plan to create sandboxes."
    return [theirs || "ascii.dev needs a paid Box plan before it will create a computer.", link].filter(Boolean).join(" ");
  }
  if (status === 401 || status === 403) {
    return "your box token was rejected by ascii.dev — open App Settings and paste a current token (it starts with box_)";
  }
  if (status === 429) {
    return theirs || "ascii.dev is rate-limiting this account — wait a minute and try again";
  }
  return theirs ? `${what} failed: ${theirs}` : `${what} failed (${status})`;
}

/** ascii.dev trial accounts reject the normal eight-hour auto-stop with a
 * structured `trial_auto_stop_required` refusal. Retry that one condition
 * once at the provider's advertised maximum (or the documented two-hour
 * trial ceiling). Other create failures must retain their original error. */
function trialBoxTtlSeconds(body: any): number | null {
  const code = body?.error?.code ?? body?.code;
  if (code !== "trial_auto_stop_required") return null;
  const details = body?.error?.details ?? body?.details ?? {};
  for (const value of [details.maxTtlSeconds, details.maximumTtlSeconds, details.maxAutoStopSeconds]) {
    if (Number.isInteger(value) && value > 0 && value <= DEFAULT_BOX_TTL_SECONDS) return value;
  }
  return TRIAL_BOX_TTL_SECONDS;
}

type BoxCreateResult = Awaited<ReturnType<typeof boxJson>> & {
  request: BoxCreateRequest;
  /** Automatic deletion is safe only for a Box first created by this exact
   * provisioning call. A journal recovery may point at durable user data. */
  createdThisAttempt: boolean;
};

function idempotentCreateInProgress(result: Awaited<ReturnType<typeof boxJson>>): boolean {
  const code = result.body?.error?.code ?? result.body?.code;
  return result.status === 409 && code === "idempotency_in_progress";
}

async function requestBoxCreate(cfg: AppConfig, botId: string, ttlSeconds: number): Promise<BoxCreateResult> {
  // The computer needs the user's desktop session, not the account owner's
  // host credentials. Keep provider-side env injection off so API keys cannot
  // silently appear inside the guest. The exact serialized body is also the
  // idempotency identity: a trial-TTL retry must receive a different key.
  const body = JSON.stringify({ ttlSeconds, noEnv: true });
  let attempt = beginBoxCreate(botId, body);
  let request = attempt.request;
  let createdThisAttempt = attempt.startedNow;

  // A previous process received the Box but died before naming it. Resolve
  // the durable identity directly; never issue a second create first.
  if (request.boxId) {
    const recovered = await boxJson(cfg, `/boxes/${request.boxId}`, {
      signal: AbortSignal.timeout(20_000),
    });
    if (recovered.ok && recovered.body?.box?.id === request.boxId) {
      return { ...recovered, request, createdThisAttempt: false };
    }
    if (recovered.status !== 404 && recovered.status !== 410) {
      return { ...recovered, request, createdThisAttempt: false };
    }
    discardBoxCreate(request);
    attempt = beginBoxCreate(botId, body);
    request = attempt.request;
    createdThisAttempt = attempt.startedNow;
  }

  let last: Awaited<ReturnType<typeof boxJson>> | null = null;
  let ambiguousRetries = 0;
  let inProgressRetries = 0;
  for (;;) {
    try {
      last = await boxJson(cfg, "/boxes", {
        method: "POST",
        headers: { "Idempotency-Key": request.idempotencyKey },
        signal: AbortSignal.timeout(45_000),
        body,
      });
    } catch (error) {
      // A dropped response is ambiguous: ascii.dev may already have created
      // the Box. One retry with the same key recovers it safely.
      if (ambiguousRetries++ === 0) continue;
      throw error;
    }
    const boxId = last.body?.box?.id;
    if (last.ok && typeof boxId === "string" && boxId) {
      request = rememberCreatedBox(request, boxId);
      return { ...last, request, createdThisAttempt };
    }
    if (idempotentCreateInProgress(last)) {
      const delay = BOX_CREATE_IN_PROGRESS_RETRY_DELAYS_MS[inProgressRetries++];
      if (delay !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      return { ...last, request, createdThisAttempt };
    }
    if ((last.status >= 500 || last.ok) && ambiguousRetries++ === 0) continue;
    // A 5xx or any idempotency conflict can follow a provider-side create;
    // keep its key for recovery. Only a definitive client rejection proves
    // this request did not create a Box and may be replaced safely.
    if (last.status < 500 && last.status !== 409 && !last.ok) discardBoxCreate(request);
    return { ...last, request, createdThisAttempt };
  }
}

async function createBox(cfg: AppConfig, botId: string) {
  const first = await requestBoxCreate(cfg, botId, DEFAULT_BOX_TTL_SECONDS);
  if (first.ok) return first;
  const trialTtl = trialBoxTtlSeconds(first.body);
  return trialTtl === null ? first : requestBoxCreate(cfg, botId, trialTtl);
}

/** Box state for the Computer panel. */
export async function boxStatus(cfg: AppConfig, botId: string) {
  cfg = snapshotBoxConfig(cfg);
  if (!boxConfigured(cfg)) return { configured: false, box: null };
  const box = await findBox(cfg, botId);
  return {
    configured: true,
    box: box ? { boxId: box.id, state: box.state, desktopAvailable: box.desktopAvailable ?? null } : null,
  };
}

/**
 * Find-or-create the bot's persistent box, wait for ready, run the
 * idempotent bootstrap (screenshot tooling for the computer-use bridge +
 * a tmux welcome), and mint a fresh desktop URL.
 */
export async function provisionBox(cfg: AppConfig, botId: string, botName: string) {
  cfg = snapshotBoxConfig(cfg);
  if (!boxConfigured(cfg)) {
    throw new Error('box provider not enabled — add {"box":{"token":"…"}} to ~/.openmausbot/config.json');
  }
  const vmName = await boxNameFor(botId);
  let box = await findBox(cfg, botId);
  let created = false;
  let createRequest: BoxCreateRequest | null = null;
  try {
    if (!box) {
      // Provider-side backstop: archives itself (billing pauses, disk
      // survives) if every stop path dies. Trial accounts get one narrower
      // retry when ascii.dev reports their shorter TTL ceiling.
      const createRes = await createBox(cfg, botId);
      if (!createRes.ok || !createRes.body?.box?.id) {
        throw new Error(boxErrorMessage(createRes.status, "box create", createRes.body));
      }
      box = createRes.body.box;
      createRequest = createRes.request;
      created = createRes.createdThisAttempt;
      const rename = await boxJson(cfg, `/boxes/${box.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: vmName }),
      });
      if (!rename.ok) throw new Error(boxErrorMessage(rename.status, "box naming", rename.body));
      if (createRequest) createRequest = resolveBoxCreate(createRequest);
    }
    const ready = await waitReady(cfg, box.id);
    if (!ready) throw new Error("box did not become ready within 90s — retry in a minute");

    // Install the exact Cua Driver executable in the background, keep its
    // daemon private to the VM, and retain X11 tooling as a degraded fallback.
    const bootstrap = remoteComputerBootstrapCommand(botName);
    let boot;
    for (let attempt = 0; attempt < 5; attempt++) {
      boot = await runCommand(cfg, box.id, bootstrap);
      if (boot.ok || boot.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 3000));
    }
    if (!boot?.ok) {
      const detail = boot?.stderr?.slice(0, 200) || (boot?.exitCode != null ? `exit ${boot.exitCode}` : "no response");
      throw new Error(`box setup failed: ${detail}`);
    }

    const joinUrl = await mintDesktopUrl(cfg, box.id);
    if (!joinUrl) throw new Error("box desktop link could not be created");
    return { boxId: box.id, machineName: vmName, reused: !created, state: ready.state, joinUrl };
  } catch (error) {
    if (!created || !box?.id) throw error;
    const cleanup = await boxJson(cfg, `/boxes/${box.id}`, {
      method: "DELETE",
      headers: { "X-Ascii-Confirm-Delete": box.id },
    }).catch(() => null);
    if (cleanup && (cleanup.ok || boxDeleteProvedAbsent(cleanup))) {
      if (cleanup.ok) {
        try {
          await confirmAcceptedBoxDeletion(cfg, box.id, cleanup.body);
        } catch (cleanupError) {
          const message = error instanceof Error ? error.message : String(error);
          const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
          throw new Error(`${message}. The new computer's deletion was not confirmed: ${cleanupMessage}. Check box ${box.id} in ascii.dev.`);
        }
      }
      boxIdCache.delete(botId);
      if (createRequest) {
        // A stale record is safe (the next retry verifies its Box ID), so a
        // cleanup-journal write failure must not hide the original error.
        try {
          discardBoxCreate(createRequest);
        } catch {
          /* verified absent before any future create */
        }
      }
      throw error;
    }
    boxIdCache.delete(botId);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}. The new computer could not be removed automatically; delete box ${box.id} in ascii.dev.`);
  }
}

/** Wake the bot's box and return a FRESH desktop URL. */
export async function joinBox(cfg: AppConfig, botId: string) {
  cfg = snapshotBoxConfig(cfg);
  const box = await findBox(cfg, botId);
  if (!box) throw new Error("no computer yet — provision it first");
  const ready = await waitReady(cfg, box.id);
  if (!ready) throw new Error("the box did not wake in time — try again");
  // Provider archive/resume preserves disk but not processes. Reattach the
  // driver daemon before handing the desktop back to the user.
  await runCommand(cfg, box.id, ensureRemoteCuaCommand(), { timeoutMs: 15_000 }).catch(() => null);
  return { joinUrl: await mintDesktopUrl(cfg, box.id), state: ready.state ?? null };
}

/** Mint a human-control URL without changing provider lifecycle or guest
 * processes. This is the only join path allowed while a bot turn is active. */
export async function joinReadyBox(cfg: AppConfig, botId: string) {
  cfg = snapshotBoxConfig(cfg);
  const box = await findBox(cfg, botId);
  if (!box) throw Object.assign(new Error("no computer yet — provision it first"), { status: 409 });
  if (!READY.has(box.state)) {
    throw Object.assign(
      new Error("the cloud computer is sleeping or starting — interrupt the bot before waking it"),
      { status: 409 },
    );
  }
  return { joinUrl: await mintDesktopUrl(cfg, box.id), state: box.state ?? null };
}

/** Archive the bot's box now (billing pauses, disk survives). */
export async function sleepBox(cfg: AppConfig, botId: string) {
  cfg = snapshotBoxConfig(cfg);
  const box = await findBox(cfg, botId);
  if (!box) throw new Error("no computer for this bot");
  await stopBox(cfg, box.id);
  forgetBoxId(box.id);
  return { ok: true };
}

/** Owner-scoped shell for the Computer panel's console. */
export async function execOnBox(cfg: AppConfig, botId: string, command: string) {
  cfg = snapshotBoxConfig(cfg);
  if (command.length > MAX_REMOTE_COMMAND_LENGTH) {
    throw new RangeError(`command is too long (maximum ${MAX_REMOTE_COMMAND_LENGTH} characters)`);
  }
  const box = await findBox(cfg, botId);
  if (!box) throw new Error("no computer for this bot yet");
  const ready = await waitReady(cfg, box.id, 60_000);
  if (!ready) throw new Error("box did not wake");
  const out = await runCommand(cfg, box.id, isolatedRemoteCommand(command));
  return { exitCode: out.exitCode, stdout: out.stdout.slice(-4000), stderr: out.stderr.slice(-2000) };
}

// Screenshot for the Computer panel + screen-in-chat. Two hops: capture
// to a file on the box (scrot straight to JPEG — no ImageMagick startup
// unless a downscale is actually needed), then read the bytes back.
// Base64 over command stdout is NOT reliable for the panel's full-size
// frames (probed 2026-08-12: an otherwise-complete payload came back with
// a corrupted length), so the frame is always fetched over HTTP here.
const PANEL_PATH = "/tmp/ogb-panel.jpg";
const PANEL_WIDTH = 1024;
const SHOT_CMD = [
  "export DISPLAY=${DISPLAY:-:0}",
  `f=${PANEL_PATH}`,
  'w=$(xdotool getdisplaygeometry 2>/dev/null | cut -d" " -f1)',
  'case "$w" in ""|*[!0-9]*) w=0;; esac',
  'scrot -o -q 70 "$f" 2>/dev/null || import -window root -quality 70 "$f" 2>/dev/null || ffmpeg -y -f x11grab -i "$DISPLAY" -frames:v 1 -q:v 7 "$f" >/dev/null 2>&1',
  `if [ "$w" -gt ${PANEL_WIDTH} ] 2>/dev/null && command -v convert >/dev/null 2>&1; then convert "$f" -thumbnail ${PANEL_WIDTH}x -quality 70 "$f" 2>/dev/null || true; fi`,
  'test -s "$f" && echo captured',
].join("; ");

/** Read a file off the box as base64 — raw artifact bytes when the API
 * supports it (33% less transfer, no JSON envelope), else the files API. */
async function readFileBase64(cfg: AppConfig, boxId: string, path: string): Promise<string | null> {
  try {
    const res = await boxFetch(cfg, `/boxes/${boxId}/artifacts?path=${encodeURIComponent(path)}`);
    if (res.ok) {
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length) return bytes.toString("base64");
    }
  } catch {
    /* fall through */
  }
  const { ok, body } = await boxJson(cfg, `/boxes/${boxId}/files?path=${encodeURIComponent(path)}&encoding=base64`);
  const content = body?.content;
  return ok && typeof content === "string" && content ? content : null;
}

/** `knownBoxId` skips box resolution entirely — the screen poller holds
 * the id for the whole turn and must not re-resolve it every frame. */
export async function screenshotBox(cfg: AppConfig, botId: string, knownBoxId?: string) {
  cfg = snapshotBoxConfig(cfg);
  let boxId = knownBoxId;
  if (!boxId) {
    const box = await findBox(cfg, botId);
    if (!box) throw new Error("no computer for this bot yet");
    if (!READY.has(box.state)) throw new Error(`box is ${box.state}`);
    boxId = box.id as string;
  }
  const out = await runCommand(cfg, boxId, SHOT_CMD, { timeoutMs: 60_000 });
  if (!/captured/.test(out.stdout)) {
    throw new Error(out.stderr.slice(0, 200) || "screen capture failed on the box");
  }
  const data = await readFileBase64(cfg, boxId, PANEL_PATH);
  if (!data) throw new Error("could not read the frame back from the box");
  return { png: data, format: "jpeg" };
}
