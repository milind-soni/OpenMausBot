// Hook point for the source-available enterprise layer (enterprise/, under its own licence), loaded only when present:
// core never imports it statically. Its one obligation is `register()`, turning a licence key into entitlements. The key
// comes from <data>/license.key, OMB_LICENSE_KEY or the kept copy of the last one accepted (license-source.ts), and is
// read again while a server install runs.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RequestAuth } from "./request-auth.ts";
import type { SessionRegistry } from "./sessions.ts";

import { LAST_GOOD_FILE, LICENSE_FILE, licenseFilePath, readLicenseFile, writeLastGood, type LicenseFileRead, type LicenseSource } from "./license-source.ts";
import { SERVER_ROOT } from "./proxy-paths.ts";

export interface EditionStatus {
  edition: "oss" | "enterprise";
  /** Enterprise only: who the license was issued to. */
  customer?: string;
  /** Entitlement ids the license grants (sorted). Empty for the open-source edition. */
  features: string[];
  /** Enterprise only: ISO date the license stops working, null for perpetual. */
  expiresAt?: string | null;
  /** With an expiry only: whole days until `expiresAt`; zero or negative once the grace period runs. */
  expiresInDays?: number;
  /** Enterprise in its grace period only: when the features stop. */
  graceEndsAt?: string;
  /** Why this is not the enterprise edition although something hinted it should be, or that the key needs renewing. */
  notice?: string;
}

/** What the enterprise layer's register() must return; validated because it is external code. */
const layerSchema = z.object({
  customer: z.string().min(1),
  features: z.array(z.string().min(1)),
  expiresAt: z.string().nullable(),
  seats: z.number().int().positive().optional(),
  plan: z.string().min(1).optional(),
  sub: z.string().min(1).optional(),
  server: z.string().min(1).optional(),
  /** When the licence was issued (YYYY-MM-DD) and, finer, `iat` (epoch ms): which of two licences is newer. */
  issued: z.string().optional(),
  iat: z.number().int().nonnegative().optional(),
});
type Layer = z.infer<typeof layerSchema>;

/** The layer accepts a key that expired less than the grace period ago. */
export const LICENSE_WARN_DAYS = 30;
/** The one grace period: how long after expiry licensed features keep working. */
export const LICENSE_GRACE_DAYS = 14;
const DAY_MS = 24 * 60 * 60_000;

/** OMB_ENTERPRISE_DIR alone when set; else beside the server root (a checkout, the npm package), then inside it (the Docker
 * image and the desktop ship dist-server/ alone). */
export function enterpriseLayerDirs(env: NodeJS.ProcessEnv = process.env, serverRoot: string = SERVER_ROOT): string[] {
  if (env.OMB_ENTERPRISE_DIR) return [env.OMB_ENTERPRISE_DIR];
  return [join(serverRoot, "..", "enterprise"), join(serverRoot, "enterprise")];
}

function layerEntry(dir: string): string | undefined {
  return [join(dir, "server", "index.ts"), join(dir, "server", "index.js")].find((candidate) => existsSync(candidate));
}

let current: EditionStatus = { edition: "oss", features: [] };
let workspaceAccessFactory: ((options: WorkspaceAccessOptions) => WorkspaceAccess) | undefined;
type Register = (options: { licenseKey: string; graceDays: number }) => unknown;
/** What the last load saw, so a re-read uses the same layer, data folder and environment key. */
let loaded: { entry: string | undefined; dataDir: string | undefined; envKey: string | undefined; keyAtStart: boolean; register?: Register } | null = null;
/** The licence in force beyond what EditionStatus carries; kept out of /api/edition, which bot shells may read. */
let held: { source: LicenseSource; layer: Layer } | null = null;
let clockWarned: string | undefined;
let lastChangeLog = Number.NEGATIVE_INFINITY;
/** The last licence problem logged, so an hourly re-read of the same bad file logs it once. */
let lastProblem: string | undefined;
let rereading: Promise<unknown> = Promise.resolve();

