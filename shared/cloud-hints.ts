/** The onboarding hint a Cloud's welcome records when it is done: the app opens on the Chief's chat from then on. */
export const CLOUD_WELCOME_DONE = "cloud-welcome-done";

/** On a Team Cloud, the welcome's own record (shown, done, hidden) is each person's: one admin finishing it ends it for
 * nobody else. Its steps (an AI connected, files) stay the team's, since they are facts about the team's Cloud. */
export const TEAM_PERSONAL_HINTS: ReadonlySet<string> = new Set(["cloud-welcome-shown", CLOUD_WELCOME_DONE, "cloud-setup-hidden"]);

/**
 * The onboarding record one person on a team reads: the team's, without the welcome's own hints, plus theirs. The Owner
 * also keeps what the team's record already said, which was theirs before the record was per person.
 */
export function personalHints(teamHints: readonly string[], own: readonly string[], owner: boolean): string[] {
  return [...new Set([...teamHints.filter((hint) => owner || !TEAM_PERSONAL_HINTS.has(hint)), ...own.filter((hint) => TEAM_PERSONAL_HINTS.has(hint))])];
}
