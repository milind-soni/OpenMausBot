import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createSharedCua, executeSharedOperation, personalSecretPaths, sharedComputerError } from "./shared-computer-access.mjs";
import { createLendingActivity, describeSharedOperation } from "./lending-activity.mjs";

const uuid = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
const DATA_VOLUME = "/System/Volumes/Data";
const identify = async candidate => { const info = await fsp.stat(candidate, { bigint: true }); return `${info.dev}:${info.ino}`; };

/** Every path that names the home directory itself. macOS reaches one home
 * through a firmlink and again under the data volume, and those two paths have
 * different ancestors, so both chains have to be walked. */
function homeCandidates() {
  const home = path.resolve(os.homedir());
  const seeds = [home];
  if (process.platform === "darwin" && !home.startsWith(`${DATA_VOLUME}${path.sep}`)) seeds.push(path.join(DATA_VOLUME, home));
  return seeds;
}

/** The home directory and everything above it, as filesystem identities. Text
 * comparison misses a firmlink, a bind mount, a case-insensitive spelling, a
 * Unicode normalization and a Windows 8.3 or UNC name; {dev, ino} does not. */
async function enclosingHomeIdentities() {
  const identities = new Set();
  const [home, ...aliases] = homeCandidates();
  const canonicalHome = await fsp.realpath(home);
  const homeIdentity = await identify(canonicalHome);
  const roots = [canonicalHome];
  for (const alias of aliases) {
    try {
      const canonical = await fsp.realpath(alias);
      if ((await identify(canonical)) === homeIdentity) roots.push(canonical);
    } catch (error) {
      // The optional macOS data-volume spelling need not exist. Any other
      // failure must not silently remove part of the home boundary.
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
    }
  }
  for (let current of roots) {
    for (;;) {
      identities.add(await identify(current));
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return identities;
}

/** A drive letter, a filesystem root, or any mount point: sharing one of those
 * shares a whole volume. Unreadable parents fail closed. */
async function volumeRoot(canonical) {
  const parent = path.dirname(canonical);
  if (parent === canonical) return true;
  try { return (await fsp.stat(parent, { bigint: true })).dev !== (await fsp.stat(canonical, { bigint: true })).dev; } catch { return true; }
}

export async function validateSharedFolders(folders) {
  if (!Array.isArray(folders) || folders.length > 20) throw new Error("Choose at most 20 shared folders");
  const result = [];
  const enclosing = await enclosingHomeIdentities();
  for (const folder of folders) {
    if (!uuid(folder?.id) || typeof folder.path !== "string" || !path.isAbsolute(folder.path) || typeof folder.write !== "boolean") throw new Error("Choose folders using the desktop folder picker");
    const canonical = await fsp.realpath(folder.path);
    if (!(await fsp.stat(canonical)).isDirectory()) throw new Error("Choose a folder, not a file");
    if (enclosing.has(await identify(canonical)) || (await volumeRoot(canonical))) throw new Error("Choose specific folders, not the entire computer or home folder");
    if (result.some(entry => entry.id === folder.id || entry.path === canonical)) continue;
    result.push({ id: folder.id, path: canonical, name: path.basename(canonical).slice(0, 120), write: folder.write });
  }
  return result;
}

const JOB_KEYS = new Set(["computer_id", "action", "folder_id", "path", "content", "encoding", "expected_sha256", "command", "tool_name", "arguments"]);
const JOB_ACTIONS = new Set(["list_files", "read_file", "write_file", "run_command", "computer_tools", "computer_call"]);
const optionalText = (value, max) => value === undefined || (typeof value === "string" && value.length <= max);
/** The server's job, checked against the same shape the server accepts
 * before anything on this computer looks at it. The grant still decides
 * whether the operation is allowed; this only refuses malformed input. */
export function validSharedOperation(operation, computerId) {
  return Boolean(operation) && typeof operation === "object" && !Array.isArray(operation) &&
    Object.keys(operation).every(key => JOB_KEYS.has(key)) &&
    operation.computer_id === computerId && JOB_ACTIONS.has(operation.action) &&
    (operation.folder_id === undefined || uuid(operation.folder_id)) &&
    optionalText(operation.path, 2048) && optionalText(operation.content, 350_000) &&
    (operation.encoding === undefined || operation.encoding === "utf8" || operation.encoding === "base64") &&
    (operation.expected_sha256 === undefined || (typeof operation.expected_sha256 === "string" && /^[a-f0-9]{64}$/.test(operation.expected_sha256))) &&
    optionalText(operation.command, 8000) && optionalText(operation.tool_name, 100) &&
    (operation.arguments === undefined || (Boolean(operation.arguments) && typeof operation.arguments === "object" && !Array.isArray(operation.arguments)));
}

/** Whether a Cloud grant may run right now. Lending to the person's Cloud is
 * bound to the Cloud account that turned it on and to that account's machine:
 * signing out, another account, or a different machine ends it (the grant is
 * switched off, so resuming is the person's choice). A Cloud sign-in that
 * needs renewing, or one that cannot be read right now, pauses it; a brief
 * re-verification or an unreachable Admin (still this account) does not.
 * `current` is the native Cloud snapshot: { status, accountId, origin }
 * (origin only while the machine is verified). */
export function cloudLendingVerdict(binding, current, env) {
  if (!binding || current?.status === "signed-out") return { stop: "signed-out" };
  if (current?.accountId && current.accountId !== binding.accountId) return { stop: "account-changed" };
  if (env?.origin !== binding.origin || (current?.origin && current.origin !== binding.origin)) return { stop: "machine-changed" };
  if (!current?.accountId) return { pause: "unverified" };
  if (current.status !== "connected" && current.status !== "unavailable") return { pause: current.status };
  return { allow: true };
}

class Paused extends Error {}

/** Outbound HTTPS only; no local listening port and no host credentials in
 * the renderer. Pairing cookies and a connector secret remain in Electron.
 *
 * Two kinds of grant share this connector. A maintainer grant (any server,
 * behind the local `features.sharedComputers` flag, exactly as before). A
 * Cloud grant (`cloud: { accountId, origin }`): the person's own Mac lent to
 * their own OMB Cloud home, gated by their Cloud sign-in (`cloud()`), never
 * by the maintainer flag. */
export function createComputerSharing({ file, fetch: fetchImpl, environments, cuaConnection, hostControl, protectedPaths = [], enabled = async () => false, home = os.homedir(), activityFile, cloud = () => null, onChange = () => {} }) {
  // The grant store's own directory plus whatever the desktop shell names —
  // the server data directory holds provider API keys and sessions.json —
  // plus the person's own credential and autostart locations. This module
  // never imports electron, so those roots arrive from the caller.
  const protectedRoots = [path.dirname(file), ...protectedPaths.filter(entry => typeof entry === "string" && entry), ...personalSecretPaths(home)];
  const activity = createLendingActivity(activityFile ?? path.join(path.dirname(file), "lending-activity.jsonl"));
  let records = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed?.version === 1 && parsed.records && typeof parsed.records === "object") records = parsed.records;
  } catch { /* missing/corrupt grants never create authority */ }
  const running = new Map();
  const status = new Map();
  let closed = false;
  let maintainerOff = false;
  let executing = null;
  const changed = () => { if (!closed) try { onChange(summary()); } catch { /* an indicator never stops lending */ } };
  const summary = () => ({
    lending: environments().filter(env => records[env.id]?.cloud && records[env.id]?.enabled === true).map(env => env.id),
    busy: executing,
  });
  // The remote workspace's capability is not authority over this desktop.
  // Recheck the local feature gate even for persisted grants and live jobs.
  // A maintainer grant only: Cloud grants never read the maintainer flag.
  const requireEnabled = async () => {
    const allowed = !closed && !maintainerOff && await enabled().catch(() => false);
    if (allowed && !closed && !maintainerOff) return;
    maintainerOff = true;
    for (const env of environments()) {
      if (records[env.id]?.cloud || !running.has(env.id)) continue;
      if (status.get(env.id)?.connected) disconnect(env, records[env.id]); else stop(env.id);
    }
    throw new Error("Computer sharing is turned off on this computer. Restart the desktop after enabling it.");
  };
  /** Ends a Cloud grant for good: disconnect, cancel in-flight work, and
   * switch it off so only the person can turn it back on. */
  const endCloud = (env, reason) => {
    disconnect(env, records[env.id]);
    if (records[env.id]?.enabled) store({ ...records, [env.id]: { ...records[env.id], enabled: false } });
    status.set(env.id, { connected: false, problem: reason });
    changed();
  };
  const requireGrant = async (env, grant) => {
    if (!grant.cloud) return requireEnabled();
    // Quitting the app only pauses: a check still in flight when it closes
    // must never switch the person's lending off for the next launch.
    if (closed) throw new Paused("This app is closing.");
    const verdict = cloudLendingVerdict(grant.cloud, cloud(), env);
    if (verdict.allow) return;
    if (verdict.stop) { endCloud(env, verdict.stop); throw new Error("Lending to My Cloud stopped."); }
    throw new Paused("Waiting for your OpenMausBot Cloud sign-in.");
  };
  const store = next => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, records: next }), { mode: 0o600 });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, file); records = next;
  };
  const request = async (env, route, body, signal, secret) => {
    const origin = new URL(env.origin);
    if (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))) throw new Error("Computer sharing requires an HTTPS server address");
    const response = await fetchImpl(`${env.origin}${route}`, {
      method: body === undefined ? "GET" : "POST", credentials: "include", redirect: "error", cache: "no-store",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(35_000)]) : AbortSignal.timeout(10_000),
      headers: { origin: env.origin, ...(body === undefined ? {} : { "content-type": "application/json" }), ...(secret ? { "x-omb-computer-secret": secret } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const chunks = []; let bytes = 0;
    for await (const chunk of response.body ?? []) {
      bytes += chunk.length; if (bytes > 4_000_000) throw new Error("Server response exceeded limit");
      chunks.push(Buffer.from(chunk));
    }
    let json; try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("This server does not support computer sharing. Update its OpenMausBot installation."); }
    if (!response.ok) throw Object.assign(new Error(response.status === 401 || response.status === 403 ? "Pair this desktop again before sharing computer access." : `Server request failed (${response.status}). Update the server if needed.`), { status: response.status });
    return json;
  };
  const describe = async env => {
    const [auth, descriptor] = await Promise.all([request(env, "/api/auth/session"), request(env, "/.well-known/openmausbot/environment")])
      .catch(error => { throw error.status === 401 || error.status === 403 ? Object.assign(error, { problem: "connect-first" }) : error; });
    if (auth.kind !== "session" || !uuid(auth.id) || !uuid(descriptor.environmentId)) throw Object.assign(new Error("Complete server pairing or sign-in first"), { problem: "connect-first" });
    if (descriptor.capabilities?.sharedComputers !== true) throw new Error("Update this server to enable computer sharing");
    return { auth, info: { sessionId: auth.id, environmentId: descriptor.environmentId } };
  };
  const identity = async env => {
    await requireEnabled();
    const { info } = await describe(env);
    await requireEnabled();
    return info;
  };
  /** The person's Cloud home, signed in as one of their own admin devices. */
  const cloudIdentity = async env => {
    const { auth, info } = await describe(env);
    if (auth.cloudHome !== true || !Array.isArray(auth.scopes) || !auth.scopes.includes("admin")) throw Object.assign(new Error("This server is not My Cloud"), { problem: "not-cloud" });
    return info;
  };
  const matches = (grant, info) => grant?.sessionId === info.sessionId && grant?.environmentId === info.environmentId;
  const stop = id => {
    const live = running.get(id);
    if (live) { live.abort.abort(); live.cua?.close(); running.delete(id); }
    status.set(id, { connected: false });
  };
  const run = (env, grant) => {
    stop(env.id);
    if (closed || !grant.enabled || (!grant.cloud && maintainerOff)) return;
    const live = { abort: new AbortController(), cua: null };
    running.set(env.id, live);
    const signal = live.abort.signal;
    const call = (action, body = {}) => request(env, `/api/shared-computers/${grant.id}/${action}`, body, signal, grant.secret);
    const gate = () => requireGrant(env, grant);
    void (async () => {
      while (!signal.aborted) {
        try {
          await gate();
          if (grant.cloud) {
            // Bound to the account and machine above. A new pairing of this
            // same desktop (a new session) keeps lending; another server
            // behind that address (a new environment) does not.
            const info = await cloudIdentity(env);
            if (grant.environmentId && grant.environmentId !== info.environmentId) { endCloud(env, "machine-changed"); break; }
            if (grant.environmentId !== info.environmentId || grant.sessionId !== info.sessionId) {
              grant = { ...grant, ...info };
              if (records[env.id]?.id === grant.id) store({ ...records, [env.id]: grant });
            }
          } else if (!matches(grant, await identity(env))) throw new Error("Server sign-in changed. Review computer access again in Settings.");
          await validateSharedFolders(grant.folders);
          const effectiveGrant = { ...grant, protectedPaths: protectedRoots };
          await gate();
          await request(env, "/api/shared-computers/connect", {
            id: grant.id, name: os.hostname().slice(0, 120), environmentId: grant.environmentId,
            folders: grant.folders.map(({ id, name, write }) => ({ id, name, write })), terminal: grant.terminal, computer: grant.computer,
          }, signal, grant.secret);
          if (signal.aborted) break;
          status.set(env.id, { connected: true });
          changed();
          while (!signal.aborted) {
            await gate();
            const { job } = await call("poll");
            await gate();
            if (!job) continue;
            if (!uuid(job.id)) throw new Error("Invalid computer request");
            if (!validSharedOperation(job.operation, grant.id)) {
              activity.record({ env, action: "invalid", detail: "", ok: false, error: "Refused a malformed request" });
              await call("result", { jobId: job.id, result: sharedComputerError(new Error("Invalid computer request")) });
              continue;
            }
            if (executing) { await call("result", { jobId: job.id, result: sharedComputerError(new Error("This computer is busy with another server")) }); continue; }
            executing = { env: env.id, action: job.operation.action };
            changed();
            const jobAbort = new AbortController();
            const jobSignal = AbortSignal.any([signal, jobAbort.signal]);
            let leasing = false;
            let control;
            const lease = async () => {
              if (leasing) return;
              leasing = true;
              try {
                await gate();
                if (!(await call("lease", { jobId: job.id })).active) jobAbort.abort();
                await control?.renew();
              } catch { jobAbort.abort(); }
              finally { leasing = false; }
            };
            const heartbeat = setInterval(() => void lease(), 1000);
            let result;
            try {
              await lease(); jobSignal.throwIfAborted();
              if (grant.computer && ["computer_tools", "computer_call"].includes(job.operation.action)) {
                if (!hostControl) throw new Error("The local computer control gate is unavailable");
                control = await hostControl(job.id, jobSignal);
                jobSignal.throwIfAborted();
              }
              result = await executeSharedOperation(effectiveGrant, job.operation, jobSignal, async () => {
                if (!live.cua) {
                  const connection = await cuaConnection();
                  jobSignal.throwIfAborted();
                  if (!connection?.mcpCommand || !Array.isArray(connection.mcpArgs)) throw new Error("Computer control is unavailable. Enable it in the local app and grant OS permissions first.");
                  live.cua = createSharedCua(connection);
                }
                return live.cua;
              });
            } catch (error) { result = sharedComputerError(error); live.cua?.close(); live.cua = null; }
            finally { clearInterval(heartbeat); await control?.release().catch(() => {}); executing = null; changed(); }
            activity.record({
              env, action: job.operation.action, detail: describeSharedOperation(grant, job.operation), ok: result?.isError !== true,
              error: result?.isError === true ? result?.content?.[0]?.text : undefined,
            });
            // Never retry an action if the result delivery fails.
            await call("result", { jobId: job.id, result });
          }
        } catch (error) {
          if (error instanceof Paused) {
            // Nothing is served while the Cloud sign-in cannot be verified;
            // cloudChanged() starts this grant again once it can.
            if (running.get(env.id) === live) disconnect(env, grant);
            status.set(env.id, { connected: false, problem: "paused" });
            changed();
            break;
          }
          // A Cloud home this desktop is not (or no longer) signed in to
          // needs Connect to my Cloud; anything else is waiting for it.
          if (!signal.aborted) status.set(env.id, { connected: false, error: error.message, ...(grant.cloud ? { problem: error.problem ?? (error.status === 401 || error.status === 403 ? "connect-first" : "waiting") } : {}) });
          changed();
        }
        try { await delay(5000, undefined, { signal }); } catch { break; }
      }
    })().catch(() => {});
  };
  const state = id => {
    const grant = records[id];
    return { enabled: grant?.enabled === true, folders: Array.isArray(grant?.folders) ? grant.folders : [], terminal: grant?.terminal === true, computer: grant?.computer === true, ...status.get(id) };
  };
  const disconnect = (env, grant) => {
    stop(env.id);
    if (grant?.secret) void request(env, `/api/shared-computers/${grant.id}/disconnect`, {}, undefined, grant.secret).catch(() => {});
  };
  const cloudState = env => {
    const grant = env ? records[env.id] : undefined;
    const lent = grant?.cloud ? grant : null;
    return {
      enabled: lent?.enabled === true,
      folders: lent && Array.isArray(lent.folders) ? lent.folders : [],
      screen: lent?.computer === true,
      busy: Boolean(env && executing?.env === env.id),
      ...(env ? status.get(env.id) : {}),
    };
  };
  const validRecord = grant => grant?.enabled === true && uuid(grant.id) && /^[a-f0-9]{64}$/.test(grant.secret) && Array.isArray(grant.folders) &&
    (grant.cloud
      ? typeof grant.cloud.accountId === "string" && typeof grant.cloud.origin === "string" && (grant.environmentId === null || uuid(grant.environmentId))
      : uuid(grant.sessionId) && uuid(grant.environmentId));
  return {
    state, identity,
    /** What servers' bots did here, newest first (optionally one server's). */
    activity(id, limit) {
      const env = id === undefined ? null : environments().find(entry => entry.id === id);
      const entries = activity.list(env ? 500 : limit);
      return (env ? entries.filter(entry => entry.origin === env.origin) : entries).slice(0, limit ?? 100);
    },
    async observe(env) {
      const info = await identity(env);
      if (matches(records[env.id], info)) return null;
      disconnect(env, records[env.id]);
      return info;
    },
    decline(env, info) { disconnect(env, records[env.id]); store({ ...records, [env.id]: { ...info, enabled: false, folders: [], terminal: false, computer: false } }); },
    async save(env, input, info) {
      const fresh = await identity(env);
      if (!matches(info, fresh)) throw new Error("Server sign-in changed. Review computer access again.");
      const folders = await validateSharedFolders(input.folders);
      await requireEnabled();
      const grant = { ...fresh, id: randomUUID(), secret: randomBytes(32).toString("hex"), enabled: true, folders, terminal: input.terminal === true, computer: input.computer === true };
      if (!folders.length && !grant.terminal && !grant.computer) throw new Error("Choose at least one folder or capability to share");
      disconnect(env, records[env.id]);
      store({ ...records, [env.id]: grant }); run(env, grant); changed(); return state(env.id);
    },
    /** What this Mac lends to the person's Cloud, for Settings → OMB Cloud. */
    cloudState,
    /** Lend this Mac to the person's own Cloud: chosen folders (read-only or
     * editable) and optionally apps and screen. Never a terminal. The Cloud
     * account and its machine must be verified right now; the Cloud home's
     * identity is bound on first contact if this desktop is not signed in
     * there yet (Open My Cloud does that). */
    async saveCloud(env, input) {
      if (closed) throw new Error("Lending is unavailable while the app is closing.");
      const current = cloud();
      if (current?.status !== "connected" || !current.accountId || current.origin !== env.origin) throw Object.assign(new Error("Open My Cloud first."), { problem: "connect-first" });
      const folders = await validateSharedFolders(input?.folders);
      if (!folders.length && input?.screen !== true) throw new Error("Choose at least one folder, or apps and screen.");
      let info = { sessionId: null, environmentId: null };
      try { info = await cloudIdentity(env); } catch (error) { if (error.problem !== "connect-first") throw error; }
      const grant = { ...info, id: randomUUID(), secret: randomBytes(32).toString("hex"), enabled: true, folders, terminal: false, computer: input.screen === true,
        cloud: { accountId: current.accountId, origin: env.origin } };
      disconnect(env, records[env.id]);
      store({ ...records, [env.id]: grant }); run(env, grant); changed();
      return cloudState(env);
    },
    revoke(env) {
      disconnect(env, records[env.id]);
      if (records[env.id]) store({ ...records, [env.id]: { ...records[env.id], enabled: false } });
      changed();
      return state(env.id);
    },
    forget(env) { disconnect(env, records[env.id]); const next = { ...records }; delete next[env.id]; store(next); changed(); },
    /** Resume saved grants. Maintainer grants only when the local flag is on
     * (the caller checked it); Cloud grants whenever the Cloud sign-in allows. */
    start({ maintainer = true } = {}) {
      for (const env of environments()) {
        const grant = records[env.id];
        if (!validRecord(grant)) continue;
        if (grant.cloud) { if (cloudLendingVerdict(grant.cloud, cloud(), env).allow) run(env, grant); }
        else if (maintainer && !maintainerOff) run(env, grant);
      }
      changed();
    },
    /** The Cloud sign-in changed (or was re-verified): end, pause or resume
     * each Cloud grant at once. Ending cancels in-flight work. */
    cloudChanged() {
      if (closed) return;
      for (const env of environments()) {
        const grant = records[env.id];
        if (!grant?.cloud || grant.enabled !== true) continue;
        const verdict = cloudLendingVerdict(grant.cloud, cloud(), env);
        if (verdict.stop) endCloud(env, verdict.stop);
        else if (verdict.pause) { if (running.has(env.id)) { disconnect(env, grant); status.set(env.id, { connected: false, problem: "paused" }); changed(); } }
        else if (!running.has(env.id) && validRecord(grant)) run(env, grant);
      }
    },
    close() { closed = true; for (const id of running.keys()) stop(id); },
  };
}