export interface WorkspaceAccessOptions {
  sessions: SessionRegistry;
  cookieName: string;
  closeSessionStreams(sessionId: string): void;
  entitled(): boolean;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface WorkspaceAccess {
  handlePublic(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>;
  authorize(req: IncomingMessage, auth: RequestAuth): Promise<{ status: 401 | 403 | 503; error: string } | null>;
  revalidate(): Promise<void>;
}

export function hostedWorkspaceConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OMB_ADMIN_URL !== undefined || env.OMB_ADMIN_WORKSPACE !== undefined || env.OMB_ADMIN_MEMBERSHIP !== undefined;
}

/** A partial setting is never standalone. */
export function hostedWorkspaceConfiguration(env: NodeJS.ProcessEnv = process.env): { admin: URL; tenant: URL; workspace: string; portalMembership: boolean } | null {
  try {
    const origin = (raw: string | undefined) => {
      if (!raw || raw !== raw.trim()) throw new Error("missing origin");
      const url = new URL(raw);
      if (url.protocol !== "https:" || (raw !== url.origin && raw !== `${url.origin}/`)) throw new Error("invalid origin");
      return url;
    };
    if (!/^[a-z][a-z0-9-]{1,30}$/.test(env.OMB_ADMIN_WORKSPACE ?? "")) return null;
    if (env.OMB_ADMIN_MEMBERSHIP !== undefined && !["local", "portal"].includes(env.OMB_ADMIN_MEMBERSHIP)) return null;
    return { admin: origin(env.OMB_ADMIN_URL), tenant: origin(env.OMB_PUBLIC_URL), workspace: env.OMB_ADMIN_WORKSPACE!, portalMembership: env.OMB_ADMIN_MEMBERSHIP === "portal" };
  } catch { return null; }
}

/** A hosted workspace never issues pairing codes or email sign-in: people come in through the portal. */
export function workspaceMembership(env: NodeJS.ProcessEnv = process.env):
  { authority: "local" | "portal"; pairingCodes: boolean; peopleUrl?: string } {
  const hosted = hostedWorkspaceConfiguration(env);
  const pairingCodes = !hostedWorkspaceConfigured(env);
  if (!hosted?.portalMembership) return { authority: "local", pairingCodes };
  const people = new URL("/people", hosted.admin);
  people.search = new URLSearchParams({ workspace: hosted.workspace }).toString();
  return { authority: "portal", pairingCodes, peopleUrl: people.href };
}

/** Only on a dedicated, portal-managed server; never an HTTP setting or a desktop grant. */
export function sharedWorkspaceFullAccessConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OMB_SHARED_WORKSPACE_FULL_ACCESS === "1" && env.OMB_DESKTOP_PARENT !== "1" &&
    hostedWorkspaceConfiguration(env)?.portalMembership === true;
}

/** A configured server without this hook must refuse hosted access, never fall back to email or QR credentials. */
export function createWorkspaceAccess(options: Omit<WorkspaceAccessOptions, "entitled">): WorkspaceAccess | null {
  if (!hostedWorkspaceConfigured(options.env)) return null;
  return workspaceAccessFactory?.({ ...options, entitled: () => entitled("admin") }) ?? null;
}

