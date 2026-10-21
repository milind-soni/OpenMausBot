import { createDesktopIncludedX } from "./included-x.mjs";

// Security: the relay token is kept in memory only, never on disk.

const CATALOG_MS = 6 * 3600_000;
const RETRY_MS = 5 * 60_000;
const RENEW_BEFORE_MS = 15 * 60_000;
/** Each token request can mint a token row on the Admin, so failed ones are spaced out. */
const ACCESS_RETRY_MS = [60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000];

const deviceOf = (state) => (state?.status === "connected" && typeof state.deviceId === "string" ? state.deviceId : null);
const keyOf = (state) => (deviceOf(state) ? `${deviceOf(state)}@${state.entitlement?.version ?? ""}` : null);
const unlocked = (catalog) => catalog?.sections?.find?.((section) => section?.id === "science")?.locked === false;

/**
 * @param {{ fetchCatalog: () => Promise<object | null>,
 *   fetchAccess: () => Promise<{ url: string; token: string; expiresAt: number } | null>,
 *   send: (message: object) => void, now?: () => number }} options
 */
export function createIncludedScienceSync({ fetchCatalog, fetchAccess, send, now = Date.now }) {
  /** @type {{ key: string; catalog: object; at: number } | null} */
  let catalog = null;
  /** @type {{ access: { url: string; token: string; expiresAt: number } } | null} */
  let held = null;
  let refused = null;
  /** @type {{ key: string; at: number } | null} */
  let failed = null;
  /** @type {{ key: string; at: number; count: number } | null} */
  let accessFailed = null;
  let latest = null;
  /** @type {Promise<void> | null} */
  let inflight = null;
  let clearable = false;
  const sendCatalog = (value) => send({ type: "openmausbot:science-catalog", catalog: value });
  const sendAccess = (access, note) => send({ type: "openmausbot:included-science", access, ...(note?.offered === false ? { offered: false } : {}) });
  const stale = (key) => keyOf(latest) !== key;

  const step = async (key) => {
    if (!catalog || catalog.key !== key || now() - catalog.at >= CATALOG_MS) {
      const waiting = failed?.key === key && now() - failed.at < RETRY_MS;
      if (!waiting) {
        let fetched;
        try { fetched = await fetchCatalog(); } catch { fetched = null; }
        if (stale(key)) return;
        if (fetched) {
          failed = null;
          if (catalog?.key !== key) refused = null;
          catalog = { key, catalog: fetched, at: now() };
          clearable = true;
          sendCatalog(fetched);
        } else failed = { key, at: now() };
      }
      if (!catalog || catalog.key !== key) return;
    }
    if (!unlocked(catalog.catalog)) {
      if (held) { held = null; sendAccess(null); }
      return;
    }
    if (refused === key || (held && held.access.expiresAt - now() > RENEW_BEFORE_MS)) return;
    if (accessFailed?.key === key && now() - accessFailed.at < ACCESS_RETRY_MS[Math.min(accessFailed.count, ACCESS_RETRY_MS.length) - 1]) return;
    let access;
    try { access = await fetchAccess(); } catch {
      if (!stale(key)) accessFailed = { key, at: now(), count: accessFailed?.key === key ? accessFailed.count + 1 : 1 };
      return;
    }
    if (stale(key)) return;
    accessFailed = null;
    clearable = true;
    if (access) { held = { access }; refused = null; sendAccess(access); }
    else { held = null; refused = key; sendAccess(null, { offered: false }); }
  };

  const onState = async (state) => {
    latest = state;
    const key = keyOf(state);
    if (!key) {
      if (clearable) { sendCatalog(null); sendAccess(null); }
      catalog = null; held = null; refused = null; failed = null; accessFailed = null; clearable = false;
      return;
    }
    if (inflight) return inflight;
    inflight = step(key).finally(() => { inflight = null; });
    await inflight;
    if (latest !== state && keyOf(latest) && keyOf(latest) !== key) await onState(latest);
  };

  return {
    onState,
    /** The local server (re)started and holds nothing yet. */
    serverStarted() {
      if (catalog) sendCatalog(catalog.catalog);
      if (held) sendAccess(held.access);
    },
  };
}

/**
 * The X research and science syncs posting to whichever local server is running, over the private parent port.
 * @param {{ account: () => { xResearchAccess(): Promise<unknown>, scienceCatalog(): Promise<object | null>, scienceAccess(): Promise<unknown> } | null,
 *   server: () => { postMessage(message: unknown): void } | null, log: (line: string) => void }} options
 */
export function createDesktopIncludedServices({ account, server, log }) {
  const x = createDesktopIncludedX({ account, server, log });
  const science = createIncludedScienceSync({
    fetchCatalog: () => account()?.scienceCatalog() ?? Promise.resolve(null),
    fetchAccess: () => account()?.scienceAccess() ?? Promise.resolve(null),
    send: (message) => {
      const proc = server();
      if (!proc) return;
      try { proc.postMessage(message); }
      catch (error) { log(`Science sync failed: ${error?.message ?? error}`); }
    },
  });
  return {
    onState: (state) => Promise.all([x.onState(state), science.onState(state)]).then(() => {}),
    serverStarted() { x.serverStarted(); science.serverStarted(); },
  };
}
