import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createSharedCua, executeSharedOperation, personalSecretPaths, sharedComputerError } from "./shared-computer-access.mjs";
import { sharedCuaConnection } from "./shared-cua-connection.mjs";
export { sharedCuaConnection };
import { createLendingActivity, describeSharedOperation } from "./lending-activity.mjs";
import { cuaUnavailable, SCREEN_LOCKED } from "./lent-screen-failures.mjs";
import { BACKGROUND_HEADERS, CloudAsleepError, asleepAnswer, createCloudPowerGate } from "./cloud-power.mjs";
import { linkUrl, runDeviceLink } from "./device-link.mjs";
import { LINK_ASLEEP, linkPath } from "./device-link-protocol.mjs";
import { existingFolders } from "./cloud-lending-ipc.mjs";
import { shareableDrive } from "./shared-drives.mjs";

const uuid = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
const DATA_VOLUME = "/System/Volumes/Data";
const identify = async candidate => { const info = await fsp.stat(candidate, { bigint: true }); return `${info.dev}:${info.ino}`; };

/** macOS reaches one home through a firmlink and again under the data volume, with different ancestors: walk both. */
function homeCandidates() {
  const home = path.resolve(os.homedir());
  const seeds = [home];
  if (process.platform === "darwin" && !home.startsWith(`${DATA_VOLUME}${path.sep}`)) seeds.push(path.join(DATA_VOLUME, home));
  return seeds;
}

/** {dev, ino}, not text: text misses firmlinks, bind mounts, case-insensitive spellings, Unicode normalization and 8.3/UNC names. */
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
      // Only the optional macOS data-volume spelling may be absent; any other failure must not shrink the home boundary.
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

/** Sharing a drive letter, root or mount point shares a whole volume; unreadable parents fail closed. */
async function volumeRoot(canonical) {
  const parent = path.dirname(canonical);
  if (parent === canonical) return true;
  try { return (await fsp.stat(parent, { bigint: true })).dev !== (await fsp.stat(canonical, { bigint: true })).dev; } catch { return true; }
}

/** Whether `target` is exactly the person's home folder. Only the home folder itself may be lent on request (see
 * `home` in validateSharedFolders); the folders above it, and the system disk, never can. */
export async function isHomeFolder(target) {
  try {
    const [home] = homeCandidates();
    return (await identify(await fsp.realpath(target))) === (await identify(await fsp.realpath(home)));
  } catch { return false; }
}

export async function validateSharedFolders(folders) {
  if (!Array.isArray(folders) || folders.length > 20) throw Object.assign(new Error("Choose at most 20 shared folders"), { code: "TOO_MANY" });
  const result = [];
  const enclosing = await enclosingHomeIdentities();
  for (const folder of folders) {
    if (!uuid(folder?.id) || typeof folder.path !== "string" || !path.isAbsolute(folder.path) || typeof folder.write !== "boolean") throw Object.assign(new Error("Choose folders using the desktop folder picker"), { code: "NOT_PICKED" });
    const canonical = await fsp.realpath(folder.path);
    if (!(await fsp.stat(canonical)).isDirectory()) throw Object.assign(new Error("Choose a folder, not a file"), { code: "NOT_FOLDER" });
    // The home folder, everything above it and the system disk are never shared. A separate drive (an external disk, a data
    // disk on a server, a drive letter) may be shared whole; any other mount point is still refused.
    // The home folder itself is lent only when the desktop picker asked for it (`home: true`, after its own warning);
    // anything above it, and the system disk, are refused whatever is asked. The home folder is always read only: a write
    // there could reach shell start-up files or ~/.ssh, so edits need a specific folder.
    const home = folder.home === true && await isHomeFolder(canonical);
    if (!home && (enclosing.has(await identify(canonical)) || ((await volumeRoot(canonical)) && !(await shareableDrive(canonical))))) throw Object.assign(new Error("Choose specific folders or a separate drive, not the entire computer or home folder"), { code: "HOME_OR_ROOT" });
    if (result.some(entry => entry.id === folder.id || entry.path === canonical)) continue;
    result.push({ id: folder.id, path: canonical, name: path.basename(canonical).slice(0, 120), write: home ? false : folder.write, ...(home ? { home: true } : {}) });
  }
  return result;
}

