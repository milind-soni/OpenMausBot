import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createSharedCua, executeSharedOperation, personalSecretPaths, sharedComputerError, validCommandSeconds } from "./shared-computer-access.mjs";
import { sharedCuaConnection } from "./shared-cua-connection.mjs";
export { sharedCuaConnection };
import { createLendingActivity, describeSharedOperation } from "./lending-activity.mjs";
import { cuaUnavailable, SCREEN_LOCKED } from "./lent-screen-failures.mjs";
import { createLentScreenPresence } from "./lent-screen-presence.mjs";
import { BACKGROUND_HEADERS, CloudAsleepError, asleepAnswer, createCloudPowerGate } from "./cloud-power.mjs";
import { linkUrl, runDeviceLink } from "./device-link.mjs";
import { createComputerAsks } from "./computer-asks.mjs";
import { LINK_ASLEEP, linkPath } from "./device-link-protocol.mjs";
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

const GONE = new Set(["ENOENT", "ENOTDIR"]);

/** The folders that still exist and pass the checks a folder chosen by hand passes. One moved or deleted since is left
 * out; any other refusal (the whole home folder, a file) still fails. */
export async function existingFolders(folders, validate) {
  const found = await Promise.all(folders.map((folder) => validate([folder]).then((list) => list[0] ?? null, (error) => {
    if (GONE.has(error?.code)) return null;
    throw error;
  })));
  return found.filter(Boolean);
}

/** `homeEdits`: the home folder keeps the editing it asks for, which only the person's own Clouds get (lendAutomatically);
 * any other server gets it read only. */
export async function validateSharedFolders(folders, { homeEdits = false } = {}) {
  if (!Array.isArray(folders) || folders.length > 20) throw Object.assign(new Error("Choose at most 20 shared folders"), { code: "TOO_MANY" });
  const result = [];
  const enclosing = await enclosingHomeIdentities();
  for (const folder of folders) {
    if (!uuid(folder?.id) || typeof folder.path !== "string" || !path.isAbsolute(folder.path) || typeof folder.write !== "boolean") throw Object.assign(new Error("Choose folders using the desktop folder picker"), { code: "NOT_PICKED" });
    const canonical = await fsp.realpath(folder.path);
    if (!(await fsp.stat(canonical)).isDirectory()) throw Object.assign(new Error("Choose a folder, not a file"), { code: "NOT_FOLDER" });
    // The home folder, everything above it and the system disk are never shared. A separate drive (an external disk, a data
    // disk on a server, a drive letter) may be shared whole; any other mount point is still refused.
    // The home folder itself is lent only when asked for by name (`home: true`); anything above it, and the system disk,
    // are refused whatever is asked. Security: with editing, a write through it still never reaches its hidden files,
    // Library or AppData (insideHomeSettings), where shell start-up files and ~/.ssh live.
    const home = folder.home === true && await isHomeFolder(canonical);
    if (!home && (enclosing.has(await identify(canonical)) || ((await volumeRoot(canonical)) && !(await shareableDrive(canonical))))) throw Object.assign(new Error("Choose specific folders or a separate drive, not the entire computer or home folder"), { code: "HOME_OR_ROOT" });
    if (result.some(entry => entry.id === folder.id || entry.path === canonical)) continue;
    result.push({ id: folder.id, path: canonical, name: path.basename(canonical).slice(0, 120), write: home && !homeEdits ? false : folder.write, ...(home ? { home: true } : {}) });
  }
  return result;
}

