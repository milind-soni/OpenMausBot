import { t } from "./i18n";
import { randomUuid } from "./random-uuid";

interface BrowserProfileUser {
  name: string;
  browserProfile?: string | null;
  busy?: boolean;
}

interface BrowserProfileRecord {
  id: string;
  name: string;
  browser?: "chrome";
  partitionId?: string;
}

/** Partition routing is read-only: never reflect it through a config PATCH. */
export function browserProfilesForPatch(profiles: BrowserProfileRecord[]): Array<{ id: string; name: string; browser?: "chrome" }> {
  return profiles.map(({ id, name, browser }) => ({ id, name, ...(browser ? { browser } : {}) }));
}

/** Sends the list the person edited, so another window's changes cannot silently disappear. */
export function browserProfilesMutation(current: BrowserProfileRecord[], next: BrowserProfileRecord[]) {
  return {
    browserProfiles: browserProfilesForPatch(next),
    expectedBrowserProfiles: browserProfilesForPatch(current),
  };
}

export function newBrowserProfileId(): string {
  return `profile-${randomUuid().replaceAll("-", "")}`;
}

/** A live turn may still be acting on this partition: refuse deletion rather than race the wipe. */
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
