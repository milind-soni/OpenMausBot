// Mola provider implementation following Boat pattern.
// Mola Cloud API v1 (https://cloud.mola.sh/api/v1): uses /computers endpoints, viewer grants for desktop
//   Source: obaid/mola-cp (private repo) - StoreApiComputerRequest.php, ComputerController.php, ViewerGrantController.php
// mola-core self-hosted API v1 (http://127.0.0.1:4141/v1): uses /machines endpoints, direct desktop links
//   Source: https://github.com/obaid/mola-core/blob/main/docs/api.md
import { createHash } from "node:crypto";

import { DATA_DIR, type AppConfig } from "./config.ts";
import { loadEnvironmentId } from "./environment.ts";
import { molaCredential, molaProviderApi, type ServiceCredential } from "./included-services.ts";

const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

// API detection: Cloud uses /computers, self-hosted uses /machines
function isCloudApi(apiUrl: string): boolean {
  return apiUrl.includes("cloud.mola.sh");
}

function resourcePath(apiUrl: string): "computers" | "machines" {
  return isCloudApi(apiUrl) ? "computers" : "machines";
}

function getMolaApiUrl(cfg: AppConfig): string {
  return cfg.mola?.apiUrl || molaProviderApi();
}

/**
 * Derives the viewer origin for Mola Cloud viewer grants.
 * Uses MOLA_VIEWER_ORIGIN env override if set, otherwise derives from OpenMausBot's
 * configured public URL (customDomain or publicUrl from CLI startup config).
 * Throws if no valid origin can be determined - the https://localhost fallback
 * will not match real deployments.
 */
export function getMolaViewerOrigin(cfg: AppConfig): string {
  const override = process.env.MOLA_VIEWER_ORIGIN?.trim();
  if (override) return override;
  
  // Use customDomain if configured
  if (cfg.customDomain) {
    const domain = cfg.customDomain.trim().replace(/\/+$/, "");
    return domain.startsWith("http") ? domain : `https://${domain}`;
  }
  
  // Use publicUrl from CLI startup if configured
  if (cfg.cliStartup?.publicUrl) {
    return cfg.cliStartup.publicUrl.trim().replace(/\/+$/, "");
  }
  
  // No valid origin found - fail clearly
  throw new Error(
    "Cannot determine viewer origin for Mola Cloud. " +
    "Set MOLA_VIEWER_ORIGIN environment variable to your OpenMausBot deployment URL " +
    "(e.g., https://your-domain.com) or configure customDomain/publicUrl in settings."
  );
}

export const MAX_REMOTE_COMMAND_LENGTH = 4_000;

/** Runs an owner-supplied console command without the mola provider or account credentials in its environment. */
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

const READY = new Set(["ready"]);
const SLEEPING_MOLA_STATES = new Set(["stopped"]);
const TERMINAL = new Set(["error", "cancelled"]);
const TRANSITIONAL = new Set(["provisioning", "booting", "starting", "stopping"]);
const DEFAULT_MOLA_VCPUS = 4;
const DEFAULT_MOLA_MEMORY_MB = 4096;
const DEFAULT_MOLA_DISK_GB = 40;
const MOLA_WAIT_READY_MS = 90_000;
const MOLA_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LEGACY_MANAGED_MOLA_NAME = /^ogb-[a-z0-9]{1,8}-[a-f0-9]{6}$/;
const SCOPED_MANAGED_MOLA_NAME = /^ogb-[a-f0-9]{12}-[a-z0-9]{1,8}-[a-f0-9]{6}$/;

// Names carry a hash of the local environment id, so another installation on the same account never claims these computers.
let scopedMolaPrefixCache: string | null = null;

/** Call only after startup has migrated the data dir and taken its writer lease. */
function scopedMolaPrefix(): string {
  if (scopedMolaPrefixCache) return scopedMolaPrefixCache;
  const scope = createHash("sha256")
    .update(loadEnvironmentId(DATA_DIR))
    .digest("hex")
    .slice(0, 12);
  scopedMolaPrefixCache = `ogb-${scope}-`;
  return scopedMolaPrefixCache;
}

export interface ManagedMolaOwner {
  botId: string;
  name: string;
  inUse: boolean;
}

export interface ManagedMolaInventoryInstance {
  machineId: string;
  name: string;
  status: string;
  ownerBotId: string | null;
  ownerName: string | null;
  orphaned: boolean;
  inUse: boolean;
}

