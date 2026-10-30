// The desktop's calls to My Cloud's /api/sync for Files, with the Cloud sign-in the app window already holds (main passes
// session.defaultSession.fetch). Uploads go in resumable parts; downloads resume a partial file.
import { closeSync, createWriteStream, openSync, readSync, statSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { BACKGROUND_HEADERS, CloudAsleepError, asleepAnswer } from "./cloud-power.mjs";
import { CHUNK_BYTES, MIN_CHUNK_BYTES } from "./cloud-sync-rules.mjs";

// Slowest connection a transfer is given time for, in bytes per millisecond (32 KB/s).
const SLOWEST = 32;
const tooSlow = () => new Error("The connection to My Cloud is too slow for this file right now; it will carry on next time.");

export class SyncAuthError extends Error {}
export class SyncHttpError extends Error {
  constructor(status, body) {
    super(body?.error ?? `My Cloud answered ${status}`);
    this.status = status;
    this.body = body;
  }
}

/** `power`: My Cloud's power gate (cloud-power.mjs); while it says asleep no call is made. */
export function createSyncClient({ origin, fetch: fetchImpl, power = null, chunkBytes = CHUNK_BYTES, minChunkBytes = MIN_CHUNK_BYTES }) {
  let chunk = chunkBytes;
  const call = async (method, path, { body, raw, headers = {}, signal, timeoutMs = 60_000 } = {}) => {
    if (power?.asleep()) throw new CloudAsleepError();
    const response = await fetchImpl(`${origin}${path}`, {
      method, credentials: "include", redirect: "error", cache: "no-store",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      headers: { origin, ...BACKGROUND_HEADERS, ...(body !== undefined ? { "content-type": "application/json" } : raw ? { "content-type": "application/octet-stream" } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : raw ? { body: raw } : {}),
    });
    if (asleepAnswer(response)) {
      await response.body?.cancel().catch(() => {});
      power?.hold();
      throw new CloudAsleepError();
    }
    if (response.status === 401 || response.status === 403) throw new SyncAuthError("Sign in to My Cloud again.");
    return response;
  };
  const json = async (method, path, options) => {
    const response = await call(method, path, options);
    if (response.status === 204) return null;
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch {}
    if (!response.ok) throw new SyncHttpError(response.status, body);
    return body;
  };
  const id = (value) => encodeURIComponent(value);
  return {
    summary: () => json("GET", "/api/sync"),
    register: (input) => json("POST", "/api/sync/folders", { body: input }).then((result) => result.folder),
    unregister: (folderId, keepCloudCopy) => json("DELETE", `/api/sync/folders/${id(folderId)}?keepCloudCopy=${keepCloudCopy ? 1 : 0}`),
    files: (folderId) => json("GET", `/api/sync/folders/${id(folderId)}/files`).then((result) => result.files),
    changes: (cursor, waitMs, signal) => json("GET", `/api/sync/changes?cursor=${cursor}&waitMs=${waitMs}`, { signal, timeoutMs: waitMs + 15_000 }),
    ops: (folderId, ops) => json("POST", `/api/sync/folders/${id(folderId)}/ops`, { body: { ops } }).then((result) => result.results),
    trash: () => json("GET", "/api/sync/trash").then((result) => result.entries),
    restore: (entryId) => json("POST", "/api/sync/trash/restore", { body: { entryId } }),
    bots: () => json("GET", "/api/bots?messages=0").then((result) => ({ bots: result?.bots ?? [], groups: result?.groups ?? [] })),
    // Lent folders (electron/lent-folders.mjs): what this computer lends, a copy in step, and bots' changes waiting for it.
    lent: (report) => json("POST", "/api/sync/lent", { body: report }),
    synced: (folderId) => json("POST", `/api/sync/folders/${id(folderId)}/synced`, { body: {} }),
    staged: (folderId) => json("GET", `/api/sync/folders/${id(folderId)}/staged`).then((result) => result?.staged ?? []),
    stagedDone: (folderId, changeId, sha256) => json("POST", `/api/sync/folders/${id(folderId)}/staged/${id(changeId)}`, { body: { sha256 } }),
    async stagedFile(folderId, changeId, temporary) {
      const response = await call("GET", `/api/sync/folders/${id(folderId)}/staged/${id(changeId)}`);
      if (!response.ok) throw new SyncHttpError(response.status, await response.json().catch(() => null));
      await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: "w", mode: 0o600 }));
      return { sha256: response.headers.get("x-omb-sha256") };
    },
    async upload({ folderId, path, file, size, sha256, baseSha256 }) {
      let begun;
      try {
        begun = await json("POST", `/api/sync/folders/${id(folderId)}/uploads`, { body: { path, size, sha256, baseSha256 } });
      } catch (error) {
        if (error.status === 507) return { full: true, neededBytes: error.body?.neededBytes, freeBytes: error.body?.freeBytes };
        throw error;
      }
      let received = begun.received;
      const fd = openSync(file, "r");
      try {
        while (received < size) {
          const length = Math.min(chunk, size - received);
          const buffer = Buffer.alloc(length);
          if (readSync(fd, buffer, 0, length, received) !== length) throw new Error("The file changed while it was being sent.");
          let response;
          try {
            response = await call("PUT", `/api/sync/uploads/${begun.uploadId}?offset=${received}`, { raw: buffer, timeoutMs: 30_000 + Math.ceil(length / SLOWEST) });
          } catch (error) {
            // A part that timed out goes again smaller; at the smallest it is this file's failure, not the whole pass's.
            if (error?.name !== "TimeoutError") throw error;
            if (chunk <= minChunkBytes) throw tooSlow();
            chunk = Math.max(minChunkBytes, Math.floor(chunk / 2));
            continue;
          }
          if (response.status === 413 && chunk > minChunkBytes) { chunk = Math.max(minChunkBytes, Math.floor(chunk / 2)); continue; }
          const body = await response.json().catch(() => null);
          if (response.status === 409 && Number.isSafeInteger(body?.received)) { received = body.received; continue; }
          if (!response.ok) throw new SyncHttpError(response.status, body);
          received = body.received;
        }
      } finally { closeSync(fd); }
      try {
        await json("POST", `/api/sync/uploads/${begun.uploadId}/commit`);
        return { ok: true };
      } catch (error) {
        if (error.status === 409 && error.body && "current" in error.body) return { conflict: true, current: error.body.current };
        throw error;
      }
    },
    /** What arrived stays in `temporary`, so a download that timed out carries on from there next time. */
    async download(folderId, path, temporary, size = 0) {
      const have = statSync(temporary, { throwIfNoEntry: false })?.size ?? 0;
      try {
        const response = await call("GET", `/api/sync/folders/${id(folderId)}/file?path=${encodeURIComponent(path)}`, { headers: have ? { range: `bytes=${have}-` } : {}, timeoutMs: 60_000 + Math.ceil(Math.max(0, size - have) / SLOWEST) });
        if (!response.ok) throw new SyncHttpError(response.status, await response.json().catch(() => null));
        await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: response.status === 206 ? "a" : "w", mode: 0o600 }));
        return { sha256: response.headers.get("x-omb-sha256") };
      } catch (error) {
        if (error?.name === "TimeoutError") throw tooSlow();
        throw error;
      }
    },
  };
}