function oss(notice?: string): EditionStatus {
  current = notice ? { edition: "oss", features: [], notice } : { edition: "oss", features: [] };
  held = null;
  return current;
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

const LAYER_WITHOUT_KEY = "enterprise layer present but there is no licence: neither license.key nor OMB_LICENSE_KEY is set";
/** What a notice calls the licence in force: the file a person fixes, or the environment variable. */
const keyName = () => held && held.source !== "env" ? "license.key" : "OMB_LICENSE_KEY";

/** Never throws: a broken layer or key degrades to the open-source edition with a notice saying what to fix. With no key
 * and no hosted workspace nothing of the layer can be used, so it is not loaded. `dataDir`: where license.key and
 * license.last-good are; server/index.ts leaves it out on a desktop, a Cloud home and a hosted workspace, which read
 * OMB_LICENSE_KEY alone. */
export async function loadEnterpriseLayer(
  options: { dir?: string; licenseKey?: string; env?: NodeJS.ProcessEnv; serverRoot?: string; dataDir?: string; serverInstall?: boolean } = {},
): Promise<EditionStatus> {
  workspaceAccessFactory = undefined;
  lastProblem = undefined;
  lastChangeLog = Number.NEGATIVE_INFINITY;
  const dirs = options.dir ? [options.dir] : enterpriseLayerDirs(options.env, options.serverRoot);
  const envKey = options.licenseKey ?? process.env.OMB_LICENSE_KEY;
  const entry = dirs.map(layerEntry).find((candidate) => candidate !== undefined);
  const reads = await readSources(options.dataDir);
  const keyGiven = reads.file.state !== "absent" || reads.lastGood.state !== "absent" || Boolean(envKey);
  loaded = { entry, dataDir: options.dataDir, envKey, keyAtStart: keyGiven || options.serverInstall === true };
  if (!entry) {
    const named = reads.file.state !== "absent" ? `${licenseFilePath(options.dataDir!)} holds a licence` : "OMB_LICENSE_KEY is set";
    return oss(keyGiven ? `${named} but no enterprise layer exists at ${dirs.join(" or ")}` : undefined);
  }
  if (!keyGiven && !hostedWorkspaceConfigured(options.env)) return oss(LAYER_WITHOUT_KEY);
  try {
    loaded.register = await importLayer(entry);
  } catch (error) {
    return oss(`enterprise layer disabled: ${message(error)}`);
  }
  if (!keyGiven) return oss(LAYER_WITHOUT_KEY);
  return grant(reads, false, (line) => console.warn(line));
}

/** Whether server/index.ts starts the re-read: a layer, a data folder, and either a licence at start (file, environment
 * or kept copy) or a server install (license-source.ts licensePlace), whose first licence may arrive after it starts. */
export function licenseRefreshWanted(): boolean {
  return Boolean(loaded?.entry && loaded.dataDir && loaded.keyAtStart);
}

async function readSources(dataDir: string | undefined): Promise<{ file: LicenseFileRead; lastGood: LicenseFileRead }> {
  if (!dataDir) return { file: { state: "absent" }, lastGood: { state: "absent" } };
  const [file, lastGood] = await Promise.all([readLicenseFile(dataDir), readLicenseFile(dataDir, LAST_GOOD_FILE)]);
  return { file, lastGood };
}

async function importLayer(entry: string): Promise<Register> {
  const imported: unknown = await import(pathToFileURL(entry).href);
  const access: unknown = Reflect.get(Object(imported), "createWorkspaceAccess");
  if (typeof access === "function") workspaceAccessFactory = access as (options: WorkspaceAccessOptions) => WorkspaceAccess;
  const register: unknown = Reflect.get(Object(imported), "register");
  if (typeof register !== "function") throw new Error(`${entry} does not export register()`);
  return register as Register;
}

function note(problem: string, log: (line: string) => void) {
  if (problem !== lastProblem) log(problem);
  lastProblem = problem;
}

/** Where a licence came from, as a person would look for it. */
function sourceName(source: LicenseSource): string {
  return source === "env" ? "OMB_LICENSE_KEY" : source === "file" ? "license.key" : "license.last-good";
}

/** Positive when `a` was issued after `b`: the issue date, then `iat` when both carry it, then the later expiry. Equal
 * (0) when none of those tell them apart: the same day's reissue without `iat` is not refused. */
export function issuedOrder(a: LicenseOrder, b: LicenseOrder): number {
  const issuedA = a.issued ?? "";
  const issuedB = b.issued ?? "";
  if (issuedA !== issuedB) return issuedA < issuedB ? -1 : 1;
  if (a.iat !== undefined && b.iat !== undefined && a.iat !== b.iat) return a.iat < b.iat ? -1 : 1;
  const ends = (expires: string | null) => expires === null ? Number.POSITIVE_INFINITY : Date.parse(expires);
  const endA = ends(a.expiresAt);
  const endB = ends(b.expiresAt);
  return endA === endB || (Number.isNaN(endA) && Number.isNaN(endB)) ? 0 : endA < endB ? -1 : 1;
}
export type LicenseOrder = Pick<Layer, "issued" | "iat" | "expiresAt">;

/** Off: a licence's `server` claim is carried, not checked. When it is switched on, a licence is refused only when this
 * server knows its own id and the licence names a different one; a licence that names none, or a server that does not
 * know its id, is never refused for it. */
const ENFORCE_LICENSE_SERVER = false;
export function licenseServerRefusal(licensed: string | undefined, own: string | undefined, enforce: boolean = ENFORCE_LICENSE_SERVER): string | null {
  if (!enforce || !licensed || !own || licensed === own) return null;
  return `the licence was issued for server ${licensed}, not this one`;
}

/** Every licence on offer (license.key, OMB_LICENSE_KEY, the kept copy), each verified by the layer; the one issued last
 * wins, and on a tie the file, then the environment. On a re-read (`keep`) a licence in force is never replaced by one
 * issued before it, nor dropped for a broken or missing file: it stays until its grace ends. */
async function grant(reads: { file: LicenseFileRead; lastGood: LicenseFileRead }, keep: boolean, log: (line: string) => void): Promise<EditionStatus> {
  const { dataDir, envKey, register } = loaded!;
  const now = Date.now();
  const active = keep && current.edition === "enterprise" && !expired(now) && held !== null;
  const problems: string[] = [];
  const offered: { key: string; source: LicenseSource }[] = [];
  for (const [read, source] of [[reads.file, "file"], [envKey ? { state: "present", key: envKey } as const : { state: "absent" } as const, "env"], [reads.lastGood, "last-good"]] as const) {
    if (read.state === "present") offered.push({ key: read.key, source });
    else if (read.state === "unreadable") problems.push(read.error);
  }
  const accepted: { key: string; source: LicenseSource; layer: Layer }[] = [];
  for (const candidate of offered) {
    try {
      // A layer that ignores graceDays refuses an expired key at startup.
      const layer = layerSchema.parse(await register!({ licenseKey: candidate.key, graceDays: LICENSE_GRACE_DAYS }));
      const refusal = licenseServerRefusal(layer.server, undefined);
      if (refusal) throw new Error(refusal);
      accepted.push({ ...candidate, layer });
    } catch (error) {
      problems.push(candidate.source === "env" ? message(error) : `the licence in ${licenseFilePath(dataDir!, candidate.source === "file" ? LICENSE_FILE : LAST_GOOD_FILE)} was refused: ${message(error)}`);
    }
  }
  const best = accepted.reduce<(typeof accepted)[number] | undefined>((top, next) => !top || issuedOrder(next.layer, top.layer) > 0 ? next : top, undefined);
  const file = accepted.find((candidate) => candidate.source === "file");
  if (best && (!active || issuedOrder(best.layer, held!.layer) >= 0)) {
    const { layer } = best;
    const fileGone = active && held!.source === "file" && reads.file.state === "absent";
    current = { edition: "enterprise", customer: layer.customer, features: [...new Set(layer.features)].sort(), expiresAt: layer.expiresAt };
    held = { source: best.source, layer };
    if (reads.file.state !== "absent" && best.source !== "file") {
      note(`${file ? `the licence in ${licenseFilePath(dataDir!)} was issued before the one in ${sourceName(best.source)}` : problems[0]}; using ${sourceName(best.source)} instead`, log);
    } else if (fileGone) note(`no licence in ${licenseFilePath(dataDir!)} any more; using ${sourceName(best.source)} instead`, log);
    else lastProblem = undefined;
    warnClock(layer, now, log);
    if (dataDir) await writeLastGood(dataDir, best.key).catch((error: unknown) => note(`could not keep a copy of the licence: ${message(error)}`, log));
    return current;
  }
  if (active) {
    const why = file && issuedOrder(file.layer, held!.layer) < 0 ? `the licence in ${licenseFilePath(dataDir!)} was issued before the one in force`
      : problems[0] ?? `no licence in ${licenseFilePath(dataDir!)} any more`;
    note(`${why}; keeping the licence in force until it expires`, log);
    return current;
  }
  if (!problems.length) return current;
  if (keep) note(`enterprise layer disabled: ${problems[0]}`, log);
  return oss(`enterprise layer disabled: ${problems[0]}`);
}

/** Once per licence: a clock more than a day before the issue date makes every expiry check wrong. */
function warnClock(layer: Layer, now: number, log: (line: string) => void) {
  if (!layer.issued || now >= Date.parse(layer.issued) - DAY_MS || clockWarned === layer.issued) return;
  clockWarned = layer.issued;
  log(`this server's clock says ${new Date(now).toISOString()}, before the licence was issued (${layer.issued}): set the clock right, or the licence's dates are judged wrongly`);
}

/** A re-read that has not finished after this long no longer holds up the next one. */
const REREAD_DEADLINE_MS = 30_000;
/** At most one "licence changed" line in this long. */
const CHANGE_LOG_GAP_MS = 10 * 60_000;

/** Reads the licence again (license-source.ts calls this hourly and when the file changes) and switches licensed
 * features on or off without a restart. Never throws; one re-read runs at a time, and a hung one stops blocking the
 * next after REREAD_DEADLINE_MS. */
export function refreshLicense(log: (line: string) => void = (line) => console.warn(line)): Promise<EditionStatus> {
  const run = async (): Promise<EditionStatus> => {
    if (!loaded?.entry) return current;
    const reads = await readSources(loaded.dataDir);
    if (reads.file.state === "absent" && reads.lastGood.state === "absent" && !loaded.envKey && !(current.edition === "enterprise" && held)) return current;
    if (!loaded.register) {
      try {
        loaded.register = await importLayer(loaded.entry);
      } catch (error) {
        note(`enterprise layer disabled: ${message(error)}`, log);
        return current;
      }
    }
    // Which licence is in force, not where it was read from: the same licence kept or read again is no change.
    const before = JSON.stringify([current, held?.layer]);
    const status = await grant(reads, true, log);
    const now = Date.now();
    if (JSON.stringify([current, held?.layer]) !== before && status.edition === "enterprise" && now - lastChangeLog >= CHANGE_LOG_GAP_MS) {
      lastChangeLog = now;
      log(`licence changed: ${describeEdition(status)}`);
    }
    return status;
  };
  const next = rereading.then(run, run);
  rereading = Promise.race([next.catch(() => undefined), new Promise<void>((done) => setTimeout(done, REREAD_DEADLINE_MS).unref?.())]);
  return next.catch((error: unknown) => { log(`licence re-read failed: ${message(error)}`); return current; });
}

function expiryAt(): number | null {
  if (current.edition !== "enterprise" || !current.expiresAt) return null;
  const at = new Date(current.expiresAt).getTime();
  return Number.isFinite(at) ? at : null;
}

/** A license expiring while the server runs stops granting when its grace ends, not at the next restart. */
function expired(now: number): boolean {
  const at = expiryAt();
  return at !== null && now >= at + LICENSE_GRACE_DAYS * DAY_MS;
}

export function editionStatus(now: number = Date.now()): EditionStatus {
  const at = expiryAt();
  if (at === null) return current;
  if (expired(now)) {
    return {
      edition: "oss",
      features: [],
      notice: `enterprise layer disabled: ${keyName()} expired on ${current.expiresAt}; renew it to keep enterprise features`,
    };
  }
  const expiresInDays = Math.ceil((at - now) / DAY_MS);
  if (now < at) return { ...current, expiresInDays };
  const graceEndsAt = new Date(at + LICENSE_GRACE_DAYS * DAY_MS).toISOString().slice(0, 10);
  return {
    ...current,
    expiresInDays,
    graceEndsAt,
    notice: `${keyName()} expired on ${current.expiresAt}; enterprise features keep working until ${graceEndsAt} while it is renewed`,
  };
}

/** The licence as the owner's Settings shows it (GET /api/license): never the key itself. `valid` while licensed features
 * work, grace included. `graceEndsAt` whenever the licence expires; `graceDaysLeft` only once it has expired: whole days
 * until the features stop, 0 after. `source`, `plan` and `seats` describe the last licence accepted, even once lapsed. */
export interface LicenseState {
  valid: boolean;
  source: LicenseSource | null;
  customer: string | null;
  plan: string | null;
  seats: number | null;
  features: string[];
  expiresAt: string | null;
  expiresInDays: number | null;
  graceEndsAt: string | null;
  graceDaysLeft: number | null;
  notice: string | null;
}

export function licenseState(now: number = Date.now()): LicenseState {
  const status = editionStatus(now);
  const licensed = current.edition === "enterprise";
  const at = expiryAt();
  const graceEnd = at === null ? null : at + LICENSE_GRACE_DAYS * DAY_MS;
  return {
    valid: status.edition === "enterprise",
    source: licensed ? held?.source ?? null : null,
    customer: licensed ? current.customer ?? null : null,
    plan: licensed ? held?.layer.plan ?? null : null,
    seats: licensed ? held?.layer.seats ?? null : null,
    features: status.features,
    expiresAt: licensed ? current.expiresAt ?? null : null,
    expiresInDays: at === null ? null : Math.ceil((at - now) / DAY_MS),
    graceEndsAt: graceEnd === null ? null : new Date(graceEnd).toISOString().slice(0, 10),
    graceDaysLeft: at === null || graceEnd === null || now < at ? null : Math.max(0, Math.ceil((graceEnd - now) / DAY_MS)),
    notice: status.notice ?? null,
  };
}

/** No countdown, grace date or operator notice for a non-admin session. */
export function editionForMembers(status: EditionStatus): EditionStatus {
  const { expiresInDays: _days, graceEndsAt: _grace, notice: _notice, ...shared } = status;
  return shared;
}

/** Core feature gates ask only this; unknown ids are never granted. */
export function entitled(feature: string, now: number = Date.now()): boolean {
  return !expired(now) && current.features.includes(feature);
}

export function licenseWarning(status: EditionStatus): string | null {
  if (status.edition !== "enterprise" || !status.expiresAt || status.expiresInDays === undefined) return null;
  if (status.graceEndsAt) {
    return `${keyName()} expired on ${status.expiresAt}; enterprise features keep working until ${status.graceEndsAt} — renew the key before then`;
  }
  if (status.expiresInDays > LICENSE_WARN_DAYS) return null;
  const days = status.expiresInDays === 1 ? "1 day" : `${status.expiresInDays} days`;
  return `${keyName()} expires on ${status.expiresAt} (in ${days}); renew it before then to keep enterprise features`;
}

export function describeEdition(status: EditionStatus): string {
  if (status.edition === "enterprise") {
    const until = status.expiresAt ? ` until ${status.expiresAt}` : "";
    return `openmausbot enterprise edition for ${status.customer}${until}: ${status.features.join(", ") || "no features"}`;
  }
  return `openmausbot open-source edition${status.notice ? ` (${status.notice})` : ""}`;
}

/** The edition as Settings shows it: a licence block only while an Enterprise licence is near or past expiry. */
export function editionForSettings(status: EditionStatus) {
  const expiring = status.edition === "enterprise" && status.expiresAt && status.expiresInDays !== undefined &&
    (status.graceEndsAt !== undefined || status.expiresInDays <= LICENSE_WARN_DAYS);
  return {
    edition: status.edition,
    features: status.features,
    ...(expiring ? { license: { expiresAt: status.expiresAt!, expiresInDays: status.expiresInDays!, ...(status.graceEndsAt ? { graceEndsAt: status.graceEndsAt } : {}) } } : {}),
  };
}
