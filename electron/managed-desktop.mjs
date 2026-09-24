import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { parseOrganizationBranding } from "./organization-branding.mjs";

const TOKEN = /^omd_[A-Za-z0-9_-]{43}$/;
const UUID = /^[a-f0-9-]{36}$/;
const PROVIDERS = new Set(["anthropic", "openai", "openrouter"]);
const ENGINE = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
const APP_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,39}$/;
const COMPUTERS = ["thisComputer", "localVm", "box", "vps"];
// Renew on start and whenever fewer than seven days remain; retry hourly.
const RENEW_WINDOW_MS = 7 * 86400_000, RENEW_RETRY_MS = 60 * 60_000;
export const LICENSE_EXPIRED_CODE = "admin_license_expired";
// Reject control characters in portal-supplied labels and identities.
// oxlint-disable-next-line no-control-regex
const safeText = (value, max) => typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const licenseExpired = error => error?.status === 503 && error?.apiCode === LICENSE_EXPIRED_CODE;

/** The organisation's desktop policy from GET /api/desktop/session. Unknown
 * fields are ignored so a newer Admin stays compatible; a malformed known
 * field rejects the whole object rather than applying half of it. */
export function parseDesktopPolicy(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { version, companyModelsOnly, allowedEngines, mcp, computers, remoteAccess } = value;
  const flag = candidate => typeof candidate === "boolean";
  if (!Number.isSafeInteger(version) || version < 0 || !flag(companyModelsOnly) || !flag(remoteAccess) ||
      !(allowedEngines === "all" || (Array.isArray(allowedEngines) && allowedEngines.length <= 64 && allowedEngines.every(id => typeof id === "string" && ENGINE.test(id)))) ||
      !mcp || !flag(mcp.allowCustom) || !Array.isArray(mcp.allowlist) || mcp.allowlist.length > 100 || !mcp.allowlist.every(entry => safeText(entry, 200)) ||
      !computers || !COMPUTERS.every(key => flag(computers[key]))) return null;
  return { version, companyModelsOnly, allowedEngines: allowedEngines === "all" ? "all" : [...allowedEngines],
    mcp: { allowCustom: mcp.allowCustom, allowlist: [...mcp.allowlist] },
    computers: Object.fromEntries(COMPUTERS.map(key => [key, computers[key]])), remoteAccess };
}
/** Replies are correlated to the exact owned utility process, not just an id. */
export function createManagedDesktopRelay({ timeoutMs = 15_000 } = {}) {
  const pending = new Map();
  const settle = (id, error) => {
    const entry = pending.get(id); if (!entry) return;
    pending.delete(id); clearTimeout(entry.timer);
    if (error) entry.reject(new Error("Company models could not be connected to the local runtime.")); else entry.resolve();
  };
  const post = (proc, message) => new Promise((resolve, reject) => {
    const requestId = randomUUID();
    const timer = setTimeout(() => settle(requestId, true), timeoutMs); timer.unref?.();
    pending.set(requestId, { proc, resolve, reject, timer });
    try { proc.postMessage({ ...message, requestId }); }
    catch { settle(requestId, true); }
  });
  return {
    send(proc, connection) {
      if (!proc) return connection ? Promise.reject(new Error("The local bot runtime is not available.")) : Promise.resolve();
      return post(proc, { type: "openmausbot:managed-desktop", connection });
    },
    /** The runtime has no policy until it starts; its ready hook refreshes. */
    sendPolicy(proc, policy) {
      return proc ? post(proc, { type: "openmausbot:managed-desktop-policy", policy }) : Promise.resolve();
    },
    /** A saved enrollment's identity (no token) so its old ids can migrate. */
    sendIdentity(proc, identity) {
      return proc ? post(proc, { type: "openmausbot:managed-desktop-identity", identity }) : Promise.resolve();
    },
    receive(proc, raw) {
      const message = raw?.data ?? raw;
      if (message?.type !== "openmausbot:managed-desktop-result") return false;
      if (pending.get(message.requestId)?.proc === proc && typeof message.ok === "boolean") settle(message.requestId, !message.ok);
      return true;
    },
    rejectProcess(proc) { for (const [id, entry] of pending) if (entry.proc === proc) settle(id, true); },
  };
}
export function managedPortalOrigin(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
      !(url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new Error("Enter the exact HTTPS address of your organisation's Admin portal.");
  }
  return url.origin;
}

