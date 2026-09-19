// Box API plumbing — endpoint base, fetch/JSON envelopes, allowlisted
// state parsing, the direct identity probe, and the bot-to-box id cache
// shared by the higher-level modules under server/box/.

import type { AppConfig } from "../config.ts";

// overridable so tests can point at a stub instead of the live provider
const BOX_API = process.env.OMB_BOX_API || "https://ascii.dev/api/box/v1";
// Desktop URLs carry stream tokens, so a provider answer may only send the
// user to the Box service's own host, a subdomain of it, or one of these
// explicitly allowlisted extras (OMB_BOX_DESKTOP_HOSTS, comma-separated).
export const BOX_API_HOST = new URL(BOX_API).hostname.toLowerCase();
export const EXTRA_DESKTOP_HOSTS = (process.env.OMB_BOX_DESKTOP_HOSTS ?? "")
  .split(",")
  .map((host) => host.trim().toLowerCase())
  .filter(Boolean);
export const READY = new Set(["idle", "ready", "running"]);

export const BOX_ID = /^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/;

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
  "removing",
  "error",
]);

// Resolving a bot's box means LISTing every box in the account, so it is
// the most expensive thing on any hot path. The name is deterministic, so
// once we know the id we can go straight at it — the cache is refreshed
// whenever the direct read fails (deleted/renamed box) and always carries
// the live state so callers can still see "archived".
export const boxIdCache = new Map<string, string>();

/** Keep one provider account for the whole logical operation. Settings may
 * replace the shared config object after an async request has started; every
 * follow-up (rename, readiness, cleanup, etc.) must keep using the credential
 * that selected or created the Box in the first place. */
export function snapshotBoxConfig(cfg: AppConfig): AppConfig {
  return { box: cfg.box ? { token: cfg.box.token } : undefined };
}

export function boxFetch(cfg: AppConfig, path: string, opts: RequestInit = {}) {
  return fetch(`${BOX_API}${path}`, {
    ...opts,
    headers: {
      authorization: `Bearer ${cfg.box?.token}`,
      "content-type": "application/json",
      ...opts.headers,
    },
  });
}

export async function boxJson(cfg: AppConfig, path: string, opts: RequestInit = {}) {
  const res = await boxFetch(cfg, path, opts);
  const body: any = await res.json().catch(() => null);
  return { ok: res.ok && body?.ok !== false, status: res.status, body };
}

export function boxInventoryProblem(status: number, body: any): string {
  if (status === 401 || status === 403) {
    return "ascii.dev rejected the Box API key — update it in Settings → Connections";
  }
  if (status === 429) return "ascii.dev is rate-limiting this account — wait a minute and refresh";
  const message = typeof body?.message === "string" ? body.message.trim() : "";
  return message ? `ascii.dev could not list cloud computers: ${message}` : `ascii.dev could not list cloud computers (${status})`;
}

export function safeBoxState(value: unknown): string {
  if (typeof value !== "string") return "unknown";
  const state = value.toLowerCase();
  return BOX_STATES.has(state) ? state : "unknown";
}

export interface BoxIdentityInspection {
  available: boolean;
  identity: { boxId: string; name: string; state: string } | null;
  problem: string | null;
}

/** Direct identity proof for a Box remembered in the local create journal.
 * Unlike account LIST, this endpoint is not eventually consistent. Only the
 * immutable id, provider name and allowlisted lifecycle state cross this
 * boundary. */
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
  return { available: true, identity: { boxId, name, state: safeBoxState(candidate.state) }, problem: null };
}

export function forgetBoxId(boxId: string): void {
  for (const [botId, cachedId] of boxIdCache) {
    if (cachedId === boxId) boxIdCache.delete(botId);
  }
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

/** The keys this OpenMausBot already holds, as the environment its bots'
 * agents read on the box. The box is created with `noEnv: true`, so the
 * ascii.dev account's own logins never land in the guest: the box has exactly
 * these and nothing else (see "Whose keys" in the Box integrated-agents docs). */
export function boxCredentialEnv(cfg: AppConfig, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  const put = (name: string, value: string | undefined) => {
    if (typeof value === "string" && value.trim()) out[name] = value.trim();
  };
  // The workspace key only: an ANTHROPIC_API_KEY in the server's own env is
  // never the workspace key (see loadConfig), so it is not forwarded either.
  put("ANTHROPIC_API_KEY", cfg.anthropic?.key);
  for (const name of BOX_FORWARDED_CREDENTIAL_ENV) put(name, env[name]);
  return out;
}

/** Names the box's agents read (Claude Code, Codex, pi, OpenCode, Prime
 * Agent, Kimi), forwarded verbatim from this server's environment when set. */
const BOX_FORWARDED_CREDENTIAL_ENV = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "LLMGATEWAY_API_KEY",
  "DEEPSEEK_API_KEY",
  "MOONSHOT_API_KEY",
  "KIMI_CODE_ACCESS_TOKEN",
  "KIMI_CODE_REFRESH_TOKEN",
] as const;
