// Who is signed in on this device, for the You menu. The list goes only to this app's own pages: this computer's and the
// rail's. A Cloud's or a server's page never reads it, because it would learn the addresses of the person's other accounts;
// it may only ask main, from the person's click, to open the sheet on the rail's page.
import { accountPlaces, clearPlaceStorage, withoutPlaces } from "./account-places.mjs";

/** The sign-in as the You menu shows it: never a token, and no account while none is signed in. */
export function accountsView(state) {
  const account = state?.account;
  if (!account?.id || state.status === "signed-out" || state.status === "connecting") return { active: null, others: [] };
  return { active: { id: account.id, email: account.email, ...(state.status === "reauth-required" ? { signIn: true } : {}) }, others: [] };
}

/** Everything of the account this window held. `places()` names them while the sign-in still says which Cloud is My Cloud:
 * a My Cloud saved by hand carries no other mark, and the sign-in names none once it has ended. `finish(left)`, once it has:
 * they leave the list, the window leaves them, and once nothing is still waiting on them (`settled`) their sessions go. */
export function createAccountLeave({ saved, persist, session, mine, leaveWindow, settled = async () => {}, log = () => {} }) {
  return {
    places: () => accountPlaces(saved(), mine()),
    async finish(left) {
      const next = withoutPlaces(saved(), left);
      if (next !== saved()) persist(next);
      await leaveWindow();
      await settled();
      await clearPlaceStorage(session(), left, log);
      return left;
    },
  };
}

/**
 * @param {{
 *   ipcMain: { handle(channel: string, handler: (event: unknown, ...args: any[]) => unknown): void },
 *   ownPage(event: unknown): boolean,
 *   placePage(event: unknown): boolean,
 *   account(): { state(): any } | null,
 *   client(): { state(): any, signOut(): Promise<any> },
 *   holdSheet(open: boolean): void,
 *   tellSheet(): void,
 *   leaving(): void,
 *   leave: ReturnType<typeof createAccountLeave>,
 *   show(): Promise<unknown>,
 *   tell(): void,
 * }} deps `ownPage`: this app's own page in the window, or the rail's. `placePage`: the page of a place of the person's own
 * or their team's, which may offer the sheet. `holdSheet`: the rail's page stays up for the sheet, even for someone who hid
 * the rail. `leaving`: the home window lets go of what it was doing for this account; `leave`: createAccountLeave's;
 * `show`: the window goes where it belongs now; `tell`: this app's pages read the list again.
 */
export function installAccounts({ ipcMain, ownPage, placePage, account, client, holdSheet, tellSheet, leaving, leave, show, tell }) {
  let sheetPending = false, queue = Promise.resolve();
  const view = () => accountsView(account()?.state());
  const serial = (work) => { const run = queue.then(work, work); queue = run.catch(() => {}); return run; };
  const own = (channel, handler) => ipcMain.handle(channel, (event, ...args) => {
    if (!ownPage(event)) throw new Error(`${channel} is only available on this app's own page`);
    return handler(...args);
  });
  const signOutActive = () => serial(async () => {
    leaving();
    const left = leave.places();
    const after = await client().signOut();
    await leave.finish(left);
    await show();
    tell();
    return after;
  });
  own("accounts:list", view);
  own("accounts:sign-out", async (id) => {
    if (view().active?.id !== id) throw new Error("That account isn't signed in here any more.");
    await signOutActive();
    return view();
  });
  own("accounts:sheet-pending", () => { const pending = sheetPending; sheetPending = false; return pending; });
  own("accounts:sheet-closed", () => { sheetPending = false; holdSheet(false); });
  ipcMain.handle("accounts:offered", (event) => placePage(event) === true);
  ipcMain.handle("accounts:open", (event) => {
    if (!placePage(event)) throw new Error("accounts:open is only available on a page of the person's own");
    sheetPending = true;
    holdSheet(true);
    tellSheet();
  });
  return { view, signOutActive, tell };
}
