// OMB Cloud Pro home machine. The server binds 127.0.0.1 behind an edge proxy and every request carries X-Forwarded-*
// headers, so no network request is ever the loopback owner. The Admin never holds a session: it signs a request with the
// bootstrap secret (HMAC-SHA256 over method, path and query, timestamp, nonce and body hash). A valid pairing request opens
// one ordinary pairing window; a valid health request reads the content-free health report (server/cloud-health.ts).
// Nothing on a Cloud home is routed to a platform model gateway, except a free trial's Claude credit.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import type { Surface } from "../shared/wire.ts";
import { writeFileAtomic } from "./atomic.ts";
import { hostedWorkspaceConfigured } from "./enterprise.ts";
import { parseMemberClaim, teamRoleScopes, type CloudTeam } from "./cloud-team.ts";
import { formatPairingCode, type SessionRegistry } from "./sessions.ts";

/** Any of these switches the server into Cloud home mode; then all are required. */
export const CLOUD_HOME_KEYS = ["OMB_CLOUD_ROLE", "OMB_CLOUD_MACHINE_ID", "OMB_CLOUD_ADMIN_URL", "OMB_CLOUD_BOOTSTRAP_SECRET"] as const;
/** A platform model gateway's settings: a Cloud home logs one warning, and neither it nor anything it starts sees them. */
export const CLOUD_IGNORED_KEYS = ["OMB_HOSTED_MODEL_URL", "OMB_HOSTED_MODEL_TOKEN", "OMB_HOSTED_MODELS"] as const;
export const CLOUD_PAIRING_PATH = "/api/cloud/pairing";
export const CLOUD_HEALTH_PATH = "/api/cloud/health";
export const CLOUD_PAIRING_DEFAULT_TTL_S = 300;
export const CLOUD_PAIRING_MAX_TTL_S = 600;
/** A browser sign-in's owner: printable ASCII with no space, `<` or `>`, and exactly one `@`. */
const OWNER_EMAIL = /^[!-;=?A-~]{1,64}@[!-;=?A-~]{1,189}$/;
/** A browser sign-in is redeemed the moment its tab loads. */
export const CLOUD_BROWSER_SIGN_IN_MAX_TTL_S = 120;
/** How far a signed request's timestamp may be from this machine's clock. */
export const CLOUD_PAIRING_SKEW_S = 300;
/** How long a used nonce is refused. Longer than the whole accepted window. */
export const CLOUD_PAIRING_NONCE_MS = 10 * 60_000;
const MAX_NONCES = 10_000;
export const CLOUD_HOME_MARKER = ".omb-cloud-home.json";

export type CloudHomeRole = "home" | "team";

export interface CloudHomeConfig {
  /** `home`: one person's My Cloud. `team`: a Team Cloud several people use (docs/team-cloud.md). */
  role: CloudHomeRole;
  /** The team this machine is the home of; null on a My Cloud. */
  team: CloudTeam | null;
  machineId: string;
  adminOrigin: string;
  publicOrigin: string;
  bootstrapSecret: string;
  warnings: string[];
}

export function cloudHomeConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return CLOUD_HOME_KEYS.some((key) => env[key] !== undefined);
}

function invalid(why: string): never {
  throw new Error(`Cloud home configuration is invalid: ${why}.`);
}

function exactHttpsOrigin(raw: string | undefined, name: string): string {
  let url: URL;
  try {
    if (!raw || raw !== raw.trim()) throw new Error();
    url = new URL(raw);
  } catch { return invalid(`${name} must be an https origin`); }
  if (url.protocol !== "https:" || url.username || url.password || (raw !== url.origin && raw !== `${url.origin}/`)) {
    invalid(`${name} must be an exact https origin with no path`);
  }
  return url.origin;
}

