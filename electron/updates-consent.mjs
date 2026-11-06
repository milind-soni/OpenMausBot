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
 * the only way this computer can withdraw it. `replacedReceipts`: receipts of email-only opt-ins that a later answer
 * replaced (another email, or an account), each kept until its withdrawal succeeds. `receiptEmails`: the addresses
 * those receipts belong to. `pendingAccounts`: unsent choices retained for other accounts. `pending`: the Admin
 * has not recorded this answer yet.
 */
export function parseUpdatesConsent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (!UPDATES_CONSENT_STATUSES.includes(value.status) || !VERSION.test(value.version ?? "") || !Number.isSafeInteger(value.at) || value.at <= 0) return null;
  const email = cleanEmail(value.email);
  const pendingAccounts = (Array.isArray(value.pendingAccounts) ? value.pendingAccounts : []).flatMap(choice => {
    const parsed = parseUpdatesConsent({ status: choice?.status, version: choice?.version, at: choice?.at, account: choice?.account });
    return parsed?.account ? [parsed] : [];
  });
  return {
    status: value.status, version: value.version, at: value.at,
    ...(text(value.account, 128) ? { account: value.account } : {}),
    ...(email ? { email } : {}),
    ...(typeof value.receipt === "string" && RECEIPT.test(value.receipt) ? { receipt: value.receipt } : {}),
    ...withReplacedReceipts({ receiptEmails: value.receiptEmails }, Array.isArray(value.replacedReceipts) ? value.replacedReceipts.filter(receipt => typeof receipt === "string" && RECEIPT.test(receipt)) : []),
    ...(pendingAccounts.length ? { pendingAccounts } : {}),
    ...(value.pending === true ? { pending: true } : {}),
  };
}

function withReplacedReceipts(record, receipts, withdrawn = null, email = null) {
  const { replacedReceipts = [], receiptEmails, ...rest } = record;
  const left = [...new Set([...replacedReceipts, ...receipts])].filter(receipt => receipt && receipt !== withdrawn);
  const emails = Object.fromEntries(left.flatMap(receipt => {
    const address = cleanEmail(receipts.includes(receipt) && email ? email : receiptEmails?.[receipt]);
    return address ? [[receipt, address]] : [];
  }));
  return { ...rest, ...(left.length ? { replacedReceipts: left } : {}), ...(Object.keys(emails).length ? { receiptEmails: emails } : {}) };
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
  const save = (record, recorded = null) => {
    const previous = prefs.updatesConsent();
    const pendingAccounts = new Map((previous?.pendingAccounts ?? []).map(choice => [choice.account, choice]));
    if (previous?.pending && previous.account) pendingAccounts.set(previous.account,
      { status: previous.status, version: previous.version, at: previous.at, account: previous.account });
    if (recorded) {
      const pending = pendingAccounts.get(recorded.account);
      if (pending?.status === recorded.status && pending.version === recorded.version && pending.at === recorded.at) {
        pendingAccounts.delete(recorded.account);
        if (record.account === recorded.account) record = { ...record, pending: false };
      }
    }
    pendingAccounts.delete(record.account);
    prefs.setUpdatesConsent({ ...record, pendingAccounts: [...pendingAccounts.values()] });
    onChange();
  };

  async function signedOutSync(local, sameAnswer) {
    if (!local?.pending || local.account) return;
    if (local.status === "opted_in" && local.email) {
      const receipt = await client().updatesConsentByEmail({ email: local.email, installId: prefs.installId(), textVersion: local.version });
      if (sameAnswer()) return save(withReplacedReceipts({ ...local, receipt, pending: false }, [], receipt));
      const latest = prefs.updatesConsent();
      if (!latest) return;
      if (!latest.account && latest.email === local.email && (latest.status === "opted_in" || !latest.receipt)) save(withReplacedReceipts({ ...latest, receipt }, [], receipt));
      else save(withReplacedReceipts(latest, [receipt], null, local.email));
    } else if (local.status !== "opted_in" && local.receipt) {
      await client().withdrawUpdatesConsent({ status: local.status, receipt: local.receipt });
      if (sameAnswer()) save({ ...local, pending: false });
    } else save({ ...local, pending: false });
  }

  async function withdrawReplaced() {
    for (let receipt; (receipt = prefs.updatesConsent()?.replacedReceipts?.[0]);) {
      await client().withdrawUpdatesConsent({ status: "withdrawn", receipt });
      const latest = prefs.updatesConsent();
      if (latest?.replacedReceipts?.includes(receipt)) save(withReplacedReceipts(latest, [], receipt));
    }
  }

  async function reconcile(sameAnswer, fresh) {
    if (!client() || !await available()) return;
    const local = prefs.updatesConsent();
    if (!signedIn() && local?.pending && local.status === "opted_in" && local.email &&
      local.replacedReceipts?.some(receipt => !local.receiptEmails?.[receipt])) {
      await send(sameAnswer, fresh);
      if (fresh()) await withdrawReplaced();
      return;
    }
    await withdrawReplaced();
    await send(sameAnswer, fresh);
    await withdrawReplaced();
  }

  async function send(sameAnswer, fresh) {
    let local = prefs.updatesConsent();
    const who = signedIn();
    if (!who) return signedOutSync(local, sameAnswer);
    const pending = local?.pendingAccounts?.find(choice => choice.account === who.id);
    if (pending) {
      save({ ...local, ...pending, pending: true });
      local = prefs.updatesConsent();
    }
    const { receipt, ...rest } = local ?? {};
    const keep = record => { if (fresh()) save(withReplacedReceipts({ ...record, receiptEmails: local?.receiptEmails }, [receipt], null, local?.email)); };
    if (local?.pending && local.account === who.id) {
      await client().recordUpdatesConsent(local.status, local.version);
      if (fresh()) keep({ ...rest, pending: false });
      else save(prefs.updatesConsent(), local);
      return;
    }
    const remote = parseAccountConsent(await client().updatesConsent());
    if (!fresh()) return;
    if (remote) {
      if (local?.status !== remote.status || local.account !== who.id || local.pending || local.receipt)
        keep({ status: remote.status, version: remote.textVersion, at: now(), account: who.id, ...(local?.email ? { email: local.email } : {}), replacedReceipts: local?.replacedReceipts });
      return;
    }
    if (!local || (local.account && local.account !== who.id)) {
      if (receipt) keep(rest);
      return;
    }
    await client().recordUpdatesConsent(local.status, local.version);
    keep({ ...rest, account: who.id, pending: false });
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
    const saved = prefs.updatesConsent(), who = signedIn();
    const local = who && saved?.account && saved.account !== who.id ? null : saved;
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
    const returningReceipt = !who && status === "opted_in" && email
      ? previous?.replacedReceipts?.find(receipt => previous.receiptEmails?.[receipt] === email) : null;
    const sameReceipt = !who && (status !== "opted_in" || email === null ||
      (previous?.status === "opted_in" && email === previous.email));
    choices++;
    save(withReplacedReceipts({ status, version: UPDATES_CONSENT_VERSION, at: now(), pending: true,
      ...(who ? { account: who.id } : {}), ...(email ? { email } : {}),
      ...(returningReceipt || (sameReceipt && previous?.receipt) ? { receipt: returningReceipt || previous.receipt } : {}),
      replacedReceipts: previous?.replacedReceipts, receiptEmails: previous?.receiptEmails },
    sameReceipt ? [] : [previous?.receipt], returningReceipt, previous?.email));
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