export interface ManagedMolaInventory {
  configured: boolean;
  available: boolean;
  problem: string | null;
  credentialRejected?: boolean;
  instances: ManagedMolaInventoryInstance[];
}

export interface MolaIdentityInspection {
  available: boolean;
  identity: { machineId: string; name: string; status: string } | null;
  problem: string | null;
}

export type MolaTurnLifecycleAction = "attach" | "provision" | "wake";

export function molaTurnLifecycleAction(status: string | null): MolaTurnLifecycleAction {
  if (status && READY.has(status)) return "attach";
  return status ? "wake" : "provision";
}

export type ManagedMolaMutationClaim = (
  instance: ManagedMolaInventoryInstance,
) => (() => void) | void;

/** One credential for the whole operation, even if Settings swaps the config mid-request. */
function snapshotMolaConfig(cfg: AppConfig): AppConfig {
  return { mola: cfg.mola ? { token: cfg.mola.token, apiUrl: cfg.mola.apiUrl } : undefined };
}

/** An own token goes to Mola; Cloud Pro's included token only to its relay. */
export function molaFetch(cfg: AppConfig, path: string, opts: RequestInit = {}) {
  const account = molaAccount(cfg);
  return fetch(`${account?.api ?? molaProviderApi()}${path}`, {
    ...opts,
    headers: {
      authorization: `Bearer ${account?.token}`,
      "content-type": "application/json",
      ...opts.headers,
    },
  });
}

async function molaJson(cfg: AppConfig, path: string, opts: RequestInit = {}) {
  const res = await molaFetch(cfg, path, opts);
  const body: any = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, body };
}

function molaBotNameParts(botId: string): { prefix: string; hash: string } {
  const prefix = botId.slice(0, 8).toLowerCase().replace(/[^a-z0-9]/g, "") || "bot";
  const hash = createHash("sha256").update(botId).digest("hex").slice(0, 6);
  return { prefix, hash };
}

function legacyMolaNameFor(botId: string): string {
  const { prefix, hash } = molaBotNameParts(botId);
  return `ogb-${prefix}-${hash}`;
}

export async function molaNameFor(botId: string) {
  const { prefix, hash } = molaBotNameParts(botId);
  return `${scopedMolaPrefix()}${prefix}-${hash}`;
}

export async function molaNameMatchesBot(botId: string, name: string): Promise<boolean> {
  return name === await molaNameFor(botId) || name === legacyMolaNameFor(botId);
}

export async function runCommand(cfg: AppConfig, machineId: string, command: string, { timeoutMs = 120_000, signal }: { timeoutMs?: number; signal?: AbortSignal } = {}) {
  const apiUrl = getMolaApiUrl(cfg);
  const resource = resourcePath(apiUrl);
  
  // Mola Cloud validates timeout as integer 1-120 seconds (422 if out of range)
  const timeoutSeconds = Math.floor(timeoutMs / 1000);
  const clampedTimeout = Math.max(1, Math.min(120, timeoutSeconds));
  
  const res = await molaFetch(cfg, `/${resource}/${machineId}/actions`, {
    method: "POST",
    body: JSON.stringify({ action: "exec", command, timeout: clampedTimeout }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs + 5_000)]) : AbortSignal.timeout(timeoutMs + 5_000),
  });
  const body: any = await res.json().catch(() => null);
  return {
    ok: res.ok && body?.data?.exit_code === 0,
    exitCode: body?.data?.exit_code ?? null,
    stdout: body?.data?.stdout ?? "",
    stderr: body?.data?.stderr ?? "",
    ...(body?.data?.timed_out === true ? { timedOut: true as const } : {}),
    ...(body?.data?.truncated === true ? { truncated: true as const } : {}),
  };
}

