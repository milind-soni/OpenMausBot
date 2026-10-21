import { createManagedDesktopStore, retryDelay, unreadableRecord } from "./managed-desktop.mjs";
import { CLOUD_MACHINE_CONNECTABLE, cloudUnreachableText, parseCloudCredit, parseCloudOffer, parseCloudPurchase, parseCloudSummary, parseCloudTrial, parsePairingGrant, parsePublicOffer, withoutTrial } from "./cloud-home.mjs";
import { cleanCode, cleanEmail, parseSignInStart, SIGN_IN_START, SIGN_IN_TRIES, SIGN_IN_VERIFY, signInIdentity, startFailure, verifyFailure } from "./cloud-signin.mjs";

export const CLOUD_ORIGIN = "https://cloud.openmausbot.com";
/** The staging Admin (Dodo test mode, real test Clouds): a fixed address, on only with OMB_CLOUD_STAGING=1. */
export const STAGING_CLOUD_ORIGIN = "https://omb-cloud-staging.fly.dev";
/** Which Admin this app signs in to, and the files that depend on it (the sign-in, saved servers with the Cloud's
 * entry, Files' state, the Cloud's chosen name): staging never reads or writes production's. */
export function cloudTarget(env = process.env) {
  return env?.OMB_CLOUD_STAGING === "1"
    ? { origin: STAGING_CLOUD_ORIGIN, staging: true, file: "cloud-account-staging.bin", environments: "environments-staging.json", sync: "cloud-sync-staging", look: "cloud-home-look-staging.json" }
    : { origin: CLOUD_ORIGIN, staging: false, file: "cloud-account.bin", environments: "environments.json", sync: "cloud-sync", look: "cloud-home-look.json" };
}
const TOKEN = /^omc_[A-Za-z0-9_-]{43}$/;
const CODE = /^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/;
const PRIVATE_CODE = /^[A-Za-z0-9_-]{43}$/;
const SCIENCE_TOKEN = /^omb_sd_[A-Za-z0-9_-]{43}$/;
const TIER = /^[a-z][a-z0-9-]{0,23}$/;
const REFRESH_MS = 60_000;
const STEADY_MS = 15 * 60_000;
const SETUP_REFRESH_MS = 15_000;
/** While My Cloud sleeps and Files or lending waits for it: the session every 15 s, so they resume soon after it wakes. */
const ASLEEP_REFRESH_MS = 15_000;
const WAKE_STATES = Object.freeze(["awake", "waking"]);
/** While a checkout this app opened waits for its payment and setup: the session every 3 s (30 minutes at most). */
const WATCH_REFRESH_MS = 3_000;
const CHECKING_AFTER = 2;
const MAX_ENROLL_SECONDS = 1800;
const OFFER_MS = 10 * 60_000, OFFER_RETRY_MS = 30_000;
const CHECKOUT_WATCH_MS = 30 * 60_000, CHECKOUT_KEPT_MS = 24 * 3600_000;
/** The Admin's plan change waits on Dodo's charge, which can take about two minutes. */
const UPGRADE_TIMEOUT_MS = 180_000;
/** Node's fetch failure causes that mean the request never left this computer. */
const UNSENT_CAUSES = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);
/** A gateway that stopped waiting while the Admin may still finish: 504, and Cloudflare's origin timeout 524. */
const GATEWAY_TIMEOUTS = [504, 524];
export const CHECKOUT_SOURCES = Object.freeze(["app_card", "app_howto", "app_menu", "app_settings", "app_routines", "update_popup", "app_onboarding", "science"]);
const CHECKOUT_ORIGIN = "https://checkout.dodopayments.com", TEST_CHECKOUT_ORIGIN = "https://test.checkout.dodopayments.com";
/** Only Dodo's own HTTPS checkout origin, with no credentials and no fragment; anything else is never opened. Staging's
 * Admin sells in Dodo's test mode, so its checkouts are only Dodo's test page. */
