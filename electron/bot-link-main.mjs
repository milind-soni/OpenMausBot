// Main's side of the link between this computer's bots and My Cloud's (server/bot-link/link.ts). There is no switch of
// its own: it follows "This computer and My Cloud together" (places-together.mjs). When that is on and both places
// exist, main pairs without a code or a prompt: the app is already signed in to My Cloud, so it asks My Cloud, over that
// sign-in, for a sign-in of the link's own and hands it to this computer's server, which keeps the link from then on,
// window open or closed. The link belongs to one Cloud and one account: when the switch is turned off, the person signs
// out, or either changes, main ends it on this computer at once, and this computer's server tells that Cloud (now, or
// when main next says it is awake).
//
// A Cloud that sleeps is never started for the link's sake: anything main sends it, and the "awake" main passes on to this
// computer's server (which then asks it), waits until the Admin answered just now that it is awake: main's last word can be
// a minute old, and a Cloud that went to sleep since would be started again by one request. Only the person's own turn on
// pairs at once. Nothing of this in the app's first `quietMs`; a refusal is not asked again for hours.
// "Asleep" goes with the time main first heard it, so that end can tell the Admin's lagging word from the Cloud's own
// answers since (server/bot-link/dial.ts).
//
// Security: only My Cloud is ever paired (the address the person's account names), never a server saved by hand or a
// team's Cloud. The link's sign-in goes from My Cloud to this computer's server and nowhere else; no page sees it.
import { linkedAddress } from "./bot-link-address.mjs";
import { BACKGROUND_HEADERS } from "./cloud-power.mjs";
import { readTogether } from "./places-together.mjs";

const STATE = "/api/bot-link";
const PAIR = "/api/bot-link/pair";
/** How often main brings the link in line with the switch, the account and the Cloud's sleep. */
const WATCH_MS = 60_000;
/** After My Cloud refused, or this computer's server did not take the link, main waits this long before it asks again. */
export const RETRY_MS = 6 * 60 * 60_000;
/** A Cloud on a version without the link is asked again once a day (or when the app starts, or the switch is turned on again). */
export const OUTDATED_RETRY_MS = 24 * 60 * 60_000;
/** The Admin is asked again about the Cloud's sleep for the link at most this often. */
export const ADMIN_EVERY_MS = 60_000;
/** An answer from the Admin that the Cloud is awake still counts as "just now" this long (one look's own steps). */
export const FRESH_AWAKE_MS = 5_000;

async function body(response) {
  try { return await response.json(); } catch { return null; }
}

/**
 * @param {{
 *   wanted(): boolean,
 *   pref?: { read(): unknown },
 *   switchedOff?(): boolean,
 *   chosen?(): boolean | null,
 *   powerChecked?(): Promise<boolean>,
 *   napped?(): void,
 *   proved?(): void,
 *   quietMs?: number,
 *   localRequest(route: string, init?: RequestInit): Promise<Response>,
 *   fetch: typeof fetch,
 *   cloud(): { origin: string | null, account: string | null, asleep: boolean, since?: string | number | null, signedOut?: boolean },
 *   cloudName(): string,
 *   changed?(): void,
 *   log?(line: string): void,
 *   watchMs?: number,
 *   now?(): number,
 * }} deps `wanted()`: the switch is on and both places exist. `pref`: the switch's own file: turning it off ends a
 * link (My Cloud not being seen for a moment leaves it alone). `switchedOff()` and `chosen()` (places-together.mjs) stand
 * in for it: off also while the person never chose and has not seen the notice of the default; `chosen()` is the person's
 * own choice, and only their own turn on pairs with a Cloud the Admin says sleeps. `powerChecked()`: asks the Admin again,
 * true once it answered just now (at most every ADMIN_EVERY_MS from here). `napped()`: this computer's end heard My Cloud
 * itself answer that it sleeps; main holds it asleep (cloud-power.mjs `hold`), as Files and lending do, so the Admin's
 * lagging "awake" starts nothing. `proved()`: this computer's end has My Cloud's own answer, since that, to work a person
 * waits on: it is awake, so the hold ends at once (cloud-power.mjs `woke`). `cloud()`: My
 * Cloud's address and the signed-in account while the person has them, whether the Admin says it sleeps now (and
 * since when, in its words: a new `since` is a new word), and whether the person signed out. `cloudName()`: what the app calls My Cloud, in the person's language. `changed()`: the
 * addresses `address` gives changed (the link came, went, or is another Cloud's now).
 */