/** A separate OS-encrypted record; never copy company tokens into config.json,
 * backups, renderer storage, environment variables or personal CLI homes. */
export function createManagedDesktopStore({ file, encryption }) {
  let tail = Promise.resolve();
  const available = async () => {
    if (!(await encryption.available())) throw new Error("Unlock your system keychain before connecting an organisation.");
  };
  return {
    async read() {
      let handle;
      try {
        handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 64 * 1024) throw new Error("Invalid company connection record.");
        await available();
        return JSON.parse(await encryption.decrypt(await handle.readFile()));
      } catch (error) { if (error?.code === "ENOENT") return null; throw new Error("Your company connection could not be read. Unlock your system keychain and try again."); }
      finally { await handle?.close(); }
    },
    write(value) {
      const operation = tail.catch(() => {}).then(async () => {
        // Forgetting a capability must work even while the keychain is locked.
        // This exact owned file is removed in the same queue as pending writes.
        if (value === null) {
          try { await fs.unlink(file); } catch (error) { if (error?.code !== "ENOENT") throw error; }
          return;
        }
        await available();
        await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        const temporary = `${file}.${randomUUID()}.tmp`;
        try {
          const encrypted = await encryption.encrypt(JSON.stringify(value));
          const handle = await fs.open(temporary, "wx", 0o600);
          try { await handle.writeFile(encrypted); await handle.sync(); } finally { await handle.close(); }
          await fs.rename(temporary, file);
        } finally { await fs.rm(temporary, { force: true }); }
      });
      tail = operation;
      return operation;
    },
  };
}