export function checkoutDestination(value, { fixture = false, staging = false } = {}) {
  if (typeof value !== "string" || value.length > 2048) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  const allowed = fixture ? [CHECKOUT_ORIGIN, TEST_CHECKOUT_ORIGIN] : staging ? [TEST_CHECKOUT_ORIGIN] : [CHECKOUT_ORIGIN];
  if (!allowed.includes(url.origin) || url.username || url.password || url.hash || value.includes("#")) return null;
  return url.href;
}
// Never accept an address from the renderer.
export function cloudOrigin(value = CLOUD_ORIGIN, fixture = false) {
  const url = new URL(value);
  if (value !== url.origin || (![CLOUD_ORIGIN, STAGING_CLOUD_ORIGIN].includes(value) && !(fixture && url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new Error("Invalid MausBot Cloud address.");
  }
  return value;
}
export const createCloudAccountStore = createManagedDesktopStore;
// oxlint-disable-next-line no-control-regex
const text = (value, max) => typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const timestamp = value => Number.isSafeInteger(value) && value > 0;
/** Display only: the last verified plan, never an entitlement. */
function planHint(value) {
  if (!value || typeof value !== "object" || typeof value.active !== "boolean") return null;
  return { ...(typeof value.tier === "string" && TIER.test(value.tier) ? { tier: value.tier } : {}), active: value.active };
}
/** Only the Admin's own JSON "invalid_token" ends a sign-in; a 401/403 page from Cloudflare or a proxy does not. */
const signInEnded = error => [401, 403].includes(error?.status) && error.code === "invalid_token";
const sameHint = (left, right) => (left?.tier ?? null) === (right?.tier ?? null) && (left?.active ?? null) === (right?.active ?? null);

export function createCloudAccountClient({ store, openBrowser, platform, deviceName, appVersion,
  origin = CLOUD_ORIGIN, fixture = false, fetch: fetcher = globalThis.fetch, now = Date.now, onState = () => {},
  setTimer = setTimeout, clearTimer = clearTimeout, warn = message => console.warn(message), awaitingWake = () => false }) {
  origin = cloudOrigin(origin, fixture);
  const staging = origin === STAGING_CLOUD_ORIGIN;
  let grant = null, issued = null, cleanup = null, pending = null, cleanupNeeded = false;
  let value = { status: "signed-out", message: "restoring" }, generation = 0, timer = null, closed = false, clearing = null, refreshing = null;
  let verifiedUntil = 0, restoring = false, controller = new AbortController(), failures = 0;
  let plan = null, savedHint = null;
  let offerCache = null, offerPending = null, waking = false;
  /** The checkout this app opened, its address kept here for Reopen and Copy link: never published, never asked for again. */
  let opened = null;
  /** An email code on its way: the attempt the Admin answered, kept in main only. */
  let emailed = null;
  const newerPlans = new Set();
  const lastPlan = () => plan && grant && plan.accountId === grant.account.id ? { ...(plan.tier ? { tier: plan.tier } : {}), active: plan.active } : null;
  const view = (status, message) => {
    const known = status === "connected" ? null : lastPlan();
    return { status, ...(message ? { message } : {}), ...(grant ? { account: grant.account, deviceId: grant.device.id, expiresAt: grant.expiresAt } : {}), ...(known ? { lastPlan: known } : {}) };
  };
  const checkout = () => opened && now() - opened.startedAt < CHECKOUT_KEPT_MS
    ? { plan: opened.plan, startedAt: opened.startedAt, ...(opened.signIn ? { signIn: true } : {}), ...(opened.url ? { link: true } : {}), ...(opened.done ? { done: true } : {}) } : null;
  const withCheckout = current => {
    const open = checkout(), shown = waking && current.status === "connected" ? { ...current, waking: true } : current;
    const next = open ? { ...shown, checkout: open } : shown;
    return staging ? { ...next, staging: true } : next;
  };
  const state = () => {
    if (value.status === "connected") {
      if (grant && grant.expiresAt <= now()) return structuredClone(withCheckout(view("reauth-required", "expired")));
      if (now() >= verifiedUntil) return structuredClone(withCheckout(view("unavailable", "verification-expired")));
      if (failures >= CHECKING_AFTER) return structuredClone(withCheckout({ ...value, checking: true }));
    }
    return structuredClone(withCheckout(value));
  };
  const watching = () => Boolean(opened && now() - opened.startedAt < CHECKOUT_WATCH_MS);
  const publish = next => { value = next; onState(state()); return state(); };
  const record = (saved, hint) => ({ ...saved, ...(hint ? { planHint: hint } : {}) });
  const stopTimer = () => { if (timer !== null) clearTimer(timer); timer = null; };
  const schedule = (work, delay) => {
    stopTimer();
    if (!closed) { timer = setTimer(() => { timer = null; void work().catch(() => {}); }, Math.max(1, delay)); timer?.unref?.(); }
  };
  const reset = () => { generation++; stopTimer(); controller.abort(); controller = new AbortController(); pending = null; emailed = null; verifiedUntil = 0; failures = 0; return generation; };
  const current = stamp => !closed && generation === stamp;
  const versionHeader = text(appVersion, 40) && /^[0-9A-Za-z][0-9A-Za-z.+-]{0,39}$/.test(appVersion) ? { "x-openmausbot-version": appVersion } : {};
  async function request(route, { method = "GET", body, token, signal = controller.signal, timeout = 20_000, path = `/api/cloud/desktop/${route}` } = {}) {
    const response = await fetcher(`${origin}${path}`, {
      method, redirect: "error", credentials: "omit", cache: "no-store",
      headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }), ...(token ? { authorization: `Bearer ${token}`, ...versionHeader } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
    });
    const reader = response.body?.getReader(), chunks = []; let size = 0;
    try {
      if (reader) while (true) {
        const { done, value: chunk } = await reader.read(); if (done) break;
        size += chunk.byteLength; if (size > 64 * 1024) throw new Error("Cloud response too large.");
        chunks.push(chunk);
      }
    } catch (error) { await reader?.cancel().catch(() => {}); throw error; }
    finally { reader?.releaseLock(); }
    let data;
    try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {
      if (!response.ok) throw Object.assign(new Error("Cloud request failed."), { status: response.status, opaque: true });
      throw new Error("Invalid Cloud response.");
    }
    if (!response.ok) throw Object.assign(new Error("Cloud request failed."), { status: response.status, code: data?.error, interval: data?.interval });
    return data;
  }
  function identity(result) {
    if (result?.cloudContractVersion !== 1 || !timestamp(result.expiresAt) || !text(result.device?.id, 128) ||
      !text(result.account?.id, 128) || !text(result.account?.email, 254)) throw new Error("Invalid Cloud identity.");
    return { expiresAt: result.expiresAt, device: { id: result.device.id }, account: { id: result.account.id, email: result.account.email } };
  }
  function validateGrant(saved) {
    if (saved?.origin !== origin || !TOKEN.test(saved.token)) throw new Error("Invalid Cloud credential.");
    return { origin, token: saved.token, ...identity({ ...saved, cloudContractVersion: 1 }) };
  }
  /** A plan newer than this app is paid with its tier, never a lockout; a malformed tier is no tier. */
  function entitlement(input) {
    const newer = typeof input?.plan === "string" && !["free", "pro"].includes(input.plan) && TIER.test(input.plan);
    if (!input || !(newer || ["free", "pro"].includes(input.plan)) || !["active", "inactive"].includes(input.status) ||
      !(input.expiresAt === null || timestamp(input.expiresAt)) || !Number.isSafeInteger(input.version) || input.version < 0) throw new Error("Invalid Cloud entitlement.");
    const plan = input.plan === "free" ? "free" : "pro";
    if (input.status === "active" && (plan !== "pro" || input.expiresAt === null || input.expiresAt <= now())) throw new Error("Invalid active Cloud entitlement.");
    if (newer && !newerPlans.has(input.plan)) { newerPlans.add(input.plan); warn(`[cloud] MausBot Cloud sent plan "${input.plan}", newer than this app; treating it as paid.`); }
    const tier = typeof input.tier === "string" && TIER.test(input.tier) ? input.tier : newer ? input.plan : undefined;
    return { plan, ...(tier ? { tier } : {}), status: input.status,
      expiresAt: input.expiresAt, version: input.version };
  }
  async function revoke(previous) {
    try { await request("session", { method: "DELETE", body: {}, token: previous.token, signal: AbortSignal.timeout(20_000) }); }
    catch (error) { if (![401, 403].includes(error?.status) || error.opaque) throw error; }
  }
  function homeTarget() {
    const current = state();
    const machine = current.status === "connected" ? current.machine : undefined;
    return machine?.origin && CLOUD_MACHINE_CONNECTABLE.includes(machine.status) ? { origin: machine.origin } : null;
  }
  function forget({ quiet = false } = {}) {
    if (clearing) return clearing;
    const previous = grant ?? issued ?? cleanup, stamp = reset();
    grant = null; issued = null; cleanup = previous; cleanupNeeded = true; plan = null; savedHint = null; opened = null;
    if (!quiet) publish({ status: "signed-out" });
    const operation = (async () => {
      const [persisted, revoked] = await Promise.allSettled([Promise.resolve().then(() => store.write(null)), previous ? revoke(previous) : Promise.resolve()]);
      if (persisted.status === "fulfilled") { cleanup = null; cleanupNeeded = false; }
      if (!current(stamp)) return state();
      if (persisted.status === "rejected") return publish({ status: "unavailable", message: "signout-storage-failed" });
      if (quiet) return state();
      return publish({ status: "signed-out", ...(revoked.status === "rejected" ? { message: "signout-local-only" } : {}) });
    })().finally(() => { if (clearing === operation) clearing = null; });
    clearing = operation; return operation;
  }
  const signOut = () => forget();
  async function synchronize(stamp) {
    if (!grant || !current(stamp)) return state();
    if (grant.expiresAt <= now()) { stopTimer(); return publish(view("reauth-required", "expired")); }
    try {
      const previous = grant, result = await request("session", { token: previous.token });
      if (!current(stamp) || grant !== previous) return state();
      const next = identity(result);
      if (next.device.id !== previous.device.id || next.account.id !== previous.account.id || next.account.email !== previous.account.email || next.expiresAt <= now()) {
        throw Object.assign(new Error("Cloud identity changed."), { status: 401, code: "invalid_token" });
      }
      const access = entitlement(result.entitlement);
      const machine = parseCloudSummary(result.cloud);
      const purchase = parseCloudPurchase(result.cloud?.purchase);
      const trial = parseCloudTrial(result.cloud?.trial), credit = parseCloudCredit(result.cloud?.credit), offer = parseCloudOffer(result.offer);
      const hint = access.plan === "pro" ? { ...(access.tier ? { tier: access.tier } : {}), active: access.status === "active" } : null;
      if (next.expiresAt !== previous.expiresAt) {
        const replacement = { ...previous, expiresAt: next.expiresAt };
        await store.write(record(replacement, hint));
        if (!current(stamp) || grant !== previous) return state();
        grant = replacement; savedHint = hint;
      } else if (!sameHint(savedHint, hint)) {
        try { await store.write(record(previous, hint)); savedHint = hint; } catch {}
        if (!current(stamp) || grant !== previous) return state();
      }
      plan = hint ? { accountId: grant.account.id, ...hint } : null;
      failures = 0;
      // A checkout the Admin still holds open, with none kept here (this app restarted mid-checkout): watched as this
      // app's own from first sight, so payment, setup and "ready" are followed as closely as before the restart.
      if (!opened && offer?.checkout && offer.checkout.openUntil > now() && access.status !== "active") {
        opened = { plan: offer.checkout.plan, source: null, startedAt: now() };
      }
      verifiedUntil = Math.min(grant.expiresAt, now() + STEADY_MS,
        access.status === "active" && access.expiresAt !== null ? access.expiresAt : Infinity);
      publish({ ...view("connected"), entitlement: access, ...(machine ? { machine } : {}), ...(purchase ? { purchase } : {}),
        ...(trial ? { trial } : {}), ...(credit ? { credit } : {}), ...(offer ? { offer } : {}), verifiedAt: now(), verifiedUntil });
      const settingUp = machine?.status === "provisioning" || (access.status === "active" && !machine) || Boolean(purchase);
      const delay = watching() && machine?.status !== "ready" ? WATCH_REFRESH_MS : settingUp ? SETUP_REFRESH_MS : awaitingWake() ? ASLEEP_REFRESH_MS : REFRESH_MS;
      schedule(refresh, Math.min(delay, verifiedUntil - now()));
    } catch (error) {
      if (!current(stamp)) return state();
      if (signInEnded(error)) { verifiedUntil = 0; failures = 0; stopTimer(); return publish(view("reauth-required", "access-ended")); }
      failures++;
      if (value.status === "connected") publish(value);
      else publish(view("unavailable", "unreachable"));
      schedule(refresh, Math.min(retryDelay(failures), grant.expiresAt - now()));
    }
    return state();
  }
  function refresh() {
    if (clearing) return clearing;
    if (refreshing?.stamp === generation) return refreshing.operation;
    const entry = { stamp: generation, operation: null };
    entry.operation = synchronize(generation).finally(() => { if (refreshing === entry) refreshing = null; });
    refreshing = entry; return entry.operation;
  }
  /** A token the Admin just issued: stored where every sign-in goes, then this computer is signed in with it. One no
   * longer wanted (the sign-in was superseded or cancelled meanwhile) is revoked, never left behind. */
  async function adopt(result, stamp, wanted = () => true) {
    const next = validateGrant({ origin, token: result?.accessToken, ...identity(result) });
    if (!current(stamp) || !wanted()) { await revoke(next).catch(() => {}); return false; }
    if (next.expiresAt <= now()) throw new Error("Expired Cloud credential.");
    issued = next;
    await store.write(next);
    if (!current(stamp)) return false;
    grant = next; issued = null; pending = null; emailed = null; savedHint = null;
    if (plan?.accountId !== next.account.id) plan = null;
    return true;
  }
  async function poll() {
    const attempt = pending, stamp = generation;
    if (!attempt || !current(stamp)) return state();
    if (now() >= attempt.expiresAt) { pending = null; opened = null; return publish({ status: "signed-out", message: "enrollment-expired" }); }
    try {
      const result = await request("token", { method: "POST", body: { deviceCode: attempt.deviceCode } });
      if (!(await adopt(result, stamp))) return state();
      const intent = opened;
      const signedIn = await refresh();
      if (intent && current(stamp) && opened === intent && signedIn.status === "connected") {
        if (signedIn.entitlement?.plan !== "free" || signedIn.purchase || signedIn.machine) { opened = null; return publish(value); }
        if (!signedIn.offer) return (await openCheckout(intent.plan, intent.source).catch(() => ({ state: state() }))).state;
      }
      return signedIn;
    } catch (error) {
      if (!current(stamp)) return state();
      if (issued) return signOut();
      if (error?.code === "slow_down") attempt.interval = Math.min(60_000, Math.max(attempt.interval + 5000, Number.isSafeInteger(error.interval) ? error.interval * 1000 : 0));
      else if (["access_denied", "expired_token", "invalid_grant"].includes(error?.code)) { pending = null; opened = null; return publish({ status: "signed-out", message: "enrollment-ended" }); }
      else if (error?.status && !error.opaque && error.code !== "authorization_pending" && error.status !== 429) { pending = null; opened = null; return publish({ status: "signed-out", message: "signin-failed" }); }
      schedule(poll, Math.min(attempt.interval, attempt.expiresAt - now()));
      return state();
    }
  }
  async function begin(intent = null) {
    if (closed || restoring || clearing || grant || issued || cleanupNeeded) throw new Error("Sign out before starting another Cloud connection.");
    const stamp = reset();
    opened = intent ? { plan: intent.plan, source: intent.source, startedAt: now(), signIn: true } : null;
    publish({ status: "connecting" });
    try {
      if (!text(deviceName, 100) || !["darwin", "win32", "linux"].includes(platform)) throw new Error("Invalid desktop.");
      const result = await request("authorize", { method: "POST", body: { deviceName, platform, ...(text(appVersion, 40) ? { appVersion } : {}) } });
      if (!current(stamp)) return state();
      if (result.cloudContractVersion !== 1 || !PRIVATE_CODE.test(result.deviceCode) || !CODE.test(result.userCode) ||
        result.verificationUriComplete !== `${origin}/cloud/desktop?code=${result.userCode}` || !Number.isSafeInteger(result.expiresIn) || result.expiresIn < 1 || result.expiresIn > MAX_ENROLL_SECONDS ||
        !Number.isSafeInteger(result.interval) || result.interval < 5 || result.interval > 60) throw new Error("Invalid Cloud authorization.");
      const next = intent ? `&${new URLSearchParams({ next: "checkout", plan: intent.plan, src: intent.source })}` : "";
      pending = { deviceCode: result.deviceCode, verificationUri: `${result.verificationUriComplete}${next}`, expiresAt: now() + result.expiresIn * 1000, interval: result.interval * 1000 };
      publish({ status: "connecting", enrollment: { userCode: result.userCode, expiresAt: pending.expiresAt } });
      await openBrowser(pending.verificationUri);
      if (current(stamp)) schedule(poll, pending.interval);
    } catch { if (current(stamp)) { pending = null; opened = null; publish({ status: "signed-out", message: "signin-failed" }); } }
    return state();
  }
  const signInBlocked = () => closed || restoring || clearing || grant || issued || cleanupNeeded;
  /** Sends the 8-digit code to `email`. Nothing is signed in yet; the answer says what the sheet shows next. */
  async function emailStart(email) {
    if (signInBlocked() || value.status === "connecting") throw new Error("Sign out before starting another Cloud connection.");
    const address = cleanEmail(email), app = signInIdentity({ deviceName, platform, appVersion });
    if (!address) return { outcome: "invalid-email" };
    if (!app) return { outcome: "browser" };
    const stamp = generation;
    // A code already sent stays good until a new one is: a refused Resend (too many, offline) must not lose it.
    if (emailed && emailed.email !== address) emailed = null;
    try {
      const started = parseSignInStart(await request(null, { method: "POST", path: SIGN_IN_START, body: { email: address, ...app } }));
      if (!current(stamp)) return { outcome: "failed" };
      if (!started) return { outcome: "failed" };
      emailed = { attempt: started.attempt, email: address, expiresAt: now() + started.expiresIn * 1000, wrong: 0 };
      return { outcome: "sent", email: address, expiresAt: emailed.expiresAt, resendAt: now() + started.resendAfter * 1000, signupOpen: started.signupOpen };
    } catch (error) {
      return current(stamp) ? { outcome: startFailure(error) } : { outcome: "failed" };
    }
  }
  /** Checks the code; on success the token is stored like the browser sign-in's and the session is read at once. */
  async function emailVerify(code) {
    const attempt = emailed, digits = cleanCode(code);
    if (!attempt || now() >= attempt.expiresAt) { emailed = null; return { outcome: "expired" }; }
    if (!digits) return { outcome: "wrong-code", triesLeft: SIGN_IN_TRIES - attempt.wrong };
    if (signInBlocked()) throw new Error("Sign out before starting another Cloud connection.");
    const stamp = generation;
    try {
      const result = await request(null, { method: "POST", path: SIGN_IN_VERIFY, body: { attempt: attempt.attempt, code: digits } });
      if (!(await adopt(result, stamp, () => emailed === attempt))) return { outcome: "failed" };
      return { outcome: "signed-in", state: await refresh() };
    } catch (error) {
      if (!current(stamp)) return { outcome: "failed" };
      if (issued) { await signOut(); return { outcome: "failed" }; }
      const outcome = verifyFailure(error);
      if (outcome === "wrong-code" && emailed === attempt) {
        attempt.wrong++;
        if (attempt.wrong < SIGN_IN_TRIES) return { outcome, triesLeft: SIGN_IN_TRIES - attempt.wrong };
      }
      if (emailed === attempt) emailed = null;
      return { outcome: outcome === "wrong-code" ? "expired" : outcome };
    }
  }
  async function openCheckout(plan, source) {
    if (typeof plan !== "string" || !TIER.test(plan) || !CHECKOUT_SOURCES.includes(source)) throw new Error("Invalid Cloud checkout.");
    const current = state();
    if (current.status === "signed-out" && !grant) return { outcome: "signing-in", state: await begin({ plan, source }) };
    if (current.status !== "connected" || !grant) throw new Error("Sign in to MausBot Cloud before choosing a plan.");
    const signedIn = grant;
    let destination;
    try {
      const result = await request("checkout", { method: "POST", body: { plan, source }, token: signedIn.token });
      destination = checkoutDestination(result?.url, { fixture, staging });
      if (result?.cloudContractVersion !== 1 || !destination) return { outcome: "failed", state: state() };
    } catch (error) {
      if (!error?.opaque && error?.status === 409) return { outcome: "conflict", state: await refresh() };
      if (!error?.opaque && error?.status === 429) return { outcome: "rate-limited", state: state() };
      if (signInEnded(error)) return { outcome: "failed", state: await refresh() };
      if (![404, 405, 501].includes(error?.status)) return { outcome: "failed", state: state() };
      destination = `${origin}/cloud?${new URLSearchParams({ checkout: "start", plan, src: source })}`;
    }
    if (grant !== signedIn) return { outcome: "failed", state: state() };
    await openBrowser(destination);
    opened = { plan, source, startedAt: now(), url: destination };
    publish(value);
    schedule(refresh, WATCH_REFRESH_MS);
    return { outcome: "opened", state: state() };
  }
  /** Runs a signed-in desktop request; a 401 `invalid_token` means the sign-in ended, so the session is read again and the error still surfaces. */
  async function signedRequest(signedIn, route, options) {
    try { return await request(route, { ...options, token: signedIn.token }); }
    catch (error) { if (signInEnded(error)) await refresh().catch(() => {}); throw error; }
  }
  /** Choosing Max from a paid plan: every answer of the Admin's upgrade route becomes one outcome; only `not_subscribed` goes on to checkout. */
  async function upgrade(plan, source) {
    if (typeof plan !== "string" || !TIER.test(plan) || !CHECKOUT_SOURCES.includes(source)) throw new Error("Invalid Cloud upgrade.");
    if (state().status !== "connected" || !grant) throw new Error("Sign in to MausBot Cloud before choosing a plan.");
    const signedIn = grant;
    const done = async outcome => (grant === signedIn ? { outcome, state: await refresh() } : { outcome: "unknown", state: state() });
    let result;
    try { result = await request("upgrade", { method: "POST", body: { plan, source }, token: signedIn.token, timeout: UPGRADE_TIMEOUT_MS }); }
    catch (error) {
      const status = error?.status;
      if (!Number.isInteger(status)) return done(UNSENT_CAUSES.has(error?.cause?.code) ? "unknown" : "pending");
      if (GATEWAY_TIMEOUTS.includes(status)) return done("pending");
      if ([404, 405, 501].includes(status)) {
        if (grant !== signedIn) return { outcome: "failed", state: state() };
        await openBrowser(`${origin}/cloud`);
        return { outcome: "opened", state: state() };
      }
      if ([502, 503].includes(status)) return { outcome: "failed", state: state() };
      if (status === 429) return { outcome: "rate-limited", state: state() };
      if (error.opaque) return done("unknown");
      if (status === 402 && error.code === "payment_failed") return { outcome: "payment-failed", state: state() };
      if (status === 409 && error.code === "not_subscribed") return openCheckout(plan, source).catch(() => ({ outcome: "not-subscribed", state: state() }));
      if (status === 409 && error.code === "already_on_plan") return done("already-on-plan");
      if (status === 409 && error.code === "plan_change_unavailable") return { outcome: "unavailable", state: state() };
      if (signInEnded(error)) return { outcome: "failed", state: await refresh() };
      if (status >= 400 && status < 500) return { outcome: "failed", state: state() };
      return done("unknown");
    }
    if (result?.cloudContractVersion === 1 && result.status === "upgraded") return done("upgraded");
    if (result?.cloudContractVersion === 1 && result.status === "pending") return done("pending");
    return done("unknown");
  }
  /** Reopen checkout: the same page again, never a new one from the Admin; only with none kept here (the browser
   * sign-in led to it, or the app restarted) is the Admin asked, and it reopens the open one. Watches 30 minutes more. */
  async function reopenCheckout(plan, source) {
    const kept = opened;
    if (!kept?.url) return openCheckout(kept?.plan ?? plan, kept?.source ?? source);
    await openBrowser(kept.url);
    if (opened !== kept) return { outcome: "failed", state: state() };
    opened = { ...kept, startedAt: now() };
    publish(value);
    schedule(refresh, WATCH_REFRESH_MS);
    return { outcome: "opened", state: state() };
  }
  /** A sign-in that may only be locked in the keychain is kept, never removed, and read again shortly. */
  async function restoreFailed(stamp, unreadable) {
    cleanupNeeded = true;
    if (unreadable) {
      const removed = await store.write(null).then(() => true, () => false);
      if (!current(stamp)) return state();
      if (removed) { cleanupNeeded = false; failures = 0; return publish({ status: "signed-out", message: "restore-removed" }); }
    }
    failures++;
    if (value.message !== "restore-failed") publish({ status: "unavailable", message: "restore-failed" });
    schedule(start, retryDelay(failures));
    return state();
  }
  async function start() {
    const stamp = generation;
    restoring = true; verifiedUntil = 0;
    let saved, restored = null, failed = false, unreadable = false;
    try { saved = await store.read(); } catch (error) { failed = true; unreadable = unreadableRecord(error); }
    if (!failed) try { restored = saved ? validateGrant(saved) : null; } catch { failed = unreadable = true; }
    restoring = false;
    if (!current(stamp)) return state();
    if (failed) return restoreFailed(stamp, unreadable);
    grant = restored; cleanupNeeded = false; failures = 0;
    savedHint = grant ? planHint(saved.planHint) : null;
    plan = grant && savedHint ? { accountId: grant.account.id, ...savedHint } : null;
    if (!grant) return ["restoring", "restore-failed"].includes(value.message) ? publish({ status: "signed-out" }) : state();
    return refresh();
  }
  return {
    state,
    start,
    begin: () => begin(),
    emailStart, emailVerify,
    emailCancel() { emailed = null; },
    checkout: openCheckout,
    reopenCheckout,
    /** For main's clipboard only: the kept checkout page, while it is the one being waited on. */
    checkoutLink: () => (opened?.url && now() - opened.startedAt < CHECKOUT_KEPT_MS ? opened.url : null),
    checkoutPending: watching,
    /** The Cloud this checkout bought was opened, announced or shown ready: the purchase is over (Add a Cloud… says one Cloud for now). */
    checkoutDone() { if (opened && !opened.done) { opened = { ...opened, done: true }; publish(value); } },
    async signInAgain() {
      if (state().status !== "reauth-required") throw new Error("This computer is still signed in to MausBot Cloud.");
      publish({ status: "connecting" });
      const forgotten = await forget({ quiet: true });
      if (forgotten.status === "unavailable") return forgotten;
      return begin();
    },
    async reopen() {
      if (pending && value.status === "connecting" && pending.expiresAt > now()) await openBrowser(pending.verificationUri);
      return state();
    },
    cancel: () => { if (!pending && value.status !== "connecting") return Promise.resolve(state()); opened = null; return signOut(); },
    refresh, signOut,
    async openDashboard() { await openBrowser(`${origin}/cloud`); return state(); },
    async offer() {
      const current = state();
      if (current.status === "connected" && current.offer) return current.offer;
      if (!offerCache || now() >= offerCache.until) {
        offerPending ??= request(null, { path: "/api/public/config", signal: AbortSignal.timeout(10_000) }).then(
          config => { const offer = parsePublicOffer(config); offerCache = { value: offer, until: now() + (offer ? OFFER_MS : OFFER_RETRY_MS) }; return offer; },
          () => { offerCache = { value: null, until: now() + OFFER_RETRY_MS }; return null; },
        ).finally(() => { offerPending = null; });
        await offerPending;
      }
      return current.status === "connected" ? withoutTrial(offerCache.value) : offerCache.value;
    },
    async interest(kind) {
      if (kind !== "another_cloud") throw new Error("Invalid Cloud interest.");
      const signedIn = grant;
      if (!signedIn || state().status !== "connected") throw new Error("Sign in to MausBot Cloud first.");
      const result = await request("interest", { method: "POST", body: { kind }, token: signedIn.token });
      if (result?.ok !== true) throw new Error("Invalid Cloud response.");
    },
    homeTarget,
    /** The Admin's last verified word on a Cloud whose plan sleeps, kept while a re-check fails; null for any other. */
    power: () => (value.status === "connected" ? value.machine?.power ?? null : null),
    /** Starts a sleeping Cloud through the Admin (`awake` once started, `waking` if it is still starting), then reads the
     *  session again so Files and lending resume. Null when there is nothing to wake or the Admin can't say. */
    async wakeHome() {
      const current = grant, power = value.status === "connected" ? value.machine?.power : null;
      if (!current || !power || power.state === "awake") return null;
      let woke = null;
      try {
        const result = await request("wake", { method: "POST", body: {}, token: current.token });
        woke = WAKE_STATES.includes(result?.state) ? result.state : null;
      } catch {}
      await refresh().catch(() => {});
      return woke;
    },
    /** Opening a sleeping Cloud takes a moment: the state says so meanwhile. */
    setWaking(on) {
      if (waking === (on === true)) return;
      waking = on === true;
      publish(value);
    },
    async growDisk(sizeGb) {
      const current = grant;
      if (!current || state().status !== "connected") throw new Error("My Cloud is not ready yet.");
      if (!Number.isSafeInteger(sizeGb) || sizeGb < 1 || sizeGb > 10_000) throw new Error("Invalid Cloud disk size.");
      let result;
      try { result = await request("disk", { method: "POST", body: { sizeGb }, token: current.token }); } catch (error) {
        if ([404, 405, 501].includes(error?.status)) return { supported: false };
        if ([409, 422].includes(error?.status)) return { supported: true, refused: true };
        throw error;
      }
      const disk = result?.disk;
      if (!disk || !Number.isSafeInteger(disk.gb) || !Number.isSafeInteger(disk.maxGb) || disk.gb < 1 || disk.maxGb < disk.gb) throw new Error("Invalid Cloud disk response.");
      return { supported: true, disk: { gb: disk.gb, maxGb: disk.maxGb } };
    },
    /** The code goes to main only, for one navigation, and is not kept. */
    async pairHome() {
      const target = homeTarget(), current = grant;
      if (!target || !current) throw new Error("My Cloud is not ready to connect yet.");
      let result;
      try { result = await request("pairing", { method: "POST", body: {}, token: current.token }); } catch (error) {
        const why = cloudUnreachableText(await refresh().catch(() => state()), target.origin);
        throw why ? new Error(why) : error;
      }
      const pairing = parsePairingGrant(result, target.origin, now());
      if (!pairing) throw new Error("Invalid Cloud pairing response.");
      return pairing;
    },
    /** This sign-in's own X research relay access while its plan is paid:
     * `{ url, token }` for the local server (electron/included-x.mjs), or null
     * when there is no sign-in, the Admin says the plan is not active (402) or
     * it does not offer X research (404). Never kept on disk. The relay must
     * be on the Cloud's own origin: the token goes nowhere else. */
    async xResearchAccess() {
      const current = grant;
      if (!current) return null;
      let result;
      try { result = await request("services/x", { method: "POST", body: {}, token: current.token }); }
      catch (error) { if (error?.status === 402 || error?.status === 404) return null; throw error; }
      let relay = null;
      try { relay = typeof result?.url === "string" ? new URL(result.url) : null; } catch { relay = null; }
      if (result?.cloudContractVersion !== 1 || !relay || relay.origin !== origin || typeof result.token !== "string" || !/^omb_xd_[A-Za-z0-9_-]{43}$/.test(result.token)) {
        throw new Error("Invalid Cloud X research response.");
      }
      return { url: result.url, token: result.token };
    },
    /** The science catalog as the Admin serves it (never kept); null with no sign-in. */
    async scienceCatalog() {
      const current = grant;
      if (!current) return null;
      const result = await signedRequest(current, "catalog");
      if (result?.cloudContractVersion !== 1 || !Number.isSafeInteger(result.version) || !Array.isArray(result.sections)) throw new Error("Invalid Cloud catalog.");
      const { cloudContractVersion: _version, ...catalog } = result;
      return catalog;
    },
    /** This sign-in's own science relay access while its plan allows it: `{ url, token, expiresAt }` for the local server,
     * or null with no sign-in, no active plan (402) or no science service (404). The relay is only the Cloud's own exact
     * route and the token goes nowhere else. Never kept on disk or logged. */
    async scienceAccess() {
      const current = grant;
      if (!current) return null;
      let result;
      try { result = await signedRequest(current, "services/science", { method: "POST", body: {} }); }
      catch (error) { if (error?.status === 402 || error?.status === 404) return null; throw error; }
      if (result?.cloudContractVersion !== 1 || result.url !== `${origin}/api/cloud/services/science` || typeof result.token !== "string" ||
        !SCIENCE_TOKEN.test(result.token) || !Number.isSafeInteger(result.expiresAt) || result.expiresAt <= now()) throw new Error("Invalid Cloud science response.");
      return { url: result.url, token: result.token, expiresAt: result.expiresAt };
    },
    upgrade,
    close() { closed = true; reset(); },
  };
}

export function cloudMenuSublabel(state, date) {
  if (state?.status !== "connected") return null;
  const trial = state.trial;
  if (state.entitlement?.plan === "pro" && state.entitlement.status === "active") {
    if (trial?.state === "active" || trial?.state === "ending") return `Free trial until ${date(trial.endsAt)}`;
    return state.machine?.power?.sleeps ? "Sleeps when idle" : "Always on";
  }
  return state.machine || trial ? "Stopped" : null;
}

/** What the person's own Cloud page may show of the plan: never the account, a credential or an address. */
export function cloudPlanSnapshot(state, { notice = null } = {}) {
  const tier = state?.status === "connected" ? state.entitlement?.tier : state?.lastPlan?.tier;
  const named = typeof tier === "string" ? { tier } : {};
  const trial = state?.status === "connected"
    ? { ...(state.trial ? { trial: state.trial } : {}), ...(state.credit ? { credit: state.credit } : {}), ...(notice && state.trial ? { notice } : {}),
      ...(state.machine?.power?.sleeps ? { sleeps: true } : {}) } : {};
  if (state?.status === "connected" && state.entitlement?.plan === "pro") return { status: state.entitlement.status === "active" ? "paid" : "attention", ...named, ...trial };
  if (state?.status === "reauth-required") return { status: "signin", ...(state.lastPlan ? { tier: state.lastPlan.tier ?? "pro" } : {}) };
  if (state?.status !== "connected" && state?.lastPlan) return { status: "checking", ...named };
  return { status: "none", ...trial };
}
