import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { parseOrganizationBranding } from "./organization-branding.mjs";
import { libraryCapability, libraryRouteLimits, parseLibraryPointer } from "./org-library.mjs";

const TOKEN = /^omd_[A-Za-z0-9_-]{43}$/;
const UUID = /^[a-f0-9-]{36}$/;
const PROVIDERS = new Set(["anthropic", "openai", "openrouter"]);
const ENGINE = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
const APP_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,39}$/;
const COMPUTERS = ["thisComputer", "localVm", "box", "vps"];
const RENEW_WINDOW_MS = 7 * 86400_000, RENEW_RETRY_MS = 60 * 60_000;
const LIBRARY_PROBE_MS = 10 * 60_000;
export const LICENSE_EXPIRED_CODE = "admin_license_expired";
// oxlint-disable-next-line no-control-regex
const safeText = (value, max) => typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const licenseExpired = error => error?.status === 503 && error?.apiCode === LICENSE_EXPIRED_CODE;

/** Unknown fields are ignored so a newer Admin stays compatible; a malformed known field rejects the whole object. */
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
    sendPolicy(proc, policy) {
      return proc ? post(proc, { type: "openmausbot:managed-desktop-policy", policy }) : Promise.resolve();
    },
    sendIdentity(proc, identity) {
      return proc ? post(proc, { type: "openmausbot:managed-desktop-identity", identity }) : Promise.resolve();
    },
    receive(proc, raw) {
      const message = raw?.data ?? raw;
      if (message?.type !== "openmausbot:managed-desktop-result") return false;
      if (pending.get(message.requestId)?.proc === proc && typeof message.ok === "boolean") settle(message.requestId, !message.ok);
      return true;
    },
    sendLibrary(proc, library) {
      if (!proc) return library ? Promise.reject(new Error("The local bot runtime is not available.")) : Promise.resolve();
      return post(proc, { type: "openmausbot:managed-library", library });
    },
    rejectProcess(proc) { for (const [id, entry] of pending) if (entry.proc === proc) settle(id, true); },
  };
}
export function managedPortalOrigin(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
      !(url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new Error("Enter the exact HTTPS address of your organization's Admin portal.");
  }
  return url.origin;
}

/** Electron 43's safeStorage.decryptStringAsync resolves to { shouldReEncrypt, result }; test fakes resolve to the string. */
export function decryptedText(decrypted) {
  return typeof decrypted === "string" ? decrypted : decrypted?.result;
}

/** Never readable: not a small regular file, a key that no longer opens it (Windows reinstall), or not JSON. A locked keychain is never this. */
export const unreadableRecord = error => error?.code === "unreadable_record";
const unreadable = message => Object.assign(new Error(message), { code: "unreadable_record" });
export const retryDelay = attempt => [15_000, 30_000, 60_000][Math.min(attempt, 3) - 1];

export const MANAGED_TEXT = Object.freeze({
  clearFailed: "The saved company sign-in could not be cleared. Unlock your system keychain and Disconnect again before reconnecting.",
  disconnected: "Disconnected on this computer.",
  runtimeRunning: "The local runtime did not confirm stopping Company tasks. Quit and reopen OpenMausBot before using Company models again.",
  portalUnreachable: "The portal was unreachable; ask your administrator to revoke this device there too.",
  confirmStopped: "Quit and reopen OpenMausBot to confirm Company tasks have stopped.",
  expired: "Your company sign-in expired. Reconnect to continue using company models and backups.",
  accessEnded: "Company access ended or needs a new sign-in. Your personal and local providers are unchanged.",
  retrying: "Can't reach the Admin portal or apply company models. Personal and local providers are still available. We'll retry shortly.",
  codeExpired: "The sign-in code expired. Start again.",
  denied: "Sign-in was denied, expired or already used. Start again on this computer.",
  completeFailed: "Could not complete sign-in. Check your Admin address and start again.",
  removed: "This computer's company sign-in couldn't be read, so it was removed. Sign in again.",
  restoreFailed: "The saved company sign-in can't be read right now. OpenMausBot tries again every minute.",
  startFailed: "Could not start company sign-in. Check the Admin portal address and your connection.",
});
const said = (...codes) => ({ message: codes.map(code => MANAGED_TEXT[code]).join(" "), messageCodes: codes });