/** Null on any machine that is not a Cloud home; throws, so the server refuses to start, on a partial or invalid one. */
export function cloudHomeConfiguration(env: NodeJS.ProcessEnv = process.env): CloudHomeConfig | null {
  if (!cloudHomeConfigured(env)) return null;
  if (env.OMB_DESKTOP_PARENT === "1") invalid("the desktop app cannot run as a Cloud home machine");
  if (hostedWorkspaceConfigured(env)) invalid("a Cloud home is not a hosted team workspace; remove OMB_ADMIN_URL, OMB_ADMIN_WORKSPACE and OMB_ADMIN_MEMBERSHIP");
  const role = env.OMB_CLOUD_ROLE;
  if (role !== "home" && role !== "team") invalid('OMB_CLOUD_ROLE must be "home" or "team"; this image runs the home machine');
  const team = role === "team" ? cloudTeamConfiguration(env) : null;
  const machineId = env.OMB_CLOUD_MACHINE_ID ?? "";
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/.test(machineId)) invalid("OMB_CLOUD_MACHINE_ID must be the Admin's machine id (letters, digits, dashes)");
  const adminOrigin = exactHttpsOrigin(env.OMB_CLOUD_ADMIN_URL, "OMB_CLOUD_ADMIN_URL");
  const publicOrigin = exactHttpsOrigin(env.OMB_PUBLIC_URL, "OMB_PUBLIC_URL");
  const bootstrapSecret = env.OMB_CLOUD_BOOTSTRAP_SECRET ?? "";
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(bootstrapSecret)) invalid("OMB_CLOUD_BOOTSTRAP_SECRET must be at least 256 bits of base64url");
  const warnings: string[] = [];
  const ignored = CLOUD_IGNORED_KEYS.filter((key) => env[key] !== undefined);
  if (ignored.length) warnings.push(`ignoring ${ignored.join(", ")}: Cloud Pro includes no AI; people sign in with their own Claude or ChatGPT account, or an API key`);
  return { role, team, machineId, adminOrigin, publicOrigin, bootstrapSecret, warnings };
}

const TEAM_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
// oxlint-disable-next-line no-control-regex
const TEAM_NAME = /^[^\x00-\x1f\x7f]{1,80}$/;
const TEAM_LANGUAGE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/;

/** A Team Cloud boots with the Admin's team id and the team's name, and answers by that name. */
function cloudTeamConfiguration(env: NodeJS.ProcessEnv): CloudTeam {
  const id = env.OMB_CLOUD_TEAM_ID ?? "";
  if (!TEAM_ID.test(id)) invalid("OMB_CLOUD_TEAM_ID must be the Admin's team id (letters, digits, dashes)");
  const name = (env.OMB_CLOUD_TEAM_NAME ?? "").trim();
  if (!TEAM_NAME.test(name)) invalid("OMB_CLOUD_TEAM_NAME must be the team's name (1 to 80 characters)");
  // A language the app doesn't know is ignored rather than refused: the Team Cloud still boots, in its own default.
  const language = (env.OMB_CLOUD_TEAM_LANGUAGE ?? "").trim().toLowerCase();
  return { id, name, ...(TEAM_LANGUAGE.test(language) ? { language } : {}) };
}

export { CLOUD_HOME_SECRET_KEYS, CLOUD_SECRETS_FD_ENV, cloudHomeSecrets, takeCloudSecrets, withoutCloudSecrets } from "./cloud-secrets.ts";

export function withoutIgnoredCloudKeys(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const kept = { ...env };
  for (const key of CLOUD_IGNORED_KEYS) delete kept[key];
  return kept;
}

export { cloudHomeOffersPlace } from "../shared/cloud-home.ts";

/** In the person's words; a turn's error shows 160 characters, so each fits. */
export function cloudHomePlaceRefusal(place: Surface): string | undefined {
  if (place === "local") return "This computer isn't a place in the Cloud. Set Works on to Auto, Cloud desktop or Browser, or share your computer under Settings → MausBot Cloud.";
  if (place === "vm") return "Cloud bots can't use a private desktop. Set Works on to Auto, Cloud desktop or Browser.";
  return undefined;
}

/** Recorded once in this Cloud's own onboarding record, which never travels with Move to Cloud, so moved-in turns never count. */
export function firstCloudTurnPatch(turn: { cloudHome: boolean; recorded: string | undefined; ok: boolean; known: boolean; now?: Date }): { onboarding: { firstTurnAt: string } } | null {
  if (!turn.cloudHome || turn.recorded || !turn.ok || !turn.known) return null;
  return { onboarding: { firstTurnAt: (turn.now ?? new Date()).toISOString() } };
}

