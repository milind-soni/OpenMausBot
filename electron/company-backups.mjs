import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, rm, statfs } from "node:fs/promises";
import { isAbsolute, join, parse, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const MAX_BYTES = 10 * 1024 ** 3;
const PART_BYTES = 64 * 1024 ** 2;
const SPACE_MARGIN = 64 * 1024 ** 2;
const MAGIC = Buffer.from("OMB-WORKSPACE-1\n");
const HEADER_BYTES = MAGIC.length + 16 + 12;
const MIN_BYTES = HEADER_BYTES + 16;
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/;
const HASH = /^[a-f\d]{64}$/;
const ETAG = /^(?:"[a-f\d]{32}"|[a-f\d]{32})$/;
const R2_HOST = /^(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)*[a-f\d]{32}(?:\.(?:eu|us|fedramp))?\.r2\.cloudflarestorage\.com$/;
const LOCAL = "/api/workspace-backup";
const CLOUD = "/api/desktop/backups";

export class CompanyBackupError extends Error {
  constructor(code, message) { super(message); this.name = "CompanyBackupError"; this.code = code; }
}
const fail = (code, message) => { throw new CompanyBackupError(code, message); };
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const archiveSize = value => Number.isSafeInteger(value) && value >= MIN_BYTES && value <= MAX_BYTES;
const identifier = value => typeof value === "string" && UUID.test(value);
const checkPassword = password => {
  if (typeof password !== "string" || password.length < 12 || password.length > 1024) fail("invalid_password", "Use a backup password between 12 and 1,024 characters.");
};
const safeError = (error, signal) => {
  if (error instanceof CompanyBackupError) return error;
  if (signal?.aborted || error?.name === "AbortError") return new CompanyBackupError("cancelled", "The backup transfer was cancelled or timed out.");
  if (error?.code === "ENOSPC") return new CompanyBackupError("no_space", "There is not enough free disk space for this backup transfer.");
  if (error?.status === 401 || error?.status === 403) return new CompanyBackupError("access_changed", "Company access changed. Reconnect your desktop and try again.");
  // Fetch/provider exceptions may contain signed URLs. Never forward them.
  return new CompanyBackupError("transfer_failed", "The backup transfer could not be completed. Please try again.");
};
async function discard(response) { try { await response?.body?.cancel(); } catch {} }

function signedUrl(value, allowLoopbackForTests) {
  let url;
  try { url = new URL(value); } catch { fail("invalid_response", "The backup service returned an invalid storage address."); }
  const loopback = allowLoopbackForTests && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) && ["http:", "https:"].includes(url.protocol);
  if (url.username || url.password || url.hash || (!loopback && (url.protocol !== "https:" || url.port || !R2_HOST.test(url.hostname)))) {
    fail("invalid_response", "The backup service returned an unsupported storage address.");
  }
  return url.href;
}
function cloudMetadata(value, expectedStatus, expected) {
  if (!record(value) || !identifier(value.id) || value.status !== expectedStatus || !archiveSize(value.sizeBytes) || typeof value.sha256 !== "string" || !HASH.test(value.sha256) ||
      (expected && (value.id !== expected.id || value.sizeBytes !== expected.sizeBytes || value.sha256 !== expected.sha256))) {
    fail("invalid_response", "The backup service returned inconsistent archive metadata.");
  }
  return { id: value.id, status: value.status, sizeBytes: value.sizeBytes, sha256: value.sha256,
    passwordRequired: value.passwordRequired !== false,
    ...(typeof value.appVersion === "string" ? { appVersion: value.appVersion.slice(0, 64) } : {}),
    ...(Number.isSafeInteger(value.createdAt) ? { createdAt: value.createdAt } : {}),
    ...(Number.isSafeInteger(value.completedAt) ? { completedAt: value.completedAt } : {}),
  };
}
function liveExpiry(value) {
  if (!Number.isSafeInteger(value) || value <= Date.now() || value > Date.now() + 15 * 60_000) fail("invalid_response", "The storage link has expired or has an invalid lifetime. Try again.");
}

