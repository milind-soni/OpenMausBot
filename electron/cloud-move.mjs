// Move to Cloud, the desktop's half (docs/cloud-pro.md "Move to Cloud";
// server/cloud-move-http.ts is the Cloud's). One action copies this
// computer's workspace to the person's Cloud home:
//
//   1. this computer's server exports its ordinary encrypted workspace backup
//      (the backup policy decides what travels: never a credential, sign-in,
//      pairing or session, never this app's Cloud sign-in or lending grants);
//   2. main copies it to a private temporary file and uploads it to the Cloud
//      in parts, continuing where a dropped connection left it;
//   3. the Cloud checks it is a valid backup, backs up its own work if it has
//      any, restores, and restarts; main waits until it is back.
//
// Main talks to the Cloud with a session of its own: the Admin opens a
// single-use pairing window for the signed-in owner (pairHome), main redeems
// it for a bearer token held only in memory, and signs that session out when
// the move ends. This computer's data is copied, never changed or deleted.
// Pure apart from its injected requests, so node tests drive it end to end.
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { isAbsolute, join, parse, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const MAGIC = Buffer.from("OMB-WORKSPACE-1\n");
const MIN_BYTES = MAGIC.length + 16 + 12 + 16;
/** The largest backup a Cloud accepts (server/cloud-move.ts CLOUD_MOVE_MAX_BYTES). */
export const CLOUD_MOVE_MAX_BYTES = 10 * 1024 ** 3 + 256 * 1024 ** 2;
const PART_BYTES = 16 * 1024 ** 2;
const MAX_PART_BYTES = 64 * 1024 ** 2;
const SPACE_MARGIN = 256 * 1024 ** 2;
// A failed upload keeps its archive this long, so Try again continues it.
const REUSE_MS = 30 * 60_000;
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/;
const LOCAL_ROUTES = /^\/api\/(?:workspace-backup\/(?:status|export|download\/[a-f\d-]{36})|cloud-move\/estimate)$/;
const RESUMABLE = new Set(["upload_failed", "cloud_unavailable", "network", "cloud_busy", "cancelled"]);

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
 * session reports, while that is the window's active server. */
export function cloudPageSenderAllowed(event, { contents, homeOrigin, activeOrigin }) {
  if (!contents || !homeOrigin || activeOrigin !== homeOrigin) return false;
  if (event?.sender !== contents || !event.senderFrame || event.senderFrame !== contents.mainFrame) return false;
  try { return new URL(event.senderFrame.url).origin === homeOrigin; } catch { return false; }
}

/** What the Cloud and this computer hold, as shown before a move. */
export function parseMoveEstimate(value) {
  if (!record(value) || !["bots", "rooms", "chats", "bytes", "files"].every(key => count(value[key]))) return null;
  return { bots: value.bots, rooms: value.rooms, chats: value.chats, bytes: value.bytes, files: value.files };
}
export function parseCloudMoveStatus(value) {
  if (!record(value) || !record(value.contents) || !["bots", "rooms", "chats"].every(key => count(value.contents[key])) ||
    typeof value.empty !== "boolean" || !count(value.freeBytes)) return null;
  const previous = record(value.previous) && typeof value.previous.createdAt === "string" && ["bots", "rooms", "chats"].every(key => count(value.previous[key]))
    ? { createdAt: value.previous.createdAt, bots: value.previous.bots, rooms: value.previous.rooms, chats: value.previous.chats, ...(count(value.previous.bytes) ? { bytes: value.previous.bytes } : {}) } : null;
  return {
    contents: { bots: value.contents.bots, rooms: value.contents.rooms, chats: value.contents.chats },
    empty: value.empty, freeBytes: value.freeBytes, previous,
    // A stored part of an earlier upload: space the next upload frees first.
    uploadReceived: record(value.upload) && count(value.upload.received) ? value.upload.received : 0,
    heldBytes: count(value.heldBytes) ? value.heldBytes : null,
    pendingRestore: value.pendingRestore === true, busy: value.busy === true,
    job: record(value.job) ? value.job : null,
    lastRestoreId: typeof value.lastRestoreId === "string" ? value.lastRestoreId : null,
    rolledBackId: typeof value.rolledBackId === "string" ? value.rolledBackId : null,
    partBytes: Number.isSafeInteger(value.partBytes) && value.partBytes > 0 && value.partBytes <= MAX_PART_BYTES ? value.partBytes : PART_BYTES,
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

/** One move at a time; `state()` is what Settings and the Cloud's card show. */
export function createCloudMove({ localRequest, pairHome, fetchImpl = fetch, tempRoot, availableBytes, now = Date.now, sleep = defaultSleep,
  onState = () => {}, retryDelaysMs = [1_000, 3_000, 8_000, 15_000, 30_000], pollMs = 2_000, restartTimeoutMs = 10 * 60_000, jobTimeoutMs = 3 * 3600_000 }) {
  if (typeof localRequest !== "function" || typeof pairHome !== "function" || typeof tempRoot !== "string" || !isAbsolute(tempRoot) ||
    resolve(tempRoot) === parse(resolve(tempRoot)).root || typeof availableBytes !== "function") throw new Error("Move to Cloud needs its requests and a private temporary folder.");
  let value = { phase: "idle" }, running = false, controller = null, committing = false, prepared = null;
  const state = () => structuredClone(value);
  const publish = next => { value = next; try { onState(state()); } catch { /* a closed view must not stop the move */ } return state(); };
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
      if ([409, 503].includes(response.status)) fail("busy", said ?? "Wait for bots on this computer to finish what they are doing, then move again.");
      fail("export_failed", said ?? "This computer's workspace could not be prepared for the move.");
    }
    const body = await readJson(response, 2 * 1024 ** 2);
    if (!record(body)) fail("export_failed", "This computer's workspace could not be prepared for the move.");
    return body;
  }
  async function estimate(signal) {
    const result = parseMoveEstimate(await localJson("/api/cloud-move/estimate", { method: "GET" }, signal ?? AbortSignal.timeout(60_000)));
    if (!result) fail("export_failed", "This computer's workspace could not be measured.");
    return result;
  }

  // ── The Cloud session ────────────────────────────────────────────────
  async function openSession(signal) {
    let grant;
    try { grant = await pairHome(); } catch { fail("cloud_unavailable", "Your Cloud is not ready. Check it in Settings → OMB Cloud, then try again."); }
    if (!record(grant) || typeof grant.origin !== "string" || typeof grant.code !== "string") fail("cloud_unavailable", "Your Cloud is not ready. Check it in Settings → OMB Cloud, then try again.");
    const response = await fetchImpl(`${grant.origin}/api/auth/pair`, {
      method: "POST", redirect: "error", credentials: "omit", cache: "no-store",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ code: grant.code, label: "Move to Cloud" }), signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    });
    const body = await readJson(response);
    if (!response.ok || typeof body?.token !== "string" || !body.token.startsWith("omb_sess_")) fail("cloud_unavailable", "This app could not sign in to your Cloud for the move. Try again.");
    return { origin: grant.origin, token: body.token };
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
    if (status === 401 || status === 403) fail("access_changed", "Your Cloud sign-in changed. Connect to your Cloud again, then move.");
    if (status === 507) fail("cloud_full", "Your Cloud does not have enough free space for this move.", { freeBytes: count(body?.freeBytes) ? body.freeBytes : undefined, neededBytes: count(body?.neededBytes) ? body.neededBytes : undefined });
    if (status === 413) fail("too_large", "This workspace is larger than a move can carry.");
    if (status === 409) fail("cloud_busy", message ?? "Your Cloud is busy. Try again in a minute.");
    if (status === 404) fail("not_found", message ?? "Your Cloud does not know this move. Start it again.");
    if (status >= 500 || status === 429 || status === 408) fail("network", "Your Cloud did not answer. Try again; the move continues where it stopped.");
    fail("cloud_refused", message ?? "Your Cloud refused the move.");
  }
  async function cloudJson(session, method, route, body, signal) {
    const response = await cloudFetch(session, route, { method, signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
    const result = await readJson(response);
    if (!response.ok) cloudRefusal(response.status, result);
    if (!record(result)) fail("invalid_response", "Your Cloud gave an answer this app does not understand.");
    return result;
  }
  async function cloudStatus(session, signal) {
    // A Cloud from before Move to Cloud has no such route.
    const answer = await cloudJson(session, "GET", "/api/cloud-move", undefined, signal).catch(error => {
      if (error?.code === "not_found") fail("cloud_outdated", "Your Cloud has not updated to a version that can receive a move yet.");
      throw error;
    });
    const status = parseCloudMoveStatus(answer);
    if (!status) fail("invalid_response", "Your Cloud gave an answer this app does not understand. Update the app and try again.");
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
    if (status.busy || status.pendingRestore) fail("busy", "Wait for this computer's backup or restore to finish, then move again.");
    await mkdir(tempRoot, { recursive: true, mode: 0o700 });
    const root = await lstat(tempRoot);
    if (!root.isDirectory() || root.isSymbolicLink() || (process.platform !== "win32" && (root.mode & 0o077) !== 0)) fail("local_failed", "The move needs a private temporary folder.");
    const directory = await mkdtemp(join(tempRoot, "cloud-move-"));
    try {
      await chmod(directory, 0o700);
      if (await availableBytes(directory) < local.bytes + SPACE_MARGIN) fail("local_full", "This computer does not have enough free disk space to prepare the move.");
      const password = randomBytes(32).toString("base64url");
      // No drafts or window preferences: they belong to this computer's window.
      const exported = await localJson("/api/workspace-backup/export", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password, clientState: {} }) }, signal);
      if (typeof exported.id !== "string" || !UUID.test(exported.id) || !Number.isSafeInteger(exported.bytes) || exported.bytes < MIN_BYTES || !record(exported.summary)) fail("export_failed", "This computer's workspace could not be prepared for the move.");
      if (exported.bytes > CLOUD_MOVE_MAX_BYTES) fail("too_large", "This workspace is larger than a move can carry.");
      const response = await localRequest(`/api/workspace-backup/download/${exported.id}`, { method: "GET", signal, redirect: "error" });
      const declared = response.headers.get("content-length");
      if (!response.ok || !response.body || (declared !== null && Number(declared) !== exported.bytes)) { await discard(response); fail("export_failed", "This computer's workspace could not be prepared for the move."); }
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
      if (bytes !== exported.bytes || !header.equals(MAGIC)) fail("export_failed", "This computer's workspace could not be prepared for the move.");
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
      // Another offset than ours: continue from where the Cloud stands.
      if (answer?.status === 409 && count(answer.body?.received) && answer.body.received !== offset) return answer.body.received;
      if (answer && ![409, 408, 429, 500, 502, 503, 504].includes(answer.status)) cloudRefusal(answer.status, answer.body);
      if (attempt >= retryDelaysMs.length) fail("upload_failed", "The upload to your Cloud kept failing. Check your connection and try again; it continues where it stopped.");
      await sleep(retryDelaysMs[attempt], signal);
    }
  }
  async function upload(session, archived, signal) {
    const begun = await cloudJson(session, "POST", "/api/cloud-move/upload", { sha256: archived.sha256, bytes: archived.bytes, files: archived.summary.files }, signal);
    if (!count(begun.received) || begun.received > archived.bytes) fail("invalid_response", "Your Cloud gave an answer this app does not understand.");
    const partBytes = Number.isSafeInteger(begun.partBytes) && begun.partBytes > 0 && begun.partBytes <= MAX_PART_BYTES ? begun.partBytes : PART_BYTES;
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
        if (received > archived.bytes) fail("invalid_response", "Your Cloud gave an answer this app does not understand.");
        stalls = received > offset ? 0 : stalls + 1;
        if (stalls > retryDelaysMs.length) fail("upload_failed", "The upload to your Cloud kept failing. Check your connection and try again; it continues where it stopped.");
        offset = received;
        progress("uploading", offset, archived.bytes);
      }
    } finally { await handle.close(); }
  }

  // ── Following the Cloud's jobs and its restart ────────────────────────
  async function waitForPreview(session, signal) {
    const deadline = now() + jobTimeoutMs;
    for (;;) {
      await sleep(pollMs, signal);
      let status = null;
      try { status = await cloudStatus(session, signal); } catch (error) { if (signal.aborted || error?.code === "access_changed") throw error; }
      const job = status?.job;
      if (job?.kind === "preview" && job.state === "failed") fail("invalid_backup", typeof job.error === "string" ? job.error.slice(0, 300) : "Your Cloud could not read the moved workspace.");
      if (job?.kind === "preview" && job.state === "done" && typeof job.id === "string" && UUID.test(job.id) && record(job.summary)) return job;
      // Reachable, and no check of ours is running: it restarted meanwhile.
      if (status && job?.kind !== "preview") fail("network", "Your Cloud restarted during the move. Try again.");
      if (now() > deadline) fail("cloud_busy", "Your Cloud is taking too long to check the moved workspace.");
    }
  }
  async function waitForRestart(session, kind, target, signal) {
    // The Cloud's own job may take long on a large workspace; once it is
    // done (or the Cloud stops answering), the restart gets its own limit.
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
        if (job?.kind === kind && job.state === "failed") fail("restore_failed", typeof job.error === "string" ? job.error.slice(0, 300) : "Your Cloud could not restore the workspace.");
        if (job?.kind === kind && job.state === "done" && typeof job.id === "string") { id = job.id; restartBegins(); }
        const restored = id ? status.lastRestoreId === id : status.lastRestoreId !== null && status.lastRestoreId !== target.lastRestoreId;
        const rolledBack = id ? status.rolledBackId === id : status.rolledBackId !== null && status.rolledBackId !== target.rolledBackId;
        if (rolledBack) fail("restore_failed", "Your Cloud could not install the workspace and kept what it had.");
        if (restored && !status.pendingRestore && status.job?.state !== "running") return status;
        // Reachable, not restored, nothing pending and no job of ours: the
        // request never took effect (or a restart lost it).
        if (!restored && !status.pendingRestore && job?.kind !== kind) {
          fail(sawJob ? "restore_failed" : "network", sawJob ? "Your Cloud restarted without installing the workspace. Try again." : "Your Cloud did not start replacing its workspace. Try again.");
        }
      } else restartBegins();
      if (now() > deadline) fail("restart_timeout", "Your Cloud is taking longer than usual to restart. Check it again in a few minutes.");
    }
  }

  function classify(error, signal) {
    return error instanceof CloudMoveError && !(signal?.aborted && error.code !== "cancelled") ? error
      : signal?.aborted ? new CloudMoveError("cancelled", "The move was stopped. Your Cloud's workspace was not replaced.")
        : error?.code === "ENOSPC" ? new CloudMoveError("local_full", "This computer does not have enough free disk space to prepare the move.")
          : new CloudMoveError("network", "The move could not reach your Cloud. Check your connection and try again.");
  }
  async function run(action, work) {
    if (running) return state();
    running = true; committing = false; controller = new AbortController();
    const signal = controller.signal;
    let session = null;
    try {
      publish({ phase: "preparing", action });
      session = await openSession(signal);
      return await work(session, signal);
    } catch (error) {
      const failure = classify(error, signal);
      // Nothing was replaced: the Cloud drops what this attempt staged there
      // (a stored upload part stays, so moving again continues it).
      if (session && !committing) {
        try { await discard(await cloudFetch(session, "/api/cloud-move/discard", { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(10_000) })); } catch { /* the next upload drops it */ }
      }
      // An upload that stopped keeps its archive so Try again continues it.
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
    /** Copy this computer's workspace to the Cloud, replacing what it holds. */
    move: () => run("move", async (session, signal) => {
      const [cloud, local] = await Promise.all([cloudStatus(session, signal), estimate(signal)]);
      if (cloud.pendingRestore || cloud.busy || cloud.job?.state === "running") fail("cloud_busy", "Your Cloud is busy. Try again in a minute.");
      if (local.bytes > CLOUD_MOVE_MAX_BYTES) fail("too_large", "This workspace is larger than a move can carry.");
      // The Cloud checks again, exactly (its own backup included), before the
      // upload starts. A stored part of an earlier upload is freed first.
      if (cloud.freeBytes + cloud.uploadReceived < 3 * local.bytes + SPACE_MARGIN) {
        fail("cloud_full", "Your Cloud does not have enough free space for this move.", { freeBytes: cloud.freeBytes + cloud.uploadReceived, neededBytes: 3 * local.bytes + SPACE_MARGIN });
      }
      const archived = await archive(local, signal);
      await upload(session, archived, signal);
      publish({ phase: "checking", action: "move" });
      await cloudJson(session, "POST", "/api/cloud-move/preview", { sha256: archived.sha256, password: archived.password }, signal);
      const preview = await waitForPreview(session, signal);
      if (preview.summary.bots !== archived.summary.bots || preview.summary.messages !== archived.summary.messages) fail("invalid_backup", "Your Cloud read a different workspace than this computer sent.");
      publish({ phase: "replacing", action: "move", replacing: !cloud.empty });
      // A busy Cloud is asked again with the same staged workspace. Once the
      // request is out it cannot be stopped; a dropped answer is settled by
      // the Cloud's own status below.
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
      return publish({ phase: "done", action: "move", moved: after.contents, previous: Boolean(after.previous) });
    }),
    /** Swap back: the previous Cloud returns, and what the Cloud has now
     * becomes the previous Cloud, so this can be undone the same way. */
    restorePrevious: () => run("restore", async (session, signal) => {
      const before = await cloudStatus(session, signal);
      if (!before.previous) fail("no_previous", "There is no previous Cloud to restore.");
      if (before.pendingRestore || before.busy || before.job?.state === "running") fail("cloud_busy", "Your Cloud is busy. Try again in a minute.");
      committing = true;
      publish({ phase: "replacing", action: "restore" });
      await cloudJson(session, "POST", "/api/cloud-move/undo", {}, signal);
      const after = await waitForRestart(session, "undo", { lastRestoreId: before.lastRestoreId, rolledBackId: before.rolledBackId }, signal);
      return publish({ phase: "done", action: "restore", moved: after.contents });
    }),
    /** Stops a move until the Cloud starts replacing its workspace. */
    cancel() { if (running && !committing) controller?.abort(); return state(); },
    /** Forget a finished or failed move's message. */
    reset() { if (!running) publish({ phase: "idle" }); return state(); },
    running: () => running,
    async close() { controller?.abort(); await disposeArchive(); },
  };
}
