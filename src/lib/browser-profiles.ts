interface BrowserProfileUser {
  name: string;
  browserProfile?: string | null;
  busy?: boolean;
}

/** A live turn may still be issuing browser actions against this partition.
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
