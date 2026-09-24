// Neutral hook point for the source-available enterprise layer.
//
// The layer lives in enterprise/ (its own LICENSE) and is loaded only if that
// folder is present: delete it and this file still compiles, the server still
// starts, and /api/edition reports the open-source edition. Core never imports
// the layer statically; a build ships it as its own bundled file beside the
// server (see enterpriseLayerDirs for where it is looked up).
// The layer's only obligation is `register()`, which turns OMB_LICENSE_KEY into
// entitlements; core keeps the resulting status and answers `entitled()`.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RequestAuth } from "./request-auth.ts";
import type { SessionRegistry } from "./sessions.ts";

import { SERVER_ROOT } from "./proxy-paths.ts";

export interface EditionStatus {
  edition: "oss" | "enterprise";
  /** Enterprise only: who the license was issued to. */
  customer?: string;
  /** Entitlement ids the license grants (sorted). Empty for the open-source edition. */
  features: string[];
  /** Enterprise only: ISO date the license stops working, null for perpetual. */
  expiresAt?: string | null;
  /** Enterprise with an expiry only: whole days until `expiresAt`, counted
   * up; zero or negative once it has passed and the grace period runs. */
  expiresInDays?: number;
  /** Enterprise in its grace period only: when the features stop. */
  graceEndsAt?: string;
  /** Why the server is not running the enterprise edition although something
   * hinted it should, or, in the grace period, that the key needs renewing. */
  notice?: string;
}

/** What the enterprise layer's register() must return; validated because it is external code. */
const layerSchema = z.object({
  customer: z.string().min(1),
  features: z.array(z.string().min(1)),
  expiresAt: z.string().nullable(),
});

/** Days before expiry that the startup log, /api/edition and Settings start
 * saying so, and days after it that the features keep working while the
 * operator renews. The key and its verification are unchanged: the layer
 * accepts a key that expired less than the grace period ago. */
export const LICENSE_WARN_DAYS = 30;
export const LICENSE_GRACE_DAYS = 7;
const DAY_MS = 24 * 60 * 60_000;

/** Where the layer may be, in order. An explicit OMB_ENTERPRISE_DIR is the
 * only place looked at when set. Otherwise: beside the server root (a
 * checkout, where server/ and enterprise/ are siblings, and the npm package,
 * which copies the bundled layer to <package>/enterprise), then inside it
 * (the Docker image and the packaged desktop ship dist-server/ alone, and
 * scripts/bundle-server.mjs writes the layer to dist-server/enterprise). */
export function enterpriseLayerDirs(env: NodeJS.ProcessEnv = process.env, serverRoot: string = SERVER_ROOT): string[] {
  if (env.OMB_ENTERPRISE_DIR) return [env.OMB_ENTERPRISE_DIR];
  return [join(serverRoot, "..", "enterprise"), join(serverRoot, "enterprise")];
}

/** Source in a checkout, a compiled bundle in an image: same convention as proxy-paths.ts. */
function layerEntry(dir: string): string | undefined {
  return [join(dir, "server", "index.ts"), join(dir, "server", "index.js")].find((candidate) => existsSync(candidate));
}

let current: EditionStatus = { edition: "oss", features: [] };
let workspaceAccessFactory: ((options: WorkspaceAccessOptions) => WorkspaceAccess) | undefined;

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

/** Validate the operator's complete hosted configuration before any session
 * can delegate membership authority. A partial setting is never standalone. */
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

/** Who decides who may use this workspace, for Settings → People and
 * Remote access. On a portal-membership workspace the organisation's Admin
 * does, and `peopleUrl` opens its People page for this workspace (identifiers
 * only; Admin authorizes its own visitor). A hosted workspace never issues
 * pairing codes or email sign-in: people come in through the portal. */
export function workspaceMembership(env: NodeJS.ProcessEnv = process.env):
  { authority: "local" | "portal"; pairingCodes: boolean; peopleUrl?: string } {
  const hosted = hostedWorkspaceConfiguration(env);
  const pairingCodes = !hostedWorkspaceConfigured(env);
  if (!hosted?.portalMembership) return { authority: "local", pairingCodes };
  const people = new URL("/people", hosted.admin);
  people.search = new URLSearchParams({ workspace: hosted.workspace }).toString();
  return { authority: "portal", pairingCodes, peopleUrl: people.href };
}

/** An operator may authorize new Full tasks only on a dedicated,
 * portal-managed server. This is not an HTTP setting or a desktop grant. */
export function sharedWorkspaceFullAccessConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OMB_SHARED_WORKSPACE_FULL_ACCESS === "1" && env.OMB_DESKTOP_PARENT !== "1" &&
    hostedWorkspaceConfiguration(env)?.portalMembership === true;
}

/** No enterprise import or portal dependency enters the core bundle. A
 * configured server without this hook must refuse hosted access, not fall
 * back to legacy email or QR credentials. */
