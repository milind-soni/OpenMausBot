// Copy this computer here, the desktop's half (docs/copy-workspace.md;
// server/cloud-move-http.ts is the receiving server's). One action copies this
// computer's workspace to a server the person owns and added in this app, their
// OMB Cloud included, by one code path:
//
//   1. this computer's server exports its ordinary encrypted workspace backup
//      (the backup policy decides what travels: never a credential, sign-in,
//      pairing or session, never this app's Cloud sign-in or lending grants);
//   2. main copies it to a private temporary file and uploads it to the
//      destination in parts, continuing where a dropped connection left it;
//   3. the destination checks it is a valid backup, backs up its own work if it
//      has any (Swap back), restores, and restarts; main waits until it is back.
//
// Main talks to the destination with a session of its own. The destination's
// `grant()` proves the owner and opens one single-use admin pairing window
// there: on the Cloud the Admin does (pairHome); on any other server, this
// window's own owner session mints it (mintOwnerCode). Main redeems it for a
// bearer token held only in memory, and signs that session out when the copy
// ends. This computer's data is copied, never changed or deleted. Pure apart
// from its injected requests, so node tests drive it end to end. The names say
// "cloud" (`cloud-move`, CloudMove…): the routes must stay for live Clouds.
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { isAbsolute, join, parse, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { CLOUD_HOME_NAME } from "./cloud-home.mjs";

const MAGIC = Buffer.from("OMB-WORKSPACE-1\n");
const MIN_BYTES = MAGIC.length + 16 + 12 + 16;
/** The largest backup a server accepts (server/cloud-move.ts CLOUD_MOVE_MAX_BYTES). */
export const CLOUD_MOVE_MAX_BYTES = 10 * 1024 ** 3 + 256 * 1024 ** 2;
const PART_BYTES = 16 * 1024 ** 2;
const MAX_PART_BYTES = 64 * 1024 ** 2;
// A proxy in front of a server (nginx allows 1 MB by default) answers 413 to
// a part: parts halve down to this before the copy says so.
const MIN_PART_BYTES = 512 * 1024;
const SPACE_MARGIN = 256 * 1024 ** 2;
const GB = 1024 ** 3;
/** A Cloud whose disk grows does so in steps of this size (openmaus-cloud VOLUME_EXTEND). */
const DISK_STEP_GB = 10;
// A failed upload keeps its archive this long, so Try again continues it.
const REUSE_MS = 30 * 60_000;
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/;
const LOCAL_ROUTES = /^\/api\/(?:workspace-backup\/(?:status|export|download\/[a-f\d-]{36})|cloud-move\/estimate)$/;
const RESUMABLE = new Set(["upload_failed", "cloud_unavailable", "network", "cloud_busy", "cancelled", "proxy_limit"]);
/** The version rule a server stages a backup by (server/workspace-backup.ts). */
const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

export class CloudMoveError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = "CloudMoveError"; this.code = code; this.details = details; }
}
const fail = (code, message, details) => { throw new CloudMoveError(code, message, details); };
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const defaultSleep = (ms, signal) => new Promise((done, reject) => {
  const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); done(); }, ms);
  const abort = () => { clearTimeout(timer); reject(signal.reason); };
  signal?.addEventListener("abort", abort, { once: true });
});

/** Whether an IPC sender is the person's own Cloud, open in this window:
 * the main frame of the main window, at exactly the origin the verified Cloud
 * session reports, while that is the window's active server. Only the Cloud's
 * own channels use it (lending, the plan); a copy asks moveSenderDestination. */
export function cloudPageSenderAllowed(event, { contents, homeOrigin, activeOrigin }) {
  if (!contents || !homeOrigin || activeOrigin !== homeOrigin) return false;
  if (event?.sender !== contents || !event.senderFrame || event.senderFrame !== contents.mainFrame) return false;
  try { return new URL(event.senderFrame.url).origin === homeOrigin; } catch { return false; }
}

/** Where a copy asked over IPC goes, decided by main, never by the page:
 * - this computer's own page (the main window's main frame, on Local) names a
 *   saved server by `id`, or "cloud" for the person's Cloud home;
 * - a saved server's own page, open as the window's active server, names
 *   nothing and is answered about itself (`remote: true`).
 * `entry: null`: this computer's page asked without naming one. Anything else
 * (another window, a subframe, a page naming a destination) is null. */
export function moveSenderDestination(event, { contents, environments, localOrigin, cloudHomeOrigin = null, id }) {
  if (!contents || event?.sender !== contents || !event.senderFrame || event.senderFrame !== contents.mainFrame) return null;
  let origin;
  try { origin = new URL(event.senderFrame.url).origin; } catch { return null; }
  const saved = Array.isArray(environments?.environments) ? environments.environments : [];
  const active = saved.find(entry => entry.id === environments.activeId) ?? null;
  const named = id !== undefined && id !== null;
  if (!active && localOrigin && origin === localOrigin) {
    if (!named) return { entry: null, remote: false };
    if (id === "cloud") {
      return { entry: { ...(saved.find(entry => cloudHomeOrigin && entry.origin === cloudHomeOrigin) ?? { id: "cloud", name: CLOUD_HOME_NAME, origin: cloudHomeOrigin }), cloud: true }, remote: false };
    }
    const entry = typeof id === "string" ? saved.find(candidate => candidate.id === id) : undefined;
    return entry ? { entry, remote: false } : null;
  }
  if (named || !active || origin !== active.origin) return null;
  return { entry: active, remote: true };
}

