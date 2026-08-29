/* oxlint-disable anti-slop/no-runtime-typeof -- encrypted backup envelopes are
 * untrusted JSON and are narrowed at this module's I/O seam before use. */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const BACKUP_KEY_FIELD = "encryptedBackupKey";
const FORMAT = "openmausbot-encrypted-backup-v1";
const ROLLBACK_FORMAT = "openmausbot-offline-rollback-v1";
const ROLLBACK_AUTH_DOMAIN = "openmausbot-offline-rollback-auth-v1\0";
const CORE_FILES = [
  "bots.json",
  "capture.db",
  "config.json",
  "decisions.ndjson",
  "delegations.json",
  "groups.json",
  "messages.db",
  "routines.json",
  "section-contexts.json",
];

export const DEFAULT_BACKUP_KEEP = 14;

export function normalizeBackupKeep(value, fallback = DEFAULT_BACKUP_KEEP) {
  const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return Number.isInteger(parsed) && parsed >= 3 && parsed <= 90 ? parsed : fallback;
}

function validKey(value) {
  if (typeof value !== "string") return false;
  const decoded = Buffer.from(value, "base64");
  return decoded.length === 32 && decoded.toString("base64") === value;
}

export function ensureBackupEncryptionKey(credentials, generate = randomBytes) {
  const next = credentials && typeof credentials === "object" && !Array.isArray(credentials)
    ? { ...credentials }
    : {};
  if (validKey(next[BACKUP_KEY_FIELD])) return next;
  if (Object.hasOwn(next, BACKUP_KEY_FIELD)) return next;
  next[BACKUP_KEY_FIELD] = Buffer.from(generate(32)).toString("base64");
  return next;
}

/** Write the recovery key selected by the user without ever returning the key
 * through the renderer. Validation happens before the destination is opened,
 * so invalid credential state cannot truncate an existing recovery file. */
export function writeBackupRecoveryKey(destination, keyBase64) {
  if (!validKey(keyBase64)) throw new Error("Backup encryption key is unavailable");
  if (typeof destination !== "string" || !path.isAbsolute(destination)) {
    throw new Error("Recovery key destination must be an absolute path");
  }
  const document = `${keyBase64}\n`;
  if (process.platform === "win32") {
    fs.writeFileSync(destination, document, { mode: 0o600 });
    return destination;
  }
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW;
  const handle = fs.openSync(destination, flags, 0o600);
  try {
    fs.fchmodSync(handle, 0o600);
    fs.writeFileSync(handle, document, "utf8");
  } finally {
    fs.closeSync(handle);
  }
  return destination;
}

function safeRelative(value) {
  return typeof value === "string"
    && value.length > 0
    && !path.isAbsolute(value)
    && !value.split(/[\\/]/).includes("..");
}

function decodeBackup(file, keyBase64) {
  if (!validKey(keyBase64)) throw new Error("Backup encryption key is unavailable");
  const envelope = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope) || envelope.format !== FORMAT) {
    throw new Error("Unsupported Agent Centipede backup format");
  }
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(keyBase64, "base64"), Buffer.from(envelope.iv, "base64"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const compressed = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final(),
  ]);
  const archive = JSON.parse(gunzipSync(compressed).toString("utf8"));
  if (!archive || typeof archive !== "object" || !Array.isArray(archive.entries) || archive.entries.length === 0) {
    throw new Error("Backup contains no core state");
  }
  return archive;
}

