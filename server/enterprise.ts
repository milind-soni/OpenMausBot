// Neutral hook point for the source-available enterprise layer.
//
// The layer lives in ../enterprise (its own LICENSE) and is loaded only if that
// folder is present: delete it and this file still compiles, the server still
// starts, and /api/edition reports the open-source edition. Core never imports
// the layer statically, so the bundle and the packaged app carry no trace of it.
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
  /** Why the server is not running the enterprise edition although something hinted it should. */
  notice?: string;
}

/** What the enterprise layer's register() must return; validated because it is external code. */
const layerSchema = z.object({
  customer: z.string().min(1),
  features: z.array(z.string().min(1)),
  expiresAt: z.string().nullable(),
});

const DEFAULT_DIR = join(SERVER_ROOT, "..", "enterprise");

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
  options: { dir?: string; licenseKey?: string } = {},
): Promise<EditionStatus> {
  workspaceAccessFactory = undefined;
  const dir = options.dir ?? process.env.OMB_ENTERPRISE_DIR ?? DEFAULT_DIR;
  const licenseKey = options.licenseKey ?? process.env.OMB_LICENSE_KEY;
  // Source in a checkout, a compiled bundle in an image: same convention as proxy-paths.ts.
  const entry = [join(dir, "server", "index.ts"), join(dir, "server", "index.js")].find((candidate) => existsSync(candidate));
  if (!entry) {
    return oss(
      licenseKey ? `OMB_LICENSE_KEY is set but no enterprise layer exists at ${dir}` : undefined,
    );
  }
  try {
    const loaded: unknown = await import(pathToFileURL(entry).href);
    const access: unknown = Reflect.get(Object(loaded), "createWorkspaceAccess");
    if (typeof access === "function") workspaceAccessFactory = access as (options: WorkspaceAccessOptions) => WorkspaceAccess;
    const register: unknown = Reflect.get(Object(loaded), "register");
    if (typeof register !== "function") throw new Error(`${entry} does not export register()`);
    if (!licenseKey) return oss("enterprise layer present but OMB_LICENSE_KEY is not set");
    const registered: unknown = await register({ licenseKey });
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

/** A license that expires while the server keeps running stops granting
 * features at that moment, not at the next restart. */
function expired(now: number): boolean {
  if (current.edition !== "enterprise" || !current.expiresAt) return false;
  return now >= new Date(current.expiresAt).getTime();
}

export function editionStatus(now: number = Date.now()): EditionStatus {
  if (!expired(now)) return current;
  return {
    edition: "oss",
    features: [],
    notice: `enterprise layer disabled: OMB_LICENSE_KEY expired on ${current.expiresAt}; renew it to keep enterprise features`,
  };
}

/** Feature gates in core ask this and nothing else. Unknown ids are simply not
 * granted, and the open-source edition always carries an empty feature list. */
export function entitled(feature: string, now: number = Date.now()): boolean {
  return !expired(now) && current.features.includes(feature);
}

/** One line for the startup log. */
export function describeEdition(status: EditionStatus): string {
  if (status.edition === "enterprise") {
    const until = status.expiresAt ? ` until ${status.expiresAt}` : "";
    return `openmausbot enterprise edition for ${status.customer}${until}: ${status.features.join(", ") || "no features"}`;
  }
  return `openmausbot open-source edition${status.notice ? ` (${status.notice})` : ""}`;
}
