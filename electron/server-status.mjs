// How each server saved by hand is doing, for Settings → Servers: connected, reconnecting after a passing problem, or
// blocked on something only the person can fix. Clouds and teams are the Admin's to report, never checked here.
import { allowedServerOrigin } from "./server-address.mjs";

export const RECONNECT = Object.freeze({ baseMs: 2_000, capMs: 300_000, healthyMs: 60_000, cantReachAfterMs: 120_000, timeoutMs: 15_000, refocusMs: 5_000 });
const INSTALLS = new Set(["npx", "global", "docker", "source"]);

/** Equal jitter: half of the doubled wait for sure, the other half at random, never past the cap. */
export function reconnectDelay(attempt, random = Math.random, { baseMs, capMs } = RECONNECT) {
  const ceiling = Math.min(capMs, baseMs * 2 ** Math.min(attempt, 30));
  return Math.round(ceiling / 2 + (random() * ceiling) / 2);
}

const release = (version) => {
  const parts = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? ""));
  return parts ? parts.slice(1).map(Number) : null;
};

/** Whether `server` is an older release than `app`; an unknown version is never called behind. */
export function versionBehind(server, app) {
  const [ours, theirs] = [release(app), release(server)];
  if (!ours || !theirs) return false;
  for (let index = 0; index < 3; index++) if (theirs[index] !== ours[index]) return theirs[index] < ours[index];
  return false;
}

/**
 * One look at a saved server: `{ kind: "ok", version, install }`; `{ kind: "transient" }` for the network, a timeout or
 * a server restarting; `{ kind: "blocked", reason }` for a session it no longer takes (signedOut) or an address on the
 * open internet over plain http (insecure), where nothing is sent at all.
 */
export async function checkServer(origin, fetchImpl, timeoutMs = RECONNECT.timeoutMs) {
  if (!allowedServerOrigin(origin)) return { kind: "blocked", reason: "insecure" };
  const get = (path, init = {}) => fetchImpl(`${origin}${path}`, { redirect: "error", cache: "no-store", signal: AbortSignal.timeout(timeoutMs), ...init });
  try {
    const described = await get("/.well-known/openmausbot/environment", { credentials: "omit" });
    const body = described.ok ? await described.json().catch(() => null) : null;
    if (typeof body?.environmentId !== "string") return { kind: "transient" };
    const session = await get("/api/auth/session", { credentials: "include", headers: { origin } });
    await session.body?.cancel?.().catch(() => {});
    if (session.status === 401 || session.status === 403) return { kind: "blocked", reason: "signedOut" };
    if (!session.ok) return { kind: "transient" };
    const install = body.capabilities?.install;
    return { kind: "ok", version: typeof body.version === "string" ? body.version.slice(0, 32) : null, install: INSTALLS.has(install) ? install : null };
  } catch {
    return { kind: "transient" };
  }
}

/**
 * Keeps one timer per saved server. A reachable one is looked at again each minute; a passing problem retries with
 * `reconnectDelay` and reads "Can't reach" after two minutes; a blocked one waits for the person. `retry()` (a network
 * change, the app coming to the front) looks at once at every server with a passing problem; `retry(id)` (Try now,
 * after Pair again) looks at that one whatever its state. `entries()`: the saved servers, `{ id, origin }`.
 */
export function createServerStatus({ entries, check, appVersion, onChange = () => {}, random = Math.random, now = Date.now, setTimeout: later = setTimeout, clearTimeout: cancel = clearTimeout }) {
  const rows = new Map();
  let stopped = false;
  let lastRefocus = -Infinity;

  const schedule = (row, ms) => {
    cancel(row.timer);
    row.timer = stopped ? null : later(() => void look(row), ms);
    row.timer?.unref?.();
  };

  async function look(row) {
    cancel(row.timer);
    row.timer = null;
    const generation = ++row.generation;
    const result = await check(row.origin).catch(() => ({ kind: "transient" }));
    if (stopped || rows.get(row.id) !== row || generation !== row.generation) return;
    if (result.kind === "ok") {
      if (row.state !== "connected") row.since = now();
      Object.assign(row, { state: "connected", attempt: 0, failingSince: null, version: result.version, install: result.install });
      schedule(row, RECONNECT.healthyMs);
    } else if (result.kind === "blocked") {
      if (row.state !== result.reason) row.since = now();
      Object.assign(row, { state: result.reason, attempt: 0, failingSince: null });
    } else {
      row.failingSince ??= now();
      const state = now() - row.failingSince >= RECONNECT.cantReachAfterMs ? "cantReach" : "reconnecting";
      if (state === "reconnecting" || row.state !== "cantReach") row.since = row.failingSince;
      row.state = state;
      schedule(row, reconnectDelay(row.attempt++, random));
    }
    onChange();
  }

  const failing = (row) => row.state === "reconnecting" || row.state === "cantReach";

  return {
    sync() {
      if (stopped) return;
      const wanted = new Map(entries().filter((entry) => entry.origin).map((entry) => [entry.id, entry.origin]));
      for (const [id, row] of rows) {
        if (wanted.get(id) === row.origin) continue;
        cancel(row.timer);
        rows.delete(id);
      }
      for (const [id, origin] of wanted) {
        if (rows.has(id)) continue;
        const row = { id, origin, state: "checking", since: now(), attempt: 0, failingSince: null, version: null, install: null, timer: null, generation: 0 };
        rows.set(id, row);
        void look(row);
      }
    },
    retry(id) {
      if (id !== undefined) {
        const row = rows.get(id);
        if (row) void look(row);
        return;
      }
      if (now() - lastRefocus < RECONNECT.refocusMs) return;
      lastRefocus = now();
      for (const row of rows.values()) if (failing(row)) void look(row);
    },
    list() {
      return [...rows.values()].map((row) => ({ id: row.id, state: row.state, since: row.since, version: row.version, behind: versionBehind(row.version, appVersion), install: row.install }));
    },
    stop() {
      stopped = true;
      for (const row of rows.values()) cancel(row.timer);
      rows.clear();
    },
  };
}

/**
 * Settings → Servers' channels (`guard`: this computer's own page only), and the moments worth an immediate retry: the
 * app coming to the front, the computer waking, and the network coming back (`online()`, looked at every 10 s).
 * Checks start the first time the page asks, so a person who never opens Servers sends nothing.
 */
export function installServerStatus({ ipcMain, guard, status, app, powerMonitor, online = () => true, setInterval: every = setInterval }) {
  ipcMain.handle("environments:status", guard("environments:status", () => { status.sync(); return status.list(); }));
  ipcMain.handle("environments:retry", guard("environments:retry", (_event, id) => { status.sync(); status.retry(typeof id === "string" ? id : undefined); }));
  app.on("browser-window-focus", () => status.retry());
  powerMonitor.on("resume", () => status.retry());
  let wasOnline = online();
  every(() => {
    const now = online();
    if (now && !wasOnline) status.retry();
    wasOnline = now;
  }, 10_000).unref?.();
}
