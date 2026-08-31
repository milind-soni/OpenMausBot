interface BrowserProfileUser {
  name: string;
  browserProfile?: string | null;
  busy?: boolean;
}

interface BrowserProfileRecord {
  id: string;
  name: string;
  partitionId?: string;
}

/** Ids are derived from the name so config stays readable, and "guest" is
 * reserved for the throwaway session every bot can fall back to. */
export function browserProfileIdFor(name: string, taken: BrowserProfileRecord[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "profile";
  let candidate = base;
  for (let n = 2; candidate === "guest" || taken.some((profile) => profile.id === candidate); n += 1) {
    candidate = `${base}-${n}`;
  }
  return candidate;
}

/** Internal partition routing is read-only. Never reflect it through a config
 * PATCH, even though GET /api/config provides it to the trusted desktop UI. */
export function browserProfilesForPatch(profiles: BrowserProfileRecord[]): Array<{ id: string; name: string }> {
  return profiles.map(({ id, name }) => ({ id, name }));
}

/** A live turn may still be issuing browser actions against this profile.
 * Refuse deletion until those turns are stopped rather than racing the wipe. */
export function browserProfileDeletionBlockReason(
  bots: BrowserProfileUser[],
  profileId: string,
): string | null {
  const running = bots.filter((bot) => bot.browserProfile === profileId && bot.busy);
  if (!running.length) return null;
  const names = running.map((bot) => bot.name).join(", ");
  return running.length === 1
    ? `${names} is still running. Stop that bot before deleting this browser profile.`
    : `${names} are still running. Stop those bots before deleting this browser profile.`;
}
