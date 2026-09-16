import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { parseOrganizationBranding } from "./organization-branding.mjs";

const TOKEN = /^omd_[A-Za-z0-9_-]{43}$/;
const UUID = /^[a-f0-9-]{36}$/;
const PROVIDERS = new Set(["anthropic", "openai", "openrouter"]);
// Reject control characters in portal-supplied labels and identities.
// oxlint-disable-next-line no-control-regex
const safeText = (value, max) => typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
/** Replies are correlated to the exact owned utility process, not just an id. */
export function createManagedDesktopRelay({ timeoutMs = 15_000 } = {}) {
  const pending = new Map();
  const settle = (id, error) => {
    const entry = pending.get(id); if (!entry) return;
    pending.delete(id); clearTimeout(entry.timer);
    if (error) entry.reject(new Error("Company models could not be connected to the local runtime.")); else entry.resolve();
  };
  return {
    send(proc, connection) {
      if (!proc) return connection ? Promise.reject(new Error("The local bot runtime is not available.")) : Promise.resolve();
      return new Promise((resolve, reject) => {
        const requestId = randomUUID();
        const timer = setTimeout(() => settle(requestId, true), timeoutMs); timer.unref?.();
        pending.set(requestId, { proc, resolve, reject, timer });
        try { proc.postMessage({ type: "openmausbot:managed-desktop", requestId, connection }); }
        catch { settle(requestId, true); }
      });
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

export function createManagedDesktopClient({ store, applyConnection, openBrowser, platform, deviceName,
  fetch: fetcher = globalThis.fetch, now = Date.now, onState = () => {} }) {
  let grant = null, connection = null, pending = null, state = { status: "signed-out" };
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
      code: typeof data?.error === "string" ? data.error : "request_failed", interval: data?.interval });
    return data;
  }
  const validateGrant = value => {
    if (!value || managedPortalOrigin(value.portalOrigin) !== value.portalOrigin || !TOKEN.test(value.token) || !UUID.test(value.deviceId) ||
        !UUID.test(value.organizationId) || !safeText(value.email, 320) || !Number.isSafeInteger(value.expiresAt)) throw new Error("Invalid company connection.");
    return { portalOrigin: value.portalOrigin, token: value.token, deviceId: value.deviceId, organizationId: value.organizationId, email: value.email, expiresAt: value.expiresAt };
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
      // These are independent cleanup obligations. A stopped/unresponsive
      // runtime must not prevent durable sign-out or portal revocation.
      const [runtime, persisted, revoked] = await Promise.allSettled([
        Promise.resolve().then(() => applyConnection(null)),
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
    connection = null;
    try { await applyConnection(null); }
    catch { message += " Quit and reopen OpenMausBot to confirm Company tasks have stopped."; }
    return current(stamp) ? publish({ status: "reauth-required", message }) : snapshot();
  }
  async function synchronize(stamp) {
    if (!grant || !current(stamp)) return snapshot();
    if (grant.expiresAt <= now()) {
      return endAccess(stamp, "Your company sign-in expired. Reconnect to continue using company models and backups.");
    }
    try {
      const result = await request(grant.portalOrigin, "/api/desktop/session", { token: grant.token });
      if (!current(stamp)) return snapshot();
      if (result.desktopContractVersion !== 1 || !/^omg_[A-Za-z0-9_-]{43}$/.test(result.modelAccessToken) || result.device?.id !== grant.deviceId || result.device?.organizationId !== grant.organizationId ||
          result.device?.email !== grant.email || result.organization?.id !== grant.organizationId || !safeText(result.organization?.name, 100) ||
          result.device?.revokedAt !== null || result.device?.expiresAt !== grant.expiresAt || !Array.isArray(result.providers) || result.providers.length > 3 ||
          new Set(result.providers.map(row => row.id)).size !== result.providers.length || result.providers.some(row => !PROVIDERS.has(row.id) || typeof row.configured !== "boolean" ||
            !Array.isArray(row.models) || row.models.length > 500 || row.models.some(model => typeof model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/:+-]{0,199}$/.test(model) || model.includes("::")))) {
        throw Object.assign(new Error("Company connection identity could not be verified."), { status: 401 });
      }
      const next = { ...grant, token: result.modelAccessToken, organizationName: result.organization.name, providers: result.providers.map(({ id, configured, models }) => ({ id, configured, models })) };
      await applyConnection(next);
      if (!current(stamp)) return snapshot();
      connection = next;
      branding = parseOrganizationBranding(result.branding);
      publish({ ...view("connected"), cloudBackups: Boolean(result.cloudBackups) });
    } catch (error) {
      if (!current(stamp)) return snapshot();
      if ([401, 403].includes(error?.status)) {
        return endAccess(stamp, "Company access ended or needs a new sign-in. Your personal and local providers are unchanged.");
      }
      // The portal is unreachable, not revoking. A server process that restarted
      // meanwhile has an empty overlay, so re-apply the cached, unexpired grant
      // rather than leaving Company models missing until the next heartbeat.
      if (connection && connection.expiresAt > now()) await applyConnection(connection).catch(() => {});
      if (!current(stamp)) return snapshot();
      publish(view("unavailable", "Can't reach the Admin portal or apply company models. Personal and local providers are still available. We'll retry shortly."));
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
      try { const saved = await store.read(); if (!current(stamp)) return snapshot(); grant = saved ? validateGrant(saved) : null; }
      catch { return current(stamp) ? publish({ status: "unavailable", message: "Company sign-in could not be restored. Unlock your system keychain and restart OpenMausBot." }) : snapshot(); }
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
        if (info.desktopContractVersion !== 1 || info.capabilities?.desktopEnrollment !== true) throw new Error("Update the Admin portal before connecting this desktop.");
        const result = await request(portalOrigin, "/api/desktop/enrollment", { method: "POST", body: { deviceName, platform } });
        if (!current(stamp)) return snapshot();
        if (!/^[A-Za-z0-9_-]{43}$/.test(result.deviceCode) || !/^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/.test(result.userCode) ||
            result.verificationUriComplete !== `${portalOrigin}/enroll?code=${result.userCode}` || !Number.isSafeInteger(result.expiresIn) || result.expiresIn < 1 || result.expiresIn > 600 ||
            !Number.isSafeInteger(result.interval) || result.interval < 5 || result.interval > 60) throw new Error("Invalid company enrollment response.");
        pending = { portalOrigin, deviceCode: result.deviceCode, expiresAt: now() + result.expiresIn * 1000, interval: result.interval * 1000 };
        publish({ status: "connecting", enrollment: { userCode: result.userCode, verificationUri: result.verificationUriComplete, expiresAt: pending.expiresAt } });
        await openBrowser(result.verificationUriComplete);
        if (current(stamp)) schedule(poll, pending.interval);
      } catch {
        if (current(stamp)) { pending = null; publish({ status: "signed-out", message: "Could not start company sign-in. Check the Admin portal address and your connection." }); }
      }
      return snapshot();
    },
    async cancelEnrollment() {
      return state.status === "connecting" || !grant ? clearConnection() : snapshot();
    },
    refresh,
    disconnect: clearConnection,
    /** Main-process only. Never expose this method through the renderer bridge. */
    connection: () => connection ? structuredClone(connection) : null,
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
