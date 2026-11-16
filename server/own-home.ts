// A server of one person's own (`openmausbot serve` on their VPS or Mac mini) can be their home, as My Cloud is: its owner
// moves a computer's bots into it, and that computer then works for it. Security: only where nobody else signs in, so no
// one else's bots or turns ever reach a computer lent this way, and never a Cloud, a team's Cloud or a hosted workspace.
import { nameFromEmail } from "../shared/bot-owner.ts";
import { movedFrom } from "./cloud-send-arrived.ts";
import type { OwnServer } from "./person-key.ts";
import type { RequestAuth } from "./request-auth.ts";
import type { SessionRecord } from "./sessions.ts";

export interface OwnServerFacts {
  /** A Cloud home, a team's Cloud or a hosted workspace: MausBot or an organization runs it, never one person. */
  managed: boolean;
  /** Others sign in here: a team, an organization's members, or members on the sign-in list. */
  shared: boolean;
  /** The sign-in list's admins: addresses, or "@domain" for everyone there. */
  admins: readonly string[];
}

/** Nobody but one person signs in here: no members, and at most one admin, named by address. */
export function oneOwner(facts: OwnServerFacts): boolean {
  if (facts.managed || facts.shared) return false;
  return facts.admins.length === 0 || (facts.admins.length === 1 && !facts.admins[0]!.startsWith("@"));
}

/** The request is that one person's own: an admin session, by the one admin's address when the sign-in list names one. A
 * paired device carries no address; only an admin pairs one, so it is theirs. */
export function ownServerOwner(facts: OwnServerFacts, auth: RequestAuth): boolean {
  if (!oneOwner(facts) || auth.kind !== "session" || !auth.scopes.includes("admin")) return false;
  const email = auth.session.email?.trim().toLowerCase();
  return !email || facts.admins.length === 0 || facts.admins[0] === email;
}

/** A device without an address is the one admin's only with full access (only an admin pairs one); a device that may only
 * chat, or a script token, may be anyone's. */
export function selfHostedPersonName(session: Pick<SessionRecord, "email" | "label" | "scopes" | "token">, admins: readonly string[], profile?: { name?: string; email?: string }): string {
  const email = session.email?.trim().toLowerCase();
  const soleAdmin = oneOwner({ managed: false, shared: false, admins });
  const theirs = email ? email === profile?.email?.trim().toLowerCase() || (soleAdmin && admins[0] === email) : soleAdmin && !session.token && session.scopes.includes("admin");
  return (theirs && profile?.name?.trim()) || (email ? nameFromEmail(email) : session.label.trim());
}

/** `facts()` is read on every ask, so a sign-in list changed in Settings counts at once. `here()`: this server took a move
 * from its owner (cloud-send-arrived.ts keeps where from), so it is their home and their computers work for it. */
export function createOwnHome({ facts, dataDir }: { facts(): OwnServerFacts; dataDir: string }) {
  return {
    owner: (auth: RequestAuth): auth is Extract<RequestAuth, { kind: "session" }> => ownServerOwner(facts(), auth),
    ownServer: (): OwnServer => { const known = facts(); return oneOwner(known) ? { admin: known.admins[0] ?? null } : null; },
    takesMove: () => oneOwner(facts()),
    here: () => oneOwner(facts()) && movedFrom(dataDir) !== null,
  };
}
