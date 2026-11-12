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

/** Every full-access paired device of a server of one person's own, for shared computers only. */
export const PAIRED_DEVICES_LENDER = hashed("lender:full-access-paired-devices");

/** A device paired with full access and no email: not a guest, a limited pairing, a team member or a script token. */
function fullAccessPairedDevice(session: DeviceSession): boolean {
  return !session.email && !session.owner && !session.teamRole && !session.token && session.scopes.includes("admin");
}

/** Who lends and uses a shared computer on a self-hosted server. Without email sign-in each paired device is its own
 * person, so a phone could never use the PC its owner's desktop lends: all full-access paired devices count as one
 * lender there. Everyone else keeps their own key. Only where one person signs in (own-home.ts oneOwner). */
export function lendingPersonKey(session: DeviceSession, oneOwner: boolean): string {
  return oneOwner && fullAccessPairedDevice(session) ? PAIRED_DEVICES_LENDER : personKey(session);
}

/** The same for a person known only by the key on their message: only while that key belongs to a live full-access
 * paired device; otherwise (a revoked device, a guest, a relayed person) it stays as it is. */
export function lendingPerson(person: string | null, oneOwner: boolean, sessions: () => readonly DeviceSession[]): string | null {
  if (!person || !oneOwner) return person;
  return sessions().some((session) => fullAccessPairedDevice(session) && personKey(session) === person) ? PAIRED_DEVICES_LENDER : person;
}