/** What a destination's own answer to this window says about a copy there
 * (`GET /api/cloud-move` with the window's session): why it cannot receive one. */
export function moveRefusal(status, body) {
  if (status === 403 && body?.code === "shared_workspace") return "shared_workspace";
  // A server from before any server could receive one.
  if (status === 404) return "outdated";
  if (status === 401 || status === 403) return "owner_needed";
  return "unreachable";
}

/** Whether version `a` is older than `b`, by the staging rule; unknown is not older. */
export function olderVersion(a, b) {
  const [left, right] = [a, b].map(version => typeof version === "string" ? VERSION.exec(version)?.slice(1).map(Number) : undefined);
  if (!left || !right) return false;
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] < right[i];
  return false;
}

/** Why a copy to a destination cannot start now, before anything is asked of
 * it, or null: one reason, so each has one message. `refusal`: moveRefusal.
 * The Cloud's Admin opens a session there itself, so no session in this
 * window (or none reachable yet) does not block the Cloud. */
export function moveBlocked({ kind, refusal = null, local = null, cloud = null, busyElsewhere = false }) {
  if (busyElsewhere) return "busy_elsewhere";
  if (refusal && !(kind === "cloud" && (refusal === "owner_needed" || refusal === "unreachable"))) return refusal;
  if (local?.environmentId && cloud?.environmentId && local.environmentId === cloud.environmentId) return "same_computer";
  if (olderVersion(cloud?.appVersion, local?.appVersion)) return "outdated";
  return null;
}

/** Mint a single-use owner pairing code on `origin` with this window's own
 * session there (the cookie the server's /pair page set): it must be a
 * signed-in session with admin scope. The code carries the owner's scopes
 * (admin and client, like the Cloud's): signing the copy's session out
 * needs client scope. `fetchImpl` is the window session's
 * fetch (Chromium's cookie jar); the cookie is never the copy's own
 * credential, because signing that session out would sign the window out. */
export async function mintOwnerCode(fetchImpl, origin, { label = "Copy from desktop", timeoutMs = 15_000 } = {}) {
  const ask = (route, init = {}) => fetchImpl(`${origin}${route}`, { ...init, credentials: "include", redirect: "error", cache: "no-store",
    headers: { accept: "application/json", origin, ...init.headers }, signal: AbortSignal.timeout(timeoutMs) });
  const ownerNeeded = () => fail("owner_needed", "This app isn't signed in to that server as its owner. Pair it again with an owner code, then copy.");
  let response;
  try { response = await ask("/api/auth/session"); } catch { fail("network", "The copy could not reach that server. Check your connection and try again."); }
  const session = await readJson(response).catch(() => null);
  if (!response.ok || session?.kind !== "session" || !Array.isArray(session.scopes) || !session.scopes.includes("admin")) ownerNeeded();
  // A hosted organisation workspace: other people work there too.
  if (session.hosted === true) fail("shared_workspace", "That server is shared with other people, so it can't receive this computer's bots and chats.");
  try {
    response = await ask("/api/auth/pairing", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scopes: ["admin", "client"], label }) });
  } catch { fail("network", "The copy could not reach that server. Check your connection and try again."); }
  const minted = await readJson(response).catch(() => null);
  if (!response.ok || typeof minted?.code !== "string") {
    // An organisation that turned remote access off says so in its own words.
    if (minted?.code === "managed_policy" && sentence(minted.error)) fail("cloud_refused", sentence(minted.error));
    ownerNeeded();
  }
  return { origin, code: minted.code, expiresAt: count(minted.expiresAt) ? minted.expiresAt : Date.now() + 60_000 };
}

/** What this computer holds, as shown before a copy. `routines`: how many
 * are switched on here (they arrive paused); `appVersion` and
 * `environmentId`: which server this is (a server from before does not say). */
export function parseMoveEstimate(value) {
  if (!record(value) || !["bots", "rooms", "chats", "bytes", "files"].every(key => count(value[key]))) return null;
  return { bots: value.bots, rooms: value.rooms, chats: value.chats, bytes: value.bytes, files: value.files, ...(count(value.routines) ? { routines: value.routines } : {}),
    ...identity(value) };
}
/** Which server answered, when it says. */
const identity = value => ({
  appVersion: typeof value.appVersion === "string" && VERSION.test(value.appVersion) ? value.appVersion : null,
  environmentId: typeof value.environmentId === "string" && /^[\w-]{1,128}$/.test(value.environmentId) ? value.environmentId : null,
});

