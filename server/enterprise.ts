// Hook point for the source-available enterprise layer (enterprise/, under its own licence), loaded only when present:
// core never imports it statically. Its one obligation is `register()`, turning OMB_LICENSE_KEY into entitlements.
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
});

/** The layer accepts a key that expired less than the grace period ago. */
export const LICENSE_WARN_DAYS = 30;
export const LICENSE_GRACE_DAYS = 7;
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
  return current;
}

/** Never throws: a broken layer or key degrades to the open-source edition with a notice saying what to fix. */
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
    // A layer that ignores graceDays refuses an expired key at startup.
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
    return `OMB_LICENSE_KEY expired on ${status.expiresAt}; enterprise features keep working until ${status.graceEndsAt} — renew the key before then`;
  }
  if (status.expiresInDays > LICENSE_WARN_DAYS) return null;
  const days = status.expiresInDays === 1 ? "1 day" : `${status.expiresInDays} days`;
  return `OMB_LICENSE_KEY expires on ${status.expiresAt} (in ${days}); renew it before then to keep enterprise features`;
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