async function mintDesktopUrl(cfg: AppConfig, machineId: string, { requestMs = 30_000, interactive: _interactive = false } = {}) {
  const apiUrl = getMolaApiUrl(cfg);
  const resource = resourcePath(apiUrl);
  
  if (isCloudApi(apiUrl)) {
    // Cloud API: viewer grants require iframe embedding + postMessage auth handshake
    // OpenMausBot currently only supports direct desktop URLs (self-hosted Mola)
    throw new Error(
      "Mola Cloud viewer grants require iframe embedding with postMessage authentication, " +
      "which is not yet implemented in OpenMausBot. Use self-hosted mola-core for desktop access, " +
      "or open computers directly at cloud.mola.sh. " +
      "See https://github.com/obaid/mola-core for self-hosted setup."
    );
    
    // Future implementation would:
    // 1. Create viewer grant with: POST /${resource}/${machineId}/viewers
    //    body: { origin: getMolaViewerOrigin(cfg), mode: "desktop", interactive, expires_in_minutes: 60 }
    //    response: { data: { id, embed_url, token, expires_at } }
    // 2. Store { embedUrl, token, grantId, machineId, expiresAt } server-side (never expose token to client)
    // 3. Return URL to OpenMausBot-hosted embedding page: /mola/viewer/${grantId}
    // 4. Embedding page:
    //    - Loads iframe with embed_url
    //    - Waits for postMessage 'loaded' event from iframe
    //    - Fetches token from server endpoint (authorized by session)
    //    - Sends { type: 'mola-viewer-auth', token } to iframe via postMessage
    // 5. Server endpoint delivers token only to authenticated user who owns the bot
  } else {
    // Self-hosted API: direct desktop link (works as-is)
    const { body } = await molaJson(cfg, `/${resource}/${machineId}/desktop`, { 
      method: "POST", 
      signal: AbortSignal.timeout(requestMs) 
    });
    return body?.data?.desktop_url ?? null;
  }
}

async function waitReady(cfg: AppConfig, machineId: string, budgetMs = MOLA_WAIT_READY_MS) {
  const deadline = Date.now() + budgetMs;
  const untilDeadline = () => AbortSignal.timeout(Math.max(1, deadline - Date.now()));
  const outOfTime = (error: unknown) => error instanceof Error && error.name === "TimeoutError";
  
  try {
    while (Date.now() < deadline) {
      const apiUrl = getMolaApiUrl(cfg);
      const resource = resourcePath(apiUrl);
      const { body } = await molaJson(cfg, `/${resource}/${machineId}`, { signal: untilDeadline() });
      const data = body?.data;
      const status = data?.status;
      const isTransitional = data?.is_transitional === true;
      
      if (READY.has(status)) return data;
      if (TERMINAL.has(status)) return null;
      
      // If status is transitional (provisioning, booting, starting) or marked as such by API, continue waiting
      if (TRANSITIONAL.has(status) || isTransitional) {
        await new Promise((r) => setTimeout(r, Math.min(2500, Math.max(0, deadline - Date.now()))));
        continue;
      }
      
      if (status === "stopped") {
        const apiUrl = getMolaApiUrl(cfg);
        const resource = resourcePath(apiUrl);
        const started = await molaJson(cfg, `/${resource}/${machineId}/start`, { method: "POST", signal: untilDeadline() });
        if (!started.ok && started.status !== 409) {
          const refusal = molaRefusal(started.status, "starting the cloud computer", started.body, usesIncludedMola(cfg));
          if (started.status < 500) throw refusal;
        }
      }
      await new Promise((r) => setTimeout(r, Math.min(2500, Math.max(0, deadline - Date.now()))));
    }
  } catch (error) {
    if (!outOfTime(error)) throw error;
  }
  return null;
}

const molaIdCache = new Map<string, string>();

function molaInventoryProblem(status: number, body: any, included = false): string {
  if (status === 401 || status === 403) {
    return included ? INCLUDED_MOLA_UNAVAILABLE : "mola.sh rejected the Mola API key — update it in Settings → API keys";
  }
  const service = molaServiceName(included);
  if (status === 429) return `${service} is rate-limiting this account — wait a minute and refresh`;
  const message = typeof body?.message === "string" ? body.message.trim() : "";
  return message ? `${service} could not list cloud computers: ${message}` : `${service} could not list cloud computers (${status})`;
}

/** A read that fails on the network or times out is sent once more; any answer, even an error status, is final. */
function molaRead(cfg: AppConfig, path: string) {
  const read = () => molaJson(cfg, path, { signal: AbortSignal.timeout(20_000) });
  return read().catch(async () => { await new Promise((resolve) => setTimeout(resolve, 1_000)); return read(); });
}

function safeMolaStatus(value: unknown, isTransitional?: boolean): string {
  if (typeof value !== "string") return "unknown";
  const status = value.toLowerCase();
  const VALID_STATES = new Set(["provisioning", "booting", "ready", "stopped", "starting", "stopping", "unknown", "error", "cancelled"]);
  if (VALID_STATES.has(status)) return status;
  // If API says it's transitional but we don't recognize the status, treat as in-progress
  if (isTransitional === true) return "starting";
  return "unknown";
}

