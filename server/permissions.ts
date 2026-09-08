// Permissions as data (phase 3 of docs/plans/2026-09-07-users-and-roles.md).
//
// A role is a name; a permission is a capability. This file is the catalog of
// capabilities and the map from each role to the ones it holds — the
// vocabulary a panel renders and, eventually, custom roles are built from.
//
// Enforcement still flows through the two scopes and requiredScope() in
// request-auth.ts: `admin` and `client` remain the wire contract every route
// and client already speaks. A permission projects onto a scope, so this
// layer describes the model precisely without a risky rewrite of the single
// chokepoint every one of the 64 routes passes through. When custom roles
// land, requiredScope() starts consulting this map instead of a literal
// allowlist; until then the projection keeps the two views in lockstep.
import type { Scope } from "./sessions.ts";
import type { Role } from "./users.ts";

export type Permission =
  | "chat" // talk to a bot, read its transcript
  | "bots.read" // see the fleet
  | "settings.write" // change engines, connectors, features
  | "users.manage" // create, disable, remove people
  | "devices.manage" // mint pairing codes, revoke sessions
  | "bots.manage" // create, configure and delete bots
  | "visibility.manage" // decide who may see which bot
  | "audit.read"; // read the human-action log

export interface PermissionInfo {
  id: Permission;
  /** The scope a holder of this permission must have. A route stays
   * client-reachable only if every permission it needs projects to `client`. */
  scope: Scope;
  label: string;
  description: string;
}

/** The catalog. Ordered least to most privileged, so a panel can render it
 * top to bottom. */
export const PERMISSIONS: readonly PermissionInfo[] = [
  { id: "chat", scope: "client", label: "Chat", description: "Message bots and read their conversations" },
  { id: "bots.read", scope: "client", label: "See bots", description: "See the bots they are allowed to see" },
  { id: "settings.write", scope: "admin", label: "Change settings", description: "Engines, connectors and experimental features" },
  { id: "bots.manage", scope: "admin", label: "Manage bots", description: "Create, configure and delete bots" },
  { id: "visibility.manage", scope: "admin", label: "Set bot visibility", description: "Decide who may see which bot" },
  { id: "users.manage", scope: "admin", label: "Manage people", description: "Create, disable and remove accounts" },
  { id: "devices.manage", scope: "admin", label: "Manage devices", description: "Pair devices and revoke sessions" },
  { id: "audit.read", scope: "admin", label: "Read the audit log", description: "See who did what, and when" },
];

const BY_ID = new Map(PERMISSIONS.map((p) => [p.id, p]));

/** The permissions each built-in role holds. `member` gets exactly the
 * client-scoped ones; `admin` gets everything. Custom roles (a later step)
 * pick from PERMISSIONS, and permissionsForRole reads their stored set. */
export const DEFAULT_ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  admin: PERMISSIONS.map((p) => p.id),
  member: PERMISSIONS.filter((p) => p.scope === "client").map((p) => p.id),
};

export function permissionsForRole(role: Role): readonly Permission[] {
  return DEFAULT_ROLE_PERMISSIONS[role] ?? DEFAULT_ROLE_PERMISSIONS.member;
}

/** The scopes a set of permissions projects onto — the bridge to the enforced
 * two-scope model. A permission list that includes any admin-scoped capability
 * yields the admin scope; every list yields client. Kept identical to
 * roleScopes(role) for the two built-in roles, by construction. */
export function scopesForPermissions(permissions: readonly Permission[]): Scope[] {
  const scopes = new Set<Scope>(["client"]);
  for (const id of permissions) {
    const info = BY_ID.get(id);
    if (info?.scope === "admin") scopes.add("admin");
  }
  return [...scopes];
}

/** What a route needs, when the day comes that requiredScope() consults this
 * map. Not wired into enforcement yet; here so the catalog and the routes are
 * described in one place. */
export function permissionInfo(id: Permission): PermissionInfo | undefined {
  return BY_ID.get(id);
}
