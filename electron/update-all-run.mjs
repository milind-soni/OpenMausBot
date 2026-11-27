// Update all, on Settings → Devices: every saved server this app may update, then this app last. Each server is driven by
// its own answers (`GET /api/updates/check`, `GET/POST /api/updates/server`) and counts as updated only once its
// descriptor reports the `latest` that server named itself.
import { allowedServerOrigin } from "./server-address.mjs";

/** `giveUpMs`: how long a server may stay unreachable, the two hours a server itself gives a run before calling it cut off. */
export const UPDATE_ALL = Object.freeze({ pollMs: 4_000, timeoutMs: 15_000, giveUpMs: 2 * 60 * 60_000 });

const STATUS = "/api/updates/server";
const DESCRIPTOR = "/.well-known/openmausbot/environment";
const FAILED_RUNS = new Set(["rolled-back", "rollback-failed", "not-changed", "not-started"]);
/** The desktop's clock and a server's may differ; a run asked for this long before a request with no answer is older. */
const CLOCK_SLACK_MS = 5 * 60_000;
const WANTED_APP = new Set(["downloading", "preparing", "downloaded"]);

const readJson = (response) => response.json().catch(() => null);
const isCheck = (body) => typeof body?.current === "string" && typeof body?.available === "boolean";
const isStatus = (body) => typeof body?.mode === "string" && typeof body?.current === "string";