async function listMolaPages(cfg: AppConfig): Promise<{ ok: true; machines: any[] } | { ok: false; problem: string; credentialRejected?: boolean; unreachable?: boolean }> {
  let listed: Awaited<ReturnType<typeof molaJson>>;
  try {
    const apiUrl = getMolaApiUrl(cfg);
    const resource = resourcePath(apiUrl);
    listed = await molaRead(cfg, `/${resource}`);
  } catch {
    return { ok: false, unreachable: true, problem: `Could not reach ${molaServiceName(usesIncludedMola(cfg))} to list cloud computers — check your connection and refresh` };
  }
  if (!listed.ok || !Array.isArray(listed.body?.data)) {
    const credentialRejected = listed.status === 401 || listed.status === 403;
    return { ok: false, problem: molaInventoryProblem(listed.status, listed.body, usesIncludedMola(cfg)), credentialRejected };
  }
  return { ok: true, machines: listed.body.data };
}

export async function listManagedMolas(
  cfg: AppConfig,
  owners: ManagedMolaOwner[],
): Promise<ManagedMolaInventory> {
  cfg = snapshotMolaConfig(cfg);
  if (!molaConfigured(cfg)) {
    return { configured: false, available: false, problem: null, instances: [] };
  }

  const listed = await listMolaPages(cfg);
  if (!listed.ok) return { configured: true, available: false, problem: listed.problem, credentialRejected: listed.credentialRejected, instances: [] };

  const namedOwners = await Promise.all(owners.map(async (owner) => ({
    currentName: await molaNameFor(owner.botId),
    legacyName: legacyMolaNameFor(owner.botId),
    owner,
  })));

  const ownerByCurrentName = new Map(namedOwners.map(({ currentName, owner }) => [currentName, owner] as const));
  const ownerByLegacyName = new Map(namedOwners.map(({ legacyName, owner }) => [legacyName, owner] as const));
  const molaIdCounts = new Map<string, number>();
  
  for (const candidate of listed.machines) {
    if (!candidate || typeof candidate !== "object") continue;
    const machineId = typeof candidate.id === "string" ? candidate.id : "";
    if (MOLA_ID.test(machineId)) molaIdCounts.set(machineId, (molaIdCounts.get(machineId) ?? 0) + 1);
  }

  const ownedMolaByBot = new Map<string, string>();
  for (const candidate of listed.machines) {
    if (!candidate || typeof candidate !== "object") continue;
    const name = typeof candidate.name === "string" ? candidate.name : "";
    const owner = ownerByCurrentName.get(name) ?? ownerByLegacyName.get(name) ?? null;
    if (!owner) continue;
    const machineId = typeof candidate.id === "string" ? candidate.id : "";
    if (!MOLA_ID.test(machineId)) {
      return { configured: true, available: false, problem: "mola.sh returned an invalid id for an OpenMaus-managed cloud computer — refresh or repair it in mola.sh", instances: [] };
    }
    const existing = ownedMolaByBot.get(owner.botId);
    if (existing && existing !== machineId) {
      return { configured: true, available: false, problem: "mola.sh returned conflicting cloud computers for one OpenMaus bot — repair them in mola.sh before continuing", instances: [] };
    }
    ownedMolaByBot.set(owner.botId, machineId);
  }

  const instances: ManagedMolaInventoryInstance[] = [];
  const seenMolaIds = new Set<string>();
  const scopedPrefix = scopedMolaPrefix();
  
  for (const candidate of listed.machines) {
    if (!candidate || typeof candidate !== "object") continue;
    const machineId = typeof candidate.id === "string" ? candidate.id : "";
    const name = typeof candidate.name === "string" ? candidate.name : "";
    let owner: ManagedMolaOwner | null = null;
    
    if (SCOPED_MANAGED_MOLA_NAME.test(name)) {
      if (!name.startsWith(scopedPrefix)) continue;
      owner = ownerByCurrentName.get(name) ?? null;
    } else if (LEGACY_MANAGED_MOLA_NAME.test(name)) {
      owner = ownerByLegacyName.get(name) ?? null;
      if (!owner) continue;
    } else {
      continue;
    }
    
    if (!MOLA_ID.test(machineId)) {
      return { configured: true, available: false, problem: "mola.sh returned an invalid id for an OpenMaus-managed cloud computer — refresh or repair it in mola.sh", instances: [] };
    }
    if ((molaIdCounts.get(machineId) ?? 0) !== 1 || seenMolaIds.has(machineId)) {
      return { configured: true, available: false, problem: "mola.sh returned a conflicting id for an OpenMaus-managed cloud computer — refresh or repair it in mola.sh", instances: [] };
    }
    
    seenMolaIds.add(machineId);
    instances.push({
      machineId,
      name,
      status: safeMolaStatus(candidate.status, candidate.is_transitional),
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

export async function inspectMolaIdentity(cfg: AppConfig, machineId: string): Promise<MolaIdentityInspection> {
  cfg = snapshotMolaConfig(cfg);
  if (!MOLA_ID.test(machineId)) {
    return { available: false, identity: null, problem: "the remembered cloud computer id is invalid" };
  }
  
  let inspected: Awaited<ReturnType<typeof molaJson>>;
  try {
    const apiUrl = getMolaApiUrl(cfg);
    const resource = resourcePath(apiUrl);
    inspected = await molaJson(cfg, `/${resource}/${machineId}`, { signal: AbortSignal.timeout(20_000) });
  } catch {
    return {
      available: false,
      identity: null,
      problem: `Could not reach ${molaServiceName(usesIncludedMola(cfg))} to verify a remembered cloud computer`,
    };
  }
  
  const candidate = inspected.body?.data;
  const returnedId = typeof candidate?.id === "string" ? candidate.id : "";
  
  if (inspected.status === 404 || inspected.status === 410) {
    return { available: true, identity: null, problem: null };
  }
  if (!inspected.ok) {
    return { available: false, identity: null, problem: molaInventoryProblem(inspected.status, inspected.body, usesIncludedMola(cfg)) };
  }
  
  const name = typeof candidate?.name === "string" ? candidate.name : "";
  if (returnedId !== machineId || name.length === 0 || name.length > 100 || /[\r\n]/.test(name)) {
    return { available: false, identity: null, problem: "mola.sh returned an invalid cloud computer identity" };
  }
  
  return { available: true, identity: { machineId, name, status: safeMolaStatus(candidate.status) }, problem: null };
}

async function stopMola(cfg: AppConfig, machineId: string): Promise<void> {
  const apiUrl = getMolaApiUrl(cfg);
  const resource = resourcePath(apiUrl);
  const stopped = await molaJson(cfg, `/${resource}/${machineId}/stop`, { method: "POST" });
  if (!stopped.ok) {
    throw Object.assign(new Error(molaErrorMessage(stopped.status, "mola sleep", stopped.body, usesIncludedMola(cfg))), { status: stopped.status });
  }
}

function forgetMolaId(machineId: string): void {
  for (const [botId, cachedId] of molaIdCache) {
    if (cachedId === machineId) molaIdCache.delete(botId);
  }
}

export async function sleepManagedMola(
  cfg: AppConfig,
  owners: ManagedMolaOwner[],
  machineId: string,
  claim?: ManagedMolaMutationClaim,
) {
  cfg = snapshotMolaConfig(cfg);
  const inventory = await listManagedMolas(cfg, owners);
  if (!inventory.available) throw Object.assign(new Error(inventory.problem ?? "Mola inventory is unavailable"), { status: 503 });
  
  const instance = inventory.instances.find((candidate) => candidate.machineId === machineId);
  if (!instance) {
    throw Object.assign(new Error("that OpenMaus-managed cloud computer no longer exists"), { status: 404 });
  }
  if (instance.inUse) {
    throw Object.assign(new Error("this cloud computer is in use — stop its bot's work first"), { status: 409 });
  }
  if (!SLEEPING_MOLA_STATES.has(instance.status) && !READY.has(instance.status)) {
    throw Object.assign(new Error(`this cloud computer cannot sleep while it is ${instance.status}`), { status: 409 });
  }
  
  const release = claim?.(instance);
  try {
    if (!SLEEPING_MOLA_STATES.has(instance.status)) await stopMola(cfg, instance.machineId);
    forgetMolaId(instance.machineId);
    return { ok: true };
  } finally {
    release?.();
  }
}

export async function deleteManagedMola(
  cfg: AppConfig,
  owners: ManagedMolaOwner[],
  machineId: string,
  confirmName: string,
  claim?: ManagedMolaMutationClaim,
) {
  cfg = snapshotMolaConfig(cfg);
  const inventory = await listManagedMolas(cfg, owners);
  if (!inventory.available) throw Object.assign(new Error(inventory.problem ?? "Mola inventory is unavailable"), { status: 503 });
  
  const instance = inventory.instances.find((candidate) => candidate.machineId === machineId);
  if (!instance) {
    throw Object.assign(new Error("that OpenMaus-managed cloud computer no longer exists"), { status: 404 });
  }
  if (instance.inUse) {
    throw Object.assign(new Error("this cloud computer is in use — stop its bot's work first"), { status: 409 });
  }
  if (confirmName !== instance.name) {
    throw Object.assign(new Error("cloud computer confirmation no longer matches — refresh and try again"), { status: 409 });
  }
  
  const release = claim?.(instance);
  try {
    const apiUrl = getMolaApiUrl(cfg);
    const resource = resourcePath(apiUrl);
    const removed = await molaJson(cfg, `/${resource}/${machineId}`, { method: "DELETE" });
    if (!removed.ok && removed.status !== 404 && removed.status !== 410) {
      throw Object.assign(new Error(molaErrorMessage(removed.status, "mola delete", removed.body, usesIncludedMola(cfg))), { status: removed.status });
    }
    forgetMolaId(machineId);
    return { ok: true };
  } finally {
    release?.();
  }
}

export async function findMola(cfg: AppConfig, botId: string) {
  cfg = snapshotMolaConfig(cfg);
  const cachedId = molaIdCache.get(botId);
  
  if (cachedId) {
    let direct: Awaited<ReturnType<typeof molaJson>> | null = null;
    try {
      const apiUrl = getMolaApiUrl(cfg);
      const resource = resourcePath(apiUrl);
      direct = await molaJson(cfg, `/${resource}/${cachedId}`, { signal: AbortSignal.timeout(20_000) });
    } catch {
    }
    const directMola = direct?.body?.data;
    if (direct?.ok && directMola?.id === cachedId && !TERMINAL.has(directMola.status)) return directMola;
    if (direct?.ok && directMola?.id !== cachedId) {
      throw Object.assign(new Error("mola.sh returned an invalid cloud computer identity"), { status: 503 });
    }
    molaIdCache.delete(botId);
  }
  
  const name = await molaNameFor(botId);
  const legacyName = legacyMolaNameFor(botId);
  const listed = await listMolaPages(cfg);
  if (!listed.ok) {
    throw Object.assign(new Error(listed.problem), { status: 503, transient: listed.unreachable === true });
  }
  
  const expected = listed.machines.filter((candidate: any) => candidate?.name === name || candidate?.name === legacyName);
  if (expected.some((candidate: any) => !MOLA_ID.test(candidate?.id))) {
    throw Object.assign(new Error("mola.sh returned an invalid cloud computer identity"), { status: 503 });
  }
  
  const found = expected.find((candidate: any) => candidate.name === name && !TERMINAL.has(candidate.status))
    ?? expected.find((candidate: any) => candidate.name === legacyName && !TERMINAL.has(candidate.status))
    ?? null;
  
  if (found) {
    const duplicateId = listed.machines.filter((candidate: any) => candidate?.id === found.id).length !== 1;
    if (duplicateId) {
      throw Object.assign(new Error("mola.sh returned a conflicting cloud computer identity"), { status: 503 });
    }
    molaIdCache.set(botId, found.id);
  }
  return found;
}

export async function readyMola(cfg: AppConfig, botId: string, budgetMs = 60_000) {
  cfg = snapshotMolaConfig(cfg);
  const mola = await findMola(cfg, botId);
  if (!mola) return null;
  if (READY.has(mola.status)) return mola;
  return waitReady(cfg, mola.id, budgetMs);
}

export function molaAccount(cfg: AppConfig): ServiceCredential | null {
  return molaCredential(cfg.mola?.token, cfg.mola?.apiUrl);
}

export function molaConfigured(cfg: AppConfig) {
  return Boolean(molaAccount(cfg));
}

function usesIncludedMola(_cfg: AppConfig): boolean {
  return false;
}

export function describeMolaAccount(cfg: AppConfig): { configured: boolean } {
  return { configured: molaConfigured(cfg) };
}

export async function verifyToken(token: string, apiUrl?: string): Promise<{ ok: true } | { ok: false; message: string; rejected?: true }> {
  try {
    const baseUrl = apiUrl || molaProviderApi();
    const resource = resourcePath(baseUrl);
    const res = await fetch(`${baseUrl}/${resource}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.ok) return { ok: true };
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false, rejected: true,
        message: "mola.sh rejected that key — it may have been revoked or expired. Copy a fresh one from your mola.sh account.",
      };
    }
    return { ok: false, message: `mola.sh returned ${res.status} for that token — try again in a moment.` };
  } catch {
    return { ok: false, message: "Couldn't reach mola.sh to check that token — check your connection and retry." };
  }
}

const INCLUDED_MOLA_UNAVAILABLE = "The cloud computers included with your Cloud plan aren't available right now. Try again later.";
const molaServiceName = (included: boolean) => included ? "MausBot Cloud's computer service" : "mola.sh";

export function molaErrorMessage(status: number, what: string, body?: any, included = false): string {
  const theirs = typeof body?.message === "string" ? body.message.trim() : "";
  const code = body?.error?.code ?? body?.code;
  
  if (status === 403 && code === "insufficient_token_ability") {
    const required = body?.error?.details?.required;
    const abilities = required ? ` (needs ${required})` : " (needs computers:read and computers:write)";
    return included 
      ? INCLUDED_MOLA_UNAVAILABLE 
      : `Mola API key has insufficient permissions${abilities} — update it in Settings → API keys`;
  }
  
  if (status === 401 || status === 403) {
    if (included) return INCLUDED_MOLA_UNAVAILABLE;
    return "mola.sh rejected your Mola API key — paste a current one in Settings → API keys";
  }
  if (status === 429) {
    return theirs || "mola.sh is rate-limiting this account — wait a minute and try again";
  }
  return theirs ? `${what} failed: ${theirs}` : `${what} failed (${status})`;
}

export function molaRefusal(status: number, what: string, body?: any, included = false): Error & { molaStatus: number; molaCode?: string } {
  const code = body?.error?.code ?? body?.code;
  return Object.assign(new Error(molaErrorMessage(status, what, body, included)), {
    molaStatus: status, ...(typeof code === "string" && /^[a-z0-9_]{1,64}$/.test(code) ? { molaCode: code } : {}),
  });
}

export async function molaStatus(cfg: AppConfig, botId: string) {
  cfg = snapshotMolaConfig(cfg);
  if (!molaConfigured(cfg)) return { configured: false, machine: null };
  const mola = await findMola(cfg, botId);
  return {
    configured: true,
    machine: mola ? { machineId: mola.id, status: mola.status, capabilities: mola.capabilities ?? null } : null,
  };
}

export async function provisionMola(cfg: AppConfig, botId: string, _botName: string) {
  cfg = snapshotMolaConfig(cfg);
  if (!molaConfigured(cfg)) {
    throw new Error("Mola is not configured — add its API key in Settings → API keys");
  }
  
  const vmName = await molaNameFor(botId);
  let mola = await findMola(cfg, botId);
  let created = false;
  
  try {
    if (!mola) {
      const apiUrl = getMolaApiUrl(cfg);
      const resource = resourcePath(apiUrl);
      
      // Different payload shapes for Cloud vs self-hosted
      // See obaid/mola-cp: app/Http/Requests/Api/StoreApiComputerRequest.php
      let createPayload: any;
      if (isCloudApi(apiUrl)) {
        // Cloud API: image slug, omit profile to use image default (e.g. "lite" for ubuntu)
        createPayload = {
          name: vmName,
          image: "ubuntu", // Ubuntu image slug (mola-cp docs/ubuntu.md)
          // Omit profile: Cloud auto-fills from image.default_profile_slug
        };
      } else {
        // Self-hosted uses image_ref and explicit resources
        createPayload = {
          name: vmName,
          vcpus: DEFAULT_MOLA_VCPUS,
          memory_mb: DEFAULT_MOLA_MEMORY_MB,
          disk_gb: DEFAULT_MOLA_DISK_GB,
          image_ref: "ubuntu-xfce:24.04-4", // Ubuntu 24.04 XFCE desktop
        };
      }
      
      const createRes = await molaJson(cfg, `/${resource}`, {
        method: "POST",
        body: JSON.stringify(createPayload),
        signal: AbortSignal.timeout(45_000),
      });
      
      if (!createRes.ok || !createRes.body?.data?.id) {
        throw molaRefusal(createRes.status, "mola create", createRes.body, usesIncludedMola(cfg));
      }
      mola = createRes.body.data;
      created = true;
      molaIdCache.set(botId, mola.id);
    }
    
    const ready = await waitReady(cfg, mola.id);
    if (!ready) throw new Error("the cloud computer did not become ready within 90s — retry in a minute");

    const joinUrl = await mintDesktopUrl(cfg, mola.id);
    if (!joinUrl) throw new Error("the cloud computer's desktop link could not be created");
    
    return { machineId: mola.id, machineName: vmName, reused: !created, status: ready.status, joinUrl };
  } catch (error) {
    if (!created || !mola?.id) throw error;
    
    try {
      const apiUrl = getMolaApiUrl(cfg);
      const resource = resourcePath(apiUrl);
      await molaJson(cfg, `/${resource}/${mola.id}`, { method: "DELETE" });
    } catch {
      // Cleanup failed, but throw original error
    }
    molaIdCache.delete(botId);
    throw error;
  }
}

export async function joinMola(cfg: AppConfig, botId: string) {
  cfg = snapshotMolaConfig(cfg);
  const mola = await findMola(cfg, botId);
  if (!mola) throw new Error("no computer yet — provision it first");
  const ready = await waitReady(cfg, mola.id);
  if (!ready) throw new Error("the cloud computer did not wake in time — try again");
  return { joinUrl: await mintDesktopUrl(cfg, mola.id), status: ready.status ?? null };
}

export async function joinReadyMola(cfg: AppConfig, botId: string) {
  cfg = snapshotMolaConfig(cfg);
  const mola = await findMola(cfg, botId);
  if (!mola) throw Object.assign(new Error("no computer yet — provision it first"), { status: 409 });
  if (!READY.has(mola.status)) {
    throw Object.assign(
      new Error("the cloud computer is sleeping or starting — interrupt the bot before waking it"),
      { status: 409 },
    );
  }
  return { joinUrl: await mintDesktopUrl(cfg, mola.id), status: mola.status ?? null };
}

export async function sleepMola(cfg: AppConfig, botId: string) {
  cfg = snapshotMolaConfig(cfg);
  const mola = await findMola(cfg, botId);
  if (!mola) throw new Error("no computer for this bot");
  await stopMola(cfg, mola.id);
  forgetMolaId(mola.id);
  return { ok: true };
}

export async function execOnMola(cfg: AppConfig, botId: string, command: string) {
  cfg = snapshotMolaConfig(cfg);
  if (command.length > MAX_REMOTE_COMMAND_LENGTH) {
    throw new RangeError(`command is too long (maximum ${MAX_REMOTE_COMMAND_LENGTH} characters)`);
  }
  const mola = await findMola(cfg, botId);
  if (!mola) throw new Error("no computer for this bot yet");
  const ready = await waitReady(cfg, mola.id, 60_000);
  if (!ready) throw new Error("the cloud computer did not wake");
  const out = await runCommand(cfg, mola.id, isolatedRemoteCommand(command));
  return { exitCode: out.exitCode, stdout: out.stdout.slice(-4000), stderr: out.stderr.slice(-2000) };
}

export const PANEL_FRAME_WIDTH = 1920;
export const PANEL_FRAME_QUALITY = 85;

export async function screenshotMola(cfg: AppConfig, botId: string, knownMolaId?: string, options?: { signal?: AbortSignal }) {
  cfg = snapshotMolaConfig(cfg);
  let machineId = knownMolaId;
  if (!machineId) {
    const mola = await findMola(cfg, botId);
    if (!mola) throw new Error("no computer for this bot yet");
    if (!READY.has(mola.status)) throw new Error(`the cloud computer is ${mola.status}`);
    machineId = mola.id as string;
  }
  
  const apiUrl = getMolaApiUrl(cfg);
  const resource = resourcePath(apiUrl);
  const res = await molaFetch(cfg, `/${resource}/${machineId}/actions`, {
    method: "POST",
    body: JSON.stringify({ action: "screenshot" }),
    signal: options?.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
  });
  
  const body: any = await res.json().catch(() => null);
  if (!res.ok || !body?.data?.image_base64) {
    throw new Error("screen capture failed on the cloud computer");
  }
  
  return { png: body.data.image_base64, format: body.data.mime_type?.includes("jpeg") ? "jpeg" : "png" };
}