function validateRestoredEntries(entries, temporaryRoot) {
  const seen = new Set();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || !safeRelative(entry.path) || !CORE_FILES.includes(entry.path)) {
      throw new Error("Backup contains an unsupported or unsafe path");
    }
    if (seen.has(entry.path)) throw new Error(`Backup contains duplicate entry ${entry.path}`);
    seen.add(entry.path);
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw new Error(`Backup metadata is invalid for ${entry.path}`);
    }
    if (typeof entry.data !== "string") throw new Error(`Backup data is invalid for ${entry.path}`);
    const data = Buffer.from(entry.data, "base64");
    if (data.length !== entry.size || createHash("sha256").update(data).digest("hex") !== entry.sha256) {
      throw new Error(`Backup verification failed for ${entry.path}`);
    }
    const restored = path.join(temporaryRoot, entry.path);
    fs.mkdirSync(path.dirname(restored), { recursive: true, mode: 0o700 });
    fs.writeFileSync(restored, data, { mode: 0o600 });
    if (entry.path.endsWith(".db")) {
      const database = new DatabaseSync(restored, { readOnly: true });
      try {
        const result = database.prepare("PRAGMA integrity_check").get();
        if (!result || Object.values(result)[0] !== "ok") throw new Error(`SQLite restore check failed for ${entry.path}`);
      } finally {
        database.close();
      }
    } else if (entry.path.endsWith(".json")) {
      JSON.parse(data.toString("utf8"));
    } else if (entry.path === "decisions.ndjson") {
      for (const line of data.toString("utf8").split(/\r?\n/)) {
        if (line.trim()) JSON.parse(line);
      }
    }
  }
  return { files: entries.length, paths: [...seen] };
}

function rollbackDirectoryFor(dataDirectory, now) {
  const base = path.resolve(dataDirectory);
  return `${base}.restore-rollback-${new Date(now).toISOString().replaceAll(":", "-")}-${process.pid}`;
}

function rollbackAuthentication(payload, keyBase64) {
  if (!validKey(keyBase64)) throw new Error("Backup encryption key is unavailable");
  return createHmac("sha256", Buffer.from(keyBase64, "base64"))
    .update(ROLLBACK_AUTH_DOMAIN)
    .update(JSON.stringify(payload))
    .digest("hex");
}

function authenticateRollbackManifest(raw, root, keyBase64) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)
    || raw.format !== ROLLBACK_FORMAT || raw.dataDirectory !== root
    || !Array.isArray(raw.entries) || raw.entries.length === 0
    || typeof raw.authentication !== "string" || !/^[a-f0-9]{64}$/.test(raw.authentication)) {
    throw new Error("invalid authenticated offline restore rollback manifest");
  }
  const entries = [];
  const seen = new Set();
  for (const entry of raw.entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
      || !safeRelative(entry.path) || !CORE_FILES.includes(entry.path)
      || !["existing", "absent"].includes(entry.disposition)
      || seen.has(entry.path)) {
      throw new Error("invalid authenticated offline restore rollback entry");
    }
    seen.add(entry.path);
    if (entry.disposition === "existing") {
      if (!Number.isSafeInteger(entry.size) || entry.size < 0
        || typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
        throw new Error(`invalid authenticated offline restore rollback metadata: ${entry.path}`);
      }
      entries.push({ path: entry.path, disposition: "existing", size: entry.size, sha256: entry.sha256 });
    } else {
      entries.push({ path: entry.path, disposition: "absent" });
    }
  }
  const payload = { format: ROLLBACK_FORMAT, dataDirectory: root, entries };
  const expected = Buffer.from(rollbackAuthentication(payload, keyBase64), "hex");
  const actual = Buffer.from(raw.authentication, "hex");
  if (!timingSafeEqual(expected, actual)) throw new Error("rollback authentication failed");
  return payload;
}

function acquireOfflineRestoreLock(dataDirectory) {
  const lockPath = path.join(path.resolve(dataDirectory), ".openmausbot-offline-restore.lock");
  try {
    const handle = fs.openSync(lockPath, "wx", 0o600);
    fs.writeFileSync(handle, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), "utf8");
    return { lockPath, handle };
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error("offline restore is already running for this data directory");
    throw error;
  }
}

function releaseOfflineRestoreLock(lock) {
  try { fs.closeSync(lock.handle); } catch { /* already closed */ }
  try { fs.rmSync(lock.lockPath, { force: true }); } catch { /* best effort cleanup */ }
}

/** Validate a data root without mutating it. The returned shape contains no
 * contents, only the verified file count. This is the same seam used by the
 * offline restore command and its tests. */
