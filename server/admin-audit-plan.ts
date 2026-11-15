import type { AdminActionRow } from "./admin-activity.ts";
import { requiredScope } from "./request-auth.ts";

type AuditedSession = { id: string; label: string; email?: string; scopes: string[]; view?: unknown };

/** A device signed out, or one whose view changed (which also takes its admin away). */
export function sessionAuditRows(before: AuditedSession | undefined, now: readonly AuditedSession[]): Array<Omit<AdminActionRow, "at" | "actor">> {
  if (!before) return [];
  const target = { kind: "session", id: before.id, name: before.email ?? before.label };
  const kept = now.find((session) => session.id === before.id);
  if (!kept) return [{ category: "session", action: "session.revoke", target, before: { label: before.label, ...(before.email ? { email: before.email } : {}), scopes: before.scopes } }];
  if (JSON.stringify(kept.view ?? null) === JSON.stringify(before.view ?? null)) return [];
  return [{ category: "session", action: "session.view", target, changed: ["view"],
    before: { scopes: before.scopes, view: before.view ?? "everything" }, after: { scopes: kept.scopes, view: kept.view ?? "everything" } }];
}

/** What an admin's write request changes, so the admin activity log can record it; null for reads and internal calls. */
export interface AuditPlan {
  config: boolean;
  botId?: string;
  createsBots: boolean;
  deletesBot?: string;
  createsWebhook: boolean;
  webhookId?: string;
  sessionId?: string;
  pairing: boolean;
  engineAction?: { id: string; action: string };
  roomId?: string;
}

const ACCOUNT_ADD_ENGINES = new Map([["/api/instances/claude-accounts", "claude"], ["/api/instances/chatgpt-accounts", "chatgpt"],
  ["/api/instances/antigravity-accounts", "antigravity"]]);

export function adminAuditPlan(method: string, path: string, sharedComputers: boolean): AuditPlan | null {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return null;
  if (path.startsWith("/api/internal/") || path.startsWith("/api/testing/")) return null;
  const plan: AuditPlan = {
    config: requiredScope(method, path, { sharedComputers }) === "admin",
    createsBots: method === "POST" && (path === "/api/bots" || path === "/api/teams/import" || path === "/api/org-library/add"),
    createsWebhook: method === "POST" && path === "/api/webhooks",
    pairing: method === "POST" && path === "/api/auth/pairing",
  };
  let m = /^\/api\/bots\/([\w-]+)(?:\/(always-allow|model|profile))?$/.exec(path);
  if (m && method === (m[2] === "always-allow" ? "POST" : "PATCH")) plan.botId = m[1];
  if (m && !m[2] && method === "DELETE") plan.deletesBot = m[1];
  m = /^\/api\/webhooks\/([\w-]+)(\/rotate)?$/.exec(path);
  if (m && ((m[2] && method === "POST") || (!m[2] && (method === "PATCH" || method === "DELETE")))) plan.webhookId = m[1];
  m = /^\/api\/auth\/sessions\/([\w-]+)$/.exec(path);
  if (m && (method === "DELETE" || method === "PATCH")) plan.sessionId = m[1];
  m = /^\/api\/groups\/([\w-]+)$/.exec(path);
  if (m && method === "PATCH") plan.roomId = m[1];
  m = /^\/api\/instances\/([\w.-]+)\/(install|auth\/complete|auth\/sign-out|claude-update|leftover-files\/remove)$/.exec(path);
  if (m && method === "POST") plan.engineAction = { id: m[1]!, action: m[2]!.replace("/", "-") };
  const accountAdd = method === "POST" ? ACCOUNT_ADD_ENGINES.get(path) : undefined;
  if (accountAdd) plan.engineAction = { id: accountAdd, action: "account-add" };
  return plan.config || plan.botId || plan.createsBots || plan.deletesBot || plan.createsWebhook || plan.webhookId || plan.sessionId || plan.pairing || plan.engineAction || plan.roomId ? plan : null;
}