/** Must match openmaus-cloud's cloudRequestSignature. `target` is the path and query exactly as the Admin sent them. */
export function cloudRequestSignature(secret: string, timestamp: string, nonce: string, method: string, target: string, body: Buffer | string): string {
  const bodyHash = createHash("sha256").update(body).digest("base64url");
  return createHmac("sha256", secret).update(`v1\n${timestamp}\n${nonce}\n${method}\n${target}\n${bodyHash}`).digest("base64url");
}

export function cloudPairingSignature(secret: string, timestamp: string, nonce: string, body: Buffer | string): string {
  return cloudRequestSignature(secret, timestamp, nonce, "POST", CLOUD_PAIRING_PATH, body);
}

export type CloudRequestRefusal = "invalid_signature" | "stale_request" | "replayed_request" | "busy";
export type CloudRequestVerdict = { ok: true } | { ok: false; status: 401 | 503; error: CloudRequestRefusal };

/** One route's verifier, with its own used nonces. Signature first (constant time), then clock and nonce. Nothing is logged. */
export function createCloudRequestVerifier(options: { secret: string; now?: () => number }) {
  const now = options.now ?? Date.now;
  const nonces = new Map<string, number>();
  return {
    verify(input: { timestamp: string | undefined; nonce: string | undefined; signature: string | undefined; method: string; target: string; body: Buffer | string }): CloudRequestVerdict {
      const timestamp = input.timestamp ?? "", nonce = input.nonce ?? "";
      const presented = /^v1=([A-Za-z0-9_-]{43})$/.exec(input.signature ?? "")?.[1];
      const expected = Buffer.from(cloudRequestSignature(options.secret, timestamp, nonce, input.method, input.target, input.body), "base64url");
      const given = presented ? Buffer.from(presented, "base64url") : Buffer.alloc(expected.length);
      const matches = given.length === expected.length && timingSafeEqual(given, expected);
      if (!presented || !matches || !/^\d{1,12}$/.test(timestamp) || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) return { ok: false, status: 401, error: "invalid_signature" };
      const at = now();
      if (Math.abs(at / 1000 - Number(timestamp)) > CLOUD_PAIRING_SKEW_S) return { ok: false, status: 401, error: "stale_request" };
      for (const [seen, until] of nonces) if (until <= at) nonces.delete(seen);
      if (nonces.has(nonce)) return { ok: false, status: 401, error: "replayed_request" };
      if (nonces.size >= MAX_NONCES) return { ok: false, status: 503, error: "busy" };
      nonces.set(nonce, at + CLOUD_PAIRING_NONCE_MS);
      return { ok: true };
    },
  };
}

export interface CloudPairingResult {
  status: 200 | 400 | 401 | 429 | 503;
  body: Record<string, unknown>;
}

type PairingSessions = Pick<SessionRegistry, "openPairing" | "attemptAllowed" | "noteFailure" | "clearFailures">;

