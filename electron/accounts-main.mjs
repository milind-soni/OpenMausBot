// Who is signed in on this device, for the You menu. The list goes only to this app's own pages: this computer's and the
// rail's. A Cloud's or a server's page never reads it, because it would learn the addresses of the person's other accounts;
// it may only ask main, from the person's click, to open the sheet on the rail's page.
import { clearPlaceStorage, createPlaceStash, withoutAccountPlaces, withPlacesBack } from "./account-places.mjs";
import { createCloudAccounts } from "./cloud-accounts.mjs";

/** The accounts as the You menu shows them: never a token, and no active account while none is signed in. */
export function accountsView(state, others = []) {
  const account = state?.account;
  const active = account?.id && state.status !== "signed-out" && state.status !== "connecting"
    ? { id: account.id, email: account.email, ...(state.status === "reauth-required" ? { signIn: true } : {}) } : null;
  return { active, others: others.filter((row) => row.id !== active?.id) };
}

/** Everything of the account this window held: its places leave the list and wait in `keep` (or go, signing out), the window
 * leaves them, and their sessions go. */
export function createAccountLeave({ saved, persist, session, mine, leaveWindow, keep = () => {}, log = () => {} }) {
  return async (accountId = null) => {
    const { saved: next, left } = withoutAccountPlaces(saved(), mine());
    if (left.length) { keep(accountId, left); persist(next); }
    await leaveWindow();
    await clearPlaceStorage(session(), left, log);
    return left;
  };
}

/**
 * The accounts as main keeps them, made on first use, and what a change of account does to the rest of this app.
 * @param {{
 *   allowed(): boolean, active(): any, savedStore(): any, stash(): { read(): unknown, write(value: unknown): void }, client(): any, origin: string,
 *   makeClient(options: { store: any, onState(state: any): void }): any,
 *   saved(): any, persist(next: unknown): void, session(): any, mine(): string | null, leaveWindow(): unknown,
 *   holding(): string | null, letGo(accountId: string | null): void, settled(): Promise<unknown>, forgetLending(place: any): void, tell(): void, log?(line: string): void,
 * }} deps `letGo(id)`: what runs for that account in the window and for lending stops; `forgetLending(place)`: that place is off
 * this device with its account.
 */
export function createDesktopRing(deps) {
  let made = null, stash = null;
  const places = () => (stash ??= createPlaceStash(deps.stash()));
  const leave = createAccountLeave({ saved: deps.saved, persist: deps.persist, session: deps.session, mine: deps.mine, leaveWindow: deps.leaveWindow, keep: (id, left) => places().put(id, left), log: deps.log });
  const ring = () => {
    if (!deps.allowed()) return null;
    return made ??= createCloudAccounts({ active: deps.active(), saved: deps.savedStore(), client: deps.client, makeClient: deps.makeClient, origin: deps.origin, holding: deps.holding, settled: deps.settled, changed: deps.tell, log: deps.log,
      leaving: async (id) => { deps.letGo(id); await leave(id); },
      arriving: async (id) => { deps.persist(withPlacesBack(deps.saved(), places().take(id))); },
      removed: async (id) => { for (const place of places().take(id)) deps.forgetLending(place); } });
  };
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
 * }} deps `ownPage`: this app's own page in the window, or the rail's. `placePage`: the page of a place of the person's own
 * or their team's, which may offer the sheet. `ring`: the accounts kept on this device. `holdSheet`: the rail's page stays up
 * for the sheet, even for someone who hid the rail. `tell`: this app's pages read the list again.
 */
export function installAccounts({ ipcMain, ownPage, placePage, account, client, ring, holdSheet, tellSheet, tell }) {
  let sheetPending = false;
  const view = () => accountsView(account()?.state(), ring()?.others() ?? []);
  const answered = async (work) => {
    try { return { ...await work(), view: view() }; }
    catch { return { outcome: "failed", view: view() }; }
  };
  const own = (channel, handler) => ipcMain.handle(channel, (event, ...args) => {
    if (!ownPage(event)) throw new Error(`${channel} is only available on this app's own page`);
    return handler(...args);
  });
  const text = (value, max) => (typeof value === "string" ? value.slice(0, max) : "");
  own("accounts:list", view);
  own("accounts:switch", (id) => answered(() => ring().switchTo(text(id, 128))));
  own("accounts:sign-out", (id) => answered(() => ring().signOut(text(id, 128))));
  own("accounts:add-start", (email) => ring().addStart(text(email, 254)));
  own("accounts:add-verify", async (code) => {
    const result = await ring().addVerify(text(code, 16));
    return "email" in result || ["switched", "added", "already"].includes(result.outcome) ? { ...result, view: view() } : result;
  });
  own("accounts:add-browser", () => ring().addBrowser());
  own("accounts:add-reopen", () => ring().addReopen());
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
      if (outcome === "moving") throw new Error("This computer's bots are moving to the Cloud. Try again once that's done.");
      return client().state();
    },
  };
}
