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
    if (state?.status === "signed-out") { log("team link: signing in to open the team"); await client.begin(); return true; }
    if (state?.status === "reauth-required") { await client.signInAgain(); return true; }
    if (state?.status === "connecting") return true;
    // Joined a moment ago: the list is read again now, not at the next minute's check.
    state = await client.refresh().catch(() => client.state());
    if (await openIfListed(state)) return true;
    if (state?.status !== "connected" || want.asked || asking) return false;
    want.asked = true;
    asking = true;
    try {
      const email = state.account?.email ?? "";
      if (await ask({ kind: "other-account", email })) await addAccount();
      else wanted = null;
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
      if (!fresh()) return;
      void openIfListed(state).catch((error) => log(`team link: ${error?.message ?? error}`));
    },
    pending: () => fresh()?.teamId ?? null,
  };
}

/**
 * The team an invited person's account lands in (the session's `landing`: no Cloud of their own, invited into a team): opened
 * once on this device, the first time the session says so, so a new install signed in with the invited address shows the team
 * first, not an empty place or a plan to buy. Once the person opened that team here, by any way, it never moves the window again.
 * @param {{ store: { read(): unknown, write(value: unknown): void }, open(team: { id: string, name: string }): Promise<unknown>, log?(line: string): void }} deps
 * `store`: team-landing.json, the teams already opened here.
 */
export function createTeamLanding({ store, open, log = () => {} }) {
  const MAX = 50;
  const seen = () => {
    try { const kept = store.read(); return Array.isArray(kept?.teams) ? kept.teams.filter((id) => TEAM_ID.test(id)) : []; } catch { return []; }
  };
  const mark = (teamId) => {
    if (!TEAM_ID.test(teamId ?? "") || seen().includes(teamId)) return;
    try { store.write({ teams: [...seen(), teamId].slice(-MAX) }); } catch (error) { log(`team landing: could not keep it (${error?.message ?? error})`); }
  };
  return {
    changed(state) {
      const teamId = state?.status === "connected" ? state.landing?.teamId : null;
      if (!teamId || seen().includes(teamId)) return;
      const team = listed(state, teamId);
      if (!team) return;
      mark(teamId);
      void Promise.resolve().then(() => open({ id: team.id, name: team.name })).catch((error) => log(`team landing: ${error?.message ?? error}`));
    },
    /** The window went to this team, by any way: it is no landing any more. */
    opened: mark,
  };
}
