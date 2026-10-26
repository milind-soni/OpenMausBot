// The one-time "Get MausBot updates?" question: this computer's answer, kept in desktop-prefs.json before anything is
// sent, and the MausBot Cloud Admin's consent record (account or email-only), kept in step with it.
import { cleanEmail } from "./cloud-signin.mjs";

/** The consent wording shown, by version: the Admin keeps the version with each answer as proof of what was asked. */
export const UPDATES_CONSENT_VERSION = "2026-10-23";
export const UPDATES_CONSENT_STATUSES = Object.freeze(["opted_in", "declined", "withdrawn"]);
const VERSION = /^[0-9a-z][0-9a-z.-]{0,39}$/;
const RECEIPT = /^[A-Za-z0-9_-]{43}$/;
// oxlint-disable-next-line no-control-regex
const text = (value, max) => typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const STATE_WAIT_MS = 8_000;

/**
 * The record kept on this computer. `account`: the MausBot Cloud account the answer belongs to (given while signed in,
 * or carried over to it). `email`: typed while signed out. `receipt`: the Admin's handle for that email-only answer,
 * the only way this computer can withdraw it. `pending`: the Admin has not recorded it yet.
 */
export function parseUpdatesConsent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (!UPDATES_CONSENT_STATUSES.includes(value.status) || !VERSION.test(value.version ?? "") || !Number.isSafeInteger(value.at) || value.at <= 0) return null;
  const email = cleanEmail(value.email);
  return {
    status: value.status, version: value.version, at: value.at,
    ...(text(value.account, 128) ? { account: value.account } : {}),
    ...(email ? { email } : {}),
    ...(typeof value.receipt === "string" && RECEIPT.test(value.receipt) ? { receipt: value.receipt } : {}),
    ...(value.pending === true ? { pending: true } : {}),
  };
}

/** The Admin's answer for an account: null while it has no recorded choice. Anything else unreadable throws. */
export function parseAccountConsent(result) {
  if (result?.cloudContractVersion !== 1 || !("consent" in result)) throw new Error("Invalid Cloud consent response.");
  if (result.consent === null) return null;
  const { status, textVersion } = result.consent ?? {};
  if (!UPDATES_CONSENT_STATUSES.includes(status) || !VERSION.test(textVersion ?? "")) throw new Error("Invalid Cloud consent response.");
  return { status, textVersion };
}

/**
 * `account()`: the Cloud account client (cloud-account.mjs), or null where there is none. `available()`: this app may
 * ask at all (the installed app, not a branded build). A failure to reach the Admin never loses an answer: it stays
 * `pending` and is sent again on the next launch, sign-in or look at Settings.
 */
