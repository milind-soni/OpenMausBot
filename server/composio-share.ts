// One person's connected apps on this computer and on their own Cloud. With OpenMausBot's connected-apps service, this
// computer's installation mints a code for the Cloud's installation, which then acts as the same Composio user. With the
// person's own Composio project, the Cloud saves the same key and user. A Cloud whose own apps are already connected
// keeps them: each app connected here is then connected there once.
import { createHash } from "node:crypto";
import { z } from "zod";

import * as composio from "./composio.ts";
import { saveConfig, syncCredentialEnv, type AppConfig } from "./config.ts";

export type ComposioMode = "managed" | "own";

/** This server's connected-apps account, in digests: two servers reach the same apps exactly when `account` is equal. */
export interface ComposioIdentity {
  mode: ComposioMode;
  account: string;
  /** The managed service's installation, which a code from this computer is minted for. */
  installationId?: string;
  /** This installation acts as a user another installation shared with it. */
  shared: boolean;
  /** The apps connected now, as last read; absent until the first read. */
  apps?: string[];
}

const meSchema = z.object({ installationId: z.string().min(1), user: z.string().regex(/^[0-9a-f]{24}$/u).optional(), shared: z.boolean().optional() });
const IDENTITY_TTL_MS = 10 * 60_000;
const APPS_TTL_MS = 10 * 60_000;
const ownDigest = (userId: string) => createHash("sha256").update(`omb-composio-own:${userId}`).digest("hex").slice(0, 24);

let identity: { token: string; at: number; value: { installationId: string; user?: string; shared: boolean } } | null = null;
let apps: { key: string; at: number; slugs: string[] } | null = null;
let appsReading: Promise<void> | null = null;

/** Forgets what the managed service said about this installation, after it adopted a shared user. */
export function forgetComposioIdentity(): void {
  identity = null;
  apps = null;
}

async function brokerFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const access = composio.brokerAccess();
  if (!access) throw new Error("The connected-apps service is unavailable.");
  return fetch(`${access.url}${path}`, {
    ...init, redirect: "error", signal: AbortSignal.timeout(20_000),
    headers: { authorization: `Bearer ${access.token}`, ...(init.body ? { "content-type": "application/json" } : {}) },
  });
}

async function managedMe(): Promise<{ installationId: string; user?: string; shared: boolean } | null> {
  const access = composio.brokerAccess();
  if (!access) return null;
  if (identity && identity.token === access.token && Date.now() - identity.at < IDENTITY_TTL_MS) return identity.value;
  const response = await brokerFetch("/v1/me");
  if (!response.ok) { await response.body?.cancel(); return null; }
  const parsed = meSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) return null;
  const value = { installationId: parsed.data.installationId, ...(parsed.data.user ? { user: parsed.data.user } : {}), shared: parsed.data.shared === true };
  identity = { token: access.token, at: Date.now(), value };
  return value;
}

/** The apps connected now, read at most every ten minutes and never waited for: the first call starts the read. */
function connectedApps(cfg: AppConfig, key: string): string[] | undefined {
  const fresh = apps && apps.key === key && Date.now() - apps.at < APPS_TTL_MS;
  if (!fresh && !appsReading) {
    appsReading = composio.connectedServices(cfg)
      .then((services) => { apps = { key, at: Date.now(), slugs: Object.entries(services).filter(([, state]) => state.connected).map(([slug]) => slug).sort() }; })
      .catch(() => {})
      .finally(() => { appsReading = null; });
  }
  return apps?.key === key ? apps.slugs : undefined;
}

/** Null when this server has no connected-apps account, or the service is too old to share one. */
export async function composioIdentity(cfg: AppConfig): Promise<ComposioIdentity | null> {
  const mode = composio.connectionMode(cfg);
  if (mode === "self-hosted") {
    const userId = cfg.composio?.userId;
    return userId ? { mode: "own", account: `own:${ownDigest(userId)}`, shared: false, apps: connectedApps(cfg, `own:${userId}`) } : null;
  }
  if (mode !== "managed") return null;
  const me = await managedMe().catch(() => null);
  if (!me?.user) return null;
  return { mode: "managed", account: `managed:${me.user}`, installationId: me.installationId, shared: me.shared, apps: connectedApps(cfg, `managed:${me.user}`) };
}

/** A one-time code for that installation to act as this computer's Composio user. */
export async function composioShareCode(forInstallation: string): Promise<string> {
  const response = await brokerFetch("/v1/installation/share", { method: "POST", body: JSON.stringify({ for: forInstallation }) });
  const body = await response.json().catch(() => null) as { code?: unknown; error?: unknown } | null;
  if (!response.ok || typeof body?.code !== "string") throw new Error(typeof body?.error === "string" ? body.error : `The connected-apps service did not share them (HTTP ${response.status}).`);
  return body.code;
}

export type ShareOutcome = { shared: true } | { kept: true };

/** Adopts the code on this Cloud's installation; a Cloud with connected apps of its own keeps them. */
export async function adoptComposioShare(code: string): Promise<ShareOutcome> {
  const response = await brokerFetch("/v1/installation/adopt", { method: "POST", body: JSON.stringify({ code }) });
  const body = await response.json().catch(() => null) as { shared?: unknown; code?: unknown; error?: unknown } | null;
  if (response.ok && body?.shared === true) { forgetComposioIdentity(); return { shared: true }; }
  if (response.status === 409 && body?.code === "has_connections") return { kept: true };
  throw new Error(typeof body?.error === "string" ? body.error : `The connected-apps service did not share them (HTTP ${response.status}).`);
}

/** Saves this computer's own Composio project on this Cloud, for the same user, unless this Cloud already reaches
 * connected apps of its own. */
export async function adoptOwnComposio(cfg: AppConfig, apiKey: string, userId: string): Promise<ShareOutcome> {
  const current = cfg.composio;
  if (current?.apiKey?.trim()) return current.apiKey.trim() === apiKey.trim() && current.userId === userId ? { shared: true } : { kept: true };
  if (composio.connectionMode(cfg) === "managed") {
    const services = await composio.connectedServices(cfg);
    if (Object.values(services).some((state) => state.connected)) return { kept: true };
  }
  const prepared = await composio.prepareProjectSession(apiKey, { userId });
  saveConfig({ composio: prepared });
  syncCredentialEnv({ composio: prepared });
  cfg.composio = prepared;
  forgetComposioIdentity();
  return { shared: true };
}