export function createManagedDesktopClient({ store, applyConnection, applyPolicy = async () => {}, migrateIdentity = async () => {}, openBrowser, platform, deviceName, appVersion,
  fetch: fetcher = globalThis.fetch, now = Date.now, onState = () => {} }) {
  // Resolves once the saved enrollment (and its policy) has been read.
  let markRestored;
  const restored = new Promise(resolve => { markRestored = resolve; });
  let grant = null, connection = null, pending = null, state = { status: "signed-out" };
  // Renewal is additive: only an Admin advertising deviceRenewal is asked.
  let renewalCheckedFor = null, lastRenewAttempt = 0, renewalSupported = false, reportedPolicyVersion = null;
  // Revocation or expiry lifts the policy with company access, even though the
  // saved grant stays until the person disconnects.
  let policyLifted = false;
  let issuedGrant = null, cleanupGrant = null, cleanupNeeded = false, clearing = null;
  let generation = 0, timer = null, closed = false, controller = new AbortController(), refreshing = null;
  let branding = parseOrganizationBranding(null);
  const snapshot = () => structuredClone(state);
  const publish = (next) => { state = next; onState(snapshot()); return snapshot(); };
  const stopTimer = () => { if (timer) clearTimeout(timer); timer = null; };
  const schedule = (fn, delay) => {
    stopTimer();
    if (!closed) { timer = setTimeout(() => { timer = null; void fn().catch(() => {}); }, delay); timer.unref?.(); }
  };
  const reset = () => { generation++; stopTimer(); controller.abort(); controller = new AbortController(); pending = null; return generation; };
  const current = stamp => !closed && stamp === generation;
  const view = (status, message) => ({ status, ...(message ? { message } : {}), ...(connection ? {
    organization: { id: connection.organizationId, name: connection.organizationName }, email: connection.email,
    deviceId: connection.deviceId, expiresAt: connection.expiresAt,
    branding,
    providers: connection.providers.map(({ id, configured, models }) => ({ id, configured, models: [...models] })),
    cloudBackups: state.cloudBackups ?? false,
  } : {}) });
  async function request(origin, route, { method = "GET", body, token, signal = controller.signal } = {}) {
    const response = await fetcher(`${origin}${route}`, {
      method, redirect: "error", credentials: "omit", cache: "no-store",
      headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    });
    const reader = response.body?.getReader();
    let size = 0; const chunks = [];
    try {
      if (reader) while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength; if (size > 512 * 1024) throw new Error("Company response is too large.");
        chunks.push(value);
      }
    } catch (error) { await reader?.cancel().catch(() => {}); throw error; }
    finally { reader?.releaseLock(); }
    let data;
    try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("The Admin portal returned an invalid response."); }
    if (!response.ok) throw Object.assign(new Error("The Admin portal could not complete this request."), { status: response.status,
      code: typeof data?.error === "string" ? data.error : "request_failed", apiCode: typeof data?.code === "string" ? data.code : undefined, interval: data?.interval });
    return data;
  }
  const validateGrant = value => {
    if (!value || managedPortalOrigin(value.portalOrigin) !== value.portalOrigin || !TOKEN.test(value.token) || !UUID.test(value.deviceId) ||
        !UUID.test(value.organizationId) || !safeText(value.email, 320) || !Number.isSafeInteger(value.expiresAt)) throw new Error("Invalid company connection.");
    // The last applied policy is kept with the OS-encrypted grant so it still
    // holds after an offline restart, until this credential expires.
    const policy = parseDesktopPolicy(value.policy), organizationName = value.policy?.organizationName;
    return { portalOrigin: value.portalOrigin, token: value.token, deviceId: value.deviceId, organizationId: value.organizationId, email: value.email, expiresAt: value.expiresAt,
      ...(policy && safeText(organizationName, 100) ? { policy: { ...policy, organizationName } } : {}) };
  };
  /** What the local runtime enforces; never written to config.json. */
  const policyMessage = value => value?.policy && value.expiresAt > now()
    ? { ...value.policy, organizationId: value.organizationId, expiresAt: value.expiresAt } : null;
  const sendPolicy = value => Promise.resolve().then(() => applyPolicy(policyMessage(value))).catch(() => {});
  /** Lets the runtime move references to this enrollment's old device-scoped
   * ids before the grant is cleared or after it expired. Never the token. */
  const sendIdentity = value => value ? Promise.resolve().then(() => migrateIdentity({ portalOrigin: value.portalOrigin, organizationId: value.organizationId, email: value.email, deviceId: value.deviceId })).catch(() => {}) : Promise.resolve();
  const report = () => ({ platform, ...(typeof appVersion === "string" && APP_VERSION.test(appVersion) ? { appVersion } : {}),
    ...(grant?.policy ? { policyVersion: grant.policy.version } : {}) });
  /** Persist a newer grant (renewal, adopted expiry, new policy) before using
   * it. A rotated token is adopted only once it is safely stored: otherwise a
   * restart would come back with a token the portal may no longer accept. */
  const replaceGrant = async (stamp, previous, next) => {
    let persisted = true;
    try { await store.write(next); } catch { persisted = false; }
    if (!persisted && next.token !== previous.token) return;
    if (current(stamp) && grant === previous) grant = next;
  };
  const revokeGrant = async previous => {
    try {
      await request(previous.portalOrigin, "/api/desktop/session", { method: "DELETE", body: {}, token: previous.token, signal: AbortSignal.timeout(20_000) });
    } catch (error) {
      // An expired or already revoked device is no longer usable either.
      if (error?.status !== 401) throw error;
    }
  };
  function clearConnection() {
    if (clearing) return clearing;
    const previous = grant ?? issuedGrant ?? cleanupGrant, stamp = reset();
    grant = null; issuedGrant = null; connection = null;
    cleanupGrant = previous; cleanupNeeded = true;
    const operation = (async () => {
      await sendIdentity(previous);
      // These are independent cleanup obligations. A stopped/unresponsive
      // runtime must not prevent durable sign-out or portal revocation.
      const [runtime, persisted, revoked] = await Promise.allSettled([
        Promise.resolve().then(() => Promise.all([applyConnection(null), Promise.resolve().then(() => applyPolicy(null)).catch(() => {})])),
        Promise.resolve().then(() => store.write(null)),
        previous ? revokeGrant(previous) : Promise.resolve(),
      ]);
      if (persisted.status === "fulfilled") { cleanupGrant = null; cleanupNeeded = false; }
      if (!current(stamp)) return snapshot();
      const warnings = [];
      if (runtime.status === "rejected") warnings.push("The local runtime did not confirm stopping Company tasks. Quit and reopen OpenMausBot before using Company models again.");
      if (revoked.status === "rejected") warnings.push("The portal was unreachable; ask your administrator to revoke this device there too.");
      if (persisted.status === "rejected") return publish({ status: "unavailable", message: [
        "The saved company sign-in could not be cleared. Unlock your system keychain and Disconnect again before reconnecting.", ...warnings,
      ].join(" ") });
      return publish({ status: "signed-out", ...(warnings.length ? { message: ["Disconnected on this computer.", ...warnings].join(" ") } : {}) });
    })().finally(() => { if (clearing === operation) clearing = null; });
    clearing = operation;
    return operation;
  }
  async function endAccess(stamp, message) {
    connection = null; policyLifted = true;
    await sendIdentity(grant);
    await Promise.resolve().then(() => applyPolicy(null)).catch(() => {});
    try { await applyConnection(null); }
    catch { message += " Quit and reopen OpenMausBot to confirm Company tasks have stopped."; }
    return current(stamp) ? publish({ status: "reauth-required", message }) : snapshot();
  }
  /** Renew once per start and when fewer than seven days remain, only when
   * the Admin advertises it. Same deviceId; a rotated token is stored
   * OS-encrypted before use. Any failure leaves the current grant in place. */
  async function renew(stamp) {
    const enrolled = grant;
    const due = renewalCheckedFor !== enrolled.deviceId || (enrolled.expiresAt - now() < RENEW_WINDOW_MS && now() - lastRenewAttempt >= RENEW_RETRY_MS);
    if (!due) return;
    renewalCheckedFor = enrolled.deviceId; lastRenewAttempt = now();
    let info;
    try { info = await request(enrolled.portalOrigin, "/api/public/config"); } catch { return; }
    renewalSupported = Number.isSafeInteger(info?.capabilities?.deviceRenewal) && info.capabilities.deviceRenewal >= 1;
    if (!current(stamp) || grant !== enrolled || !renewalSupported) return;
    let result;
    try { result = await request(enrolled.portalOrigin, "/api/desktop/session/renew", { method: "POST", body: report(), token: enrolled.token }); }
    catch (error) { if (licenseExpired(error)) throw error; return; }
    if (!current(stamp) || grant !== enrolled || result?.device?.id !== enrolled.deviceId || result.device?.organizationId !== enrolled.organizationId ||
        result.device?.email !== enrolled.email || !Number.isSafeInteger(result.expiresAt) || result.expiresAt < enrolled.expiresAt) return;
    reportedPolicyVersion = enrolled.policy?.version ?? null;
    const token = typeof result.accessToken === "string" && TOKEN.test(result.accessToken) ? result.accessToken : enrolled.token;
    if (result.expiresAt !== enrolled.expiresAt || token !== enrolled.token) await replaceGrant(stamp, enrolled, { ...enrolled, token, expiresAt: result.expiresAt });
  }
  async function synchronize(stamp) {
    if (!grant || !current(stamp)) return snapshot();
    if (grant.expiresAt <= now()) {
      return endAccess(stamp, "Your company sign-in expired. Reconnect to continue using company models and backups.");
    }
    // A restarted runtime has no policy: restore the saved one before any
    // network call, which can take a while.
    if (grant.policy && !policyLifted) await sendPolicy(grant);
    if (!current(stamp)) return snapshot();
    try {
      await renew(stamp);
      if (!grant || !current(stamp)) return snapshot();
      const result = await request(grant.portalOrigin, "/api/desktop/session", { token: grant.token });
      if (!current(stamp)) return snapshot();
      // A later expiry than ours means a renewal we did not get to save.
      if (result.desktopContractVersion !== 1 || !/^omg_[A-Za-z0-9_-]{43}$/.test(result.modelAccessToken) || result.device?.id !== grant.deviceId || result.device?.organizationId !== grant.organizationId ||
          result.device?.email !== grant.email || result.organization?.id !== grant.organizationId || !safeText(result.organization?.name, 100) ||
          result.device?.revokedAt !== null || !Number.isSafeInteger(result.device?.expiresAt) || result.device.expiresAt < grant.expiresAt || !Array.isArray(result.providers) || result.providers.length > 3 ||
          new Set(result.providers.map(row => row.id)).size !== result.providers.length || result.providers.some(row => !PROVIDERS.has(row.id) || typeof row.configured !== "boolean" ||
            !Array.isArray(row.models) || row.models.length > 500 || row.models.some(model => typeof model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/:+-]{0,199}$/.test(model) || model.includes("::")))) {
        throw Object.assign(new Error("Company connection identity could not be verified."), { status: 401 });
      }
      // An Admin without policies sends none: nothing is restricted. A policy
      // that does not parse keeps the last one applied instead of widening.
      const policy = result.policy === undefined ? null : parseDesktopPolicy(result.policy) ?? grant.policy ?? null;
      const known = policy ? { ...policy, organizationName: result.organization.name } : undefined;
      if (result.device.expiresAt !== grant.expiresAt || JSON.stringify(known) !== JSON.stringify(grant.policy)) {
        const { policy: _previous, ...identity } = grant;
        await replaceGrant(stamp, grant, { ...identity, expiresAt: result.device.expiresAt, ...(known ? { policy: known } : {}) });
        if (!current(stamp)) return snapshot();
      }
      const { policy: _policy, ...access } = grant;
      const next = { ...access, token: result.modelAccessToken, organizationName: result.organization.name, providers: result.providers.map(({ id, configured, models }) => ({ id, configured, models })) };
      await applyConnection(next);
      if (!current(stamp)) return snapshot();
      policyLifted = false;
      await sendPolicy(grant);
      if (!current(stamp)) return snapshot();
      connection = next;
      branding = parseOrganizationBranding(result.branding);
      publish({ ...view("connected"), cloudBackups: Boolean(result.cloudBackups) });
      // Tell Admin promptly which policy this desktop now applies.
      if (renewalSupported && grant.policy && reportedPolicyVersion !== grant.policy.version) {
        const reported = grant.policy.version, enrolled = grant;
        void request(enrolled.portalOrigin, "/api/desktop/heartbeat", { method: "POST", body: report(), token: enrolled.token })
          .then(() => { if (grant === enrolled) reportedPolicyVersion = reported; }, () => {});
      }
    } catch (error) {
      if (!current(stamp)) return snapshot();
      if (licenseExpired(error)) {
        // The operator's licence lapsed: not a revocation and not a reason to
        // sign in again. Company models stay listed but unavailable; the last
        // policy still holds; the heartbeat keeps checking for the renewal.
        if (connection && connection.expiresAt > now()) {
          connection = { ...connection, suspended: "license-expired" };
          await applyConnection(connection).catch(() => {});
        }
        await sendPolicy(grant);
        if (!current(stamp)) return snapshot();
        publish(view("license-expired"));
      } else if ([401, 403].includes(error?.status)) {
        return endAccess(stamp, "Company access ended or needs a new sign-in. Your personal and local providers are unchanged.");
      } else {
        // The portal is unreachable, not revoking. A server process that restarted
        // meanwhile has an empty overlay, so re-apply the cached, unexpired grant
        // rather than leaving Company models missing until the next heartbeat.
        if (connection && connection.expiresAt > now()) await applyConnection(connection).catch(() => {});
        await sendPolicy(grant);
        if (!current(stamp)) return snapshot();
        publish(view("unavailable", "Can't reach the Admin portal or apply company models. Personal and local providers are still available. We'll retry shortly."));
      }
    }
    if (current(stamp)) schedule(() => refresh(), Math.max(1000, Math.min(60_000, grant.expiresAt - now())));
    return snapshot();
  }
  function refresh() {
    if (clearing) return clearing;
    if (refreshing?.generation === generation) return refreshing.operation;
    const entry = { generation, operation: null };
    const operation = synchronize(generation).finally(() => { if (refreshing === entry) refreshing = null; });
    entry.operation = operation; refreshing = entry;
    return operation;
  }
  async function poll() {
    const attempt = pending, stamp = generation;
    if (!attempt || !current(stamp)) return;
    if (attempt.expiresAt <= now()) {
      pending = null;
      return publish({ status: "signed-out", message: "The sign-in code expired. Start again." });
    }
    try {
      const result = await request(attempt.portalOrigin, "/api/desktop/enrollment/token", { method: "POST", body: { deviceCode: attempt.deviceCode } });
      const next = validateGrant({ portalOrigin: attempt.portalOrigin, token: result.accessToken, expiresAt: result.expiresAt,
        deviceId: result.device?.id, organizationId: result.device?.organizationId, email: result.device?.email });
      // If cancellation raced a consumed response, dispose of the exact new
      // capability without ever persisting or applying it to a newer attempt.
      if (!current(stamp)) { await revokeGrant(next).catch(() => {}); return; }
      if (next.expiresAt <= now()) throw new Error("Expired company connection.");
      issuedGrant = next;
      await store.write(next);
      if (!current(stamp)) return;
      grant = next; issuedGrant = null; pending = null;
      return await refresh();
    } catch (error) {
      if (!current(stamp)) return;
      if (issuedGrant) return clearConnection();
      if (error?.code === "slow_down" && Number.isSafeInteger(error.interval)) attempt.interval = Math.max(attempt.interval + 5000, Math.min(60_000, error.interval * 1000));
      else if (error?.code === "authorization_pending") { /* Keep the browser consent screen open. */ }
      else if (["access_denied", "expired_token", "invalid_grant"].includes(error?.code)) {
        pending = null;
        return publish({ status: "signed-out", message: "Sign-in was denied, expired or already used. Start again on this computer." });
      } else if (error?.status && error.status !== 429) {
        pending = null;
        return publish({ status: "signed-out", message: "Could not complete sign-in. Check your Admin address and start again." });
      }
      schedule(poll, attempt.interval);
    }
  }
  return {
    state: snapshot,
    async start() {
      const stamp = generation;
      try { const saved = await store.read(); if (!current(stamp)) { markRestored(); return snapshot(); } grant = saved ? validateGrant(saved) : null; }
      catch { markRestored(); return current(stamp) ? publish({ status: "unavailable", message: "Company sign-in could not be restored. Unlock your system keychain and restart OpenMausBot." }) : snapshot(); }
      // Restore the organisation's last policy before any network call, and
      // move references to this enrollment's old device-scoped ids.
      if (grant?.policy && grant.expiresAt > now()) await sendPolicy(grant);
      markRestored();
      await sendIdentity(grant);
      return refresh();
    },
    async begin(input) {
      if (clearing) throw new Error("Wait for company sign-out to finish before starting another sign-in.");
      if (closed || grant || issuedGrant || cleanupNeeded) throw new Error("Disconnect your current organisation before connecting another.");
      const portalOrigin = managedPortalOrigin(input?.portalOrigin);
      if (!safeText(deviceName, 100) || !["darwin", "win32", "linux"].includes(platform)) throw new Error("This desktop platform is not supported.");
      const stamp = reset();
      publish({ status: "connecting" });
      try {
        const info = await request(portalOrigin, "/api/public/config");
        if (!current(stamp)) return snapshot();
        if (info.license?.state === "expired") { pending = null; return publish({ status: "signed-out", notice: "license-expired" }); }
        if (info.desktopContractVersion !== 1 || info.capabilities?.desktopEnrollment !== true) throw new Error("Update the Admin portal before connecting this desktop.");
        const result = await request(portalOrigin, "/api/desktop/enrollment", { method: "POST", body: { deviceName, platform } });
        if (!current(stamp)) return snapshot();
        if (!/^[A-Za-z0-9_-]{43}$/.test(result.deviceCode) || !/^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/.test(result.userCode) ||
            result.verificationUriComplete !== `${portalOrigin}/enroll?code=${result.userCode}` || !Number.isSafeInteger(result.expiresIn) || result.expiresIn < 1 || result.expiresIn > 600 ||
            !Number.isSafeInteger(result.interval) || result.interval < 5 || result.interval > 60) throw new Error("Invalid company enrollment response.");
        pending = { portalOrigin, deviceCode: result.deviceCode, expiresAt: now() + result.expiresIn * 1000, interval: result.interval * 1000,
          verificationUri: result.verificationUriComplete };
        publish({ status: "connecting", enrollment: { userCode: result.userCode, verificationUri: result.verificationUriComplete, expiresAt: pending.expiresAt } });
        await openBrowser(result.verificationUriComplete);
        if (current(stamp)) schedule(poll, pending.interval);
      } catch (error) {
        if (current(stamp)) { pending = null; publish(licenseExpired(error) ? { status: "signed-out", notice: "license-expired" } : { status: "signed-out", message: "Could not start company sign-in. Check the Admin portal address and your connection." }); }
      }
      return snapshot();
    },
    /** Opens this attempt's own validated sign-in page again, for a closed
     * browser tab. It takes nothing from the renderer, so it can never open
     * another address, and does nothing once the attempt ends or expires. */
    async reopen() {
      const attempt = pending, stamp = generation;
      if (!attempt?.verificationUri || !current(stamp) || state.status !== "connecting" || attempt.expiresAt <= now()) return snapshot();
      await openBrowser(attempt.verificationUri);
      return snapshot();
    },
    async cancelEnrollment() {
      return state.status === "connecting" || !grant ? clearConnection() : snapshot();
    },
    refresh,
    disconnect: clearConnection,
    /** Main-process only. Never expose this method through the renderer bridge. */
    connection: () => connection ? structuredClone(connection) : null,
    /** Resolves after start() has read the saved enrollment. */
    whenRestored: () => restored,
    /** The organisation's applied policy while the credential lasts, else null. */
    policy: () => !policyLifted && grant?.policy && grant.expiresAt > now() ? structuredClone(grant.policy) : null,
    backupGeneration: () => generation,
    /** Fixed first-party backup API only; this function stays in Electron main. */
    async requestBackup(route, options = {}) {
      if (!/^\/api\/desktop\/backups(?:\/[a-f0-9-]{36}(?:\/(?:complete|abort|download|parts\/[0-9]+))?)?$/.test(route)) throw new Error("Unsupported company backup operation.");
      if (options.generation !== undefined && options.generation !== generation) throw new Error("Your organisation connection changed during the backup.");
      if (!grant || !connection || grant.expiresAt <= now()) throw new Error("Reconnect your organisation before using company backups.");
      const stamp = generation, enrolled = grant;
      const result = await request(enrolled.portalOrigin, route, { method: options.method ?? "GET", body: options.body, token: enrolled.token,
        signal: options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal });
      if (!current(stamp) || grant !== enrolled || enrolled.expiresAt <= now()) throw new Error("Your organisation connection changed during the backup.");
      return result;
    },
    close() { closed = true; reset(); },
  };
}