/** Transfer existing encrypted .ombbackup archives. Never commits a restore. */
export function createCompanyBackups({ localRequest, portalRequest, tempRoot, fetchImpl = fetch, allowLoopbackForTests = false, availableBytes }) {
  if (typeof localRequest !== "function" || typeof portalRequest !== "function" || typeof fetchImpl !== "function" || typeof tempRoot !== "string" ||
      !isAbsolute(tempRoot) || resolve(tempRoot) === parse(resolve(tempRoot)).root) throw new Error("A private backup transfer directory and request adapters are required.");
  const freeBytes = availableBytes ?? (async path => { const disk = await statfs(path, { bigint: true }); return Number(disk.bavail * disk.bsize > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : disk.bavail * disk.bsize); });
  let operating = false;
  async function checkSpace(path, required) {
    const available = await freeBytes(path);
    if (!Number.isFinite(available) || available < required + SPACE_MARGIN) fail("no_space", "There is not enough free disk space for this backup transfer and its temporary files.");
  }
  async function localJson(path, body, signal, preview = false) {
    const response = await localRequest(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal, redirect: "error" });
    if (!response.ok) {
      await discard(response);
      if (response.status === 401 || response.status === 403) fail("access_changed", "Access to this installation changed. Reopen Backups and try again.");
      if (preview && response.status === 400) fail("invalid_archive", "The backup password is incorrect, or the archive is damaged or unsupported. Nothing was restored.");
      if ([409, 503].includes(response.status)) fail("workspace_busy", "Wait for this installation to finish its current work before backing up or restoring.");
      fail("local_backup_failed", "The local backup operation could not be completed. Check Backups in the desktop app and try again.");
    }
    if (!response.body) fail("invalid_response", "The local backup service returned an empty response.");
    const chunks = []; let bytes = 0;
    for await (const chunk of Readable.fromWeb(response.body)) {
      signal.throwIfAborted(); bytes += chunk.length;
      if (bytes > 2 * 1024 ** 2) fail("invalid_response", "The local backup response was too large.");
      chunks.push(chunk);
    }
    let result;
    try { result = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { fail("invalid_response", "The local backup service returned invalid metadata."); }
    if (!record(result)) fail("invalid_response", "The local backup service returned invalid metadata.");
    return result;
  }
  async function transferToFile(response, file, expectedBytes, signal, report, phase) {
    const declared = response.headers.get("content-length");
    if (!response.ok || response.status !== 200 || !response.body || (declared !== null && (!/^\d+$/.test(declared) || Number(declared) !== expectedBytes)) ||
        (response.headers.has("content-encoding") && response.headers.get("content-encoding") !== "identity")) {
      await discard(response); fail("invalid_archive", "The archive download has an invalid size or encoding.");
    }
    const hash = createHash("sha256"), prefix = Buffer.alloc(HEADER_BYTES);
    let bytes = 0, checkedAt = 0;
    await pipeline(Readable.fromWeb(response.body), async function* (source) {
      for await (const chunk of source) {
        signal.throwIfAborted();
        if (bytes + chunk.length > expectedBytes) fail("invalid_archive", "The archive download exceeded its declared size.");
        if (bytes < HEADER_BYTES) chunk.copy(prefix, bytes, 0, Math.min(chunk.length, HEADER_BYTES - bytes));
        bytes += chunk.length; hash.update(chunk);
        if (bytes - checkedAt >= PART_BYTES) { checkedAt = bytes; await checkSpace(file, expectedBytes - bytes); }
        report(phase, bytes, expectedBytes); yield chunk;
      }
    }, createWriteStream(file, { flags: "wx", mode: 0o600 }), { signal });
    if (bytes !== expectedBytes) fail("invalid_archive", "The archive download was incomplete.");
    if (!prefix.subarray(0, MAGIC.length).equals(MAGIC)) fail("invalid_archive", "This is not a supported encrypted installation backup.");
    return hash.digest("hex");
  }
  async function storageRequest(url, init) {
    const response = await fetchImpl(url, { ...init, redirect: "error", credentials: "omit", referrerPolicy: "no-referrer" });
    if (response.redirected || (response.url && response.url !== url)) { await discard(response); fail("invalid_response", "The backup storage request was redirected and was stopped."); }
    return response;
  }
  async function run(signal, onProgress, work) {
    if (operating) fail("busy", "Another cloud backup transfer is in progress.");
    operating = true;
    const operationSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(24 * 3600_000)]) : AbortSignal.timeout(24 * 3600_000);
    let directory, result, failure, lastPhase = "", lastAt = 0;
    const report = (phase, bytesTransferred = 0, totalBytes = 0) => {
      if (phase === lastPhase && bytesTransferred !== totalBytes && Date.now() - lastAt < 250) return;
      lastPhase = phase; lastAt = Date.now();
      try { onProgress?.({ phase, bytesTransferred, totalBytes }); } catch { /* A view closing must not interrupt cleanup. */ }
    };
    try {
      operationSignal.throwIfAborted();
      await mkdir(tempRoot, { recursive: true, mode: 0o700 });
      const root = await lstat(tempRoot);
      if (!root.isDirectory() || root.isSymbolicLink() || (process.platform !== "win32" && (root.mode & 0o077) !== 0)) fail("unsafe_directory", "Backup transfers require a private temporary directory.");
      directory = await mkdtemp(join(tempRoot, "company-backup-"));
      await chmod(directory, 0o700); await checkSpace(directory, 0);
      result = await work(directory, operationSignal, report);
    } catch (error) { failure = safeError(error, operationSignal); }
    finally {
      try { if (directory) await rm(directory, { recursive: true, force: true }); }
      catch { failure = new CompanyBackupError("cleanup_failed", "The encrypted temporary transfer file could not be removed. Close the app and check its backup cache."); }
      finally { operating = false; }
    }
    if (failure) throw failure;
    return result;
  }
  return {
    backup(input, signal, onProgress) {
      return run(signal, onProgress, async (directory, operationSignal, report) => {
        const password = randomBytes(32).toString("base64url");
        const clientState = input?.clientState ?? {};
        if (!record(clientState) || Object.values(clientState).some(value => typeof value !== "string") || Buffer.byteLength(JSON.stringify(clientState)) > 2 * 1024 ** 2) fail("invalid_preferences", "Saved desktop preferences exceed the supported backup limit.");
        report("exporting");
        const exported = await localJson(`${LOCAL}/export`, { password, clientState }, operationSignal);
        if (!identifier(exported.id) || !archiveSize(exported.bytes)) fail("invalid_archive", "The exported encrypted archive must contain no more than 10 GiB.");
        const appVersion = input.appVersion ?? exported.summary?.appVersion ?? "unknown";
        if (typeof appVersion !== "string" || !/^[a-zA-Z\d][a-zA-Z\d ._+()-]{0,63}$/.test(appVersion)) fail("invalid_response", "The desktop app version is invalid.");
        await checkSpace(directory, exported.bytes);
        const response = await localRequest(`${LOCAL}/download/${exported.id}`, { method: "GET", signal: operationSignal, redirect: "error" });
        const file = join(directory, "workspace.ombbackup");
        report("reading", 0, exported.bytes);
        const sha256 = await transferToFile(response, file, exported.bytes, operationSignal, report, "reading");
        let pendingId = null;
        try {
          operationSignal.throwIfAborted();
          const started = await portalRequest(CLOUD, { method: "POST", body: { sizeBytes: exported.bytes, sha256, appVersion, unlockKey: password }, signal: operationSignal });
          if (identifier(started?.id)) pendingId = started.id;
          const backup = cloudMetadata(started, "uploading");
          if (backup.passwordRequired) fail("update_required", "Update your organization's Admin service to enable passwordless backups.");
          if (backup.sizeBytes !== exported.bytes || backup.sha256 !== sha256 || started.partSizeBytes !== PART_BYTES || started.partCount !== Math.ceil(exported.bytes / PART_BYTES)) fail("invalid_response", "The backup service returned an invalid multipart plan.");
          const parts = [];
          report("uploading", 0, exported.bytes);
          for (let partNumber = 1; partNumber <= started.partCount; partNumber++) {
            operationSignal.throwIfAborted();
            const start = (partNumber - 1) * PART_BYTES, sizeBytes = Math.min(PART_BYTES, exported.bytes - start);
            const signed = await portalRequest(`${CLOUD}/${backup.id}/parts/${partNumber}`, { method: "POST", body: {}, signal: operationSignal });
            if (!record(signed) || signed.partNumber !== partNumber || signed.sizeBytes !== sizeBytes || !record(signed.headers) ||
                Object.keys(signed.headers).some(name => name.toLowerCase() !== "content-length") ||
                new Headers(signed.headers).get("content-length") !== String(sizeBytes)) fail("invalid_response", "The backup service returned invalid upload instructions.");
            liveExpiry(signed.expiresAt);
            const url = signedUrl(signed.url, allowLoopbackForTests), stream = createReadStream(file, { start, end: start + sizeBytes - 1, highWaterMark: 256 * 1024 });
            let uploaded;
            try { uploaded = await storageRequest(url, { method: "PUT", headers: { "content-length": String(sizeBytes) }, body: stream, duplex: "half", signal: operationSignal }); }
            finally { stream.destroy(); }
            const etag = uploaded.headers.get("etag");
            const accepted = uploaded.ok; await discard(uploaded);
            if (!accepted || !etag || !ETAG.test(etag)) fail("upload_failed", "A backup part could not be uploaded and verified. Try the backup again.");
            parts.push({ partNumber, etag }); report("uploading", start + sizeBytes, exported.bytes);
          }
          report("completing", exported.bytes, exported.bytes);
          const completed = await portalRequest(`${CLOUD}/${backup.id}/complete`, { method: "POST", body: { parts }, signal: operationSignal });
          const result = cloudMetadata(completed, "ready", backup);
          if (result.passwordRequired) fail("invalid_response", "The backup service did not retain the encryption key.");
          pendingId = null; report("ready", exported.bytes, exported.bytes); return result;
        } finally {
          if (pendingId) {
            try { await portalRequest(`${CLOUD}/${pendingId}/abort`, { method: "POST", body: {}, signal: AbortSignal.timeout(10_000) }); } catch { /* Server expiry and durable cleanup remain the backstop. */ }
          }
        }
      });
    },
    prepareRestore(input, signal, onProgress) {
      return run(signal, onProgress, async (directory, operationSignal, report) => {
        if (!identifier(input?.id)) fail("invalid_archive", "Select a valid cloud backup.");
        const signed = await portalRequest(`${CLOUD}/${input.id}/download`, { method: "POST", body: {}, signal: operationSignal });
        const backup = cloudMetadata(signed, "ready");
        // Keys stay in the native process, never in the renderer or object URL.
        const password = backup.passwordRequired ? input.password : signed.unlockKey;
        checkPassword(password);
        if (backup.id !== input.id) fail("invalid_response", "The backup service returned a different archive.");
        liveExpiry(signed.expiresAt);
        const url = signedUrl(signed.url, allowLoopbackForTests);
        // Version 1 is uncompressed tar: encrypted transfer, local upload,
        // decrypted tar and extracted staging can coexist during preview.
        await checkSpace(directory, backup.sizeBytes * 4);
        report("downloading", 0, backup.sizeBytes);
        const downloaded = await storageRequest(url, { method: "GET", signal: operationSignal });
        const file = join(directory, "workspace.ombbackup");
        const sha256 = await transferToFile(downloaded, file, backup.sizeBytes, operationSignal, report, "downloading");
        report("validating", backup.sizeBytes, backup.sizeBytes);
        if (sha256 !== backup.sha256) fail("checksum_mismatch", "The downloaded backup checksum did not match. Nothing was uploaded locally or restored.");
        await checkSpace(directory, backup.sizeBytes * 3); operationSignal.throwIfAborted();
        report("preparing", 0, backup.sizeBytes);
        const stream = createReadStream(file, { highWaterMark: 256 * 1024 });
        let response;
        try { response = await localRequest(`${LOCAL}/upload`, { method: "POST", headers: { "content-type": "application/octet-stream", "content-length": String(backup.sizeBytes) }, body: stream, duplex: "half", signal: operationSignal, redirect: "error" }); }
        finally { stream.destroy(); }
        if (!response.ok) { await discard(response); fail("local_backup_failed", "The verified archive could not be staged in this installation."); }
        // The upload receipt is tiny; use the same bounded JSON reader without
        // making another request or retaining an unbounded response body.
        const receipt = await readUploadReceipt(response, operationSignal);
        if (!identifier(receipt.id)) fail("invalid_response", "This installation returned an invalid upload receipt.");
        await checkSpace(directory, backup.sizeBytes * 2); operationSignal.throwIfAborted();
        const preview = await localJson(`${LOCAL}/preview`, { id: receipt.id, password }, operationSignal, true);
        if (!identifier(preview.id) || !record(preview.summary) || preview.summary.format !== "openmaus.workspace-backup" || preview.summary.version !== 1 ||
            !identifier(preview.summary.id) || !Number.isSafeInteger(preview.summary.bytes) || preview.summary.bytes < 0 || preview.summary.bytes > MAX_BYTES) fail("invalid_response", "This installation returned an invalid restore preview.");
        report("ready", backup.sizeBytes, backup.sizeBytes);
        return { id: preview.id, summary: preview.summary };
      });
    },
  };
}

async function readUploadReceipt(response, signal) {
  if (!response.body) fail("invalid_response", "This installation returned an empty upload receipt.");
  const chunks = []; let bytes = 0;
  for await (const chunk of Readable.fromWeb(response.body)) {
    signal.throwIfAborted(); bytes += chunk.length;
    if (bytes > 4096) fail("invalid_response", "The local upload receipt was too large.");
    chunks.push(chunk);
  }
  try { const value = JSON.parse(Buffer.concat(chunks).toString("utf8")); if (record(value)) return value; } catch {}
  fail("invalid_response", "This installation returned an invalid upload receipt.");
}
