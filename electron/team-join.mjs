// openmausbot://team/<team id>: the join page's Open in the MausBot app, after someone joined a team in their browser. An
// action, not a credential: it names a team by its id only, and the team is opened only as the Admin's verified session lists
// it for whoever is signed in here. Signed out, it starts this app's own browser sign-in (its device code never leaves main);
// signed in as someone the team isn't listed for, it says so and offers to sign in with another address. Another app that
// catches the link learns a team id and can do nothing with it.
export const TEAM_LINK_PREFIX = "openmausbot://team/";
/** The Admin's team ids. */
const TEAM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A link opened and waiting on a sign-in finishes it within this long, or is dropped. */
export const TEAM_JOIN_WAIT_MS = 30 * 60_000;

/** The team a link names, or null for anything but exactly `openmausbot://team/<team id>`. */
export function teamIdFromLink(value) {
  if (typeof value !== "string" || !value.startsWith(TEAM_LINK_PREFIX)) return null;
  const id = value.slice(TEAM_LINK_PREFIX.length);
  return TEAM_ID.test(id) ? id : null;
}

/** The last team link on a command line (a launch or a second instance on Windows and Linux), taken out so a relaunch
 * doesn't open it again. */
export function takeTeamLink(argv) {
  let found = null;
  for (let index = argv.length - 1; index >= 0; index--) {
    const id = teamIdFromLink(argv[index]);
    if (!id) continue;
    found ??= id;
    argv.splice(index, 1);
  }
  return found;
}

const listed = (state, teamId) => (state?.status === "connected" && Array.isArray(state.teams) ? state.teams.find((team) => team?.id === teamId) ?? null : null);

/**
 * @param {{
 *   account(): { state(): any, refresh(): Promise<any>, begin(): Promise<any>, signInAgain(): Promise<any> } | null,
 *   addAccount(): Promise<unknown>,
 *   open(team: { id: string, name: string }): Promise<unknown>,
 *   ask(question: { kind: "other-account", email: string }): Promise<boolean>,
 *   reveal(): void,
 *   now?(): number,
 *   log?(line: string): void,
 * }} deps `account()`: the MausBot Cloud sign-in, null where this app can't have one (a build run from source, or connected
 * to another computer). `addAccount()`: Add another account's browser sign-in, which keeps the one in use waiting.
 * `open(team)`: the team's Cloud in the window, as the rail opens it. `ask`: main's own dialog, never a page's.
 */
export function createTeamJoin({ account, addAccount, open, ask, reveal, now = Date.now, log = () => {} }) {
  let wanted = null, ready = false, asking = false;
  const fresh = () => (wanted && now() < wanted.until ? wanted : (wanted = null));
  async function openIfListed(state) {
    const want = fresh();
    const team = want ? listed(state, want.teamId) : null;
    if (!team) return false;
    wanted = null;
    await open({ id: team.id, name: team.name });
    return true;
  }
  async function deliver() {
    const want = fresh(), client = account();
    if (!ready || !want || !client) return false;
    let state = client.state();
    if (state?.status === "signed-out" && state.message === "restoring") return false;
    if (state?.status === "signed-out") { log("team link: signing in to open the team"); want.begun = true; await client.begin(); return true; }
    if (state?.status === "reauth-required") { want.begun = true; await client.signInAgain(); return true; }
    if (state?.status === "connecting") return true;
    // Joined a moment ago: the list is read again now, not at the next minute's check.
    state = await client.refresh().catch(() => client.state());
    if (await openIfListed(state)) return true;
    return askOther(want, state);
  }
  /** Signed in, and the team isn't listed for this account: said once, with the way to sign in with the other address. */
  async function askOther(want, state) {
    if (state?.status !== "connected" || want.asked || asking) return false;
    want.asked = true;
    asking = true;
    try {
      const email = state.account?.email ?? "";
      if (await ask({ kind: "other-account", email })) await addAccount();
      else if (wanted === want) wanted = null;
    } finally { asking = false; }
    return true;
  }
  return {
    /** A link arrived: the team it names opens once someone it is listed for is signed in here. `launch`: the link this app
     * was started with, which waits for `ready` without showing anything yet. */
    request(teamId, { launch = false } = {}) {
      if (!TEAM_ID.test(teamId ?? "")) return false;
      wanted = { teamId, until: now() + TEAM_JOIN_WAIT_MS };
      if (launch) return true;
      reveal();
      void deliver().catch((error) => log(`team link: ${error?.message ?? error}`));
      return true;
    },
    /** The app can show a window and has read its sign-in: a link from the launch goes now. */
    ready() {
      ready = true;
      return deliver().catch((error) => { log(`team link: ${error?.message ?? error}`); return false; });
    },
    /** The sign-in changed (a sign-in finished, another account became the one in use): the waiting team opens once listed. */
    changed(state) {
      const want = fresh();
      if (!want) return;
      void openIfListed(state).then((opened) => {
        // The sign-in this link started finished as an account the team isn't listed for: say so, never just nothing.
        if (!opened && want.begun && state?.status === "connected") { want.begun = false; return askOther(want, state); }
      }).catch((error) => log(`team link: ${error?.message ?? error}`));
    },
    pending: () => fresh()?.teamId ?? null,
  };
}

/**
 * The team an invited person's account lands in (the session's `landing`: no Cloud of their own, invited into a team). The
 * window moves there only on a sign-in this app just saw, the first on this device, with no place of the person's own in
 * use; then once. Any other time the team is in the rail and the window stays where it is.
 * @param {{ store: { read(): unknown, write(value: unknown): void }, open(team: { id: string, name: string }): Promise<unknown>,
 *   ownPlace(): boolean, log?(line: string): void }} deps `store`: team-landing.json, the accounts signed in here before and the
 * teams already opened here. `ownPlace()`: My Cloud or another place of the person's own is what the window shows.
 */
export function createTeamLanding({ store, open, ownPlace, log = () => {} }) {
  const MAX = 50, ACCOUNT = /^[\w-]{1,128}$/;
  let signingIn = false;
  const kept = () => {
    try {
      const value = store.read();
      return { teams: Array.isArray(value?.teams) ? value.teams.filter((id) => TEAM_ID.test(id)) : [], accounts: Array.isArray(value?.accounts) ? value.accounts.filter((id) => ACCOUNT.test(id)) : [] };
    } catch { return { teams: [], accounts: [] }; }
  };
  const save = (next) => { try { store.write(next); } catch (error) { log(`team landing: could not keep it (${error?.message ?? error})`); } };
  const mark = (teamId) => {
    const now = kept();
    if (TEAM_ID.test(teamId ?? "") && !now.teams.includes(teamId)) save({ ...now, teams: [...now.teams, teamId].slice(-MAX) });
  };
  return {
    changed(state) {
      if (state?.status === "connecting" || (state?.status === "signed-out" && state.message !== "restoring")) { signingIn = true; return; }
      if (state?.status !== "connected" || !state.account?.id) return;
      const justSignedIn = signingIn, before = kept();
      signingIn = false;
      if (!before.accounts.includes(state.account.id)) save({ ...before, accounts: [...before.accounts, state.account.id].slice(-MAX) });
      const teamId = state.landing?.teamId;
      if (!justSignedIn || before.accounts.length || !teamId || before.teams.includes(teamId) || ownPlace()) return;
      const team = listed(state, teamId);
      if (!team) return;
      mark(teamId);
      void Promise.resolve().then(() => open({ id: team.id, name: team.name })).catch((error) => log(`team landing: ${error?.message ?? error}`));
    },
    /** The window went to this team, by any way: it is no landing any more. */
    opened: mark,
  };
}