export function createWorkspaceAccess(options: Omit<WorkspaceAccessOptions, "entitled">): WorkspaceAccess | null {
  if (!hostedWorkspaceConfigured(options.env)) return null;
  return workspaceAccessFactory?.({ ...options, entitled: () => entitled("admin") }) ?? null;
}

function oss(notice?: string): EditionStatus {
  current = notice ? { edition: "oss", features: [], notice } : { edition: "oss", features: [] };
  return current;
}

/** Resolve the edition once at startup. Never throws: a broken layer or key
 * degrades to the open-source edition with a notice that says what to fix. */
export async function loadEnterpriseLayer(
  options: { dir?: string; licenseKey?: string; env?: NodeJS.ProcessEnv; serverRoot?: string } = {},
): Promise<EditionStatus> {
  workspaceAccessFactory = undefined;
  const dirs = options.dir ? [options.dir] : enterpriseLayerDirs(options.env, options.serverRoot);
  const licenseKey = options.licenseKey ?? process.env.OMB_LICENSE_KEY;
  const entry = dirs.map(layerEntry).find((candidate) => candidate !== undefined);
  if (!entry) {
    return oss(
      licenseKey ? `OMB_LICENSE_KEY is set but no enterprise layer exists at ${dirs.join(" or ")}` : undefined,
    );
  }
  try {
    const loaded: unknown = await import(pathToFileURL(entry).href);
    const access: unknown = Reflect.get(Object(loaded), "createWorkspaceAccess");
    if (typeof access === "function") workspaceAccessFactory = access as (options: WorkspaceAccessOptions) => WorkspaceAccess;
    const register: unknown = Reflect.get(Object(loaded), "register");
    if (typeof register !== "function") throw new Error(`${entry} does not export register()`);
    if (!licenseKey) return oss("enterprise layer present but OMB_LICENSE_KEY is not set");
    // graceDays is additive: a layer that ignores it refuses an expired key
    // at startup exactly as before.
    const registered: unknown = await register({ licenseKey, graceDays: LICENSE_GRACE_DAYS });
    const layer = layerSchema.parse(registered);
    current = {
      edition: "enterprise",
      customer: layer.customer,
      features: [...new Set(layer.features)].sort(),
      expiresAt: layer.expiresAt,
    };
    return current;
  } catch (error) {
    return oss(`enterprise layer disabled: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** When the key stops being valid, or null for perpetual / open-source. */
function expiryAt(): number | null {
  if (current.edition !== "enterprise" || !current.expiresAt) return null;
  const at = new Date(current.expiresAt).getTime();
  return Number.isFinite(at) ? at : null;
}

/** A license that expires while the server keeps running stops granting
 * features once its grace period ends, at that moment, not at the next restart. */
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
      notice: `enterprise layer disabled: OMB_LICENSE_KEY expired on ${current.expiresAt}; renew it to keep enterprise features`,
    };
  }
  const expiresInDays = Math.ceil((at - now) / DAY_MS);
  if (now < at) return { ...current, expiresInDays };
  const graceEndsAt = new Date(at + LICENSE_GRACE_DAYS * DAY_MS).toISOString().slice(0, 10);
  return {
    ...current,
    expiresInDays,
    graceEndsAt,
    notice: `OMB_LICENSE_KEY expired on ${current.expiresAt}; enterprise features keep working until ${graceEndsAt} while it is renewed`,
  };
}

/** The edition as a non-admin session sees it: what is entitled, without
 * the license's countdown, grace date or operator notice. */
export function editionForMembers(status: EditionStatus): EditionStatus {
  const { expiresInDays: _days, graceEndsAt: _grace, notice: _notice, ...shared } = status;
  return shared;
}

/** Feature gates in core ask this and nothing else. Unknown ids are simply not
 * granted, and the open-source edition always carries an empty feature list. */
export function entitled(feature: string, now: number = Date.now()): boolean {
  return !expired(now) && current.features.includes(feature);
}

/** The startup warning for a key that is about to lapse or already in its
 * grace period; null when there is nothing to say. */
export function licenseWarning(status: EditionStatus): string | null {
  if (status.edition !== "enterprise" || !status.expiresAt || status.expiresInDays === undefined) return null;
  if (status.graceEndsAt) {
    return `OMB_LICENSE_KEY expired on ${status.expiresAt}; enterprise features keep working until ${status.graceEndsAt} — renew the key before then`;
  }
  if (status.expiresInDays > LICENSE_WARN_DAYS) return null;
  const days = status.expiresInDays === 1 ? "1 day" : `${status.expiresInDays} days`;
  return `OMB_LICENSE_KEY expires on ${status.expiresAt} (in ${days}); renew it before then to keep enterprise features`;
}

/** One line for the startup log. */
export function describeEdition(status: EditionStatus): string {
  if (status.edition === "enterprise") {
    const until = status.expiresAt ? ` until ${status.expiresAt}` : "";
    return `openmausbot enterprise edition for ${status.customer}${until}: ${status.features.join(", ") || "no features"}`;
  }
  return `openmausbot open-source edition${status.notice ? ` (${status.notice})` : ""}`;
}
