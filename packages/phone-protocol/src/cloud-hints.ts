/** The onboarding hint a Cloud's welcome records when it is done: the app opens on the Chief's chat from then on. */
export const CLOUD_WELCOME_DONE = "cloud-welcome-done";

/** A team session that ended because its person is no longer in the team (removed, or they left): the session read says so,
 * and the page says "You're no longer in <team>." instead of offering a sign-in that can't work. */
export const TEAM_LEFT_REFUSAL = "unauthorized: you are no longer in this team";

/** On a Team Cloud, the welcome's own record (shown, done, hidden) is each person's: one admin finishing it ends it for
 * nobody else. Its steps (an AI connected, files) stay the team's, since they are facts about the team's Cloud. So is
 * whether they saw the Teams What's new (src/lib/notices.ts TEAMS_NOTICE). */
export const TEAM_PERSONAL_HINTS: ReadonlySet<string> = new Set(["cloud-welcome-shown", CLOUD_WELCOME_DONE, "cloud-setup-hidden", "teams-2026-11b"]);

/** When the person last opened Announcements, in epoch milliseconds: `announcements-read-<ms>`. A record keeps one, the
 * newest; on a Team Cloud it is each person's. */
export const ANNOUNCEMENTS_READ_HINT = /^announcements-read-(\d{1,16})$/;

export function teamPersonalHint(hint: string): boolean {
  return TEAM_PERSONAL_HINTS.has(hint) || ANNOUNCEMENTS_READ_HINT.test(hint);
}

/** The newest `announcements-read-<ms>` among `hints`, or null. */
export function announcementsReadAt(hints: readonly string[]): number | null {
  let newest: number | null = null;
  for (const hint of hints) {
    const at = Number(ANNOUNCEMENTS_READ_HINT.exec(hint)?.[1] ?? NaN);
    if (Number.isSafeInteger(at) && (newest === null || at > newest)) newest = at;
  }
  return newest;
}

/** `hints` keeping only the newest read mark among them. */
export function newestReadMarkOnly(hints: readonly string[]): string[] {
  const newest = announcementsReadAt(hints);
  return hints.filter((hint) => !ANNOUNCEMENTS_READ_HINT.test(hint) || hint === `announcements-read-${newest}`);
}

/**
 * The onboarding record one person on a team reads: the team's, without the welcome's own hints, plus theirs. The Owner
 * also keeps what the team's record already said, which was theirs before the record was per person.
 */
export function personalHints(teamHints: readonly string[], own: readonly string[], owner: boolean): string[] {
  return newestReadMarkOnly([...new Set([...teamHints.filter((hint) => owner || !teamPersonalHint(hint)), ...own.filter(teamPersonalHint)])]);
}