/** Whether a move of `localBytes` fits on the Cloud: `now`; once its disk
 * grows (`grow`: a plan whose disk grows as it fills, up to `disk.maxBytes`,
 * with `sizeGb` the size to ask for); or `never`, not even at the plan's
 * largest disk. The room a move needs is the Cloud's own rule (three times
 * the upload while it is checked and installed, and a margin); the Cloud
 * checks again, exactly, before anything is uploaded. */
export function moveFit({ localBytes, freeBytes, uploadReceived = 0, volumeBytes = null, disk = null }) {
  const neededBytes = 3 * localBytes + SPACE_MARGIN, available = freeBytes + uploadReceived;
  const maxBytes = count(disk?.maxBytes) && disk.maxBytes > 0 ? disk.maxBytes : null;
  const volume = [volumeBytes, disk?.volumeBytes, disk?.startBytes].find(value => count(value) && value > 0) ?? null;
  if (available >= neededBytes) return { fit: "now", neededBytes, freeBytes: available };
  const room = maxBytes && volume && maxBytes > volume ? maxBytes - volume : 0;
  if (room > 0 && available + room >= neededBytes) {
    const sizeGb = Math.min(Math.floor(maxBytes / GB), Math.ceil((volume + neededBytes - available) / GB / DISK_STEP_GB) * DISK_STEP_GB);
    return { fit: "grow", neededBytes, freeBytes: available, maxBytes, sizeGb };
  }
  // What it is up against: the plan's whole disk (`maxBytes`, `largest` on the
  // top plan) or, when the Admin does not say, this Cloud's disk as it is now.
  return { fit: "never", neededBytes, freeBytes: available, ...(maxBytes ? { maxBytes, ...(disk?.largest === true ? { largest: true } : {}) } : volume ? { volumeBytes: volume } : {}) };
}
export function parseCloudMoveStatus(value) {
  if (!record(value) || !record(value.contents) || !["bots", "rooms", "chats"].every(key => count(value.contents[key])) ||
    typeof value.empty !== "boolean" || !count(value.freeBytes)) return null;
  const previous = record(value.previous) && typeof value.previous.createdAt === "string" && ["bots", "rooms", "chats"].every(key => count(value.previous[key]))
    ? { createdAt: value.previous.createdAt, bots: value.previous.bots, rooms: value.previous.rooms, chats: value.previous.chats, ...(count(value.previous.bytes) ? { bytes: value.previous.bytes } : {}) } : null;
  return {
    contents: { bots: value.contents.bots, rooms: value.contents.rooms, chats: value.contents.chats },
    empty: value.empty, freeBytes: value.freeBytes, previous,
    // The whole volume, from a Cloud that says (null from an older one).
    volumeBytes: count(value.volumeBytes) && value.volumeBytes > 0 ? value.volumeBytes : null,
    // A stored part of an earlier upload: space the next upload frees first.
    uploadReceived: record(value.upload) && count(value.upload.received) ? value.upload.received : 0,
    heldBytes: count(value.heldBytes) ? value.heldBytes : null,
    pendingRestore: value.pendingRestore === true, busy: value.busy === true,
    job: record(value.job) ? value.job : null,
    lastRestoreId: typeof value.lastRestoreId === "string" ? value.lastRestoreId : null,
    rolledBackId: typeof value.rolledBackId === "string" ? value.rolledBackId : null,
    partBytes: Number.isSafeInteger(value.partBytes) && value.partBytes > 0 && value.partBytes <= MAX_PART_BYTES ? value.partBytes : PART_BYTES,
    ...identity(value),
  };
}

async function readJson(response, limit = 256 * 1024) {
  const chunks = []; let size = 0;
  if (response.body) {
    for await (const chunk of Readable.fromWeb(response.body)) {
      size += chunk.length;
      if (size > limit) fail("invalid_response", "An unexpectedly large answer was refused.");
      chunks.push(chunk);
    }
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "null"); } catch { return null; }
}
async function discard(response) { try { await response?.body?.cancel(); } catch {} }
/** A server's own error sentence, safe to show: one line, bounded. */
const sentence = value => typeof value === "string" && value.trim()
  // oxlint-disable-next-line no-control-regex
  ? value.replace(/[\x00-\x1f\x7f]+/g, " ").trim().slice(0, 300) : undefined;

/** One copy at a time, to one destination; `state()` is what Settings and a
 * server's card show, and carries `destination` ({id, name, origin, kind}).
 * A destination (main's destinationFor) is `{id, name, origin, kind, grant}`:
 * `grant()` opens one single-use admin pairing window there ({origin, code}).
 * Only the Cloud (`kind: "cloud"`) has `disk()`, the disk its plan has and may
 * grow to (cloud-home.mjs cloudPlanDisk), and `grow(sizeGb)`, which asks OMB
 * Cloud to grow it now (cloud-account.mjs growDisk). */