const JOB_KEYS = new Set(["computer_id", "action", "folder_id", "path", "content", "encoding", "expected_sha256", "command", "tool_name", "arguments"]);
const JOB_ACTIONS = new Set(["list_files", "read_file", "write_file", "run_command", "computer_tools", "computer_call"]);
const optionalText = (value, max) => value === undefined || (typeof value === "string" && value.length <= max);
/** Refuses malformed input only; the grant still decides whether the operation is allowed. */
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

export function cloudLendingVerdict(binding, current, env) {
  // A saved sign-in still being read at startup is not a sign-out: lending waits for it.
  if (!binding || current?.status === "signed-out") return { stop: "signed-out" };
  if (current?.status === "restoring") return { pause: "restoring" };
  if (current?.accountId && current.accountId !== binding.accountId) return { stop: "account-changed" };
  if (env?.origin !== binding.origin || (current?.origin && current.origin !== binding.origin)) return { stop: "machine-changed" };
  if (!current?.accountId) return { pause: "unverified" };
  if (current.status !== "connected" && current.status !== "unavailable") return { pause: current.status };
  return { allow: true };
}

class Paused extends Error {}

const LENT_PLATFORMS = new Set(["darwin", "win32", "linux"]);
const RECONNECT_EVERY_MS = 15 * 60_000;
/** Waits before the device link is dialled again, longer after each attempt that never opened. */
const LINK_RETRY_MS = [2_000, 5_000, 15_000, 60_000];
/** The link carried bytes this recently: the tray says the computer is in use. */
const IN_USE_MS = 5_000;
/** A site opened through this computer goes into its activity once per outcome in this long, so a page's many
 * connections are one line. */
const BROWSE_NOTE_MS = 10 * 60_000;

/** Outbound HTTPS only: no local listening port, and pairing cookies and the connector secret stay in Electron. */
/** `reconnect(origin)`: signs this app back in to the person's own Cloud when its session there has ended, so lending
 * resumes by itself; at most every 15 minutes. `linkHeaders(env)`: the device link's sign-in, as the poll's fetch
 * carries it (the session cookie). */
