// Main's side of a team the person joined (team-join.mjs): the team link from a launch, a URL or a second instance, and the
// landing of an invited person's first sign-in, with main's own dialog for the account that isn't in the team.
import { createTeamJoin, createTeamLanding, takeTeamLink, teamIdFromLink } from "./team-join.mjs";

/**
 * @param {{
 *   argv: string[],
 *   account(): any, addAccount(): Promise<unknown>, openTeam(team: { id: string, name: string }): Promise<unknown>,
 *   confirm(message: string, detail: string, button: string): Promise<boolean>, t(key: string, params?: Record<string, string>): string,
 *   reveal(): void, store: { read(): unknown, write(value: unknown): void }, ownPlace(): boolean, log(line: string): void,
 * }} deps `confirm`: main's own question dialog, true for `button`.
 */
export function installTeamJoin({ argv, account, addAccount, openTeam, confirm, t, reveal, store, ownPlace, log }) {
  const join = createTeamJoin({ account, addAccount, open: openTeam, reveal, log,
    ask: ({ email }) => confirm(t("native.teamLink.otherTitle"), t("native.teamLink.otherDetail", { email }), t("native.teamLink.signIn")) });
  const landing = createTeamLanding({ store, open: openTeam, ownPlace, log });
  const launched = takeTeamLink(argv);
  if (launched) join.request(launched, { launch: true });
  return {
    /** An `openmausbot://team/…` URL (macOS open-url): handled, true; anything else is left to the other handlers. */
    fromUrl(url) { const id = teamIdFromLink(url); return id ? join.request(id) : false; },
    /** A second instance's command line (Windows, Linux). */
    fromArgs(commandLine) { const id = takeTeamLink(commandLine); return id ? join.request(id) : false; },
    changed(state) { join.changed(state); landing.changed(state); },
    opened: (teamId) => landing.opened(teamId),
    ready: () => join.ready(),
  };
}