const JOB_KEYS = new Set(["computer_id", "action", "folder_id", "path", "content", "encoding", "expected_sha256", "old_text", "new_text", "command", "timeout_seconds", "tool_name", "arguments"]);
const JOB_ACTIONS = new Set(["list_files", "read_file", "write_file", "edit_file", "append_file", "delete_file", "run_command", "computer_tools", "computer_call"]);
const optionalText = (value, max) => value === undefined || (typeof value === "string" && value.length <= max);
/** Refuses malformed input only; the grant still decides whether the operation is allowed. */
export function validSharedOperation(operation, computerId) {
  return Boolean(operation) && typeof operation === "object" && !Array.isArray(operation) &&
    Object.keys(operation).every(key => JOB_KEYS.has(key)) &&
    operation.computer_id === computerId && JOB_ACTIONS.has(operation.action) &&
    (operation.folder_id === undefined || uuid(operation.folder_id)) &&
    optionalText(operation.path, 2048) && optionalText(operation.content, 350_000) &&
    optionalText(operation.old_text, 350_000) && optionalText(operation.new_text, 350_000) &&
    (operation.encoding === undefined || operation.encoding === "utf8" || operation.encoding === "base64") &&
    (operation.expected_sha256 === undefined || (typeof operation.expected_sha256 === "string" && /^[a-f0-9]{64}$/.test(operation.expected_sha256))) &&
    optionalText(operation.command, 8000) && validCommandSeconds(operation.timeout_seconds) && optionalText(operation.tool_name, 100) &&
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

/** A Cloud grant lends the internet connection unless it was unticked: one kept without `internet` lends it too. */
const lendsInternet = grant => Boolean(grant?.cloud) && grant.internet !== false;

/** Whether the person said no to lending this Cloud before lending was automatic: their own Off (`stopped.reason` "you",
 * or an Off kept from before the reason was) or the internet connection unticked. Lending then starts Paused. */
export function saidNo(record) {
  if (!record?.cloud) return false;
  if (record.enabled !== true) return record.stopped?.reason === "you" || typeof record.stopped?.reason !== "string";
  return record.internet === false;
}

/** Security: the menu's switch lends the terminal to every Cloud of one account, so grants from before it stand for it
 * only when one account's grants all lent the terminal, as the person confirmed then, and nobody said no to lending. */
function terminalLentBeforeAutomatic(records) {
  const grants = Object.values(records).filter(record => record?.enabled === true && typeof record.cloud?.accountId === "string" && !saidNo(record));
  const accounts = new Set(grants.filter(grant => grant.terminal === true).map(grant => grant.cloud.accountId));
  if (accounts.size !== 1) return null;
  const [account] = accounts;
  return grants.every(grant => grant.cloud.accountId !== account || grant.terminal === true) ? account : null;
}

/** What each Cloud of the person's own gets by itself: the internet connection, their Chrome, apps and screen once
 * computer control works here (`screen`), and the home folder with editing (`home`, null when it can't be lent), on top
 * of the folders lent to it already (`kept`, which Files may keep copies of) and the project folders the move adds. The
 * terminal only when the person turned it on (`terminal`). At most 20 folders, the home folder first. */
export function automaticGrant({ kept = [], home = null, screen = false, projects = [], terminal = false }) {
  const byPath = new Map();
  const keptHome = home ? kept.find(folder => folder.path === home.path) : null;
  for (const folder of [...(home ? [keptHome ? { ...keptHome, write: true, home: true } : home] : []), ...kept, ...projects]) {
    const known = byPath.get(folder.path);
    byPath.set(folder.path, known ? { ...known, write: known.write || folder.write === true } : folder);
  }
  return { folders: [...byPath.values()].slice(0, 20), screen: screen === true, internet: true, chrome: true, terminal: terminal === true };
}

const lentAs = folder => `${folder.path}\n${folder.write === true}`;
/** The saved grant lends exactly what `wanted` (an automaticGrant) says. */
export function lendsAsWanted(record, wanted) {
  if (record?.enabled !== true || !record.cloud || !Array.isArray(record.folders)) return false;
  const have = new Set(record.folders.map(lentAs));
  return record.internet === true && record.chrome === true && (record.computer === true) === wanted.screen && (record.terminal === true) === wanted.terminal
    && have.size === wanted.folders.length && wanted.folders.every(folder => have.has(lentAs(folder)));
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
 * carries it (the session cookie). `myCloud()`: the saved server that is the person's own My Cloud, which the move's
 * project folders are lent to. `ownClouds()`: the saved servers that are the verified session's own Clouds, never a
 * Team Cloud: each is lent this computer by itself (automaticGrant) unless lending is paused. `screen()`: computer
 * control's state, whose `lent` says whether apps and screen are lent: computer control
 * works, or only macOS's permissions are missing, which `askForScreen(connection)` asks macOS for when a Cloud's bot
 * first needs them. `cloudPower(origin)`: the Admin's word on another Cloud of the person's own (the Clouds list's
 * `power`), so a sleeping one is never dialled. While this app is open, paused or not, each of those Clouds hears how
 * this computer is and asks for it when a bot there needs it: `prompt(env, ask, signal)` shows the ask in this app's
 * own prompt, `startScreen()` starts computer control again (its state after), and `confirmTerminal()` turns on
 * running commands once the person confirms it here. */
export function createComputerSharing({ file, fetch: fetchImpl, environments, cuaConnection, hostControl, screenLocked = () => false, idleSeconds = () => null, protectedPaths = [], enabled = async () => false, home = os.homedir(), activityFile, cloud = () => null, onChange = () => {}, reconnect = null, now = Date.now, power = createCloudPowerGate(),
  linkHeaders = () => ({}), WebSocket: linkSocket = globalThis.WebSocket, egress = {}, chrome = {}, myCloud = () => null, ownClouds = () => [], screen = () => false, askForScreen = () => {}, cloudPower = () => null,
  prompt = async () => null, startScreen = async () => null, confirmTerminal = async () => false, log = () => {} }) {
  const protectedRoots = [path.dirname(file), ...protectedPaths.filter(entry => typeof entry === "string" && entry), ...personalSecretPaths(home)];
  const activity = createLendingActivity(activityFile ?? path.join(path.dirname(file), "lending-activity.jsonl"));
  const presence = createLentScreenPresence({ idleSeconds, now });
  /** Computer control's latest state, for the icon's menu; null until it is first read. */
  let screenNow = null;
  let records = {};
  let paused = false;
  /** The Cloud account that confirmed lending the terminal; another account signed in here gets none until it confirms. */
  let terminalAccount = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed?.version === 1 && parsed.records && typeof parsed.records === "object") records = parsed.records;
    paused = parsed?.automatic ? parsed.automatic.paused === true : Object.values(records).some(saidNo);
    if (typeof parsed?.automatic?.terminalAccount === "string") terminalAccount = parsed.automatic.terminalAccount;
    else if (!parsed?.automatic) terminalAccount = terminalLentBeforeAutomatic(records);
  } catch {}
  const running = new Map();
  const grantVersions = new Map();
  const changeGrant = id => { const version = (grantVersions.get(id) ?? 0) + 1; grantVersions.set(id, version); return version; };
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
    const lent = paused ? [] : environments().filter(env => records[env.id]?.cloud && records[env.id]?.enabled === true);
    const using = lent.filter(env => executing?.env === env.id || (inUse.has(env.id) && linked.has(env.id)));
    return {
      lending: lent.map(env => env.id),
      clouds: (paused ? ownClouds() : lent).map(env => env.name),
      using: using.map(env => env.name),
      paused,
      terminal: terminalAccount !== null && terminalAccount === signedInAccount(),
      busy: executing ?? (browsing ? { env: browsing, action: "internet" } : null),
      screen: screenNow,
    };
  };
  /** Whether apps and screen are lent now; the icon's menu follows any change in why not. */
  const readScreen = () => Promise.resolve().then(screen).then(status => status, () => null).then(status => {
    const next = status && typeof status === "object" ? status : null;
    const before = JSON.stringify(screenNow);
    screenNow = next;
    if (JSON.stringify(next) !== before) changed();
    return status === true || next?.lent === true;
  });
  /** Each site My Cloud's browsers opened through this computer, or that its check refused, as activity. */
  const noted = new Map();
  const browsed = env => (target, result) => {
    if (!result?.socket && !result?.refused) return;
    const key = `${env.id}\n${target.chrome === true ? "chrome" : target.host}\n${result.refused ?? "ok"}`;
    if (now() - (noted.get(key) ?? -Infinity) < BROWSE_NOTE_MS) return;
    if (noted.size >= 1000) for (const [old, at] of noted) if (now() - at >= BROWSE_NOTE_MS) noted.delete(old);
    noted.set(key, now());
    const viaChrome = target.chrome === true;
    activity.record({ env, action: viaChrome ? "chrome" : "internet", detail: viaChrome ? "" : String(target.host), ok: Boolean(result.socket), ...(result.refused ? { error: String(result.refused) } : {}) });
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
    const verdict = cloudLendingVerdict(grant.cloud, cloud(env), env);
    if (verdict.allow) return;
    if (verdict.stop) { endCloud(env, verdict.stop); throw new Error("Lending to this Cloud stopped."); }
    throw new Paused("Waiting for your MausBot Cloud sign-in.");
  };
  const store = next => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, records: next, automatic: { paused, ...(terminalAccount ? { terminalAccount } : {}) } }), { mode: 0o600 });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, file); records = next;
  };
  const sleepsHere = env => Boolean(records[env.id]?.cloud) || cloud()?.origin === env.origin;
  /** My Cloud sleeps by the Admin's word and its own, on the gate this app shares with Files (`power`); another Cloud of
   * the person's own by the same two (the Clouds list's `power`, `cloudPower`, and its own "going to sleep" answer) on a
   * gate of its own, so one Cloud asleep never holds another's lending, and a sleeping one is not dialled until the Admin
   * says it is awake (any request reaching it would wake it). */
  const ownGates = new Map();
  const sleepGate = env => {
    if (env.id === myCloud()?.id || cloud()?.origin === env.origin) return power;
    if (!ownGates.has(env.id)) ownGates.set(env.id, createCloudPowerGate({ power: () => cloudPower(env.origin) }));
    return ownGates.get(env.id);
  };
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
      if (sleepsHere(env)) sleepGate(env).hold();
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
    return { auth, info: { sessionId: auth.id, environmentId: descriptor.environmentId }, details: descriptor.capabilities?.lendingDetails === true, link: descriptor.capabilities?.deviceLink === true, chrome: descriptor.capabilities?.myChromeLink === true, timeouts: descriptor.capabilities?.commandTimeouts === true, long: descriptor.capabilities?.longCommands === true, edits: descriptor.capabilities?.fileEdits === true, asks: descriptor.capabilities?.computerAsks === true };
  };
  const identity = async env => {
    await requireEnabled();
    const { info, edits } = await describe(env);
    await requireEnabled();
    if (edits) supportsEdits.add(env.id); else supportsEdits.delete(env.id);
    return info;
  };
  /** A server of the person's own their bots moved to: lent as their Clouds are, to its one owner's sign-in alone, at the
   * server the move chose (lending-target.mjs `own:<environment id>`). */
  const ownHomeId = env => { const current = cloud(env); return current?.origin === env.origin && current.accountId?.startsWith("own:") ? current.accountId.slice(4) : null; };
  const cloudIdentity = async env => {
    const { auth, info, details, link, chrome: takesChrome, timeouts, long, edits } = await describe(env);
    const own = ownHomeId(env);
    if (own !== null && (auth.own !== true || info.environmentId !== own)) throw Object.assign(new Error("This server is not your bots' home any more"), { problem: "not-cloud" });
    if ((own === null && auth.cloudHome !== true) || !Array.isArray(auth.scopes) || !auth.scopes.includes("admin")) throw Object.assign(new Error("This server is not My Cloud"), { problem: "not-cloud" });
    if (details) supportsDetails.add(env.id); else supportsDetails.delete(env.id);
    if (link) supportsLink.add(env.id); else supportsLink.delete(env.id);
    if (takesChrome) supportsChrome.add(env.id); else supportsChrome.delete(env.id);
    if (timeouts) supportsTimeouts.add(env.id); else supportsTimeouts.delete(env.id);
    if (long) supportsLong.add(env.id); else supportsLong.delete(env.id);
    if (edits) supportsEdits.add(env.id); else supportsEdits.delete(env.id);
    return info;
  };
  const supportsDetails = new Set();
  const supportsLink = new Set();
  /** The Clouds that take the person's Chrome over the device link. */
  const supportsChrome = new Set();
  const supportsTimeouts = new Set();
  const supportsLong = new Set();
  const supportsEdits = new Set();
  /** My Cloud's browsers reach the web through this computer while lending runs; never while My Cloud sleeps, so a
   * sleeping Cloud is never dialled. */
  const keepLink = async (env, grant, signal) => {
    for (let failures = 0; !signal.aborted;) {
      if (sleepsHere(env) && sleepGate(env).asleep()) {
        await sleepGate(env).wait(signal);
        continue;
      }
      let opened = false;
      const signIn = await Promise.resolve().then(() => linkHeaders(env)).catch(() => ({}));
      const ended = await runDeviceLink({
        url: linkUrl(env.origin, linkPath(grant.id)), signal, WebSocket: linkSocket, egress, traffic: traffic(env.id), onStream: browsed(env), chrome,
        lends: () => ({ internet: lendsInternet(grant), chrome: grant.chrome === true && supportsChrome.has(env.id) }),
        headers: { ...signIn, origin: env.origin, ...BACKGROUND_HEADERS, "x-omb-computer-secret": grant.secret },
        onOpen: () => { opened = true; failures = 0; linked.add(env.id); changed(); },
      });
      linked.delete(env.id); changed();
      if (signal.aborted) return;
      if (ended.code === LINK_ASLEEP) { if (sleepsHere(env)) sleepGate(env).hold(); continue; }
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
    if (closed || !grant.enabled || (grant.cloud ? paused : maintainerOff)) return;
    const live = { abort: new AbortController(), cua: null };
    running.set(env.id, live);
    const signal = live.abort.signal;
    const call = (action, body = {}, held = signal) => request(env, `/api/shared-computers/${grant.id}/${action}`, body, held, grant.secret);
    const gate = () => requireGrant(env, grant);
    const awake = () => { if (sleepsHere(env) && sleepGate(env).asleep()) throw new CloudAsleepError(); };
    void (async () => {
      while (!signal.aborted) {
        try {
          await gate();
          awake();
          if (grant.cloud) {
            // A new pairing of this desktop keeps lending; another server behind that address does not.
            const info = await cloudIdentity(env);
            if (signal.aborted || running.get(env.id) !== live) break;
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
            ...(grant.cloud && supportsLink.has(env.id) ? { internet: lendsInternet(grant) } : {}),
            ...(grant.cloud && supportsChrome.has(env.id) ? { chrome: grant.chrome === true } : {}),
            ...(supportsTimeouts.has(env.id) ? { commandTimeouts: true } : {}),
            ...(supportsLong.has(env.id) ? { longCommands: true } : {}),
            ...(supportsEdits.has(env.id) ? { fileEdits: true } : {}),
          }, signal, grant.secret);
          if (signal.aborted) break;
          status.set(env.id, { connected: true });
          changed();
          if (supportsLink.has(env.id) && (lendsInternet(grant) || (grant.cloud && grant.chrome === true && supportsChrome.has(env.id)))) live.link ??= keepLink(env, grant, signal).catch(() => {});
          while (!signal.aborted) {
            await gate();
            awake();
            const { job } = await call("poll", {}, sleepsHere(env) ? AbortSignal.any([signal, sleepGate(env).signal()]) : signal);
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
              // Listing the tools never touches the screen, so only a call takes this computer's screen lock.
              if (grant.computer && job.operation.action === "computer_call") {
                if (screenLocked()) throw new Error(SCREEN_LOCKED);
                const waits = presence.refusal(job.operation.tool_name, job.operation.arguments);
                if (waits) throw new Error(waits);
                if (!hostControl) throw new Error("The local computer control gate is unavailable");
                control = await hostControl(job.id, jobSignal);
                jobSignal.throwIfAborted();
              }
              result = await executeSharedOperation(effectiveGrant, job.operation, jobSignal, async () => {
                if (!live.cua) {
                  const connection = await cuaConnection();
                  jobSignal.throwIfAborted();
                  const mcp = sharedCuaConnection(connection);
                  if (!mcp) { if (grant.cloud) try { askForScreen(connection); } catch {} throw new Error(cuaUnavailable(connection?.reason)); }
                  live.cua = createSharedCua(mcp);
                }
                return live.cua;
              });
            } catch (error) { result = sharedComputerError(error); live.cua?.close(); live.cua = null; }
            finally {
              clearInterval(heartbeat); ended = true;
              if (control) presence.acted(job.operation.tool_name, job.operation.arguments);
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
          if (!signal.aborted && sleepsHere(env) && (error instanceof CloudAsleepError || sleepGate(env).asleep())) {
            status.set(env.id, { connected: false, problem: "asleep" });
            changed();
            await sleepGate(env).wait(signal);
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
  const internetState = (env, lent) => lendsInternet(lent) && lent.enabled === true && status.get(env.id)?.connected
    ? { internet: true, link: !supportsLink.has(env.id) ? "unsupported" : linked.has(env.id) ? "on" : "connecting" }
    : { internet: lendsInternet(lent) };
  /** The same for the person's Chrome: "on", "connecting", or "unsupported" by a Cloud that does not take it. */
  const chromeState = (env, lent) => lent?.cloud && lent.chrome === true && lent.enabled === true && status.get(env.id)?.connected
    ? { chrome: true, chromeLink: !supportsChrome.has(env.id) ? "unsupported" : linked.has(env.id) ? "on" : "connecting" }
    : { chrome: lent?.cloud ? lent.enabled === true && lent.chrome === true : false };
  const state = id => {
    const grant = records[id];
    return { enabled: grant?.enabled === true, folders: Array.isArray(grant?.folders) ? grant.folders : [], terminal: grant?.terminal === true, computer: grant?.computer === true, ...status.get(id) };
  };
  // `resumes`: lending waits (for the Cloud sign-in, say) and resumes by itself, so the server keeps it as lent, not stopped.
  const disconnect = (env, grant, resumes = false) => {
    stop(env.id);
    if (resumes && sleepsHere(env) && sleepGate(env).asleep()) return;
    if (grant?.secret) void request(env, `/api/shared-computers/${grant.id}/disconnect`, resumes ? { paused: true } : {}, undefined, grant.secret).catch(() => {});
  };
  const cloudState = env => {
    const grant = env ? records[env.id] : undefined;
    const lent = grant?.cloud ? grant : null;
    return {
      enabled: lent?.enabled === true,
      folders: lent && Array.isArray(lent.folders) ? lent.folders : [],
      screen: lent?.computer === true,
      terminal: lent?.enabled === true && lent.terminal === true,
      ...internetState(env, lent),
      ...chromeState(env, lent),
      busy: Boolean(env && executing?.env === env.id),
      ...(env ? status.get(env.id) : {}),
    };
  };
  const validRecord = grant => grant?.enabled === true && uuid(grant.id) && /^[a-f0-9]{64}$/.test(grant.secret) && Array.isArray(grant.folders) &&
    (grant.cloud
      ? typeof grant.cloud.accountId === "string" && typeof grant.cloud.origin === "string" && (grant.environmentId === null || uuid(grant.environmentId))
      : uuid(grant.sessionId) && uuid(grant.environmentId));
  const cloudGrant = (env, current, info, { folders = [], screen, internet, terminal, chrome }) => ({ ...info, id: randomUUID(), secret: randomBytes(32).toString("hex"), enabled: true, folders,
    terminal: terminal === true, computer: screen === true, internet: internet === true, chrome: chrome === true, cloud: { accountId: current.accountId, origin: env.origin } });
  const verifiedCloud = env => {
    const current = cloud(env);
    return current?.status === "connected" && current.accountId && current.origin === env.origin ? current : null;
  };
  const signedInAccount = () => ownClouds().map(verifiedCloud).find(Boolean)?.accountId ?? null;
  /** The Cloud account and its machine must be verified now. A terminal (unrestricted commands as this user) only when
   * `input.terminal === true`. */
  const saveCloud = async (env, input, version = changeGrant(env.id)) => {
    if (closed) throw new Error("Lending is unavailable while the app is closing.");
    if (grantVersions.get(env.id) !== version) return cloudState(env);
    const current = verifiedCloud(env);
    if (!current) throw Object.assign(new Error("Open My Cloud first."), { problem: "connect-first" });
    const folders = await validateSharedFolders(input?.folders, { homeEdits: true });
    if (!folders.length && input?.screen !== true && input?.internet !== true && input?.chrome !== true && input?.terminal !== true) throw new Error("Choose at least one folder, apps and screen, the internet connection, your Chrome, or the terminal.");
    let info = { sessionId: null, environmentId: null };
    try { info = await cloudIdentity(env); } catch (error) { if (error.problem !== "connect-first") throw error; }
    if (grantVersions.get(env.id) !== version) return cloudState(env);
    const grant = cloudGrant(env, current, info, { ...input, folders });
    disconnect(env, records[env.id]);
    store({ ...records, [env.id]: grant }); run(env, grant); changed();
    return cloudState(env);
  };
  const lendable = folders => Promise.all(folders.map(folder => validateSharedFolders([folder], { homeEdits: true }).then(([checked]) => checked ?? null, () => null)))
    .then(found => found.filter(Boolean));
  /** Calls nothing itself, so a sleeping Cloud is never woken: the grant reaches its Cloud the way any grant does, once that
   * Cloud is awake. A grant still bound to this Cloud keeps its binding to that Cloud's machine. */
  const lendNow = (env, current, kept, wanted) => {
    changeGrant(env.id);
    const bound = kept?.enabled === true && kept.cloud?.accountId === current.accountId && kept.cloud.origin === env.origin;
    const grant = cloudGrant(env, current, bound ? { sessionId: kept.sessionId ?? null, environmentId: kept.environmentId ?? null } : { sessionId: null, environmentId: null }, wanted);
    if (sleepsHere(env) && sleepGate(env).asleep()) stop(env.id); else disconnect(env, kept);
    try { store({ ...records, [env.id]: grant }); } catch { return; }
    run(env, grant);
    changed();
  };
  const automaticPass = async (projects, target) => {
    if (closed || paused || !ownClouds().some(verifiedCloud)) return;
    const [[homeFolder = null], screenLent, projectFolders] = await Promise.all([
      lendable([{ id: randomUUID(), path: home, write: true, home: true }]),
      readScreen(),
      lendable(projects.map(where => ({ id: randomUUID(), path: where, write: true }))),
    ]);
    for (const env of ownClouds()) {
      const kept = records[env.id], current = verifiedCloud(env);
      if (closed || paused || !current) continue;
      const keptFolders = kept?.cloud?.accountId === current.accountId && Array.isArray(kept.folders) ? await lendable(kept.folders) : [];
      const wanted = automaticGrant({ kept: keptFolders, home: homeFolder, screen: screenLent, projects: env.id === (target ?? myCloud())?.id ? projectFolders : [],
        terminal: terminalAccount === current.accountId });
      if (closed || paused || records[env.id] !== kept) continue;
      if (!lendsAsWanted(kept, wanted)) lendNow(env, current, kept, wanted);
      else if (!running.has(env.id) && validRecord(kept) && cloudLendingVerdict(kept.cloud, cloud(env), env).allow) run(env, kept);
    }
  };
  /** This computer as the person's own Clouds hear it: paused, and why apps and screen or commands aren't lent. */
  const thisComputer = async () => {
    const status = await Promise.resolve().then(screen).then(value => value && typeof value === "object" ? value : null, () => null);
    return { name: os.hostname().slice(0, 120) || "This computer", platform: LENT_PLATFORMS.has(process.platform) ? process.platform : null, paused,
      screen: { ready: status?.ready === true, reason: status && !status.ready ? status.reason ?? null : null }, terminal: terminalAccount !== null && terminalAccount === signedInAccount() };
  };
  /** Every Cloud of the person's own may use this computer again. */
  const resumeLending = () => {
    if (!paused || closed) return;
    paused = false;
    try { store(records); } catch {}
    const automatic = lentAutomatically();
    for (const env of environments()) {
      const grant = records[env.id];
      if (grant?.cloud && !automatic.has(env.id) && validRecord(grant) && !running.has(env.id) && cloudLendingVerdict(grant.cloud, cloud(env), env).allow) run(env, grant);
    }
    changed();
    wakeAsking();
    return lendAutomatically();
  };
  /** Turn on, from this app's prompt or the card: what the ask needs, done here. */
  const turnOn = async (env, ask) => {
    if (paused) await resumeLending();
    if (ask.need === "screen") {
      let status = await Promise.resolve().then(screen).catch(() => null);
      if (status && typeof status === "object" && !status.ready) status = await startScreen();
      if (status && typeof status === "object" && !status.ready) return { ok: false, reason: status.reason ?? "not-running" };
    }
    if (ask.need === "terminal" && terminalAccount !== signedInAccount() && !(await confirmTerminal())) return { declined: true };
    return { ok: true };
  };
  /** Per Cloud that takes asks: what stops its poll for good, and what ends its current poll early. */
  const asking = new Map();
  /** A Cloud too old to take asks is asked again only after this long. */
  const olderClouds = new Map();
  const asks = createComputerAsks({ prompt: (env, ask, signal) => prompt(env, ask, signal), turnOn, log, answered: id => asking.get(id)?.wake() });
  const keepAsking = async (env, entry) => {
    const { signal } = entry.stop;
    let heard = -1, failures = 0, supported = null;
    while (!signal.aborted && !closed) {
      if (sleepsHere(env) && sleepGate(env).asleep()) { await sleepGate(env).wait(signal); continue; }
      const early = new AbortController();
      entry.wake = () => early.abort();
      const answers = [...asks.pending(env.id)];
      try {
        supported ??= (await describe(env)).asks;
        if (!supported) { olderClouds.set(env.id, now()); return; }
        const news = await request(env, "/api/shared-computers/asks", { ...await thisComputer(), heard, answers }, AbortSignal.any([signal, early.signal, sleepGate(env).signal()]));
        asks.sent(env.id, answers);
        failures = 0;
        if (Number.isSafeInteger(news?.version)) heard = news.version;
        asks.heard(env, Array.isArray(news?.asks) ? news.asks : []);
      } catch (error) {
        if (signal.aborted) return;
        if (early.signal.aborted || error instanceof CloudAsleepError) continue;
        if (error?.status === 404) { olderClouds.set(env.id, now()); return; }
        failures++;
        try { await delay(LINK_RETRY_MS[Math.min(failures, LINK_RETRY_MS.length - 1)], undefined, { signal }); } catch { return; }
      }
    }
  };
  /** Each verified own Cloud hears this computer while this app is open; the others don't. */
  const syncAsking = () => {
    const wanted = closed ? new Set() : new Set(ownClouds().filter(verifiedCloud).map(env => env.id));
    for (const [id, entry] of asking) if (!wanted.has(id)) { entry.stop.abort(); asking.delete(id); }
    for (const env of ownClouds()) {
      if (!wanted.has(env.id) || asking.has(env.id) || now() - (olderClouds.get(env.id) ?? -Infinity) < 30 * 60_000) continue;
      const entry = { stop: new AbortController(), wake: () => {} };
      asking.set(env.id, entry);
      void keepAsking(env, entry).catch(() => {}).finally(() => { if (asking.get(env.id) === entry) asking.delete(env.id); });
    }
  };
  /** This computer changed: each Cloud hears it now, not at its next poll. */
  const wakeAsking = () => { for (const entry of asking.values()) entry.wake(); };
  /** The Clouds whose grant the automatic pass runs: it runs a kept grant only once it lends what it should. */
  const lentAutomatically = () => new Set(ownClouds().map(env => env.id));
  /** One pass at a time: a change while one runs asks for one more after it. */
  let passing = Promise.resolve(), passQueued = false;
  const lendAutomatically = (projects = [], target = null) => {
    if (passQueued && !projects.length) return passing;
    passQueued = true;
    passing = passing.then(() => { passQueued = false; return automaticPass(projects, target); }).catch(() => {}).finally(syncAsking);
    return passing;
  };
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
    decline(env, info) { changeGrant(env.id); disconnect(env, records[env.id]); store({ ...records, [env.id]: { ...info, enabled: false, folders: [], terminal: false, computer: false } }); },
    async save(env, input, info) {
      const version = changeGrant(env.id);
      const fresh = await identity(env);
      if (!matches(info, fresh)) throw new Error("Server sign-in changed. Review computer access again.");
      const folders = await validateSharedFolders(input.folders);
      await requireEnabled();
      const grant = { ...fresh, id: randomUUID(), secret: randomBytes(32).toString("hex"), enabled: true, folders, terminal: input.terminal === true, computer: input.computer === true };
      if (!folders.length && !grant.terminal && !grant.computer) throw new Error("Choose at least one folder or capability to share");
      if (grantVersions.get(env.id) !== version) return state(env.id);
      disconnect(env, records[env.id]);
      store({ ...records, [env.id]: grant }); run(env, grant); changed(); return state(env.id);
    },
    cloudState,
    /** What Files copies to My Cloud (electron/lent-folders.mjs): the folders lent to it, with this grant's id and the
     * places no grant reaches, and `paused` while lending is; `{ off: true }` while nothing is lent to it. */
    lentToCloud(env) {
      const grant = env ? records[env.id] : undefined;
      const lent = grant?.cloud ? grant : grant?.enabled === true ? grant : null;
      if (lent?.enabled !== true || !Array.isArray(lent.folders)) return { off: true };
      return { lendingId: lent.id, folders: lent.folders.map(({ id, path: where, name, write }) => ({ id, path: where, name, write: write === true })), protectedPaths: protectedRoots, ...(paused ? { paused: true } : {}) };
    },
    /** Lending to My Cloud is running, so it calls My Cloud whenever it is awake. */
    lendingToCloud: () => [...running.keys()].some(id => Boolean(records[id]?.cloud)),
    /** A server is using this computer now: a job running on it, or its browsing going through this computer. */
    busy: () => summary().busy !== null,
    saveCloud,
    /** The move's project folders, lent to the home it went to (My Cloud unless `place` names a server of the person's own)
     * with editing on top of the rest. It throws while lending there can't take them yet (paused, or not signed in there),
     * so the move tries again later. */
    async lendProjects(paths, place = null) {
      const env = place ?? myCloud();
      if (paused || !env || !verifiedCloud(env)) throw new Error("Lending to your bots' home waits until it is signed in and not paused.");
      await lendAutomatically(Array.isArray(paths) ? paths.filter(where => typeof where === "string") : [], env);
      if (records[env.id]?.enabled !== true) throw new Error("Lending to My Cloud did not start.");
    },
    paused: () => paused,
    /** Every Cloud of the person's own stops using this computer, across restarts too, until resume(). */
    pause() {
      if (paused || closed) return;
      paused = true;
      try { store(records); } catch {}
      for (const env of environments()) {
        if (!records[env.id]?.cloud) continue;
        if (running.has(env.id)) disconnect(env, records[env.id]);
        status.set(env.id, { connected: false, problem: "paused" });
      }
      changed();
      wakeAsking();
    },
    resume: () => resumeLending(),
    /** Whether every Cloud of the signed-in account's own may run commands here as this user, across restarts too. */
    lendTerminal(on) {
      const account = on === true ? signedInAccount() : null;
      if (closed || terminalAccount === account) return;
      if (on === true && !account) throw new Error("Sign in to the Cloud before lending it the terminal.");
      const before = terminalAccount;
      terminalAccount = account;
      try { store(records); } catch (error) { terminalAccount = before; throw error; }
      // A Cloud the pass can't verify now keeps its grant until it can, so its commands stop here.
      if (!account) for (const [id, grant] of Object.entries(records)) if (grant?.cloud && grant.terminal === true) stop(id);
      changed();
      wakeAsking();
      return lendAutomatically();
    },
    /** Computer control started or stopped: apps and screen follow. */
    screenChanged: () => readScreen().then(() => { wakeAsking(); return lendAutomatically(); }),
    revoke(env) {
      changeGrant(env.id);
      disconnect(env, records[env.id]);
      if (records[env.id]) store({ ...records, [env.id]: { ...records[env.id], enabled: false, ...(records[env.id].enabled ? { stopped: { reason: "you", at: now() } } : {}) } });
      changed();
      return state(env.id);
    },
    forget(env) { changeGrant(env.id); disconnect(env, records[env.id]); const next = { ...records }; delete next[env.id]; store(next); changed(); },
    start({ maintainer = true } = {}) {
      const automatic = lentAutomatically();
      for (const env of environments()) {
        const grant = records[env.id];
        if (!validRecord(grant)) continue;
        if (grant.cloud) { if (!automatic.has(env.id) && cloudLendingVerdict(grant.cloud, cloud(env), env).allow) run(env, grant); }
        else if (maintainer && !maintainerOff) run(env, grant);
      }
      changed();
      void lendAutomatically();
    },
    cloudChanged() {
      if (closed) return;
      // The Admin's word on each other Cloud may have changed: a lending loop waiting for one to wake goes on.
      for (const gate of ownGates.values()) gate.changed();
      const automatic = lentAutomatically();
      for (const env of environments()) {
        const grant = records[env.id];
        if (!grant?.cloud || grant.enabled !== true) continue;
        const verdict = cloudLendingVerdict(grant.cloud, cloud(env), env);
        if (verdict.stop) endCloud(env, verdict.stop);
        else if (verdict.pause) { if (running.has(env.id)) { disconnect(env, grant, true); status.set(env.id, { connected: false, problem: "paused" }); changed(); } }
        else if (!running.has(env.id) && !automatic.has(env.id) && validRecord(grant)) run(env, grant);
      }
      void lendAutomatically();
    },
    close() { closed = true; for (const id of running.keys()) stop(id); syncAsking(); asks.close(); },
  };
}
