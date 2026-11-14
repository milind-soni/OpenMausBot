import { createHash } from "node:crypto";

import type { SessionRecord } from "./sessions.ts";

const hashed = (basis: string) => `p_${createHash("sha256").update(basis).digest("base64url").slice(0, 22)}`;

/** Hashed, so a message or a thread can carry it without handing other members a session id. */
export function personKey(session: Pick<SessionRecord, "id" | "email">): string {
  return hashed(session.email ? `email:${session.email.trim().toLowerCase()}` : `session:${session.id}`);
}

/** A person another app relays (the Slack worker's onBehalfOf): the key their own session would have, by email,
 * or one by name when the app knows no email. */
export function relayedPersonKey(person: { email?: string; name?: string }): string {
  return person.email ? personKey({ id: "", email: person.email }) : hashed(`name:${(person.name ?? "").trim()}`);
}

type DeviceSession = Pick<SessionRecord, "id" | "email" | "scopes" | "owner" | "teamRole" | "token">;

/** A server of one person's own (own-home.ts oneOwner), with that person's address when its sign-in list names one admin.
 * Null on any other server. */
export type OwnServer = { admin: string | null } | null;

/** Every full-access device of a server of one person's own, for shared computers only. */
export const OWN_SERVER_LENDER = hashed("lender:own-server-devices");

/** A device of the server's one person, with full access: paired without email, or signed in with the one admin's address.
 * Never a guest, a limited pairing, a team member, a script token or anyone else's email. */
function ownersDevice(session: DeviceSession, own: NonNullable<OwnServer>): boolean {
  if (session.owner || session.teamRole || session.token || !session.scopes.includes("admin")) return false;
  return !session.email || session.email.trim().toLowerCase() === own.admin;
}

/** Who lends and uses a shared computer on a self-hosted server. Each paired device and each email is its own person, so a
 * phone could never use the PC its owner's desktop lends: all of the one person's full-access devices count as one lender
 * there. Everyone else keeps their own key. Only where one person signs in. */
export function lendingPersonKey(session: DeviceSession, own: OwnServer): string {
  return own && ownersDevice(session, own) ? OWN_SERVER_LENDER : personKey(session);
}

/** The same for a person known only by the key on their message: the one admin's address, or a live full-access paired
 * device; otherwise (a revoked device, a guest, another relayed person) it stays as it is. */
export function lendingPerson(person: string | null, own: OwnServer, sessions: () => readonly DeviceSession[]): string | null {
  if (!person || !own) return person;
  if (own.admin !== null && person === personKey({ id: "", email: own.admin })) return OWN_SERVER_LENDER;
  return sessions().some((session) => !session.email && ownersDevice(session, own) && personKey(session) === person) ? OWN_SERVER_LENDER : person;
}
