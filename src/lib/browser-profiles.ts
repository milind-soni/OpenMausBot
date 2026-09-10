import { t } from "./i18n";

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

/** The UI selects profiles by canonical id, while Electron must receive the
 * immutable durable partition inherited from older releases. */
export function browserProfilePartitionId(
  profiles: BrowserProfileRecord[],
  profileId: string,
): string {
  return profiles.find((profile) => profile.id === profileId)?.partitionId ?? profileId;
}

/** Internal partition routing is read-only. Never reflect it through a config
 * PATCH, even though GET /api/config provides it to the trusted desktop UI. */
export function browserProfilesForPatch(profiles: BrowserProfileRecord[]): Array<{ id: string; name: string }> {
  return profiles.map(({ id, name }) => ({ id, name }));
}

/** Include the list the person edited so another window's changes cannot
 * silently disappear when this whole-list update reaches the server. */
export function browserProfilesMutation(current: BrowserProfileRecord[], next: BrowserProfileRecord[]) {
  return {
    browserProfiles: browserProfilesForPatch(next),
    expectedBrowserProfiles: browserProfilesForPatch(current),
  };
}

export function newBrowserProfileId(): string {
  return `profile-${crypto.randomUUID().replaceAll("-", "")}`;
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
    ? t("settings.profiles.busyOne", { names })
    : t("settings.profiles.busyMany", { names });
}