export function validateDataRootIntegrity(dataDirectory) {
  const root = path.resolve(dataDirectory);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error("data directory does not exist");
  let files = 0;
  for (const relativePath of CORE_FILES) {
    const candidate = path.join(root, relativePath);
    if (!fs.existsSync(candidate)) continue;
    if (!fs.statSync(candidate).isFile()) throw new Error(`data root entry is not a file: ${relativePath}`);
    const data = fs.readFileSync(candidate);
    if (relativePath.endsWith(".db")) {
      const database = new DatabaseSync(candidate, { readOnly: true });
      try {
        const result = database.prepare("PRAGMA integrity_check").get();
        if (!result || Object.values(result)[0] !== "ok") throw new Error(`SQLite integrity check failed for ${relativePath}`);
      } finally { database.close(); }
    } else if (relativePath.endsWith(".json")) JSON.parse(data.toString("utf8"));
    else if (relativePath === "decisions.ndjson") {
      for (const line of data.toString("utf8").split(/\r?\n/)) if (line.trim()) JSON.parse(line);
    }
    files += 1;
  }
  return { files };
}

/** Restore a verified backup while the app is offline. The implementation
 * stages and validates every entry in a temporary root, then swaps only the
 * exact archived children. A sibling rollback root is retained on success.
 * `isLiveServer` is deliberately injected so the CLI can use a real health
 * probe while tests remain entirely disposable. */
