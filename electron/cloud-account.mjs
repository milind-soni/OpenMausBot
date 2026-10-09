import { createManagedDesktopStore, retryDelay, unreadableRecord } from "./managed-desktop.mjs";
import { CLOUD_MACHINE_CONNECTABLE, parseCloudPurchase, parseCloudSummary, parsePairingGrant } from "./cloud-home.mjs";

export const CLOUD_ORIGIN = "https://cloud.openmausbot.com";
const TOKEN = /^omc_[A-Za-z0-9_-]{43}$/;
const CODE = /^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/;
const PRIVATE_CODE = /^[A-Za-z0-9_-]{43}$/;
const TIER = /^[a-z][a-z0-9-]{0,23}$/;
/** A verified session is asked again this often... */
const REFRESH_MS = 60_000;
/** ...and stays current this long without a newer answer. A check that fails
 * in between keeps it: one dropped request is not news, so the plan, the
 * Cloud card and Connect never blink out. Only a longer outage turns it into
 * "unavailable", and even then the plan last seen is still shown. */
const STEADY_MS = 15 * 60_000;
/** While the Cloud is being set up (or a payment is being linked), progress is asked for this often. */
const SETUP_REFRESH_MS = 15_000;
/** Failed checks in a row before the snapshot quietly says it is checking. */
const CHECKING_AFTER = 2;
/** The longest sign-in window accepted from the Admin (it may allow 15 minutes). */
const MAX_ENROLL_SECONDS = 1800;
// Never accept an address from the renderer. Tests explicitly inject loopback.
export function cloudOrigin(value = CLOUD_ORIGIN, fixture = false) {
  const url = new URL(value);
  if (value !== url.origin || (value !== CLOUD_ORIGIN && !(fixture && url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new Error("Invalid OpenMausBot Cloud address.");
  }
  return value;
}
// Reuse the encrypted, atomic, serialized record mechanism, not organization identity.
// The caller supplies a DIFFERENT file; no entitlement is persisted in this record.
export const createCloudAccountStore = createManagedDesktopStore;
// oxlint-disable-next-line no-control-regex
const text = (value, max) => typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const timestamp = value => Number.isSafeInteger(value) && value > 0;
/** The paid plan last verified for this sign-in, kept beside the credential
 * for display only: what Settings shows while OMB Cloud cannot be asked, or
 * after this computer's sign-in has ended. It activates nothing, and is never
 * an entitlement. */
function planHint(value) {
  if (!value || typeof value !== "object" || typeof value.active !== "boolean") return null;
  return { ...(typeof value.tier === "string" && TIER.test(value.tier) ? { tier: value.tier } : {}), active: value.active };
}
/** The Admin's own answer that this computer's sign-in no longer counts: its
 * JSON "invalid_token" (a page from in between carries no code). */
const signInEnded = error => [401, 403].includes(error?.status) && error.code === "invalid_token";
const sameHint = (left, right) => (left?.tier ?? null) === (right?.tier ?? null) && (left?.active ?? null) === (right?.active ?? null);

/** Personal account only. No model provider, organization policy, workspace,
 * local settings or companion state is changed by this client. */
export function createCloudAccountClient({ store, openBrowser, platform, deviceName, appVersion,
  origin = CLOUD_ORIGIN, fixture = false, fetch: fetcher = globalThis.fetch, now = Date.now, onState = () => {},
  setTimer = setTimeout, clearTimer = clearTimeout, warn = message => console.warn(message) }) {
  origin = cloudOrigin(origin, fixture);
  let grant = null, issued = null, cleanup = null, pending = null, cleanupNeeded = false;
  // "restoring": not yet known whether a saved sign-in exists. Nobody is
  // offered a plan or a sign-in for it (start() settles it).
  let value = { status: "signed-out", message: "restoring" }, generation = 0, timer = null, closed = false, clearing = null, refreshing = null;
  let verifiedUntil = 0, restoring = false, controller = new AbortController(), failures = 0;
  // `plan`: the last verified paid plan of this account (display only); `savedHint`: what the record holds.
  let plan = null, savedHint = null;
  const newerPlans = new Set();
  const lastPlan = () => plan && grant && plan.accountId === grant.account.id ? { ...(plan.tier ? { tier: plan.tier } : {}), active: plan.active } : null;
  const view = (status, message) => {
    const known = status === "connected" ? null : lastPlan();
    return { status, ...(message ? { message } : {}), ...(grant ? { account: grant.account, deviceId: grant.device.id, expiresAt: grant.expiresAt } : {}), ...(known ? { lastPlan: known } : {}) };
  };
  const state = () => {
    if (value.status === "connected") {
      if (grant && grant.expiresAt <= now()) return structuredClone(view("reauth-required", "expired"));
      if (now() >= verifiedUntil) return structuredClone(view("unavailable", "verification-expired"));
      if (failures >= CHECKING_AFTER) return structuredClone({ ...value, checking: true });
    }
    return structuredClone(value);
  };
  const publish = next => { value = next; onState(state()); return state(); };
  const record = (saved, hint) => ({ ...saved, ...(hint ? { planHint: hint } : {}) });
  const stopTimer = () => { if (timer !== null) clearTimer(timer); timer = null; };
  const schedule = (work, delay) => {
    stopTimer();
    if (!closed) { timer = setTimer(() => { timer = null; void work().catch(() => {}); }, Math.max(1, delay)); timer?.unref?.(); }
  };
  const reset = () => { generation++; stopTimer(); controller.abort(); controller = new AbortController(); pending = null; verifiedUntil = 0; failures = 0; return generation; };
  const current = stamp => !closed && generation === stamp;
  async function request(route, { method = "GET", body, token, signal = controller.signal } = {}) {
    const response = await fetcher(`${origin}/api/cloud/desktop/${route}`, {
      method, redirect: "error", credentials: "omit", cache: "no-store",
      headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
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
      // Not an answer from the Admin's API: a route this Admin does not have,
      // or a page from something in between (a firewall or bot check). The
      // status is kept for growDisk; `opaque` keeps it from ending anything.
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
  /** `plan` stays "free" or "pro" (any paid plan); `tier` names the paid plan
   * when the Admin says. A plan newer than this app ("personal", "max") is
   * paid with that tier, never a lockout; a malformed tier is no tier. */
  function entitlement(input) {
    const newer = typeof input?.plan === "string" && !["free", "pro"].includes(input.plan) && TIER.test(input.plan);
    if (!input || !(newer || ["free", "pro"].includes(input.plan)) || !["active", "inactive"].includes(input.status) ||
      !(input.expiresAt === null || timestamp(input.expiresAt)) || !Number.isSafeInteger(input.version) || input.version < 0) throw new Error("Invalid Cloud entitlement.");
    const plan = input.plan === "free" ? "free" : "pro";
    if (input.status === "active" && (plan !== "pro" || input.expiresAt === null || input.expiresAt <= now())) throw new Error("Invalid active Cloud entitlement.");
    if (newer && !newerPlans.has(input.plan)) { newerPlans.add(input.plan); warn(`[cloud] OMB Cloud sent plan "${input.plan}", newer than this app; treating it as paid.`); }
    const tier = typeof input.tier === "string" && TIER.test(input.tier) ? input.tier : newer ? input.plan : undefined;
    return { plan, ...(tier ? { tier } : {}), status: input.status,
      expiresAt: input.expiresAt, version: input.version };
  }
  async function revoke(previous) {
    try { await request("session", { method: "DELETE", body: {}, token: previous.token, signal: AbortSignal.timeout(20_000) }); }
    // Already ended, by the Admin's own answer; a page from in between revoked nothing.
    catch (error) { if (![401, 403].includes(error?.status) || error.opaque) throw error; }
  }
  /** The verified machine to connect to; null unless a current session
   * reports one that is running. */
  function homeTarget() {
    const current = state();
    const machine = current.status === "connected" ? current.machine : undefined;
    return machine?.origin && CLOUD_MACHINE_CONNECTABLE.includes(machine.status) ? { origin: machine.origin } : null;
  }
  /** Forget this computer's sign-in. `quiet`: on the way to signing in
   * again, so "signed out" is never shown in between. */
  function forget({ quiet = false } = {}) {
    if (clearing) return clearing;
    const previous = grant ?? issued ?? cleanup, stamp = reset();
    grant = null; issued = null; cleanup = previous; cleanupNeeded = true; plan = null; savedHint = null;
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
    // A sign-in this computer holds lasts as long as OMB Cloud said; after
    // that, signing in again is the one next step (the plan is unaffected).
    if (grant.expiresAt <= now()) { stopTimer(); return publish(view("reauth-required", "expired")); }
    try {
      const previous = grant, result = await request("session", { token: previous.token });
      if (!current(stamp) || grant !== previous) return state();
      const next = identity(result);
      if (next.device.id !== previous.device.id || next.account.id !== previous.account.id || next.account.email !== previous.account.email || next.expiresAt <= now()) {
        throw Object.assign(new Error("Cloud identity changed."), { status: 401, code: "invalid_token" });
      }
      const access = entitlement(result.entitlement);
      // The Admin's state decides what the machine allows (a lapsed payment
      // is "payment-problem", not a hidden machine). A malformed one is none.
      const machine = parseCloudSummary(result.cloud);
      const purchase = parseCloudPurchase(result.cloud?.purchase);
      const hint = access.plan === "pro" ? { ...(access.tier ? { tier: access.tier } : {}), active: access.status === "active" } : null;
      if (next.expiresAt !== previous.expiresAt) {
        const replacement = { ...previous, expiresAt: next.expiresAt };
        await store.write(record(replacement, hint));
        if (!current(stamp) || grant !== previous) return state();
        grant = replacement; savedHint = hint;
      } else if (!sameHint(savedHint, hint)) {
        // Display only: a locked keychain must not hold up the verified state.
        try { await store.write(record(previous, hint)); savedHint = hint; } catch { /* tried again next time */ }
        if (!current(stamp) || grant !== previous) return state();
      }
      plan = hint ? { accountId: grant.account.id, ...hint } : null;
      failures = 0;
      verifiedUntil = Math.min(grant.expiresAt, now() + STEADY_MS,
        access.status === "active" && access.expiresAt !== null ? access.expiresAt : Infinity);
      publish({ ...view("connected"), entitlement: access, ...(machine ? { machine } : {}), ...(purchase ? { purchase } : {}), verifiedAt: now(), verifiedUntil });
      // The next check comes well before this one stops counting.
      const settingUp = machine?.status === "provisioning" || (access.status === "active" && !machine) || Boolean(purchase);
      schedule(refresh, Math.min(settingUp ? SETUP_REFRESH_MS : REFRESH_MS, verifiedUntil - now()));
    } catch (error) {
      if (!current(stamp)) return state();
      // Only the Admin itself ends a sign-in: its JSON "invalid_token". A
      // 401/403 page from anything in between (Cloudflare, a proxy) is a
      // failed check like any other, never "sign in again".
      if (signInEnded(error)) { verifiedUntil = 0; failures = 0; stopTimer(); return publish(view("reauth-required", "access-ended")); }
      // Not an answer (offline, a timeout, a malformed reply): the last
      // verified snapshot stands while it is current, and is never replaced
      // by what failed. state() says "checking" after repeated failures.
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
  async function poll() {
    const attempt = pending, stamp = generation;
    if (!attempt || !current(stamp)) return state();
    if (now() >= attempt.expiresAt) { pending = null; return publish({ status: "signed-out", message: "enrollment-expired" }); }
    try {
      const result = await request("token", { method: "POST", body: { deviceCode: attempt.deviceCode } });
      const next = validateGrant({ origin, token: result.accessToken, ...identity(result) });
      if (!current(stamp)) { await revoke(next).catch(() => {}); return state(); }
      if (next.expiresAt <= now()) throw new Error("Expired Cloud credential.");
      issued = next;
      await store.write(next);
      if (!current(stamp)) return state();
      grant = next; issued = null; pending = null; savedHint = null;
      if (plan?.accountId !== next.account.id) plan = null;
      return refresh();
    } catch (error) {
      if (!current(stamp)) return state();
      if (issued) return signOut();
      if (error?.code === "slow_down") attempt.interval = Math.min(60_000, Math.max(attempt.interval + 5000, Number.isSafeInteger(error.interval) ? error.interval * 1000 : 0));
      else if (["access_denied", "expired_token", "invalid_grant"].includes(error?.code)) { pending = null; return publish({ status: "signed-out", message: "enrollment-ended" }); }
      else if (error?.status && !error.opaque && error.code !== "authorization_pending" && error.status !== 429) { pending = null; return publish({ status: "signed-out", message: "signin-failed" }); }
      schedule(poll, Math.min(attempt.interval, attempt.expiresAt - now()));
      return state();
    }
  }
  async function begin() {
    if (closed || restoring || clearing || grant || issued || cleanupNeeded) throw new Error("Sign out before starting another Cloud connection.");
    const stamp = reset();
    publish({ status: "connecting" });
    try {
      if (!text(deviceName, 100) || !["darwin", "win32", "linux"].includes(platform)) throw new Error("Invalid desktop.");
      const result = await request("authorize", { method: "POST", body: { deviceName, platform, ...(text(appVersion, 40) ? { appVersion } : {}) } });
      if (!current(stamp)) return state();
      if (result.cloudContractVersion !== 1 || !PRIVATE_CODE.test(result.deviceCode) || !CODE.test(result.userCode) ||
        result.verificationUriComplete !== `${origin}/cloud/desktop?code=${result.userCode}` || !Number.isSafeInteger(result.expiresIn) || result.expiresIn < 1 || result.expiresIn > MAX_ENROLL_SECONDS ||
        !Number.isSafeInteger(result.interval) || result.interval < 5 || result.interval > 60) throw new Error("Invalid Cloud authorization.");
      pending = { deviceCode: result.deviceCode, verificationUri: result.verificationUriComplete, expiresAt: now() + result.expiresIn * 1000, interval: result.interval * 1000 };
      publish({ status: "connecting", enrollment: { userCode: result.userCode, expiresAt: pending.expiresAt } });
      await openBrowser(pending.verificationUri);
      if (current(stamp)) schedule(poll, pending.interval);
    } catch { if (current(stamp)) { pending = null; publish({ status: "signed-out", message: "signin-failed" }); } }
    return state();
  }
  /** The saved sign-in could not be used. One that never will be is removed,
   * and signing in again is the one next step. One that may only be locked
   * (the keychain) is kept, never removed, and read again shortly. */
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
    // Read, but not a sign-in this app can use: as unreadable as a record the key no longer opens.
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
    begin,
    /** After this computer's sign-in ended (it lasts a set time, or was
     * removed): forget it and start a new sign-in in one step, never showing
     * "signed out" in between. */
    async signInAgain() {
      if (state().status !== "reauth-required") throw new Error("This computer is still signed in to OpenMausBot Cloud.");
      publish({ status: "connecting" });
      const forgotten = await forget({ quiet: true });
      if (forgotten.status === "unavailable") return forgotten;
      return begin();
    },
    async reopen() {
      if (pending && value.status === "connecting" && pending.expiresAt > now()) await openBrowser(pending.verificationUri);
      return state();
    },
    cancel: () => pending || value.status === "connecting" ? signOut() : Promise.resolve(state()),
    refresh, signOut,
    async openDashboard() { await openBrowser(`${origin}/cloud`); return state(); },
    homeTarget,
    /** Ask OMB Cloud to grow this account's Cloud disk to `sizeGb` (at most
     * the plan's own maximum), for a move that needs the room now rather than
     * as the disk fills. `supported: false`: this Admin cannot do that yet. */
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
    /** Ask the Admin for one single-use pairing code on that machine. The
     * code is returned to main only, for one navigation; it is not kept. */
    async pairHome() {
      const target = homeTarget(), current = grant;
      if (!target || !current) throw new Error("My Cloud is not ready to connect yet.");
      const result = await request("pairing", { method: "POST", body: {}, token: current.token });
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
    close() { closed = true; reset(); },
  };
}

/** What the person's own Cloud, open in this app's window, may show of the
 * plan in its Settings: the plan's name and whether it is active. Never the
 * account, a credential or an address. */
export function cloudPlanSnapshot(state) {
  const tier = state?.status === "connected" ? state.entitlement?.tier : state?.lastPlan?.tier;
  const named = typeof tier === "string" ? { tier } : {};
  if (state?.status === "connected" && state.entitlement?.plan === "pro") return { status: state.entitlement.status === "active" ? "paid" : "attention", ...named };
  // This computer's sign-in ended: the plan still shows (`tier` "pro" when it
  // had none), and the next step is on the computer, not here.
  if (state?.status === "reauth-required") return { status: "signin", ...(state.lastPlan ? { tier: state.lastPlan.tier ?? "pro" } : {}) };
  if (state?.status !== "connected" && state?.lastPlan) return { status: "checking", ...named };
  return { status: "none" };
}