export function createBotLinkMain({ wanted, pref = null, switchedOff = null, chosen = null, powerChecked = null, napped = () => {}, proved = () => {}, quietMs = 0, localRequest, fetch: fetchImpl, cloud, cloudName, changed = () => {}, log = () => {}, watchMs = WATCH_MS, now = Date.now }) {
  const local = async (method, payload) => {
    const response = await localRequest(STATE, { method, signal: AbortSignal.timeout(15_000),
      ...(payload === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }) });
    const answer = await body(response);
    if (!response?.ok) throw Object.assign(new Error(answer?.error ?? `This computer's server answered ${response?.status}`), { status: response?.status });
    return answer ?? { on: false };
  };
  /** This computer's server, as the link knows it: read again once another workspace of this computer's runs. */
  let computer = null;
  const thisComputer = async () => {
    if (computer) return computer;
    const described = await body(await localRequest("/.well-known/openmausbot/environment", { signal: AbortSignal.timeout(10_000) }));
    if (!described?.environmentId) return null;
    return (computer = { id: described.environmentId, name: String(described.label ?? "").trim().slice(0, 120) || "This computer" });
  };
  /** My Cloud forgets this computer's link and ends its sign-in. Background: it is not the person using their Cloud. */
  const forget = (origin, id) => fetchImpl(`${origin}${PAIR}?${new URLSearchParams({ computer: id })}`, { method: "DELETE", credentials: "include", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10_000),
    headers: { accept: "application/json", origin, ...BACKGROUND_HEADERS } }).then((response) => response.body?.cancel(), () => {});

  async function pair() {
    const mine = cloud();
    if (!mine.origin) return { on: false, error: "no-cloud" };
    const me = await thisComputer();
    if (!me) return { on: false, error: "no-server" };
    const response = await fetchImpl(`${mine.origin}${PAIR}`, { method: "POST", credentials: "include", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: { accept: "application/json", "content-type": "application/json", origin: mine.origin, ...BACKGROUND_HEADERS }, body: JSON.stringify({ computer: me, name: cloudName().slice(0, 120) }) });
    const paired = await body(response);
    // A Cloud on a version without the link answers 404; one that is not the person's own refuses.
    if (!response.ok || typeof paired?.token !== "string") return { on: false, error: response.status === 404 ? "cloud-outdated" : "cloud-refused" };
    try {
      return await local("PUT", { on: true, origin: mine.origin, token: paired.token, name: me.name, cloud: paired.place, ...(mine.account ? { account: mine.account } : {}) });
    } catch (error) {
      // The sign-in My Cloud just made has no keeper: it is ended, not left behind.
      await forget(mine.origin, me.id);
      log(`bot link: this computer's server did not take the link (${error?.message ?? error})`);
      return { on: false, error: "no-server" };
    }
  }

  /** What this computer's server last said of its link, and the Cloud and account it holds for: what `address` reads. */
  let known = null, addressed = "";
  const linkedTo = () => {
    const mine = cloud();
    if (!known?.on || known.role !== "dialer" || !known.peer?.id || !mine.origin || mine.signedOut || known.origin !== mine.origin) return null;
    if (mine.account && known.account && mine.account !== known.account) return null;
    return known.peer;
  };
  const note = (state) => {
    known = state;
    const next = JSON.stringify([linkedTo()?.id ?? null, computer?.id ?? null]);
    if (next === addressed) return;
    addressed = next;
    try { changed(); } catch {}
  };

  const readChoice = () => (chosen ? chosen() : readTogether(() => pref?.read()).choice);
  // A file that can't be read just now leaves a link alone.
  const isOff = () => { if (switchedOff) return switchedOff(); const read = readTogether(() => pref?.read()); return !read.unreadable && !read.foreign && read.choice !== true; };
  let retryAt = -Infinity, choseOn = null, looking = null, idle = false;
  const quietUntil = now() + quietMs;
  let heardNap = -Infinity, heardProof = -Infinity;
  let askedAdminAt = -Infinity, awakeAt = -Infinity;
  /** When the Admin said just now, after `after`, that the Cloud is awake (this computer's clock), else null: what main
   * needs before it sends the Cloud anything, or tells this computer's server it is awake. Never in the quiet start. */
  async function awakeNow(after = -Infinity) {
    if (now() < quietUntil || cloud().asleep) return null;
    // The Admin's answer from a moment ago (the same look) is still its answer just now: not asked again, nor refused.
    if (now() - awakeAt < FRESH_AWAKE_MS) return awakeAt > after ? awakeAt : null;
    if (powerChecked) {
      if (now() - askedAdminAt < ADMIN_EVERY_MS) return null;
      askedAdminAt = now();
      let answered = false;
      try { answered = await powerChecked(); } catch {}
      if (!answered || cloud().asleep) return null;
    }
    const at = awakeAt = now();
    return at > after ? at : null;
  }
  /** The Admin's "asleep" and when main first heard it, on this computer's clock: heard again when the Admin's `since`
   * moves on or it said awake in between. */
  let heard = null;
  const hearing = (mine) => {
    if (!mine.asleep) { heard = null; return null; }
    const key = String(mine.since ?? "");
    if (!heard || heard.key !== key) heard = { key, at: now() };
    return heard.at;
  };
  async function tryPair(force) {
    if (!force && now() < retryAt) return;
    let paired;
    try { paired = await pair(); } catch (error) { paired = { on: false, error: error?.message ?? String(error) }; }
    if (paired.on) { retryAt = -Infinity; note(paired); return; }
    retryAt = now() + (paired.error === "cloud-outdated" ? OUTDATED_RETRY_MS : RETRY_MS);
    log(`bot link: not linked to My Cloud (${paired.error})`);
  }
  async function reconcile() {
    idle = false;
    const state = await local("GET").catch(() => null);
    if (!state) return;
    if (state.on) await thisComputer().catch(() => null);
    note(state);
    // My Cloud's own word that it sleeps, as this computer's end last heard it: held before anything below reads cloud().
    if (Number.isFinite(state.cloudAsleepAt) && state.cloudAsleepAt > heardNap) { heardNap = state.cloudAsleepAt; try { napped(); } catch {} }
    // Its own answer since, to work a person waits on, says it is awake: that ends the hold at once.
    const answered = Number.isFinite(state.answeredAt) ? state.answeredAt : -Infinity;
    if (answered > heardNap && answered > heardProof) { heardProof = answered; try { proved(); } catch {} }
    // When main first heard "asleep", read after the hold above, so every "asleep" goes with it.
    const heardAt = hearing(cloud());
    const mine = cloud(), off = isOff(), own = readChoice() === true;
    // Only the person's own turn on, never the default's start: a Cloud the Admin says sleeps is left asleep for that.
    const justOn = choseOn === false && own && !off;
    choseOn = own;
    if (!state.on) {
      // A link that ended while its Cloud slept or could not be reached: this computer's server tells that Cloud now.
      if (mine.origin && !mine.asleep && Array.isArray(state.ended) && state.ended.includes(mine.origin)) {
        const at = await awakeNow();
        if (at !== null) await local("PUT", { cloud: "awake", origin: mine.origin, heardAt: at }).catch(() => {});
      }
      if (wanted() && !mine.signedOut && (justOn || !mine.asleep)) { if (justOn || (now() >= retryAt && await awakeNow() !== null)) await tryPair(justOn); }
      // Off, with nothing linked and nothing left to tell a Cloud: the timer has no more to do until something changes.
      else idle = off && !(Array.isArray(state.ended) && state.ended.length);
      return;
    }
    if (state.role !== "dialer") return;
    const otherCloud = Boolean(mine.origin && state.origin && mine.origin !== state.origin), otherAccount = Boolean(mine.account && state.account && mine.account !== state.account);
    if (off || mine.signedOut || otherCloud || otherAccount) {
      retryAt = -Infinity;
      note(await local("PUT", { on: false }));
      const me = await thisComputer().catch(() => null);
      // This computer's server told its Cloud if it could. Over the person's own sign-in main can make sure, for the same Cloud and account only.
      if (me && mine.origin && mine.origin === state.origin && !mine.asleep && !mine.signedOut && !otherAccount) await forget(mine.origin, me.id);
      return;
    }
    if (!mine.origin) return;
    if (state.needsPairing) { if (!mine.asleep && now() >= retryAt && await awakeNow() !== null) await tryPair(false); return; }
    // The Admin's word, passed on for this link's own Cloud only, for as long as this computer's end disagrees with it.
    // Never for a Cloud that answered work since main heard it: it is awake, whatever the word says.
    if (mine.asleep && !state.asleep) { if (heardAt !== null && answered < heardAt) await local("PUT", { cloud: "asleep", origin: mine.origin, heardAt }); }
    else if (!mine.asleep && state.asleep) {
      // Only an Admin answer from after the link parked: the one main holds may be from before the Cloud went to sleep.
      const at = await awakeNow(Number.isFinite(state.parkedAt) ? state.parkedAt : -Infinity);
      if (at !== null) await local("PUT", { cloud: "awake", origin: mine.origin, heardAt: at });
    }
  }
  /** Brings the link in line with the switch, the account and the Cloud: now, when any of them changes, and every minute. */
  function look() {
    looking ??= reconcile().catch((error) => log(`bot link: ${error?.message ?? error}`)).finally(() => { looking = null; });
    return looking;
  }

  const watch = setInterval(() => { if (!idle) void look(); }, watchMs);
  watch.unref?.();
  void look();
  return {
    look,
    /** Another of this computer's own workspaces runs now (or the same one started again): its link is its own. */
    serverChanged() { computer = null; known = null; addressed = ""; retryAt = -Infinity; try { changed(); } catch {} return look(); },
    /** The address over the link of a bot the sidebar lists for `home`: where the other place's bots know it, and where
     * this place's stand-in for it is found. Null while no link of this Cloud and account is on, so a row never carries
     * an address that belongs to another Cloud's or another account's link. */
    address(home, botId) {
      const peer = linkedTo();
      if (!peer || typeof botId !== "string" || !botId) return null;
      if (home === "cloud") return linkedAddress(peer.id, botId);
      return home === "computer" && computer ? linkedAddress(computer.id, botId) : null;
    },
    close: () => clearInterval(watch),
  };
}
