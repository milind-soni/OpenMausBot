// The accounts kept signed in on this device. One is active: its sign-in stays in the file an older app reads, in the same
// format, so nothing happens on an upgrade and a downgrade finds the active account as it was. The others wait in a file of
// their own (`saved`), which an older app never opens, and do nothing until one becomes active: no request, no timer.
//
// A switch writes in the order that loses nothing: at every step each token is in at least one file. An account found in
// both files after a crash is the active one.
//
// Security: tokens are read and written here and in cloud-account.mjs only, both files encrypted by the OS. What leaves this
// module for a page is an id and an address.
import { unreadableRecord } from "./managed-desktop.mjs";

const TOKEN = /^omc_[A-Za-z0-9_-]{43}$/;
const VERSION = 1;

const usable = (record, origin) => record?.origin === origin && TOKEN.test(record.token ?? "") && typeof record.account?.id === "string" && Boolean(record.account.id)
  && typeof record.account.email === "string" && typeof record.device?.id === "string" && Number.isSafeInteger(record.expiresAt);
const memoryStore = () => { let held = null; return { read: async () => held, write: async (value) => { held = value; }, held: () => held }; };

/**
 * @param {{
 *   active: { read(): Promise<any>, write(value: unknown): Promise<void> },
 *   saved: { read(): Promise<any>, write(value: unknown): Promise<void> },
 *   client(): { state(): any, quiesce(): void, reload(): Promise<any>, signOut(): Promise<any>, revokeSaved(record: unknown): Promise<void> },
 *   makeClient(options: { store: any, onState(state: any): void }): any,
 *   origin: string,
 *   holding?(): string | null,
 *   naming?(accountId: string | null): Promise<unknown>,
 *   leaving?(accountId: string | null): Promise<unknown>,
 *   left?(accountId: string | null): Promise<unknown>,
 *   arriving?(accountId: string): Promise<unknown>,
 *   settled?(): Promise<unknown>,
 *   removed?(accountId: string): Promise<unknown>,
 *   changed?(): void,
 *   now?(): number,
 *   log?(line: string): void,
 * }} deps `holding()`: why the active account can't be left now ("moving"), else null. `leaving(id)`: everything that was
 * running for that account stops. `naming(id)`, before anything else: its places are named and kept as the rail shows them, while its sign-in can still say which they are and how they look, which it can't once it is quiet. `left(id)`: those
 * places leave the list and the window, and their sessions go; a sign-out's comes after its sign-in ended, whose last answers can
 * re-issue a session. `arriving(id)`: what this device kept for that
 * account comes back, before its sign-in is read. `settled()`: the window goes where it belongs. `removed(id)`: that account
 * is off this device: what was kept for it goes. `makeClient`: a sign-in of its own for Add another account, which leaves the
 * active account running until it succeeds.
 */