export function restoreEncryptedBackup({ backupFile, dataDirectory, keyBase64, isLiveServer = () => false, now = Date.now() }) {
  const root = path.resolve(dataDirectory);
  if (isLiveServer()) throw new Error("cannot restore while Agent Centipede owns the data directory");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const lock = acquireOfflineRestoreLock(root);
  const temporaryRoot = fs.mkdtempSync(`${root}.restore-staging-`);
  const rollbackDirectory = rollbackDirectoryFor(root, now);
  let moved = [];
  try {
    if (isLiveServer()) throw new Error("cannot restore while Agent Centipede owns the data directory");
    const archive = decodeBackup(backupFile, keyBase64);
    const validated = validateRestoredEntries(archive.entries, temporaryRoot);
    fs.mkdirSync(rollbackDirectory, { recursive: true, mode: 0o700 });
    const entries = [];
    for (const relativePath of validated.paths) {
      const current = path.join(root, relativePath);
      const staged = path.join(temporaryRoot, relativePath);
      const rollback = path.join(rollbackDirectory, relativePath);
      const hadExisting = fs.existsSync(current);
      if (hadExisting) {
        if (!fs.statSync(current).isFile()) throw new Error(`data root entry is not a file: ${relativePath}`);
        fs.renameSync(current, rollback);
        try {
          const previous = fs.readFileSync(rollback);
          entries.push({
            path: relativePath,
            disposition: "existing",
            size: previous.length,
            sha256: createHash("sha256").update(previous).digest("hex"),
          });
          fs.renameSync(staged, current);
        } catch (error) {
          if (fs.existsSync(rollback)) fs.renameSync(rollback, current);
          throw error;
        }
      } else {
        entries.push({ path: relativePath, disposition: "absent" });
        fs.renameSync(staged, current);
      }
      moved.push(relativePath);
    }
    validateDataRootIntegrity(root);
    const payload = { format: ROLLBACK_FORMAT, dataDirectory: root, entries };
    const manifest = { ...payload, authentication: rollbackAuthentication(payload, keyBase64) };
    const manifestFile = path.join(rollbackDirectory, "manifest.json");
    const temporaryManifest = `${manifestFile}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryManifest, JSON.stringify(manifest), { mode: 0o600 });
    fs.renameSync(temporaryManifest, manifestFile);
    return { restored: validated.files, rollbackDirectory };
  } catch (error) {
    for (const relativePath of moved.reverse()) {
      const current = path.join(root, relativePath);
      const rollback = path.join(rollbackDirectory, relativePath);
      try { fs.rmSync(current, { force: true }); } catch {}
      try { if (fs.existsSync(rollback)) fs.renameSync(rollback, current); } catch {}
    }
    fs.rmSync(rollbackDirectory, { recursive: true, force: true });
    throw error;
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    releaseOfflineRestoreLock(lock);
  }
}

/** Roll back one successful offline restore. The rollback manifest and every
 * preserved byte are authenticated with the backup key. Existing files are
 * copied into a temporary root and structurally validated before replacement. */
export function rollbackEncryptedRestore({ dataDirectory, rollbackDirectory, keyBase64, isLiveServer = () => false }) {
  const root = path.resolve(dataDirectory);
  const rollbackRoot = path.resolve(rollbackDirectory);
  if (isLiveServer()) throw new Error("cannot roll back while Agent Centipede owns the data directory");
  if (path.dirname(rollbackRoot) !== path.dirname(root) || !rollbackRoot.startsWith(`${root}.restore-rollback-`)) {
    throw new Error("rollback directory is not an offline restore sibling");
  }
  const raw = JSON.parse(fs.readFileSync(path.join(rollbackRoot, "manifest.json"), "utf8"));
  const manifest = authenticateRollbackManifest(raw, root, keyBase64);
  const lock = acquireOfflineRestoreLock(root);
  const temporaryRoot = fs.mkdtempSync(`${root}.rollback-staging-`);
  const displaced = `${rollbackRoot}.rollback-${process.pid}`;
  const moved = [];
  try {
    if (isLiveServer()) throw new Error("cannot roll back while Agent Centipede owns the data directory");
    const staged = [];
    for (const entry of manifest.entries) {
      const backup = path.join(rollbackRoot, entry.path);
      if (entry.disposition === "existing") {
        if (!fs.existsSync(backup) || !fs.statSync(backup).isFile()) throw new Error(`rollback file is missing: ${entry.path}`);
        const data = fs.readFileSync(backup);
        if (data.length !== entry.size || createHash("sha256").update(data).digest("hex") !== entry.sha256) {
          throw new Error(`rollback verification failed for ${entry.path}`);
        }
        const target = path.join(temporaryRoot, entry.path);
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        fs.writeFileSync(target, data, { mode: 0o600 });
      } else if (fs.existsSync(backup)) {
        throw new Error(`rollback verification failed for ${entry.path}`);
      }
      staged.push(entry);
    }
    const expectedStagedFiles = staged.filter((entry) => entry.disposition === "existing").length;
    if (expectedStagedFiles > 0 && validateDataRootIntegrity(temporaryRoot).files !== expectedStagedFiles) {
      throw new Error("rollback staging validation did not cover every preserved file");
    }
    fs.mkdirSync(displaced, { recursive: true, mode: 0o700 });
    for (const entry of staged) {
      const current = path.join(root, entry.path);
      const target = path.join(temporaryRoot, entry.path);
      const old = path.join(displaced, entry.path);
      if (fs.existsSync(current)) {
        fs.mkdirSync(path.dirname(old), { recursive: true, mode: 0o700 });
        fs.renameSync(current, old);
      }
      moved.push(entry);
      if (entry.disposition === "existing") fs.renameSync(target, current);
    }
    validateDataRootIntegrity(root);
    fs.rmSync(rollbackRoot, { recursive: true, force: true });
    fs.rmSync(displaced, { recursive: true, force: true });
    return { rolledBack: staged.length };
  } catch (error) {
    // A failed rollback must not leave a half-restored root. Put every file
    // displaced by this attempt back where it came from, in reverse order.
    for (const entry of moved.reverse()) {
      const current = path.join(root, entry.path);
      const old = path.join(displaced, entry.path);
      try { fs.rmSync(current, { force: true }); } catch { /* best effort; preserve original error */ }
      try { if (fs.existsSync(old)) fs.renameSync(old, current); } catch { /* preserve original error */ }
    }
    fs.rmSync(displaced, { recursive: true, force: true });
    throw error;
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    releaseOfflineRestoreLock(lock);
  }
}

function sqliteSnapshot(source, temporaryRoot) {
  const destination = path.join(temporaryRoot, path.basename(source));
  const escaped = destination.replaceAll("'", "''");
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    db.exec(`VACUUM INTO '${escaped}'`);
  } finally {
    db.close();
  }
  return destination;
}

function archiveEntries(dataDirectory, temporaryRoot) {
  const entries = [];
  for (const relativePath of CORE_FILES) {
    const source = path.join(dataDirectory, relativePath);
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) continue;
    const readable = relativePath.endsWith(".db") ? sqliteSnapshot(source, temporaryRoot) : source;
    const content = fs.readFileSync(readable);
    entries.push({
      path: relativePath,
      size: content.length,
      sha256: createHash("sha256").update(content).digest("hex"),
      data: content.toString("base64"),
    });
  }
  return entries;
}

export function verifyEncryptedBackup(file, keyBase64) {
  const archive = decodeBackup(file, keyBase64);
  const restoreTestRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openmaus-restore-test-"));
  try {
    validateRestoredEntries(archive.entries, restoreTestRoot);
  } finally {
    fs.rmSync(restoreTestRoot, { recursive: true, force: true });
  }
  return { createdAt: archive.createdAt, files: archive.entries.length };
}

function encryptedBackupFiles(destinationDirectory) {
  if (!fs.existsSync(destinationDirectory)) return [];
  const resolvedDirectory = path.resolve(destinationDirectory);
  return fs.readdirSync(destinationDirectory)
    .filter((name) => /^openmausbot-.*\.omb-backup$/.test(name))
    .map((name) => path.join(resolvedDirectory, name))
    .filter((candidate) => path.dirname(path.resolve(candidate)) === resolvedDirectory)
    .map((file, index) => {
      try {
        return { file, mtimeMs: fs.statSync(file).mtimeMs, index };
      } catch {
        // A user can remove a backup between readdir and stat. Ignore that
        // vanished entry instead of making Settings/reporting fail closed.
        return null;
      }
    })
    .filter((entry) => entry !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs || a.index - b.index)
    .map((entry) => entry.file);
}

/** Inspect only the newest backup. Every backup is authenticated and fully
 * verified when it is created; re-checking the newest gives Settings a cheap
 * recovery-health signal without decrypting the whole retained history. */
export function inspectEncryptedBackups({ destinationDirectory, keyBase64 }) {
  const files = encryptedBackupFiles(destinationDirectory);
  const latestFile = files[0];
  if (!latestFile) return { count: 0, latest: null };
  try {
    const verified = verifyEncryptedBackup(latestFile, keyBase64);
    return {
      count: files.length,
      latest: { file: latestFile, ...verified, verified: true },
    };
  } catch (error) {
    return {
      count: files.length,
      latest: {
        file: latestFile,
        createdAt: null,
        files: null,
        verified: false,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/** Remove only authenticated backup files beyond the requested retention
 * window. The file enumerator is deliberately constrained to this app's
 * filename shape and direct child directory, so a retention change can never
 * become a recursive or broad user-file deletion. */
export function pruneEncryptedBackups(destinationDirectory, keep = DEFAULT_BACKUP_KEEP) {
  const retained = normalizeBackupKeep(keep);
  const old = encryptedBackupFiles(destinationDirectory).slice(retained);
  for (const candidate of old) fs.rmSync(candidate, { force: true });
  return encryptedBackupFiles(destinationDirectory).length;
}

export function createEncryptedBackup({ dataDirectory, destinationDirectory, keyBase64, now = Date.now(), keep = DEFAULT_BACKUP_KEEP }) {
  if (!validKey(keyBase64)) throw new Error("Backup encryption key is unavailable");
  fs.mkdirSync(destinationDirectory, { recursive: true });
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openmaus-backup-"));
  try {
    const entries = archiveEntries(dataDirectory, temporaryRoot);
    if (entries.length === 0) throw new Error("No Agent Centipede core state was found to back up");
    const archive = Buffer.from(JSON.stringify({ format: FORMAT, createdAt: now, entries }), "utf8");
    const compressed = gzipSync(archive, { level: 9 });
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", Buffer.from(keyBase64, "base64"), iv);
    const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);
    const envelope = {
      format: FORMAT,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
    const stamp = new Date(now).toISOString().replaceAll(":", "-");
    const destination = path.join(destinationDirectory, `openmausbot-${stamp}.omb-backup`);
    const temporary = `${destination}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(envelope), { mode: 0o600 });
    fs.renameSync(temporary, destination);
    const verified = verifyEncryptedBackup(destination, keyBase64);

    pruneEncryptedBackups(destinationDirectory, keep);
    return { file: destination, ...verified };
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}
