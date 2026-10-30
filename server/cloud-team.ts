// A Team Cloud: one Cloud machine several people use (docs/team-cloud.md). The Admin signs each person's pairing with a
// `member` claim; this file is what that claim becomes here: the session's scopes, a session that ends within the hour,
// and the lines the server says. The role words on the wire are the Admin's (`owner`, `admin`, `member`); the app shows
// Super admin, Admin and User.
import type { Scope } from "./sessions.ts";

export type TeamRole = "owner" | "admin" | "member";
export const TEAM_ROLES: readonly TeamRole[] = ["owner", "admin", "member"];

export interface CloudTeam {
  id: string;
  name: string;
  /** The team's default language from the Admin (OMB_CLOUD_TEAM_LANGUAGE), used while this server sets none. */
  language?: string;
}

export interface TeamMember {
  email: string;
  role: TeamRole;
}

export function isTeamRole(value: unknown): value is TeamRole {
  return typeof value === "string" && (TEAM_ROLES as readonly string[]).includes(value);
}

/** Owners and Admins get the admin scope; a Member only the client scope (what a hosted member has). */
export function teamRoleScopes(role: TeamRole): Scope[] {
  return role === "member" ? ["client"] : ["admin", "client"];
}

/** Membership is live on the Admin only, and the Admin checks it at each pairing. So a team session ends within the hour
 * of its pairing however much it is used, and the app pairs again: a removed member's next pairing is refused by the Admin. */
export const TEAM_SESSION_MAX_MS = 60 * 60_000;

export function teamSessionExpiresAt(createdAt: number, proposed: number): number {
  return Math.min(proposed, createdAt + TEAM_SESSION_MAX_MS);
}

/** The pairing body's `member` is one printable-ASCII address and one of the three roles; a `team` claim, when present,
 * must name this team. */
const MEMBER_EMAIL = /^[!-;=?A-~]{1,64}@[!-;=?A-~]{1,189}$/;
export type MemberClaimRefusal = "member_required" | "invalid_member" | "team_mismatch";

/** A member's address as a claim carries it (printable ASCII), lowercased; null for anything else. */
export function teamMemberEmail(value: unknown): string | null {
  return typeof value === "string" && value.length <= 254 && MEMBER_EMAIL.test(value) ? value.trim().toLowerCase() : null;
}

export function parseMemberClaim(body: Record<string, unknown>, team: CloudTeam): { ok: true; member: TeamMember } | { ok: false; error: MemberClaimRefusal } {
  const claimedTeam = body.team;
  if (claimedTeam !== undefined) {
    if (!claimedTeam || typeof claimedTeam !== "object" || Array.isArray(claimedTeam)) return { ok: false, error: "team_mismatch" };
    if ((claimedTeam as { id?: unknown }).id !== team.id) return { ok: false, error: "team_mismatch" };
  }
  const member = body.member;
  if (member === undefined) return { ok: false, error: "member_required" };
  if (!member || typeof member !== "object" || Array.isArray(member)) return { ok: false, error: "invalid_member" };
  const { email, role } = member as { email?: unknown; role?: unknown };
  if (typeof email !== "string" || email.length > 254 || !MEMBER_EMAIL.test(email) || !isTeamRole(role)) return { ok: false, error: "invalid_member" };
  return { ok: true, member: { email: email.trim().toLowerCase(), role } };
}

/** A member's own connection (a Composio share, an MCP sign-in, HighLevel) has no path into a team. */
export function personalConnectionRefusal(team: Pick<CloudTeam, "name">, what = "it"): string {
  return `Personal connections never enter ${team.name}. Ask an admin to connect ${what} for ${team.name}.`;
}

/** A computer's one-time move goes to its owner's My Cloud only: nothing personal is carried into a team. */
export function personalMoveRefusal(team: Pick<CloudTeam, "name">): string {
  return `Moving a computer's bots, chats and logins goes to My Cloud only. Nothing personal comes into ${team.name}.`;
}

/** On a team a login belongs to the whole team, so only an admin saves one. */
export function memberLoginRefusal(team: Pick<CloudTeam, "name">): string {
  return `On ${team.name} only an admin can save a login, and it is then used by every bot in ${team.name}.`;
}
