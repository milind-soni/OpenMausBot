// Seats on a licensed server install, soft: when the people who can sign in (routes/seats.ts seatCount) would go past the
// licence's `seats`, a new invite is refused and admins see a banner. Nobody already in is locked out: removing someone,
// changing a role and saving the list as it is always work, and sign-in itself is never checked here. No licence, a
// licence without `seats`, a licence past its grace period, a desktop or a Cloud home: no limit.
import { parseAllowList, type SignInAllowList } from "./account-signin.ts";
import { licenseFilesUsed, licenseState } from "./enterprise.ts";

/** The count of people routes/seats.ts makes, now and with another sign-in list in place of this server's. */
export interface SeatSources {
  used(): number;
  usedWith(list: SignInAllowList): number;
}

let sources: SeatSources | null = null;

/** routes/seats.ts registers the server's one sign-in list and session registry when its route is made (null: none, for tests). */
export function registerSeatSources(next: SeatSources | null): void {
  sources = next;
}

/** How many people can sign in now; null before the server registered its sources. */
export function seatsInUse(): number | null {
  return sources ? sources.used() : null;
}

/** The licence's seats while it is in force (grace included) on a server that reads licence files; null: no limit. */
export function seatLimit(state = licenseState()): number | null {
  return licenseFilesUsed() && state.valid && state.seats !== null ? state.seats : null;
}

export interface SeatRefusal {
  seats: number;
  used: number;
}

/** Why saving `next` as the sign-in list is refused: it adds people, and the count after it would pass the licence's seats.
 * A list as long or shorter than before always passes, so a server already over its seats can still be tidied. Up to and
 * including `seats` people may sign in. */
export function seatInviteRefusal(next: { admins?: readonly string[]; members?: readonly string[] } | undefined): SeatRefusal | null {
  if (!next || !sources) return null;
  const limit = seatLimit();
  if (limit === null) return null;
  const used = sources.used();
  const after = sources.usedWith({ admins: parseAllowList(next.admins?.join(",")), members: parseAllowList(next.members?.join(",")) });
  return after > used && after > limit ? { seats: limit, used } : null;
}