export function createCloudMove({ localRequest, fetchImpl = fetch, tempRoot, availableBytes, now = Date.now, sleep = defaultSleep,
  onState = () => {}, retryDelaysMs = [1_000, 3_000, 8_000, 15_000, 30_000], pollMs = 2_000, restartTimeoutMs = 10 * 60_000, jobTimeoutMs = 3 * 3600_000,
  growTimeoutMs = 5 * 60_000 }) {
  if (typeof localRequest !== "function" || typeof tempRoot !== "string" || !isAbsolute(tempRoot) ||
    resolve(tempRoot) === parse(resolve(tempRoot)).root || typeof availableBytes !== "function") throw new Error("A copy needs its requests and a private temporary folder.");
  let value = { phase: "idle" }, running = false, controller = null, committing = false, prepared = null;
  // Where the current (or last) copy goes; every state names it.
  let target = null;
  const state = () => structuredClone(value);
  const publish = next => { value = target ? { ...next, destination: target } : next; try { onState(state()); } catch { /* a closed view must not stop the copy */ } return state(); };
  // How messages name the destination: the Cloud as "My Cloud", any other server by its name.
  const there = () => target?.kind === "cloud" ? "My Cloud" : target?.name || "the server";
  const There = () => target?.kind === "cloud" ? "My Cloud" : target?.name || "The server";
  // Byte counts at most four times a second; every step change at once.
  let progressAt = 0;
  const progress = (phase, bytesTransferred, totalBytes) => {
    if (value.phase === phase && bytesTransferred < totalBytes && now() - progressAt < 250) return;
    progressAt = now();
    publish({ phase, action: "move", progress: { bytesTransferred, totalBytes } });
  };

  async function localJson(route, init, signal) {
    if (!LOCAL_ROUTES.test(route)) fail("invalid_request", "Unsupported local request.");
    const response = await localRequest(route, { ...init, signal, redirect: "error" });
    if (!response.ok) {
      // This computer's server says why (a file that changed, a link it cannot copy).
      const said = sentence((await readJson(response).catch(() => null))?.error);
      if ([409, 503].includes(response.status)) fail("busy", said ?? "Wait for bots on this computer to finish what they are doing, then copy again.");
      fail("export_failed", said ?? "This computer's workspace could not be prepared for the copy.");
    }
    const body = await readJson(response, 2 * 1024 ** 2);
    if (!record(body)) fail("export_failed", "This computer's workspace could not be prepared for the copy.");
    return body;
  }
  async function estimate(signal) {
    const result = parseMoveEstimate(await localJson("/api/cloud-move/estimate", { method: "GET" }, signal ?? AbortSignal.timeout(60_000)));
    if (!result) fail("export_failed", "This computer's workspace could not be measured.");
    return result;
  }

  // ── The destination's session ─────────────────────────────────────────
  async function openSession(dest, signal) {
    let grant;
    try { grant = await dest.grant(); } catch (error) {
      // The grant says why (not the owner, a shared server, offline); anything else is "not ready".
      if (error instanceof CloudMoveError) throw error;
      fail("cloud_unavailable", `${There()} is not ready for the copy. Check it, then try again.`);
    }
    // Only the destination itself may be signed in to: never an origin a grant names instead.
    if (!record(grant) || typeof grant.origin !== "string" || grant.origin !== dest.origin || typeof grant.code !== "string") fail("cloud_unavailable", `${There()} is not ready for the copy. Check it, then try again.`);
    const response = await fetchImpl(`${dest.origin}/api/auth/pair`, {
      method: "POST", redirect: "error", credentials: "omit", cache: "no-store",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ code: grant.code, label: "Copy from desktop" }), signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    });
    const body = await readJson(response);
    if (!response.ok || typeof body?.token !== "string" || !body.token.startsWith("omb_sess_")) fail("cloud_unavailable", `This app could not sign in to ${there()} for the copy. Try again.`);
    return { origin: dest.origin, token: body.token };
  }
  async function closeSession(session) {
    try { await discard(await cloudFetch(session, "/api/auth/logout", { method: "POST", signal: AbortSignal.timeout(10_000) })); } catch { /* it expires on its own */ }
  }
  function cloudFetch(session, route, { headers, ...init } = {}) {
    return fetchImpl(`${session.origin}${route}`, { ...init, redirect: "error", credentials: "omit", cache: "no-store",
      headers: { accept: "application/json", authorization: `Bearer ${session.token}`, ...headers } });
  }
  function cloudRefusal(status, body) {
    const message = typeof body?.error === "string" ? body.error.slice(0, 300) : undefined;
    // Shared with other people: no sign-in changes that.
    if (status === 403 && body?.code === "shared_workspace") fail("shared_workspace", message ?? `${There()} is shared with other people, so it can't receive this computer's bots and chats.`);
    if (status === 401 || status === 403) fail("access_changed", `This app's sign-in to ${there()} changed. Open it in this app again, then copy.`);
    if (status === 507) fail("cloud_full", `${There()} does not have enough free space for this copy.`, { freeBytes: count(body?.freeBytes) ? body.freeBytes : undefined, neededBytes: count(body?.neededBytes) ? body.neededBytes : undefined });
    if (status === 413) fail("too_large", "This workspace is larger than a copy can carry.");
    if (status === 409) fail("cloud_busy", message ?? `${There()} is busy. Try again in a minute.`);
    if (status === 404) fail("not_found", message ?? `${There()} does not know this copy. Start it again.`);
    if (status >= 500 || status === 429 || status === 408) fail("network", `${There()} did not answer. Try again; the copy continues where it stopped.`);
    fail("cloud_refused", message ?? `${There()} refused the copy.`);
  }
  async function cloudJson(session, method, route, body, signal) {
    const response = await cloudFetch(session, route, { method, signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
    const result = await readJson(response);
    if (!response.ok) cloudRefusal(response.status, result);
    if (!record(result)) fail("invalid_response", `${There()} gave an answer this app does not understand.`);
    return result;
  }
  async function cloudStatus(session, signal) {
    // A server from before any server could receive a copy has no such route.
    const answer = await cloudJson(session, "GET", "/api/cloud-move", undefined, signal).catch(error => {
      if (error?.code === "not_found") fail("outdated", `${There()} has not updated to a version that can receive a copy yet.`);
      throw error;
    });
    const status = parseCloudMoveStatus(answer);
    if (!status) fail("invalid_response", `${There()} gave an answer this app does not understand. Update the app and try again.`);
    return status;
  }

  // ── This computer's archive ───────────────────────────────────────────
  async function disposeArchive() {
    const previous = prepared; prepared = null;
    if (previous) await rm(previous.directory, { recursive: true, force: true }).catch(() => {});
  }
  async function archive(local, signal) {
    if (prepared && now() - prepared.createdAt < REUSE_MS && await lstat(prepared.file).then(stat => stat.isFile() && stat.size === prepared.bytes, () => false)) return prepared;
    await disposeArchive();
    publish({ phase: "exporting", action: "move" });
    const status = await localJson("/api/workspace-backup/status", { method: "GET" }, signal);
    if (status.busy || status.pendingRestore) fail("busy", "Wait for this computer's backup or restore to finish, then copy again.");
    await mkdir(tempRoot, { recursive: true, mode: 0o700 });
    const root = await lstat(tempRoot);
    if (!root.isDirectory() || root.isSymbolicLink() || (process.platform !== "win32" && (root.mode & 0o077) !== 0)) fail("local_failed", "The copy needs a private temporary folder.");
    const directory = await mkdtemp(join(tempRoot, "cloud-move-"));
    try {
      await chmod(directory, 0o700);
      if (await availableBytes(directory) < local.bytes + SPACE_MARGIN) fail("local_full", "This computer does not have enough free disk space to prepare the copy.");
      const password = randomBytes(32).toString("base64url");
      // No drafts or window preferences: they belong to this computer's window.
      const exported = await localJson("/api/workspace-backup/export", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password, clientState: {} }) }, signal);
      if (typeof exported.id !== "string" || !UUID.test(exported.id) || !Number.isSafeInteger(exported.bytes) || exported.bytes < MIN_BYTES || !record(exported.summary)) fail("export_failed", "This computer's workspace could not be prepared for the copy.");
      if (exported.bytes > CLOUD_MOVE_MAX_BYTES) fail("too_large", "This workspace is larger than a copy can carry.");
      const response = await localRequest(`/api/workspace-backup/download/${exported.id}`, { method: "GET", signal, redirect: "error" });
      const declared = response.headers.get("content-length");
      if (!response.ok || !response.body || (declared !== null && Number(declared) !== exported.bytes)) { await discard(response); fail("export_failed", "This computer's workspace could not be prepared for the copy."); }
      const file = join(directory, "workspace.ombbackup"), hash = createHash("sha256"), header = Buffer.alloc(MAGIC.length);
      let bytes = 0;
      await pipeline(Readable.fromWeb(response.body), async function* (source) {
        for await (const chunk of source) {
          if (bytes + chunk.length > exported.bytes) fail("export_failed", "This computer's workspace changed size while it was prepared.");
          if (bytes < header.length) chunk.copy(header, bytes, 0, Math.min(chunk.length, header.length - bytes));
          bytes += chunk.length; hash.update(chunk);
          progress("exporting", bytes, exported.bytes);
          yield chunk;
        }
      }, createWriteStream(file, { flags: "wx", mode: 0o600 }), { signal });
      if (bytes !== exported.bytes || !header.equals(MAGIC)) fail("export_failed", "This computer's workspace could not be prepared for the copy.");
      const summary = exported.summary;
      prepared = { directory, file, password, sha256: hash.digest("hex"), bytes, createdAt: now(),
        summary: { bots: count(summary.bots) ? summary.bots : 0, files: count(summary.files) ? summary.files : 0, messages: count(summary.messages) ? summary.messages : 0 } };
      return prepared;
    } catch (error) {
      await rm(directory, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  // ── Upload ────────────────────────────────────────────────────────────
  /** Where the destination stands after this part, or null when the part was
   * too large for the way there: the server itself never answers a part 413
   * (it refuses a part over its limit with 411), so that is a proxy. */
  async function sendPart(session, sha256, offset, part, signal) {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      let answer;
      try {
        const response = await cloudFetch(session, `/api/cloud-move/upload/${sha256}?offset=${offset}`, {
          method: "PUT", headers: { "content-type": "application/octet-stream" }, body: part,
          signal: AbortSignal.any([signal, AbortSignal.timeout(10 * 60_000)]),
        });
        answer = { status: response.status, body: await readJson(response) };
      } catch (error) {
        if (signal.aborted || error instanceof CloudMoveError) throw error;
        answer = null;  // connection dropped: try the same part again
      }
      if (answer?.status === 200 && count(answer.body?.received)) return answer.body.received;
      // Another offset than ours: continue from where the destination stands.
      if (answer?.status === 409 && count(answer.body?.received) && answer.body.received !== offset) return answer.body.received;
      if (answer?.status === 413) return null;
      if (answer && ![409, 408, 429, 500, 502, 503, 504].includes(answer.status)) cloudRefusal(answer.status, answer.body);
      if (attempt >= retryDelaysMs.length) fail("upload_failed", `The upload to ${there()} kept failing. Check your connection and try again; it continues where it stopped.`);
      await sleep(retryDelaysMs[attempt], signal);
    }
  }
  async function upload(session, archived, signal) {
    const begun = await cloudJson(session, "POST", "/api/cloud-move/upload", { sha256: archived.sha256, bytes: archived.bytes, files: archived.summary.files }, signal);
    if (!count(begun.received) || begun.received > archived.bytes) fail("invalid_response", `${There()} gave an answer this app does not understand.`);
    let partBytes = Number.isSafeInteger(begun.partBytes) && begun.partBytes > 0 && begun.partBytes <= MAX_PART_BYTES ? begun.partBytes : PART_BYTES;
    let offset = begun.received, stalls = 0;
    progress("uploading", offset, archived.bytes);
    const handle = await open(archived.file, "r");
    try {
      while (offset < archived.bytes) {
        const part = Buffer.alloc(Math.min(partBytes, archived.bytes - offset));
        let filled = 0;
        while (filled < part.length) {
          const { bytesRead } = await handle.read(part, filled, part.length - filled, offset + filled);
          if (!bytesRead) fail("export_failed", "The prepared workspace changed on this computer.");
          filled += bytesRead;
        }
        const received = await sendPart(session, archived.sha256, offset, part, signal);
        if (received === null) {
          // Refused for its size on the way: smaller parts, down to MIN_PART_BYTES.
          if (part.length > MIN_PART_BYTES) { partBytes = Math.max(MIN_PART_BYTES, Math.floor(part.length / 2)); continue; }
          fail("proxy_limit", `A proxy in front of ${there()} refused a ${Math.round(part.length / 1024)} KB upload. Raise its request size limit (nginx: client_max_body_size 64m), then copy again.`,
            { partBytes: part.length });
        }
        if (received > archived.bytes) fail("invalid_response", `${There()} gave an answer this app does not understand.`);
        stalls = received > offset ? 0 : stalls + 1;
        if (stalls > retryDelaysMs.length) fail("upload_failed", `The upload to ${there()} kept failing. Check your connection and try again; it continues where it stopped.`);
        offset = received;
        progress("uploading", offset, archived.bytes);
      }
    } finally { await handle.close(); }
  }

  // ── Following the destination's jobs and its restart ──────────────────
  async function waitForPreview(session, signal) {
    const deadline = now() + jobTimeoutMs;
    for (;;) {
      await sleep(pollMs, signal);
      let status = null;
      try { status = await cloudStatus(session, signal); } catch (error) { if (signal.aborted || error?.code === "access_changed") throw error; }
      const job = status?.job;
      if (job?.kind === "preview" && job.state === "failed") fail("invalid_backup", typeof job.error === "string" ? job.error.slice(0, 300) : `${There()} could not read the copied workspace.`);
      if (job?.kind === "preview" && job.state === "done" && typeof job.id === "string" && UUID.test(job.id) && record(job.summary)) return job;
      // Reachable, and no check of ours is running: it restarted meanwhile.
      if (status && job?.kind !== "preview") fail("network", `${There()} restarted during the copy. Try again.`);
      if (now() > deadline) fail("cloud_busy", `${There()} is taking too long to check the copied workspace.`);
    }
  }
  async function waitForRestart(session, kind, target, signal) {
    // The destination's own job may take long on a large workspace; once it
    // is done (or it stops answering), the restart gets its own limit.
    let deadline = now() + jobTimeoutMs, restarting = false;
    const restartBegins = () => { if (!restarting) { restarting = true; deadline = Math.min(deadline, now() + restartTimeoutMs); publish({ ...value, phase: "restarting" }); } };
    let id = target.id, sawJob = false;
    for (;;) {
      await sleep(pollMs, signal);
      let status = null;
      try { status = await cloudStatus(session, signal); } catch (error) { if (signal.aborted || error?.code === "access_changed") throw error; /* restarting */ }
      if (status) {
        const job = status.job;
        if (job?.kind === kind) sawJob = true;
        if (job?.kind === kind && job.state === "failed") fail("restore_failed", typeof job.error === "string" ? job.error.slice(0, 300) : `${There()} could not restore the workspace.`);
        if (job?.kind === kind && job.state === "done" && typeof job.id === "string") { id = job.id; restartBegins(); }
        const restored = id ? status.lastRestoreId === id : status.lastRestoreId !== null && status.lastRestoreId !== target.lastRestoreId;
        const rolledBack = id ? status.rolledBackId === id : status.rolledBackId !== null && status.rolledBackId !== target.rolledBackId;
        if (rolledBack) fail("restore_failed", `${There()} could not install the workspace and kept what it had.`);
        if (restored && !status.pendingRestore && status.job?.state !== "running") return status;
        // Reachable, not restored, nothing pending and no job of ours: the
        // request never took effect (or a restart lost it).
        if (!restored && !status.pendingRestore && job?.kind !== kind) {
          fail(sawJob ? "restore_failed" : "network", sawJob ? `${There()} restarted without installing the workspace. Try again.` : `${There()} did not start replacing its workspace. Try again.`);
        }
      } else restartBegins();
      if (now() > deadline) {
        // The Cloud's launcher always starts it again; a server's does when
        // it is one of ours (server/restart.ts), and otherwise it installs at its next start.
        fail("restart_timeout", target?.kind === "cloud" ? "My Cloud is taking longer than usual to restart. Check it again in a few minutes."
          : `${There()} hasn't come back yet. If it doesn't start again on its own, start OpenMausBot there; it finishes installing the copy when it starts.`);
      }
    }
  }

  /** The Cloud only: the plan's disk can hold the copy, but today's disk
   * cannot. Ask OMB Cloud to grow it now, then wait until the Cloud has the room. */
  async function makeRoom(dest, session, fit, signal) {
    publish({ phase: "growing", action: "move" });
    const details = { freeBytes: fit.freeBytes, neededBytes: fit.neededBytes, maxBytes: fit.maxBytes };
    let answer = null;
    // No answer (offline, a slip): trying again later can work.
    try { answer = await dest.grow(fit.sizeGb); } catch { signal.throwIfAborted(); fail("cloud_grow_unavailable", "My Cloud could not make room for this move just now.", details); }
    signal.throwIfAborted();
    // This Admin cannot grow a disk for a move: trying again will not help.
    if (!answer?.supported) fail("cloud_grow_unsupported", "My Cloud can't make room for a move this size yet.", details);
    if (answer.refused) fail("cloud_full", "My Cloud does not have enough space for this move.", details);
    const deadline = now() + growTimeoutMs;
    for (;;) {
      await sleep(pollMs, signal);
      let status = null;
      // A Cloud whose disk grew may restart: no answer for a moment is expected.
      try { status = await cloudStatus(session, signal); } catch (error) { if (signal.aborted || error?.code === "access_changed") throw error; }
      if (status && status.freeBytes + status.uploadReceived >= fit.neededBytes) return;
      if (now() > deadline) fail("cloud_grow_unavailable", "My Cloud could not make room for this move in time.", details);
    }
  }

  function classify(error, signal) {
    return error instanceof CloudMoveError && !(signal?.aborted && error.code !== "cancelled") ? error
      : signal?.aborted ? new CloudMoveError("cancelled", `The copy was stopped. ${There()} was not replaced.`)
        : error?.code === "ENOSPC" ? new CloudMoveError("local_full", "This computer does not have enough free disk space to prepare the copy.")
          : new CloudMoveError("network", `The copy could not reach ${there()}. Check your connection and try again.`);
  }
  function destinationOf(dest) {
    if (!record(dest) || (dest.kind !== "cloud" && dest.kind !== "server") || typeof dest.grant !== "function" || (dest.origin !== null && typeof dest.origin !== "string")) {
      throw new Error("A copy needs a destination.");
    }
    return { id: typeof dest.id === "string" ? dest.id : null, name: typeof dest.name === "string" ? dest.name : "", origin: dest.origin, kind: dest.kind };
  }
  async function run(action, dest, work) {
    if (running) return state();
    const named = destinationOf(dest);
    // A finished copy's archive is this computer's, wherever it went; a stopped
    // upload continues only to the server it was going to.
    if (prepared && target && target.origin !== named.origin) await disposeArchive();
    running = true; committing = false; controller = new AbortController(); target = named;
    const signal = controller.signal;
    let session = null;
    try {
      publish({ phase: "preparing", action });
      session = await openSession(dest, signal);
      return await work(session, signal);
    } catch (error) {
      const failure = classify(error, signal);
      // Nothing was replaced: the destination drops what this attempt staged
      // there (a stored upload part stays, so copying again continues it).
      if (session && !committing) {
        try { await discard(await cloudFetch(session, "/api/cloud-move/discard", { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(10_000) })); } catch { /* the next upload drops it */ }
      }
      // An upload that stopped keeps its archive so copying again continues it.
      if (!RESUMABLE.has(failure.code) || committing) await disposeArchive();
      return publish({ phase: "failed", action, error: { code: failure.code, message: failure.message, ...failure.details },
        ...(prepared ? { resumable: true } : {}) });
    } finally {
      running = false; controller = null;
      if (session) await closeSession(session);
    }
  }

  return {
    state,
    estimate,
    /** Copy this computer's workspace to `dest`, replacing what it holds.
     * `requireEmpty`: a start from the destination's own page, which may only
     * fill a server that has no work of its own. */
    move: (dest, { requireEmpty = false } = {}) => run("move", dest, async (session, signal) => {
      const [cloud, local] = await Promise.all([cloudStatus(session, signal), estimate(signal)]);
      // Refused before anything is exported, by the rule Settings shows
      // (moveBlocked): this computer itself, or a server older than this one
      // (it could not stage the backup). Then a page asking to replace work it already has.
      const why = moveBlocked({ kind: dest.kind, local, cloud });
      if (why) {
        fail(why, why === "outdated" ? `${There()} runs ${cloud.appVersion}; this computer runs ${local.appVersion}. Update it, then copy again.` : `${There()} can't receive this copy.`,
          { destVersion: cloud.appVersion, localVersion: local.appVersion });
      }
      if (requireEmpty && !cloud.empty) fail("not_empty", `${There()} already has bots or chats of its own, so nothing was copied.`);
      if (cloud.pendingRestore || cloud.busy || cloud.job?.state === "running") fail("cloud_busy", `${There()} is busy. Try again in a minute.`);
      if (local.bytes > CLOUD_MOVE_MAX_BYTES) fail("too_large", "This workspace is larger than a copy can carry.");
      // The destination checks again, exactly (its own backup included),
      // before the upload starts. A stored part of an earlier upload is freed
      // first. A Cloud plan whose disk grows is measured at its largest disk.
      let disk = null;
      if (dest.kind === "cloud" && typeof dest.disk === "function") { try { disk = dest.disk(); } catch { /* today's free space only */ } }
      const fit = moveFit({ localBytes: local.bytes, freeBytes: cloud.freeBytes, uploadReceived: cloud.uploadReceived, volumeBytes: cloud.volumeBytes, disk });
      if (fit.fit === "never") {
        const details = { ...fit }; delete details.fit;
        fail("cloud_full", `${There()} does not have enough free space for this copy.`, details);
      }
      // Only a plan's disk (the Cloud's) can fit by growing.
      if (fit.fit === "grow" && typeof dest.grow === "function") await makeRoom(dest, session, fit, signal);
      const archived = await archive(local, signal);
      await upload(session, archived, signal);
      publish({ phase: "checking", action: "move" });
      await cloudJson(session, "POST", "/api/cloud-move/preview", { sha256: archived.sha256, password: archived.password }, signal);
      const preview = await waitForPreview(session, signal);
      if (preview.summary.bots !== archived.summary.bots || preview.summary.messages !== archived.summary.messages) fail("invalid_backup", `${There()} read a different workspace than this computer sent.`);
      publish({ phase: "replacing", action: "move", replacing: !cloud.empty });
      // A busy destination is asked again with the same staged workspace.
      // Once the request is out it cannot be stopped; a dropped answer is
      // settled by the destination's own status below.
      for (let attempt = 0; ; attempt++) {
        signal.throwIfAborted();
        committing = true;
        try { await cloudJson(session, "POST", "/api/cloud-move/restore", { id: preview.id }, signal); break; } catch (error) {
          if (error?.code === "network" || error instanceof TypeError || error?.name === "TimeoutError") break;
          committing = false;
          if (error?.code !== "cloud_busy" || attempt >= retryDelaysMs.length) throw error;
          await sleep(retryDelaysMs[attempt], signal);
        }
      }
      await disposeArchive();
      const after = await waitForRestart(session, "restore", { id: preview.id }, signal);
      // Routines arrive paused; the done message says how many to turn on there.
      return publish({ phase: "done", action: "move", moved: after.contents, previous: Boolean(after.previous), ...(local.routines > 0 ? { routines: local.routines } : {}) });
    }),
    /** Swap back: what `dest` had before returns, and what it has now is
     * kept instead, so this can be undone the same way. */
    restorePrevious: dest => run("restore", dest, async (session, signal) => {
      const before = await cloudStatus(session, signal);
      if (!before.previous) fail("no_previous", `There is nothing on ${there()} to swap back to.`);
      if (before.pendingRestore || before.busy || before.job?.state === "running") fail("cloud_busy", `${There()} is busy. Try again in a minute.`);
      committing = true;
      publish({ phase: "replacing", action: "restore" });
      await cloudJson(session, "POST", "/api/cloud-move/undo", {}, signal);
      const after = await waitForRestart(session, "undo", { lastRestoreId: before.lastRestoreId, rolledBackId: before.rolledBackId }, signal);
      return publish({ phase: "done", action: "restore", moved: after.contents });
    }),
    /** Stops a copy until the destination starts replacing its workspace. */
    cancel() { if (running && !committing) controller?.abort(); return state(); },
    /** Forget a finished or failed copy's message. */
    reset() { if (!running) { target = null; publish({ phase: "idle" }); } return state(); },
    running: () => running,
    async close() { controller?.abort(); await disposeArchive(); },
  };
}
