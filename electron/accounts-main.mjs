// Who is signed in on this device, for the You menu: the account in use, by its address, and only on this app's own pages. The
// accounts that wait show on the rail (rail-accounts.mjs), whose page is the only one that learns their addresses. A Cloud's or a
// server's page never reads any of it; it may only ask main, from the person's click, to open the sheet on the rail's page.
import { accountPlaces, clearPlaceStorage, createPlaceStash, withoutPlaces, withPlacesBack } from "./account-places.mjs";
import { createCloudAccounts } from "./cloud-accounts.mjs";
import { accountRows } from "./rail-accounts.mjs";
import nativeText from "./native-text.cjs";

/** The sign-in as the You menu shows it: never a token, and no account while none is signed in. */
export function accountsView(state) {
  const account = state?.account;
  if (!account?.id || state.status === "signed-out" || state.status === "connecting") return { active: null };
  return { active: { id: account.id, email: account.email, ...(state.status === "reauth-required" ? { signIn: true } : {}) } };
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
 * The accounts as main keeps them, made on first use, and what a change of account does to the rest of this app.
 * @param {{
 *   allowed(): boolean, active(): any, savedStore(): any, stash(): { read(): unknown, write(value: unknown): void }, client(): any, origin: string,
 *   makeClient(options: { store: any, onState(state: any): void }): any,
 *   saved(): any, persist(next: unknown): void, session(): any, mine(): string | null, leaveWindow(): unknown, rows(): any[],
 *   holding(): string | null, letGo(accountId: string | null): void, lendingDone(): Promise<unknown>, settled(): Promise<unknown>, forgetLending(place: any): void, tell(): void, log?(line: string): void,
 * }} deps `letGo(id)`: what runs for that account in the window and for lending stops; `lendingDone`: lending's last requests have
 * been answered; `rows`: the rail as it is now, kept for while the account waits; `forgetLending(place)`: that place is off this
 * device with its account.
 */
export function createDesktopRing(deps) {
  let made = null, stash = null, leavingNow = null;
  const places = () => (stash ??= createPlaceStash(deps.stash()));
  const leave = createAccountLeave({ saved: deps.saved, persist: deps.persist, session: deps.session, mine: deps.mine, leaveWindow: deps.leaveWindow, settled: deps.lendingDone, log: deps.log });
  const ring = () => {
    if (!deps.allowed()) return null;
    return made ??= createCloudAccounts({ active: deps.active(), saved: deps.savedStore(), client: deps.client, makeClient: deps.makeClient, origin: deps.origin, holding: deps.holding, settled: deps.settled, changed: deps.tell, log: deps.log,
      naming: async () => { leavingNow = { left: leave.places(), rows: accountRows(deps.rows()) }; },
      leaving: async (id) => { deps.letGo(id); },
      left: async (id) => {
        const { left, rows } = leavingNow ?? { left: [], rows: [] };
        leavingNow = null;
        places().put(id, left, rows);
        await leave.finish(left);
      },
      arriving: async (id) => { deps.persist(withPlacesBack(deps.saved(), places().take(id).places)); },
      removed: async (id) => { for (const place of places().take(id).places) deps.forgetLending(place); } });
  };
  /** The accounts that wait, with their places as they were kept: for the rail's own page only. */
  ring.waiting = () => (ring()?.others() ?? []).map((row) => ({ ...row, ...places().peek(row.id) }));
  ring.close = () => made?.close();
  return ring;
}

/**
 * @param {{
 *   ipcMain: { handle(channel: string, handler: (event: unknown, ...args: any[]) => unknown): void },
 *   ownPage(event: unknown): boolean,
 *   placePage(event: unknown): boolean,
 *   account(): { state(): any } | null,
 *   client(): { state(): any, signOut(): Promise<any> },
 *   ring(): ReturnType<typeof import("./cloud-accounts.mjs").createCloudAccounts> | null,
 *   holdSheet(open: boolean): void,
 *   tellSheet(): void,
 *   tell(): void,
 *   t?(key: string, params?: Record<string, string | number>): string,
 * }} deps `ownPage`: this app's own page in the window, or the rail's. `placePage`: the page of a place of the person's own
 * or their team's, which may offer the sheet. `ring`: the accounts kept on this device. `holdSheet`: the rail's page stays up
 * for the sheet, even for someone who hid the rail. `tell`: this app's pages read the list again.
 */
export function installAccounts({ ipcMain, ownPage, placePage, account, client, ring, holdSheet, tellSheet, tell, t = nativeText.englishText.t }) {
  let sheetPending = false;
  const view = () => accountsView(account()?.state());
  const own = (channel, handler) => ipcMain.handle(channel, (event, ...args) => {
    if (!ownPage(event)) throw new Error(`${channel} is only available on this app's own page`);
    return handler(...args);
  });
  const text = (value, max) => (typeof value === "string" ? value.slice(0, max) : "");
  own("accounts:list", view);
  own("accounts:sign-out", async (id) => {
    try { return { ...await ring().signOut(text(id, 128)), view: view() }; }
    catch { return { outcome: "failed", view: view() }; }
  });
  own("accounts:add-start", (email) => ring().addStart(text(email, 254)));
  own("accounts:add-verify", async (code) => {
    const result = await ring().addVerify(text(code, 16));
    return "email" in result || ["switched", "added", "already"].includes(result.outcome) ? { ...result, view: view() } : result;
  });
  own("accounts:add-browser", () => ring().addBrowser());
  own("accounts:add-reopen", () => ring().addReopen());
  own("accounts:add-result", () => ring().addResult());
  own("accounts:add-cancel", () => ring().addCancel());
  own("accounts:sheet-pending", () => { const pending = sheetPending; sheetPending = false; return pending; });
  own("accounts:sheet-closed", () => { sheetPending = false; holdSheet(false); });
  ipcMain.handle("accounts:offered", (event) => placePage(event) === true);
  ipcMain.handle("accounts:open", (event) => {
    if (!placePage(event)) throw new Error("accounts:open is only available on a page of the person's own");
    sheetPending = true;
    holdSheet(true);
    tellSheet();
  });
  return {
    view,
    tell,
    /** Settings' Sign out, which is the You menu's: answers the sign-in's state. */
    async signOutActive() {
      const id = view().active?.id;
      if (!id) return client().signOut();
      const { outcome } = await ring().signOut(id);
      if (outcome === "moving") throw new Error(t("native.accounts.moving"));
      return client().state();
    },
  };
}