export function createCloudAccounts({ active, saved, client, makeClient, origin, holding = () => null, naming = async () => {}, leaving = async () => {}, left = async () => {}, arriving = async () => {}, settled = async () => {}, removed = async () => {}, changed = () => {}, now = Date.now, log = () => {} }) {
  let rows = [], known = false, queue = Promise.resolve(), adder = null, browserResult = null;
  const serial = (work) => { const run = queue.then(work, work); queue = run.catch(() => {}); return run; };

  /** An unreadable file stays when the keychain is only locked (it throws here), and is replaced once it can never be read. */
  async function readSaved() {
    let raw;
    try { raw = await saved.read(); } catch (error) {
      if (!unreadableRecord(error)) throw error;
      log("accounts: the saved sign-ins could not be read and were dropped");
      known = true;
      return [];
    }
    known = true;
    if (raw === null || raw === undefined) return [];
    if (raw.v !== VERSION || !Array.isArray(raw.accounts)) throw new Error("These saved sign-ins are from a newer version.");
    return raw.accounts.filter((record) => usable(record, origin));
  }
  const activeId = () => { const state = client().state(); return ["signed-out", "connecting"].includes(state?.status) ? null : state?.account?.id ?? null; };
  const remember = (list, without = activeId()) => {
    rows = list.filter((record) => record.account.id !== without).map((record) => ({ id: record.account.id, email: record.account.email, ...(record.expiresAt <= now() ? { signIn: true } : {}) }));
  };
  const writeSaved = async (list, without) => {
    const seen = new Set(), kept = list.filter((record) => record.account.id !== without && !seen.has(record.account.id) && seen.add(record.account.id));
    await saved.write(kept.length ? { v: VERSION, accounts: kept } : null);
    remember(kept, without);
  };

  /** The account `next` becomes active; `keep`: the one active now stays signed in, waiting. */
  async function become(next, { list, keep = true }) {
    const leavingId = activeId();
    await naming(leavingId);
    const current = await active.read().catch(() => null);
    const waiting = keep && usable(current, origin) ? current : null;
    await saved.write({ v: VERSION, accounts: [...list.filter((record) => record.account.id !== waiting?.account.id), ...(waiting ? [waiting] : [])] });
    client().quiesce();
    // Whatever fails from here, the sign-in reads its file again and the window goes where it belongs: a client left quiet would
    // do nothing until the app restarts.
    try {
      await active.write(next);
      await writeSaved([...list, ...(waiting ? [waiting] : [])], next.account.id);
      await leaving(leavingId);
      await left(leavingId);
      await arriving(next.account.id);
    } finally {
      await client().reload().catch((error) => log(`accounts: ${error?.message ?? error}`));
      await settled().catch((error) => log(`accounts: ${error?.message ?? error}`));
      changed();
    }
  }

  async function switchTo(id) {
    if (activeId() === id) return { outcome: "switched" };
    const hold = holding();
    if (hold) return { outcome: hold };
    const list = await readSaved(), next = list.find((record) => record.account.id === id);
    if (!next) { remember(list); changed(); return { outcome: "gone" }; }
    if (next.expiresAt <= now()) return { outcome: "sign-in", email: next.account.email };
    await become(next, { list });
    return { outcome: "switched" };
  }

  /** Off this device: the token ends at the Admin (kept off this device even when it can't be told). The active account's
   * place goes to another that is still good; with none left, the app is signed out. */
  async function signOut(id) {
    const list = await readSaved();
    if (activeId() !== id) {
      const gone = list.find((record) => record.account.id === id);
      if (gone) {
        await writeSaved(list.filter((record) => record !== gone), activeId());
        await client().revokeSaved(gone).catch((error) => log(`accounts: signed out here only (${error?.message ?? error})`));
        await removed(id);
      }
      changed();
      return { outcome: "signed-out" };
    }
    const hold = holding();
    if (hold) return { outcome: hold };
    const next = list.find((record) => record.account.id !== id && record.expiresAt > now());
    const current = await active.read().catch(() => null);
    if (next) {
      await become(next, { list: list.filter((record) => record.account.id !== id), keep: false });
      if (usable(current, origin)) await client().revokeSaved(current).catch((error) => log(`accounts: signed out here only (${error?.message ?? error})`));
    } else {
      await naming(id);
      await leaving(id);
      await client().signOut();
      await left(id);
      await settled();
    }
    await removed(id);
    changed();
    return { outcome: "signed-out" };
  }

  /** The sign-in Add another account just finished: this account joins, active unless the move holds the switch. */
  async function joined(record, signIn) {
    const list = await readSaved(), id = record.account.id, email = record.account.email;
    const inUse = activeId() === id, kept = list.find((entry) => entry.account.id === id);
    // A sign-in that has ended here gives way to this one; one still good stays, and this one ends at once.
    const ended = inUse ? client().state().status === "reauth-required" : kept ? kept.expiresAt <= now() : true;
    if (!ended) {
      await signIn.signOut().catch(() => {});
      if (!inUse) await switchTo(id);
      return { outcome: inUse ? "already" : "switched", email };
    }
    const others = list.filter((entry) => entry !== kept);
    if (holding() && !inUse) {
      await writeSaved([...others, record], activeId());
      changed();
      return { outcome: "added", email };
    }
    await become(record, { list: others, keep: !inUse });
    return { outcome: "switched", email };
  }

  function endAdding() { adder?.client.close(); adder = null; }
  function startAdding() {
    endAdding();
    const store = memoryStore();
    const entry = { store, finished: null, client: null };
    entry.client = makeClient({ store, onState: (state) => {
      if (state?.status !== "connected" || !store.held() || adder !== entry || entry.finished) return;
      void finish(entry).catch((error) => { log(`accounts: ${error?.message ?? error}`); return { outcome: "failed" }; }).then((result) => { if (entry.browser) { browserResult = result; changed(); } });
    } });
    adder = entry;
    return entry;
  }
  /** Runs once per sign-in: the browser's way and the code's way both end here. */
  const finish = (entry) => (entry.finished ??= serial(async () => {
    try { return await joined(entry.store.held(), entry.client); }
    finally { if (adder === entry) endAdding(); }
  }));

  return {
    /** An account found in both files is the active one; with none active, the first still good takes its place. */
    start: () => serial(async () => {
      const list = await readSaved();
      remember(list);
      if (activeId() || !list.length) return;
      const current = await active.read().catch(() => undefined);
      if (current !== null) return;
      const next = list.find((record) => record.expiresAt > now());
      if (next) await become(next, { list, keep: false });
    }).catch((error) => log(`accounts: ${error?.message ?? error}`)),
    /** The others, as a page may see them: an id and an address. */
    others: () => rows.filter((row) => row.id !== activeId()),
    /** How many accounts are signed in on this device; more than one until that is known, so nothing that needs there to be
     * only one starts on a guess. */
    count: () => (known ? (activeId() ? 1 : 0) + rows.filter((row) => row.id !== activeId()).length : 2),
    email: (id) => (activeId() === id ? client().state()?.account?.email ?? null : rows.find((row) => row.id === id)?.email ?? null),
    switchTo: (id) => serial(() => switchTo(id)),
    signOut: (id) => serial(() => signOut(id)),
    addStart(email) {
      const entry = adder && !adder.finished ? adder : startAdding();
      return entry.client.emailStart(email);
    },
    async addVerify(code) {
      const entry = adder;
      if (!entry) return { outcome: "expired" };
      const result = await entry.client.emailVerify(code);
      if (result.outcome !== "signed-in") return result;
      return finish(entry);
    },
    /** Single sign-on, two-step, or the person asked: the browser approves it. The browser may be signed in to another
     * account: its own page says which, and lets them change it. */
    addBrowser() {
      const entry = startAdding();
      entry.browser = true;
      browserResult = null;
      return entry.client.begin().then((state) => ({ outcome: state.status === "connecting" ? "browser" : "failed", ...(state.enrollment ? { code: state.enrollment.userCode } : {}) }));
    },
    addReopen: () => adder?.client.reopen().then(() => {}) ?? Promise.resolve(),
    /** How the browser's way ended, once: that account is in use now, was kept while a move finishes, or was in use already, so
     * the sheet waiting on it can say so. */
    addResult() { const result = browserResult; browserResult = null; return result; },
    addCancel() { if (adder && !adder.finished) { const entry = adder; adder = null; void entry.client.cancel().catch(() => {}).finally(() => entry.client.close()); } },
    close() { endAdding(); },
  };
}