export function createComputerSharing({ file, fetch: fetchImpl, environments, cuaConnection, hostControl, screenLocked = () => false, protectedPaths = [], enabled = async () => false, home = os.homedir(), activityFile, cloud = () => null, onChange = () => {}, reconnect = null, now = Date.now, power = createCloudPowerGate(),
  linkHeaders = () => ({}), WebSocket: linkSocket = globalThis.WebSocket, egress = {} }) {
  const protectedRoots = [path.dirname(file), ...protectedPaths.filter(entry => typeof entry === "string" && entry), ...personalSecretPaths(home)];
  const activity = createLendingActivity(activityFile ?? path.join(path.dirname(file), "lending-activity.jsonl"));
  let records = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed?.version === 1 && parsed.records && typeof parsed.records === "object") records = parsed.records;
  } catch {}
  const running = new Map();
  const status = new Map();
  const reconnected = new Map();
  /** The Clouds whose device link is open now. */
  const linked = new Set();
  const inUse = new Map();
  let closed = false;
  let maintainerOff = false;
  let executing = null;
  const changed = () => { if (!closed) try { onChange(summary()); } catch {} };
  const summary = () => {
    const browsing = [...inUse.keys()].find(id => linked.has(id));
    return {
      lending: environments().filter(env => records[env.id]?.cloud && records[env.id]?.enabled === true).map(env => env.id),
      busy: executing ?? (browsing ? { env: browsing, action: "internet" } : null),
    };
  };
  /** Each site My Cloud's browsers opened through this computer, or that its check refused, as activity. */
  const noted = new Map();
  const browsed = env => (target, result) => {
    if (!result?.socket && !result?.refused) return;
    const key = `${env.id}\n${target.host}\n${result.refused ?? "ok"}`;
    if (now() - (noted.get(key) ?? -Infinity) < BROWSE_NOTE_MS) return;
    if (noted.size >= 1000) for (const [old, at] of noted) if (now() - at >= BROWSE_NOTE_MS) noted.delete(old);
    noted.set(key, now());
    activity.record({ env, action: "internet", detail: String(target.host), ok: Boolean(result.socket), ...(result.refused ? { error: String(result.refused) } : {}) });
  };
  const traffic = id => () => {
    const was = inUse.get(id);
    clearTimeout(was);
    const timer = setTimeout(() => { if (inUse.get(id) === timer) { inUse.delete(id); changed(); } }, IN_USE_MS);
    timer.unref?.();
    inUse.set(id, timer);
    if (!was) changed();
  };
  // A remote workspace's capability is not authority here: recheck the local gate (maintainer grants only).
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
  // Why and when lending stopped is kept with the grant, so after a restart the switch still says why it is off.
  const endCloud = (env, reason) => {
    disconnect(env, records[env.id]);
    if (records[env.id]?.enabled) store({ ...records, [env.id]: { ...records[env.id], enabled: false, stopped: { reason, at: now() } } });
    status.set(env.id, { connected: false, problem: reason });
    changed();
  };
  const requireGrant = async (env, grant) => {
    if (!grant.cloud) return requireEnabled();
    // Quitting only pauses: a check in flight at close must never switch lending off for the next launch.
    if (closed) throw new Paused("This app is closing.");
    const verdict = cloudLendingVerdict(grant.cloud, cloud(), env);
    if (verdict.allow) return;
    if (verdict.stop) { endCloud(env, verdict.stop); throw new Error("Lending to My Cloud stopped."); }
    throw new Paused("Waiting for your MausBot Cloud sign-in.");
  };
  const store = next => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, records: next }), { mode: 0o600 });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, file); records = next;
  };
  const sleepsHere = env => Boolean(records[env.id]?.cloud) || cloud()?.origin === env.origin;
  const request = async (env, route, body, signal, secret) => {
    const origin = new URL(env.origin);
    if (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))) throw new Error("Computer sharing requires an HTTPS server address");
    const response = await fetchImpl(`${env.origin}${route}`, {
      method: body === undefined ? "GET" : "POST", credentials: "include", redirect: "error", cache: "no-store",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(35_000)]) : AbortSignal.timeout(10_000),
      headers: { origin: env.origin, ...BACKGROUND_HEADERS, ...(body === undefined ? {} : { "content-type": "application/json" }), ...(secret ? { "x-omb-computer-secret": secret } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (asleepAnswer(response)) {
      await response.body?.cancel?.().catch(() => {});
      if (sleepsHere(env)) power.hold();
      throw new CloudAsleepError();
    }
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
    return { auth, info: { sessionId: auth.id, environmentId: descriptor.environmentId }, details: descriptor.capabilities?.lendingDetails === true, link: descriptor.capabilities?.deviceLink === true };
  };
  const identity = async env => {
    await requireEnabled();
    const { info } = await describe(env);
    await requireEnabled();
    return info;
  };
  const cloudIdentity = async env => {
    const { auth, info, details, link } = await describe(env);
    if (auth.cloudHome !== true || !Array.isArray(auth.scopes) || !auth.scopes.includes("admin")) throw Object.assign(new Error("This server is not My Cloud"), { problem: "not-cloud" });
    if (details) supportsDetails.add(env.id); else supportsDetails.delete(env.id);
    if (link) supportsLink.add(env.id); else supportsLink.delete(env.id);
    return info;
  };
  const supportsDetails = new Set();
  const supportsLink = new Set();
  /** My Cloud's browsers reach the web through this computer while lending runs; never while My Cloud sleeps, so a
   * sleeping Cloud is never dialled. */
  const keepLink = async (env, grant, signal) => {
    for (let failures = 0; !signal.aborted;) {
      if (sleepsHere(env) && power.asleep()) {
        await power.wait(signal);
        continue;
      }
      let opened = false;
      const signIn = await Promise.resolve().then(() => linkHeaders(env)).catch(() => ({}));
      const ended = await runDeviceLink({
        url: linkUrl(env.origin, linkPath(grant.id)), signal, WebSocket: linkSocket, egress, traffic: traffic(env.id), onStream: browsed(env),
        headers: { ...signIn, origin: env.origin, ...BACKGROUND_HEADERS, "x-omb-computer-secret": grant.secret },
        onOpen: () => { opened = true; failures = 0; linked.add(env.id); changed(); },
      });
      linked.delete(env.id); changed();
      if (signal.aborted) return;
      if (ended.code === LINK_ASLEEP) { if (sleepsHere(env)) power.hold(); continue; }
      if (!opened) failures++;
      try { await delay(LINK_RETRY_MS[Math.min(failures, LINK_RETRY_MS.length - 1)], undefined, { signal }); } catch { return; }
    }
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
    const call = (action, body = {}, held = signal) => request(env, `/api/shared-computers/${grant.id}/${action}`, body, held, grant.secret);
    const gate = () => requireGrant(env, grant);
    const awake = () => { if (sleepsHere(env) && power.asleep()) throw new CloudAsleepError(); };
    void (async () => {
      while (!signal.aborted) {
        try {
          await gate();
          awake();
          if (grant.cloud) {
            // A new pairing of this desktop keeps lending; another server behind that address does not.
            const info = await cloudIdentity(env);
            if (grant.environmentId && grant.environmentId !== info.environmentId) { endCloud(env, "machine-changed"); break; }
            if (grant.environmentId !== info.environmentId || grant.sessionId !== info.sessionId) {
              grant = { ...grant, ...info };
              if (records[env.id]?.id === grant.id) store({ ...records, [env.id]: grant });
            }
          } else if (!matches(grant, await identity(env))) throw new Error("Server sign-in changed. Review computer access again in Settings.");
          // A folder deleted since is left out, so the rest (the internet connection too) keeps working; any other refusal
          // still stops lending.
          const present = new Set((await existingFolders(grant.folders, validateSharedFolders)).map(folder => folder.id));
          const folders = grant.folders.filter(folder => present.has(folder.id));
          const effectiveGrant = { ...grant, folders, protectedPaths: protectedRoots };
          await gate();
          awake();
          await request(env, "/api/shared-computers/connect", {
            id: grant.id, name: os.hostname().slice(0, 120), environmentId: grant.environmentId,
            folders: folders.map(({ id, name, write }) => ({ id, name, write })), terminal: grant.terminal, computer: grant.computer,
            // So My Cloud's bots say "your PC" on Windows and "your Mac" only on a Mac; only a server that takes it gets it.
            ...(supportsDetails.has(env.id) && LENT_PLATFORMS.has(process.platform) ? { platform: process.platform } : {}),
            ...(grant.cloud && supportsLink.has(env.id) ? { internet: grant.internet === true } : {}),
          }, signal, grant.secret);
          if (signal.aborted) break;
          status.set(env.id, { connected: true });
          changed();
          if (grant.cloud && grant.internet === true && supportsLink.has(env.id)) live.link ??= keepLink(env, grant, signal).catch(() => {});
          while (!signal.aborted) {
            await gate();
            awake();
            const { job } = await call("poll", {}, sleepsHere(env) ? AbortSignal.any([signal, power.signal()]) : signal);
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
            let leasing = false, ended = false, renewal = null;
            let control;
            const lease = async () => {
              if (leasing) return;
              leasing = true;
              try {
                await gate();
                if (!(await call("lease", { jobId: job.id })).active) jobAbort.abort();
                if (!ended) await (renewal = control?.renew());
              } catch { jobAbort.abort(); }
              finally { leasing = false; renewal = null; }
            };
            const heartbeat = setInterval(() => void lease(), 1000);
            let result;
            try {
              await lease(); jobSignal.throwIfAborted();
              if (grant.computer && ["computer_tools", "computer_call"].includes(job.operation.action)) {
                if (job.operation.action === "computer_call" && screenLocked()) throw new Error(SCREEN_LOCKED);
                if (!hostControl) throw new Error("The local computer control gate is unavailable");
                control = await hostControl(job.id, jobSignal);
                jobSignal.throwIfAborted();
              }
              result = await executeSharedOperation(effectiveGrant, job.operation, jobSignal, async () => {
                if (!live.cua) {
                  const connection = await cuaConnection();
                  jobSignal.throwIfAborted();
                  const mcp = sharedCuaConnection(connection);
                  if (!mcp) throw new Error(cuaUnavailable(connection?.reason));
                  live.cua = createSharedCua(mcp);
                }
                return live.cua;
              });
            } catch (error) { result = sharedComputerError(error); live.cua?.close(); live.cua = null; }
            finally {
              clearInterval(heartbeat); ended = true;
              await renewal?.catch(() => {});
              await control?.release().catch(() => {});
              executing = null; changed();
            }
            activity.record({
              env, action: job.operation.action, detail: describeSharedOperation(grant, job.operation), ok: result?.isError !== true,
              error: result?.isError === true ? result?.content?.[0]?.text : undefined,
            });
            // Never retry an action if the result delivery fails.
            await call("result", { jobId: job.id, result });
          }
        } catch (error) {
          if (error instanceof Paused) {
            if (running.get(env.id) === live) disconnect(env, grant, true);
            status.set(env.id, { connected: false, problem: "paused" });
            changed();
            break;
          }
          if (!signal.aborted && sleepsHere(env) && (error instanceof CloudAsleepError || power.asleep())) {
            status.set(env.id, { connected: false, problem: "asleep" });
            changed();
            await power.wait(signal);
            continue;
          }
          const problem = grant.cloud ? error.problem ?? (error.status === 401 || error.status === 403 ? "connect-first" : "waiting") : undefined;
          if (!signal.aborted) status.set(env.id, { connected: false, error: error.message, ...(problem ? { problem } : {}) });
          changed();
          // Its session on My Cloud ended (unused for a month, or signed out there): sign back in rather than wait for a click.
          if (problem === "connect-first" && reconnect && !signal.aborted && now() - (reconnected.get(env.id) ?? -Infinity) >= RECONNECT_EVERY_MS) {
            reconnected.set(env.id, now());
            if (await Promise.resolve(reconnect(env.origin)).catch(() => false)) continue;
          }
        }
        try { await delay(5000, undefined, { signal }); } catch { break; }
      }
    })().catch(() => {});
  };
  /** Lent and connected, it says whether its internet connection is in use yet: "on", "connecting", or "unsupported" by
   * a Cloud too old for the device link. */
  const internetState = (env, lent) => lent?.cloud && lent.internet === true && lent.enabled === true && status.get(env.id)?.connected
    ? { internet: true, link: !supportsLink.has(env.id) ? "unsupported" : linked.has(env.id) ? "on" : "connecting" }
    : { internet: lent?.cloud ? lent.internet === true : false };
  const state = id => {
    const grant = records[id];
    return { enabled: grant?.enabled === true, folders: Array.isArray(grant?.folders) ? grant.folders : [], terminal: grant?.terminal === true, computer: grant?.computer === true, ...status.get(id) };
  };
  // `paused`: lending waits (for the Cloud sign-in, say) and resumes by itself, so the server keeps it as lent, not stopped.
  const disconnect = (env, grant, paused = false) => {
    stop(env.id);
    if (paused && sleepsHere(env) && power.asleep()) return;
    if (grant?.secret) void request(env, `/api/shared-computers/${grant.id}/disconnect`, paused ? { paused: true } : {}, undefined, grant.secret).catch(() => {});
  };
  // One truthful state for My Cloud, whichever control lent to it: a grant from Settings → Servers → Computer access
  // (kept from before that panel left My Cloud's entry) is lending too, terminal and all, and shows as such.
  const cloudState = env => {
    const grant = env ? records[env.id] : undefined;
    const access = grant && !grant.cloud && grant.enabled === true ? grant : null;
    const lent = grant?.cloud ? grant : access;
    return {
      enabled: lent?.enabled === true,
      folders: lent && Array.isArray(lent.folders) ? lent.folders : [],
      screen: lent?.computer === true,
      // Only while lent: an off switch never keeps a terminal choice to be turned on again with it.
      terminal: lent?.enabled === true && lent.terminal === true,
      ...internetState(env, lent),
      busy: Boolean(env && executing?.env === env.id),
      ...(access ? { via: "access", terminal: access.terminal === true, ...(running.has(env.id) ? {} : { problem: "access-off" }) } : {}),
      ...(lent?.enabled !== true && grant?.stopped && typeof grant.stopped.at === "number" ? { stopped: { reason: String(grant.stopped.reason), at: grant.stopped.at } } : {}),
      ...(env ? status.get(env.id) : {}),
    };
  };
  const validRecord = grant => grant?.enabled === true && uuid(grant.id) && /^[a-f0-9]{64}$/.test(grant.secret) && Array.isArray(grant.folders) &&
    (grant.cloud
      ? typeof grant.cloud.accountId === "string" && typeof grant.cloud.origin === "string" && (grant.environmentId === null || uuid(grant.environmentId))
      : uuid(grant.sessionId) && uuid(grant.environmentId));
  return {
    state, identity,
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
    cloudState,
    /** Lending to My Cloud is running, so it calls My Cloud whenever it is awake. */
    lendingToCloud: () => [...running.keys()].some(id => Boolean(records[id]?.cloud)),
    /** Folders, apps and screen, the internet connection and, only when the person ticks it in this computer's own
     * Settings, a terminal (unrestricted commands as this user; off unless `input.terminal === true`); the Cloud account
     * and its machine must be verified now. The internet connection alone is a grant too. */
    async saveCloud(env, input) {
      if (closed) throw new Error("Lending is unavailable while the app is closing.");
      const current = cloud();
      if (current?.status !== "connected" || !current.accountId || current.origin !== env.origin) throw Object.assign(new Error("Open My Cloud first."), { problem: "connect-first" });
      const folders = await validateSharedFolders(input?.folders);
      if (!folders.length && input?.screen !== true && input?.internet !== true && input?.terminal !== true) throw new Error("Choose at least one folder, apps and screen, the internet connection, or the terminal.");
      let info = { sessionId: null, environmentId: null };
      try { info = await cloudIdentity(env); } catch (error) { if (error.problem !== "connect-first") throw error; }
      const grant = { ...info, id: randomUUID(), secret: randomBytes(32).toString("hex"), enabled: true, folders, terminal: input.terminal === true, computer: input.screen === true,
        internet: input.internet === true, cloud: { accountId: current.accountId, origin: env.origin } };
      disconnect(env, records[env.id]);
      store({ ...records, [env.id]: grant }); run(env, grant); changed();
      return cloudState(env);
    },
    revoke(env) {
      disconnect(env, records[env.id]);
      if (records[env.id]) store({ ...records, [env.id]: { ...records[env.id], enabled: false, ...(records[env.id].enabled ? { stopped: { reason: "you", at: now() } } : {}) } });
      changed();
      return state(env.id);
    },
    forget(env) { disconnect(env, records[env.id]); const next = { ...records }; delete next[env.id]; store(next); changed(); },
    start({ maintainer = true } = {}) {
      for (const env of environments()) {
        const grant = records[env.id];
        if (!validRecord(grant)) continue;
        if (grant.cloud) { if (cloudLendingVerdict(grant.cloud, cloud(), env).allow) run(env, grant); }
        else if (maintainer && !maintainerOff) run(env, grant);
      }
      changed();
    },
    cloudChanged() {
      if (closed) return;
      for (const env of environments()) {
        const grant = records[env.id];
        if (!grant?.cloud || grant.enabled !== true) continue;
        const verdict = cloudLendingVerdict(grant.cloud, cloud(), env);
        if (verdict.stop) endCloud(env, verdict.stop);
        else if (verdict.pause) { if (running.has(env.id)) { disconnect(env, grant, true); status.set(env.id, { connected: false, problem: "paused" }); changed(); } }
        else if (!running.has(env.id) && validRecord(grant)) run(env, grant);
      }
    },
    close() { closed = true; for (const id of running.keys()) stop(id); },
  };
}