/** OS-encrypted; company tokens never go into config.json, backups, renderer storage, environment variables or CLI homes. */
export function createManagedDesktopStore({ file, encryption }) {
  let tail = Promise.resolve();
  const available = async () => {
    if (!(await encryption.available())) throw new Error("Unlock your system keychain before connecting an organization.");
  };
  return {
    async read() {
      let handle;
      try {
        handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 64 * 1024) throw unreadable("Invalid company connection record.");
        await available();
        const encrypted = await handle.readFile();
        let text;
        try { text = decryptedText(await encryption.decrypt(encrypted)); } catch { throw unreadable("This computer can no longer decrypt the record."); }
        // Not unreadable(): an unknown decrypt shape is this app's mistake, and the record must not be removed.
        if (typeof text !== "string") throw new Error("Unexpected decrypt result.");
        try { return JSON.parse(text); } catch { throw unreadable("The record is not JSON."); }
      } catch (error) {
        if (error?.code === "ENOENT") return null;
        throw Object.assign(new Error("Your company connection could not be read. Unlock your system keychain and try again."),
          unreadableRecord(error) ? { code: error.code } : {});
      }
      finally { await handle?.close(); }
    },
    write(value) {
      const operation = tail.catch(() => {}).then(async () => {
        // Forgetting must work while the keychain is locked; the file is removed in the same queue as pending writes.
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
  fetch: fetcher = globalThis.fetch, now = Date.now, onState = () => {}, library = null }) {
  let markRestored;
  const restored = new Promise(resolve => { markRestored = resolve; });
  let grant = null, connection = null, pending = null, state = { status: "signed-out" };
  let renewalCheckedFor = null, lastRenewAttempt = 0, renewalSupported = false, reportedPolicyVersion = null;
  let policyLifted = false, policyRead = false;
  let issuedGrant = null, cleanupGrant = null, cleanupNeeded = false, clearing = null, restoreFailures = 0;
  let generation = 0, timer = null, closed = false, controller = new AbortController(), refreshing = null;
  let branding = parseOrganizationBranding(null);
  let libraryCapableFor = null, libraryCapable = false, lastLibraryProbe = -Infinity;
  const snapshot = () => structuredClone(state);
  const publish = (next) => { state = next; onState(snapshot()); return snapshot(); };
  const stopTimer = () => { if (timer) clearTimeout(timer); timer = null; };
  const schedule = (fn, delay) => {
    stopTimer();
    if (!closed) { timer = setTimeout(() => { timer = null; void fn().catch(() => {}); }, delay); timer.unref?.(); }
  };
  const reset = () => { generation++; stopTimer(); controller.abort(); controller = new AbortController(); pending = null; return generation; };
  const current = stamp => !closed && stamp === generation;
  const view = (status, ...codes) => ({ status, ...(codes.length ? said(...codes) : {}), ...(connection ? {
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
  async function requestBytes(origin, route, { method, body, token, maxBytes, timeoutMs }) {
    const response = await fetcher(`${origin}${route}`, {
      method, redirect: "error", credentials: "omit", cache: "no-store",
      headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }), authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { body }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]),
    });
    const cap = response.ok ? maxBytes : Math.min(maxBytes, 16 * 1024), declared = Number(response.headers.get("content-length") ?? NaN);
    const reader = response.body?.getReader();
    let size = 0, overflow = Number.isFinite(declared) && declared > cap; const chunks = [];
    try {
      if (reader && !overflow) while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength; if (size > cap) { overflow = true; break; }
        chunks.push(value);
      }
      if (overflow) await reader?.cancel().catch(() => {});
    } catch (error) { await reader?.cancel().catch(() => {}); throw error; }
    finally { reader?.releaseLock(); }
    if (!response.ok) {
      let data;
      try { data = overflow ? undefined : JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {}
      const retryAfter = Number(response.headers.get("retry-after") ?? NaN);
      throw Object.assign(new Error("The Admin portal could not complete this request."), { status: response.status,
        apiCode: typeof data?.code === "string" ? data.code : undefined, ...(Number.isFinite(retryAfter) && retryAfter >= 0 ? { retryAfter } : {}) });
    }
    if (overflow) throw new Error("The organization library response is too large.");
    return Buffer.concat(chunks);
  }
  const validateGrant = value => {
    if (!value || managedPortalOrigin(value.portalOrigin) !== value.portalOrigin || !TOKEN.test(value.token) || !UUID.test(value.deviceId) ||
        !UUID.test(value.organizationId) || !safeText(value.email, 320) || !Number.isSafeInteger(value.expiresAt)) throw new Error("Invalid company connection.");
    const policy = parseDesktopPolicy(value.policy), organizationName = value.policy?.organizationName;
    return { portalOrigin: value.portalOrigin, token: value.token, deviceId: value.deviceId, organizationId: value.organizationId, email: value.email, expiresAt: value.expiresAt,
      ...(policy && safeText(organizationName, 100) ? { policy: { ...policy, organizationName } } : {}) };
  };
  /** What the local runtime enforces; never written to config.json. */
  const policyMessage = value => value?.policy && value.expiresAt > now()
    ? { ...value.policy, organizationId: value.organizationId, expiresAt: value.expiresAt } : null;
  const sendPolicy = value => Promise.resolve().then(() => applyPolicy(policyMessage(value))).catch(() => {});
  /** Identity only, never the token. */
  const sendIdentity = value => value ? Promise.resolve().then(() => migrateIdentity({ portalOrigin: value.portalOrigin, organizationId: value.organizationId, email: value.email, deviceId: value.deviceId })).catch(() => {}) : Promise.resolve();
  const report = () => ({ platform, ...(typeof appVersion === "string" && APP_VERSION.test(appVersion) ? { appVersion } : {}),
    ...(grant?.policy ? { policyVersion: grant.policy.version } : {}) });
  /** A rotated token is adopted only once stored, or a restart would come back with a token the portal may reject. */
  const replaceGrant = async (stamp, previous, next) => {
    let persisted = true;
    try { await store.write(next); } catch { persisted = false; }
    if (!persisted && next.token !== previous.token) return;
    if (current(stamp) && grant === previous) grant = next;
  };
  const readConfig = async enrolled => {
    const info = await request(enrolled.portalOrigin, "/api/public/config");
    libraryCapableFor = enrolled.deviceId; libraryCapable = libraryCapability(info);
    return info;
  };
  const libraryIdentity = value => ({ portalOrigin: value.portalOrigin, organizationId: value.organizationId, deviceId: value.deviceId, expiresAt: value.expiresAt });
  const notifyLibrary = call => {
    if (!library) return;
    try { void Promise.resolve(call(library)).catch(() => {}); } catch {}
  };
  async function synchronizeLibrary(stamp, enrolled, pointer) {
    if (libraryCapableFor !== enrolled.deviceId && now() - lastLibraryProbe >= LIBRARY_PROBE_MS) {
      lastLibraryProbe = now();
      await readConfig(enrolled).catch(() => {});
    }
    if (!current(stamp) || grant !== enrolled || !connection) return;
    const capable = libraryCapableFor === enrolled.deviceId ? libraryCapable : null;
    notifyLibrary(target => target.synchronized({ identity: libraryIdentity(enrolled), capable, pointer: capable ? parseLibraryPointer(pointer) : null, generation: stamp }));
  }
  const revokeGrant = async previous => {
    try {
      await request(previous.portalOrigin, "/api/desktop/session", { method: "DELETE", body: {}, token: previous.token, signal: AbortSignal.timeout(20_000) });
    } catch (error) {
      if (error?.status !== 401) throw error;
    }
  };
  function clearConnection() {
    if (clearing) return clearing;
    const previous = grant ?? issuedGrant ?? cleanupGrant, stamp = reset();
    grant = null; issuedGrant = null; connection = null;
    cleanupGrant = previous; cleanupNeeded = true;
    notifyLibrary(target => target.clear());
    const operation = (async () => {
      await sendIdentity(previous);
      // Independent obligations: a stopped runtime must not prevent durable sign-out or portal revocation.
      const [runtime, persisted, revoked] = await Promise.allSettled([
        Promise.resolve().then(() => Promise.all([applyConnection(null), Promise.resolve().then(() => applyPolicy(null)).catch(() => {})])),
        Promise.resolve().then(() => store.write(null)),
        previous ? revokeGrant(previous) : Promise.resolve(),
      ]);
      if (persisted.status === "fulfilled") { cleanupGrant = null; cleanupNeeded = false; }
      if (!current(stamp)) return snapshot();
      const warnings = [];
      if (runtime.status === "rejected") warnings.push("runtimeRunning");
      if (revoked.status === "rejected") warnings.push("portalUnreachable");
      if (persisted.status === "rejected") return publish({ status: "unavailable", ...said("clearFailed", ...warnings) });
      return publish({ status: "signed-out", ...(warnings.length ? said("disconnected", ...warnings) : {}) });
    })().finally(() => { if (clearing === operation) clearing = null; });
    clearing = operation;
    return operation;
  }
  async function endAccess(stamp, code) {
    const codes = [code];
    connection = null; policyLifted = true;
    notifyLibrary(target => target.clear());
    await sendIdentity(grant);
    await Promise.resolve().then(() => applyPolicy(null)).catch(() => {});
    try { await applyConnection(null); }
    catch { codes.push("confirmStopped"); }
    return current(stamp) ? publish({ status: "reauth-required", ...said(...codes) }) : snapshot();
  }
  async function renew(stamp) {
    const enrolled = grant;
    const due = renewalCheckedFor !== enrolled.deviceId || (enrolled.expiresAt - now() < RENEW_WINDOW_MS && now() - lastRenewAttempt >= RENEW_RETRY_MS);
    if (!due) return;
    renewalCheckedFor = enrolled.deviceId; lastRenewAttempt = now();
    let info;
    try { info = await readConfig(enrolled); } catch { return; }
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
      return endAccess(stamp, "expired");
    }
    // A restarted runtime has no policy: restore the saved one before any network call.
    if (grant.policy && !policyLifted) await sendPolicy(grant);
    if (!current(stamp)) return snapshot();
    try {
      await renew(stamp);
      if (!grant || !current(stamp)) return snapshot();
      const result = await request(grant.portalOrigin, "/api/desktop/session", { token: grant.token });
      if (!current(stamp)) return snapshot();
      if (result.desktopContractVersion !== 1 || !/^omg_[A-Za-z0-9_-]{43}$/.test(result.modelAccessToken) || result.device?.id !== grant.deviceId || result.device?.organizationId !== grant.organizationId ||
          result.device?.email !== grant.email || result.organization?.id !== grant.organizationId || !safeText(result.organization?.name, 100) ||
          result.device?.revokedAt !== null || !Number.isSafeInteger(result.device?.expiresAt) || result.device.expiresAt < grant.expiresAt || !Array.isArray(result.providers) || result.providers.length > 3 ||
          new Set(result.providers.map(row => row.id)).size !== result.providers.length || result.providers.some(row => !PROVIDERS.has(row.id) || typeof row.configured !== "boolean" ||
            !Array.isArray(row.models) || row.models.length > 500 || row.models.some(model => typeof model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/:+-]{0,199}$/.test(model) || model.includes("::")))) {
        throw Object.assign(new Error("Company connection identity could not be verified."), { status: 401 });
      }
      // A policy that does not parse keeps the last one applied instead of widening.
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
      if (library) void synchronizeLibrary(stamp, grant, result.library).catch(() => {});
      if (renewalSupported && grant.policy && reportedPolicyVersion !== grant.policy.version) {
        const reported = grant.policy.version, enrolled = grant;
        void request(enrolled.portalOrigin, "/api/desktop/heartbeat", { method: "POST", body: report(), token: enrolled.token })
          .then(() => { if (grant === enrolled) reportedPolicyVersion = reported; }, () => {});
      }
    } catch (error) {
      if (!current(stamp)) return snapshot();
      if (licenseExpired(error)) {
        if (connection && connection.expiresAt > now()) {
          connection = { ...connection, suspended: "license-expired" };
          await applyConnection(connection).catch(() => {});
        }
        await sendPolicy(grant);
        if (!current(stamp)) return snapshot();
        publish(view("license-expired"));
      } else if ([401, 403].includes(error?.status)) {
        return endAccess(stamp, "accessEnded");
      } else {
        if (connection && connection.expiresAt > now()) await applyConnection(connection).catch(() => {});
        await sendPolicy(grant);
        if (!current(stamp)) return snapshot();
        publish(view("unavailable", "retrying"));
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
      return publish({ status: "signed-out", ...said("codeExpired") });
    }
    try {
      const result = await request(attempt.portalOrigin, "/api/desktop/enrollment/token", { method: "POST", body: { deviceCode: attempt.deviceCode } });
      const next = validateGrant({ portalOrigin: attempt.portalOrigin, token: result.accessToken, expiresAt: result.expiresAt,
        deviceId: result.device?.id, organizationId: result.device?.organizationId, email: result.device?.email });
      // Cancellation raced a consumed response: revoke the new capability without persisting or applying it.
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
      else if (error?.code === "authorization_pending") {}
      else if (["access_denied", "expired_token", "invalid_grant"].includes(error?.code)) {
        pending = null;
        return publish({ status: "signed-out", ...said("denied") });
      } else if (error?.status && error.status !== 429) {
        pending = null;
        return publish({ status: "signed-out", ...said("completeFailed") });
      }
      schedule(poll, attempt.interval);
    }
  }
  /** A record that may only be locked in the keychain is kept, never removed, and read again shortly. */
  async function restoreFailed(stamp, unreadable) {
    if (unreadable) {
      const removed = await store.write(null).then(() => true, () => false);
      if (!current(stamp)) return snapshot();
      if (removed) { restoreFailures = 0; return publish({ status: "signed-out", ...said("removed") }); }
    }
    restoreFailures++;
    if (state.message !== MANAGED_TEXT.restoreFailed) publish({ status: "unavailable", ...said("restoreFailed") });
    schedule(start, retryDelay(restoreFailures));
    return snapshot();
  }
  async function start() {
    const stamp = generation;
    let saved, failed = false, unreadable = false;
    try { saved = await store.read(); } catch (error) { failed = true; unreadable = unreadableRecord(error); }
    if (!failed && current(stamp)) try { grant = saved ? validateGrant(saved) : null; } catch { failed = unreadable = true; }
    if (!current(stamp) || failed) { markRestored(); return current(stamp) ? restoreFailed(stamp, unreadable) : snapshot(); }
    restoreFailures = 0;
    // Restore the last policy before any network call.
    if (grant?.policy && grant.expiresAt > now()) await sendPolicy(grant);
    if (library && grant && grant.expiresAt > now()) await Promise.resolve().then(() => library.restore(libraryIdentity(grant))).catch(() => {});
    policyRead = true;
    markRestored();
    await sendIdentity(grant);
    return refresh();
  }
  return {
    state: snapshot,
    start,
    async begin(input) {
      if (clearing) throw new Error("Wait for company sign-out to finish before starting another sign-in.");
      if (closed || grant || issuedGrant || cleanupNeeded) throw new Error("Disconnect your current organization before connecting another.");
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
        if (current(stamp)) { pending = null; publish(licenseExpired(error) ? { status: "signed-out", notice: "license-expired" } : { status: "signed-out", ...said("startFailed") }); }
      }
      return snapshot();
    },
    /** Takes nothing from the renderer, so it can never open another address. */
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
    whenRestored: () => restored,
    /** The saved policy has been read; until then, and while it can't be read, `policy()` is null without meaning "none". */
    policyKnown: () => policyRead,
    policy: () => !policyLifted && grant?.policy && grant.expiresAt > now() ? structuredClone(grant.policy) : null,
    backupGeneration: () => generation,
    /** Fixed first-party backup API only; this function stays in Electron main. */
    async requestBackup(route, options = {}) {
      if (!/^\/api\/desktop\/backups(?:\/[a-f0-9-]{36}(?:\/(?:complete|abort|download|parts\/[0-9]+))?)?$/.test(route)) throw new Error("Unsupported company backup operation.");
      if (options.generation !== undefined && options.generation !== generation) throw new Error("Your organization connection changed during the backup.");
      if (!grant || !connection || grant.expiresAt <= now()) throw new Error("Reconnect your organization before using company backups.");
      const stamp = generation, enrolled = grant;
      const result = await request(enrolled.portalOrigin, route, { method: options.method ?? "GET", body: options.body, token: enrolled.token,
        signal: options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal });
      if (!current(stamp) || grant !== enrolled || enrolled.expiresAt <= now()) throw new Error("Your organization connection changed during the backup.");
      return result;
    },
    /** Fixed library routes only; raw bytes the caller verifies. Electron main only. */
    async fetchLibraryBytes(route, maxBytes, options = {}) {
      const limits = libraryRouteLimits(route);
      if (!limits) throw new Error("Unsupported organization library operation.");
      if (options.generation !== undefined && options.generation !== generation) throw new Error("Your organization connection changed.");
      if (!grant || !connection || grant.expiresAt <= now()) throw new Error("Reconnect your organization before using its library.");
      let body;
      if (limits.method === "POST") {
        body = JSON.stringify(options.body ?? null);
        if (Buffer.byteLength(body) > limits.bodyMaxBytes) throw new Error("The organization library report is too large.");
      }
      const stamp = generation, enrolled = grant;
      const bytes = await requestBytes(enrolled.portalOrigin, route, { method: limits.method, body, token: enrolled.token,
        maxBytes: Math.min(Number.isSafeInteger(maxBytes) && maxBytes > 0 ? maxBytes : limits.maxBytes, limits.maxBytes), timeoutMs: limits.timeoutMs });
      if (!current(stamp) || grant !== enrolled || !connection || enrolled.expiresAt <= now()) throw new Error("Your organization connection changed.");
      return bytes;
    },
    close() { closed = true; reset(); },
  };
}