function serverClient(origin, fetchImpl, timeoutMs) {
  const send = (path, init = {}) => fetchImpl(`${origin}${path}`, {
    redirect: "error", cache: "no-store", credentials: "include", signal: AbortSignal.timeout(timeoutMs), ...init,
    headers: { accept: "application/json", origin, ...init.headers },
  });
  return {
    send,
    /** The status the admin's button reads; null while the server can't answer it (restarting, unreachable). */
    async status() {
      try {
        const response = await send(STATUS);
        const body = response.ok ? await readJson(response) : null;
        return isStatus(body) ? body : null;
      } catch {
        return null;
      }
    },
    async post() {
      const response = await send(STATUS, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
      return { status: response.status, body: (await readJson(response)) ?? {} };
    },
    /** The version the server's public descriptor reports now: the read-back that confirms an update. */
    async version() {
      try {
        const response = await send(DESCRIPTOR, { credentials: "omit" });
        const body = response.ok ? await readJson(response) : null;
        return typeof body?.environmentId === "string" && typeof body.version === "string" ? body.version.slice(0, 32) : null;
      } catch {
        return null;
      }
    },
  };
}

/**
 * One look at a saved server before Update all. `reach`: `ok`, `unreachable`, `signed-out` (its session is gone), or
 * `insecure` (a public http address, never contacted). With `ok`: its update check, the admin's status (null on a
 * server without the button), and `adminOnly` when this computer's session there is not an admin's.
 */
export async function surveyServer(origin, fetchImpl, { fresh = false, timeoutMs = UPDATE_ALL.timeoutMs } = {}) {
  if (!allowedServerOrigin(origin)) return { reach: "insecure" };
  const server = serverClient(origin, fetchImpl, timeoutMs);
  try {
    const checked = await server.send(`/api/updates/check${fresh ? "?fresh=1" : ""}`);
    if (checked.status === 401 || checked.status === 403) return { reach: "signed-out" };
    if (checked.status === 404) return { reach: "ok", check: null, status: null, adminOnly: false };
    const check = checked.ok ? await readJson(checked) : null;
    if (!isCheck(check)) return { reach: "unreachable" };
    const answered = await server.send(STATUS);
    const body = await readJson(answered);
    if (answered.status === 403 && body?.code === "admin_only") return { reach: "ok", check, status: null, adminOnly: true };
    return { reach: "ok", check, status: answered.ok && isStatus(body) ? body : null, adminOnly: false };
  } catch {
    return { reach: "unreachable" };
  }
}

/**
 * Whether Update all updates this server, from its own answers only (never from how it compares with this app: its
 * updater moves it to its own stable channel's latest). Otherwise `why` it is skipped, with the command to run there
 * when it is updated by hand.
 */
export function serverPlan(survey, now = Date.now()) {
  if (survey.reach === "signed-out") return { updates: false, why: "signed-out" };
  if (survey.reach !== "ok") return { updates: false, why: "unreachable" };
  const { check, status } = survey;
  if (!check) return { updates: false, why: "by-hand" };
  if (!check.available || !check.latest) return { updates: false, why: "up-to-date", current: check.current };
  const by = { current: check.current, latest: check.latest };
  if (survey.adminOnly) return { updates: false, why: "admin-only", ...by };
  const command = status?.command ?? check.command;
  if (!status) return { updates: false, why: "by-hand", ...by, ...(command ? { command } : {}) };
  if (status.run?.outcome === "requested" || status.run?.outcome === "running") return { updates: false, why: "updating", ...by };
  if (status.mode === "held") return { updates: false, why: "held", ...by };
  if (status.mode !== "button") return { updates: false, why: "by-hand", ...by, ...(command ? { command } : {}) };
  if (status.retryAt && status.retryAt > now) return { updates: false, why: "too-soon", ...by };
  return { updates: true, ...by, activeTurns: status.activeTurns ?? 0 };
}

/** Whether this app takes part: an update it is downloading or has downloaded. `handoff`: it finishes in a terminal. */
export function appPlan(state) {
  if (!state || !WANTED_APP.has(state.status)) return null;
  return { version: state.version ?? null, handoff: state.installMode === "handoff" };
}

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

/**
 * Runs Update all. Servers go first, in parallel, each settled on its own; this app (`app`: the updater's `state()`,
 * `check()`, `install()` and `onState(cb) → stop`) installs last, once every server is settled or handed to its own
 * updater (it took the request, or dropped the connection as it restarts). `onChange(view)` gets every new view.
 *
 * Row phases: `waiting` (this app, until the servers are handed off), `updating`, `restarting` (no answer while it
 * restarts), `done` (`version` read back), `handed-off` (this app's command is in a terminal), `failed` (`failure`).
 */
export function createUpdateAll({ fetch: fetchImpl, app = null, onChange = () => {}, now = Date.now, sleep = (ms) => new Promise((done) => setTimeout(done, ms)), pollMs = UPDATE_ALL.pollMs, giveUpMs = UPDATE_ALL.giveUpMs, timeoutMs = UPDATE_ALL.timeoutMs }) {
  let rows = {};
  let running = null;
  const tasks = new Map();

  const view = () => ({ running: Boolean(running), rows: structuredClone(rows) });
  const set = (id, patch) => {
    const before = rows[id];
    const next = { ...before, ...patch, since: !before || (patch.phase && patch.phase !== before.phase) ? now() : before.since };
    if (next.phase !== "failed") delete next.failure;
    for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
    rows = { ...rows, [id]: next };
    onChange(view());
  };
  const finish = (id, version) => set(id, { phase: "done", version });
  const fail = (id, failure) => set(id, { phase: "failed", failure });

  async function updateServer({ id, origin, latest }, handOff) {
    set(id, { phase: "updating", latest, version: undefined });
    const server = serverClient(origin, fetchImpl, timeoutMs);
    const askedAt = now();
    let ours = null;
    try {
      const { status, body } = await server.post();
      const code = body.code;
      if (status === 202 || (status === 409 && code === "running")) ours = body.status?.run?.at ?? null;
      else if (status === 409 && code === "up-to-date") {
        const version = await server.version();
        return version === latest ? finish(id, version) : fail(id, { why: "mismatch", version: version ?? body.status?.current ?? null });
      } else if (status === 409 && code === "unavailable") return fail(id, { why: "by-hand", ...(body.status?.command ? { command: body.status.command } : {}) });
      else if (status === 429) return fail(id, { why: "too-soon" });
      else if (status === 401) return fail(id, { why: "signed-out" });
      else if (status === 403) return fail(id, { why: "admin-only" });
      else return fail(id, { why: "failed" });
    } catch {
      // No answer: the server may already be stopping for the update. It is followed as if it had said so.
    }
    const isOurs = (run) => Boolean(run) && (ours !== null ? run.at === ours : run.at >= askedAt - CLOCK_SLACK_MS);
    let downSince = null;
    for (;;) {
      await sleep(pollMs);
      const status = await server.status();
      if (!status) {
        handOff();
        if (rows[id]?.phase !== "restarting") set(id, { phase: "restarting" });
        downSince ??= now();
        const version = await server.version();
        if (version === latest) return finish(id, version);
        if (now() - downSince >= giveUpMs) return fail(id, { why: "not-back" });
        continue;
      }
      downSince = null;
      const run = isOurs(status.run) ? status.run : null;
      if (run?.outcome === "running") handOff();
      if (run && FAILED_RUNS.has(run.outcome)) return fail(id, { why: "run", status });
      const going = run?.outcome === "requested" || run?.outcome === "running";
      if (!going && (run || status.current === latest)) {
        const version = await server.version();
        if (version === latest) return finish(id, version);
        if (version !== null) return fail(id, { why: "mismatch", version, status });
      } else if (!going) return fail(id, { why: "failed" });
      if (rows[id]?.phase !== "updating") set(id, { phase: "updating" });
    }
  }

  async function confirmCurrent(id, origin) {
    const version = await serverClient(origin, fetchImpl, timeoutMs).version();
    const latest = rows[id]?.latest;
    if (latest && version === latest) finish(id, version);
    else fail(id, { why: version ? "mismatch" : "unreachable", ...(version ? { version } : {}) });
  }

  function serverTask(server) {
    const gate = deferred();
    const done = updateServer(server, gate.resolve).catch(() => fail(server.id, { why: "failed" })).finally(gate.resolve);
    tasks.set(server.id, { server, gate: gate.promise, done });
    return done;
  }

  const appStateWhere = (wanted) => new Promise((resolve) => {
    let stop = () => {};
    let settled = false;
    const look = (state) => {
      if (settled || !state || !wanted(state)) return;
      settled = true;
      stop();
      resolve(state);
    };
    stop = app.onState(look) ?? (() => {});
    if (settled) stop();
    look(app.state());
  });

  async function updateApp() {
    set("app", { phase: "updating" });
    if (!WANTED_APP.has(app.state()?.status)) await app.check();
    const ready = await appStateWhere((state) => state.status !== "downloading" && state.status !== "preparing" && state.status !== "checking");
    if (ready.status !== "downloaded") return fail("app", { why: "download" });
    set("app", { phase: "restarting", latest: ready.version ?? undefined });
    app.install();
    const after = await appStateWhere((state) => state.status === "error" || state.status === "handed-off" || state.status === "downloaded");
    if (after.status === "handed-off") return set("app", { phase: "handed-off" });
    return fail("app", { why: "install" });
  }

  async function appTask() {
    set("app", { phase: "waiting" });
    await Promise.all([...tasks.values()].map((task) => task.gate));
    await updateApp().catch(() => fail("app", { why: "install" }));
  }

  return {
    view,
    /** `servers`: `{ id, origin, latest }` for each server its plan updates; `withApp`: this app too, last. A start
     * while a run is going joins it. */
    start({ servers, withApp }) {
      if (running) return view();
      rows = {};
      tasks.clear();
      const jobs = servers.map(serverTask);
      if (withApp && app) jobs.push(appTask());
      running = Promise.allSettled(jobs).then(() => { running = null; onChange(view()); });
      onChange(view());
      return view();
    },
    /** Tries one failed row again: this app with `id` "app", or a server with `next` from a fresh look: its new
     * `{ origin, latest }`; `{ origin, current: true }` when it says it is up to date, settled by reading its version back;
     * or the `{ failure }` it gives when it no longer updates. */
    retry(id, next) {
      if (rows[id]?.phase !== "failed") return view();
      if (next?.failure) {
        fail(id, next.failure);
        return view();
      }
      const job = id === "app" ? (app ? updateApp().catch(() => fail("app", { why: "install" })) : null)
        : next?.origin && next.current ? confirmCurrent(id, next.origin).catch(() => fail(id, { why: "failed" }))
        : next?.origin && next.latest ? serverTask({ id, origin: next.origin, latest: next.latest }) : null;
      if (!job) return view();
      const all = running ?? Promise.resolve();
      running = Promise.allSettled([all, job]).then(() => { running = null; onChange(view()); });
      onChange(view());
      return view();
    },
  };
}