export function createUpdatesConsent({ prefs, account, available, now = Date.now, onChange = () => {} }) {
  let running = null, choices = 0;
  const client = () => account();
  const signedIn = () => {
    const current = client()?.state();
    return current?.status === "connected" && current.account ? current.account : null;
  };
  const save = record => { prefs.setUpdatesConsent(record); onChange(); };

  async function signedOutSync(local, sameAnswer) {
    if (!local?.pending || local.account) return;
    if (local.status === "opted_in" && local.email) {
      const receipt = await client().updatesConsentByEmail({ email: local.email, installId: prefs.installId(), textVersion: local.version });
      if (sameAnswer()) return save({ ...local, receipt, pending: false });
      const latest = prefs.updatesConsent();
      const sendsItsOwnOptIn = latest?.status === "opted_in" && latest.email;
      if (latest && !latest.account && !latest.receipt && !sendsItsOwnOptIn) save({ ...latest, receipt });
    } else if (local.status !== "opted_in" && local.receipt) {
      await client().withdrawUpdatesConsent({ status: local.status, receipt: local.receipt });
      if (sameAnswer()) save({ ...local, pending: false });
    } else save({ ...local, pending: false });
  }

  async function reconcile(sameAnswer, fresh) {
    const keep = record => { if (fresh()) save(record); };
    if (!client() || !await available()) return;
    const local = prefs.updatesConsent(), who = signedIn();
    if (!who) return signedOutSync(local, sameAnswer);
    if (local?.pending && local.account === who.id) {
      await client().recordUpdatesConsent(local.status, local.version);
      keep({ ...local, pending: false });
      return;
    }
    const remote = parseAccountConsent(await client().updatesConsent());
    if (remote) {
      if (local?.status !== remote.status || local.account !== who.id || local.pending)
        keep({ status: remote.status, version: remote.textVersion, at: now(), account: who.id, ...(local?.email ? { email: local.email } : {}) });
      return;
    }
    if (!local) return;
    await client().recordUpdatesConsent(local.status, local.version);
    keep({ ...local, account: who.id, pending: false });
  }

  async function settle() {
    for (;;) {
      const answer = choices, who = signedIn()?.id ?? null;
      const sameAnswer = () => choices === answer;
      const fresh = () => sameAnswer() && (signedIn()?.id ?? null) === who;
      try { await reconcile(sameAnswer, fresh); } catch (error) { if (fresh()) throw error; }
      if (fresh()) return;
    }
  }

  const sync = () => running ??= settle().finally(() => { running = null; });

  const snapshot = () => {
    const local = prefs.updatesConsent(), who = signedIn();
    return { available: true, due: !local, status: local?.status ?? null, signedIn: Boolean(who),
      email: who?.email ?? (local?.status === "opted_in" ? local.email ?? null : null), version: UPDATES_CONSENT_VERSION };
  };

  async function state() {
    if (!client() || !await available()) return { available: false, due: false, status: null, signedIn: false, email: null, version: UPDATES_CONSENT_VERSION };
    await Promise.race([sync().catch(() => {}), new Promise(resolve => setTimeout(resolve, STATE_WAIT_MS).unref?.())]);
    return snapshot();
  }

  async function choose(input) {
    const status = input?.status;
    if (!UPDATES_CONSENT_STATUSES.includes(status)) throw new Error("Choose opted_in, declined or withdrawn.");
    if (!client() || !await available()) throw new Error("Product updates are not available in this app.");
    const typed = input.email === undefined || input.email === null || input.email === "" ? null : cleanEmail(input.email);
    if (input.email && !typed) throw new Error("Enter a valid email address.");
    const who = signedIn(), previous = prefs.updatesConsent();
    const email = !who && status === "opted_in" ? typed ?? previous?.email ?? null : previous?.email ?? null;
    const newEmail = status === "opted_in" && email !== null;
    choices++;
    save({ status, version: UPDATES_CONSENT_VERSION, at: now(), pending: true,
      ...(who ? { account: who.id } : {}), ...(email ? { email } : {}),
      ...(!who && previous?.receipt && !newEmail ? { receipt: previous.receipt } : {}) });
    await sync().catch(() => {});
    return snapshot();
  }

  let lastAccount = null;
  /** The Cloud client's state changed: a newly signed-in account gets this computer's answer, or gives its own. */
  function accountChanged(current) {
    const id = current?.status === "connected" ? current.account?.id ?? null : null;
    if (id === lastAccount) return;
    lastAccount = id;
    if (id) void sync().catch(() => {});
  }

  return { state, choose, sync, accountChanged };
}

/** `page(event)` as desktop-prefs.mjs reads it: only this computer's page and My Cloud's own page may ask or answer. */
export function registerUpdatesConsent({ ipcMain, page, consent }) {
  const from = (channel, handler) => (event, ...args) => {
    if (!["local", "cloud"].includes(page(event))) throw new Error(`${channel} is only available in this app's window`);
    return handler(...args);
  };
  ipcMain.handle("updates-consent:state", from("updates-consent:state", () => consent.state()));
  ipcMain.handle("updates-consent:choose", from("updates-consent:choose", choice => consent.choose(choice)));
}
