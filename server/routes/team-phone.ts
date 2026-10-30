// "Open on your phone" on a Team Cloud: POST /api/team/phone-pairing makes a pairing code for the person signed in, and
// POST /api/auth/pairing does the same for a team session. The code carries that person's address and role, so the
// phone's session sees exactly what theirs does, and it ends within the hour of the Admin's last check of them. Off a
// team, and for a session the Admin never signed, both routes answer as before.
// GET /api/team/phones lists the phones those codes opened and DELETE /api/team/phones/<id> signs one out. Security:
// both are client-scoped, so visiblePhones is the gate: a member's own phones only; an owner's or admin's, everyone's.
import type { IncomingMessage } from "node:http";

import { phonePairingLink } from "../../shared/pairing-link.ts";
import { teamRoleScopes, type CloudTeam, type TeamMember } from "../cloud-team.ts";
import type { RequestAuth } from "../request-auth.ts";
import { formatPairingCode, type PublicSession, type SessionRecord, type SessionRegistry } from "../sessions.ts";
import { PASS, type RouteContext, type RouteHandler } from "./table.ts";

export const TEAM_PHONE_PAIRING_PATH = "/api/team/phone-pairing";
export const TEAM_PHONES_PATH = "/api/team/phones";
const PHONE_LABEL = "Phone";
const ONE_PHONE = /^\/api\/team\/phones\/([\w-]{1,128})$/;

/** A phone as the app lists it: its device name and the member it opens the team as. */
export interface TeamPhone {
  id: string;
  label: string;
  email: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
}

export interface TeamPhoneRouteDeps {
  team: CloudTeam | null;
  sessions: Pick<SessionRegistry, "openPairing" | "isLive" | "memberPhones" | "revoke">;
  /** The address a phone reaches this server at, for the code's link; null when it has none. */
  publicBase(req: IncomingMessage, auth: RequestAuth): string | null;
}

/** The member a team session was opened for, and when the Admin last vouched for them; null for any other session. */
export function sessionMember(session: Pick<SessionRecord, "membershipAuthority" | "email" | "teamRole" | "createdAt" | "memberCheckedAt">): { member: TeamMember; checkedAt: number } | null {
  if (session.membershipAuthority !== "team" || !session.email || !session.teamRole) return null;
  return { member: { email: session.email, role: session.teamRole }, checkedAt: session.memberCheckedAt ?? session.createdAt };
}

/** The phones `viewer` may see and remove: an owner's or admin's, everyone's; a member's, their own. */
export function visiblePhones(phones: readonly PublicSession[], viewer: TeamMember, scopes: readonly string[]): TeamPhone[] {
  const everyone = viewer.role !== "member" && scopes.includes("admin");
  return phones
    .filter((phone): phone is PublicSession & { email: string } => phone.email !== undefined && (everyone || phone.email === viewer.email))
    .map(({ id, label, email, createdAt, lastSeenAt, expiresAt }) => ({ id, label, email, createdAt, lastSeenAt, expiresAt }))
    .sort((a, b) => a.email.localeCompare(b.email) || a.createdAt - b.createdAt);
}

export function createTeamPhoneRoutes(deps: TeamPhoneRouteDeps): RouteHandler {
  return async (ctx) => {
    const one = ctx.method === "DELETE" ? ONE_PHONE.exec(ctx.path) : null;
    if (one || (ctx.method === "GET" && ctx.path === TEAM_PHONES_PATH)) return phones(deps, ctx, one?.[1] ?? null);
    return pairing(deps, ctx);
  };
}

async function phones(deps: TeamPhoneRouteDeps, { res, auth, json }: RouteContext, removing: string | null): Promise<typeof PASS | void> {
  const team = deps.team;
  if (!team) return PASS;
  const viewer = auth.kind === "session" ? sessionMember(auth.session) : null;
  if (!viewer || auth.kind !== "session") return json(res, 403, { error: `Sign in to ${team.name} in the app first.` });
  const listed = visiblePhones(deps.sessions.memberPhones(), viewer.member, auth.scopes);
  if (removing === null) return json(res, 200, { phones: listed, current: auth.session.id });
  if (!listed.some((phone) => phone.id === removing) || !deps.sessions.revoke(removing)) return json(res, 404, { error: "no such phone" });
  return json(res, 200, { ok: true });
}

async function pairing(deps: TeamPhoneRouteDeps, { req, res, path, method, auth, json }: RouteContext): Promise<typeof PASS | void> {
  if (method !== "POST" || (path !== TEAM_PHONE_PAIRING_PATH && path !== "/api/auth/pairing")) return PASS;
  const team = deps.team;
  if (!team) return PASS;
  const owner = auth.kind === "session" ? sessionMember(auth.session) : null;
  if (!owner || auth.kind !== "session") {
    return path === TEAM_PHONE_PAIRING_PATH ? json(res, 403, { error: `Sign in to ${team.name} in the app first.` }) : PASS;
  }
  if (!deps.sessions.isLive(auth.session.id)) return json(res, 401, { error: "Your session ended. Sign in again before creating a pairing code." });
  const scopes = teamRoleScopes(owner.member.role).filter((scope) => auth.scopes.includes(scope));
  if (!scopes.length) return json(res, 403, { error: `Sign in to ${team.name} in the app first.` });
  const opened = deps.sessions.openPairing({ scopes, label: PHONE_LABEL, member: owner.member, memberCheckedAt: owner.checkedAt });
  const base = deps.publicBase(req, auth);
  const code = formatPairingCode(opened.code);
  return json(res, 200, {
    id: opened.id,
    code,
    credential: opened.credential,
    expiresAt: opened.expiresAt,
    url: base ? `${base}/pair#code=${code}` : null,
    inviteUrl: base ? phonePairingLink({ address: base, token: opened.credential, name: team.name }) : null,
    serverName: team.name,
    team: { id: team.id, name: team.name, role: owner.member.role },
    hint: base ? null : "this server has no public address to put in a link: set OMB_PUBLIC_URL, or open /pair on the address you use and type the code",
  });
}