export function createCloudPairing(options: {
  secret: string;
  sessions: PairingSessions;
  /** The team this machine serves: then every pairing body must carry the Admin's `member` claim. */
  team?: CloudTeam | null;
  now?: () => number;
}) {
  const { sessions } = options;
  const verifier = createCloudRequestVerifier(options);
  return {
    /** A bad signature counts toward the pairing lockout; clock, nonce and body are checked before anything opens. Nothing is logged. */
    handle(input: { timestamp: string | undefined; nonce: string | undefined; signature: string | undefined; body: Buffer; source: string }): CloudPairingResult {
      const lock = sessions.attemptAllowed(input.source);
      if (!lock.ok) return { status: 429, body: { error: "rate_limited", retryAfterSeconds: Math.ceil(lock.retryAfterMs / 1000) } };
      const verdict = verifier.verify({ ...input, method: "POST", target: CLOUD_PAIRING_PATH });
      if (!verdict.ok && verdict.error === "invalid_signature") sessions.noteFailure(input.source);
      else sessions.clearFailures(input.source);
      if (!verdict.ok) return { status: verdict.status, body: { error: verdict.error } };
      let parsed: unknown;
      try { parsed = input.body.length ? JSON.parse(input.body.toString("utf8")) : {}; } catch { return { status: 400, body: { error: "invalid_body" } }; }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { status: 400, body: { error: "invalid_body" } };
      const { label, ttlSeconds, purpose, owner, team: claimedTeam, member: claimedMember } = parsed as { label?: unknown; ttlSeconds?: unknown; purpose?: unknown; owner?: unknown; team?: unknown; member?: unknown };
      // A My Cloud is one person's: a team claim has no meaning there and is refused rather than ignored.
      if (!options.team && (claimedTeam !== undefined || claimedMember !== undefined)) return { status: 400, body: { error: "not_a_team" } };
      const claim = options.team ? parseMemberClaim(parsed as Record<string, unknown>, options.team) : null;
      if (claim && !claim.ok) return { status: 400, body: { error: claim.error } };
      const member = claim?.ok ? claim.member : null;
      // oxlint-disable-next-line no-control-regex
      if (label !== undefined && (typeof label !== "string" || label.length > 80 || /[\x00-\x1f\x7f]/.test(label))) return { status: 400, body: { error: "invalid_label" } };
      if (ttlSeconds !== undefined && (!Number.isSafeInteger(ttlSeconds) || (ttlSeconds as number) < 1)) return { status: 400, body: { error: "invalid_ttl" } };
      if (purpose !== undefined && purpose !== "browser") return { status: 400, body: { error: "invalid_purpose" } };
      const browser = purpose === "browser";
      // The sign-in page shows this owner before the person continues: one printable-ASCII address, no `<` or `>`.
      if ((browser || owner !== undefined) && (typeof owner !== "string" || owner.length > 254 || !OWNER_EMAIL.test(owner))) {
        return { status: 400, body: { error: "invalid_owner" } };
      }
      const ttl = Math.min((ttlSeconds as number | undefined) ?? CLOUD_PAIRING_DEFAULT_TTL_S, browser ? CLOUD_BROWSER_SIGN_IN_MAX_TTL_S : CLOUD_PAIRING_MAX_TTL_S);
      const opened = sessions.openPairing({
        scopes: member ? teamRoleScopes(member.role) : ["admin", "client"],
        label: typeof label === "string" && label.trim() ? label.trim() : "MausBot Cloud",
        ttlMs: ttl * 1000,
        browser,
        ...(browser ? { owner: owner as string } : {}),
        ...(member ? { member } : {}),
      });
      // Saying `purpose` back tells the Admin this machine made a browser sign-in; an older machine ignores it.
      if (browser) return { status: 200, body: { credential: opened.credential, expiresAt: opened.expiresAt, purpose: "browser" } };
      return { status: 200, body: { code: formatPairingCode(opened.code), credential: opened.credential, expiresAt: opened.expiresAt } };
    },
  };
}

/** The exact bytes the Admin signed, bounded. */
export function readSignedBody(req: IncomingMessage, limit = 4096): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0, done = false;
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) { done = true; reject(Object.assign(new Error("body too large"), { status: 413 })); return; }
      chunks.push(chunk);
    });
    req.on("end", () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
    req.on("error", (error) => { if (!done) { done = true; reject(Object.assign(error, { status: 400 })); } });
  });
}

// useradd seeds these shell files and a fresh Fly volume carries lost+found; anything else is someone's data.
const ADOPTABLE = new Set(["lost+found", ".bash_logout", ".bashrc", ".profile"]);

/** Binds the volume to this machine on first boot and refuses any other machine's after; never deletes or rewrites data. */
export function prepareCloudHomeVolume(home: string, machineId: string): "new" | "existing" {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const marker = join(home, CLOUD_HOME_MARKER);
  if (existsSync(marker)) {
    const stat = lstatSync(marker);
    let saved: unknown;
    try {
      if (!stat.isFile() || stat.size > 4096) throw new Error();
      saved = JSON.parse(readFileSync(marker, "utf8"));
    } catch { throw new Error("This volume's Cloud marker is unreadable. No data was changed."); }
    if ((saved as { machine?: unknown })?.machine !== machineId) throw new Error("This volume belongs to another Cloud machine. No data was changed.");
    return "existing";
  }
  if (readdirSync(home).some((name) => !ADOPTABLE.has(name))) {
    throw new Error("Refusing to adopt a data volume that was not made for this Cloud machine. No data was changed.");
  }
  writeFileAtomic(marker, JSON.stringify({ version: 1, machine: machineId }) + "\n", { mode: 0o600 });
  return "new";
}

/** What the edge proxy may answer for: the machine's own public name. */
export function cloudHomeHost(config: Pick<CloudHomeConfig, "publicOrigin">): string {
  return new URL(config.publicOrigin).hostname;
}
