import type { IncomingMessage, ServerResponse } from "node:http";
import { featureEnabled } from "./features.ts";
import type { RequestAuth } from "./request-auth.ts";
import type { SessionRegistry } from "./sessions.ts";

export interface WorkspaceAccessOptions {
  sessions: SessionRegistry;
  cookieName: string;
  closeSessionStreams(sessionId: string): void;
  /** Whether the `admin` feature is on right now. */
  adminEnabled(): boolean;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface WorkspaceAccess {
  handlePublic(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>;
  authorize(req: IncomingMessage, auth: RequestAuth): Promise<{ status: 401 | 403 | 503; error: string } | null>;
  revalidate(): Promise<void>;
}

export type WorkspaceAccessFactory = (options: WorkspaceAccessOptions) => WorkspaceAccess;
let workspaceAccessFactory: WorkspaceAccessFactory | undefined;

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

/** For a hosted sign-in adapter compiled into this server; none ships with it. */
export function registerWorkspaceAccess(factory: WorkspaceAccessFactory | undefined): void {
  workspaceAccessFactory = factory;
}

/** A configured server without an adapter must refuse hosted access, never fall back to email or QR credentials. */
export function createWorkspaceAccess(options: Omit<WorkspaceAccessOptions, "adminEnabled">): WorkspaceAccess | null {
  if (!hostedWorkspaceConfigured(options.env)) return null;
  return workspaceAccessFactory?.({ ...options, adminEnabled: () => featureEnabled("admin") }) ?? null;
}
