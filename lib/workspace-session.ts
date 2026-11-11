import { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

// Request-scoped access to Convex for API routes. Nothing here outlives a request except the HTTP client, which holds
// no session: every call passes the caller's session token and Convex checks it.

type SessionUser = { _id: Id<"users">; name: string; username?: string; email: string; avatarUrl?: string | null; role?: string };
export type WorkspaceUser = SessionUser & { teamId: Id<"teams">; workspaceRole: string; slug: string };

let convexClient: ConvexHttpClient | null = null;
export function getConvexClient() {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) throw new Error("Backend unavailable");
  convexClient ??= new ConvexHttpClient(url);
  return convexClient;
}

export function sessionTokenFromRequest(request: Request, body?: { sessionToken?: unknown }) {
  const auth = request.headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return typeof body?.sessionToken === "string" ? body.sessionToken : "";
}

// Convex can briefly answer with a generic 500; retry those instead of failing call signaling.
export async function withRetry<T>(run: () => Promise<T>) {
  for (let attempt = 0; ; attempt++) {
    try { return await run(); }
    catch (error) {
      const transient = error instanceof Error && /InternalServerError|Overloaded|fetch failed|ECONNRESET|ETIMEDOUT/.test(error.message);
      if (!transient || attempt === 2) { if (transient) console.error("Convex request failed after retries:", error.message); throw error; }
      await new Promise(resolve => setTimeout(resolve, 200 * (attempt + 1)));
    }
  }
}

export async function requireLocalUser(sessionToken: string) {
  if (!sessionToken) throw new Error("Your session has expired. Sign in again.");
  const user = await withRetry(() => getConvexClient().query(api.auth.me, { sessionToken })) as SessionUser | null;
  if (!user) throw new Error("Your session has expired. Sign in again.");
  return user;
}

/** The session token, workspace and (for chat) conversation a request names; Convex checks access on every call. */
export function workspaceScope(request: Request, body?: { sessionToken?: unknown; teamId?: unknown; conversation?: unknown }) {
  const params = new URL(request.url).searchParams;
  const sessionToken = sessionTokenFromRequest(request, body);
  const teamId = params.get("teamId") || (typeof body?.teamId === "string" ? body.teamId : "");
  if (!sessionToken) throw new Error("Your session has expired. Sign in again.");
  if (!teamId) throw new Error("Workspace required");
  const conversation = params.get("conversation") || (typeof body?.conversation === "string" ? body.conversation : "");
  return { sessionToken, teamId: teamId as Id<"teams">, ...(conversation ? { conversation } : {}) };
}

export async function requireLocalWorkspace(request: Request, body?: { sessionToken?: unknown; teamId?: unknown }): Promise<WorkspaceUser> {
  const { sessionToken, teamId } = workspaceScope(request, body);
  const [user, access] = await Promise.all([
    requireLocalUser(sessionToken),
    withRetry(() => getConvexClient().query(api.workspaces.access, { sessionToken, teamId })),
  ]);
  return { ...user, teamId: access.teamId, workspaceRole: access.role, slug: access.slug };
}
