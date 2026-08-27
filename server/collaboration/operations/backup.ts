import { randomBytes, randomUUID, createCipheriv, createDecipheriv } from "node:crypto";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

import { COLLABORATION_SCHEMA_VERSION } from "../migrations.ts";
import { markRestoredLedgerForReview, readRestoreGuard } from "../restore-guard.ts";
import { readEncryptionKey, readSecureCredentialFile } from "./credentials.ts";

const MAGIC = Buffer.from("OMBBAK01", "ascii");
const IV_BYTES = 12;
const TAG_BYTES = 16;

function removePlaintext(path: string): void {
  try {
    const size = statSync(path).size;
    if (size > 0) writeFileSync(path, Buffer.alloc(size), { mode: 0o600 });
  } catch {}
  rmSync(path, { force: true });
}

function encrypt(plaintext: Buffer, key: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(MAGIC);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ciphertext]);
}

function decrypt(artifact: Buffer, key: Buffer): Buffer {
  if (artifact.length <= MAGIC.length + IV_BYTES + TAG_BYTES || !artifact.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error("backup_format_invalid");
  }
  const ivStart = MAGIC.length;
  const tagStart = ivStart + IV_BYTES;
  const bodyStart = tagStart + TAG_BYTES;
  const decipher = createDecipheriv("aes-256-gcm", key, artifact.subarray(ivStart, tagStart));
  decipher.setAAD(MAGIC);
  decipher.setAuthTag(artifact.subarray(tagStart, bodyStart));
  try {
    return Buffer.concat([decipher.update(artifact.subarray(bodyStart)), decipher.final()]);
  } catch {
    throw new Error("backup_authentication_failed");
  }
}

export async function createEncryptedLedgerBackup(input: {
  liveDatabasePath: string;
  outputPath: string;
  encryptionKeyFile: string;
  temporaryDirectory: string;
}): Promise<{ outputPath: string; bytes: number; schemaVersion: number }> {
  const liveDatabasePath = resolve(input.liveDatabasePath);
  const outputPath = resolve(input.outputPath);
  if (liveDatabasePath === outputPath) throw new Error("backup_must_not_overwrite_live_database");
  mkdirSync(resolve(input.temporaryDirectory), { recursive: true, mode: 0o700 });
  const plaintextPath = join(resolve(input.temporaryDirectory), `.collaboration-backup-${randomUUID()}.sqlite`);
  closeSync(openSync(plaintextPath, "wx", 0o600));
  const source = new DatabaseSync(liveDatabasePath, { readOnly: true });
  const key = readEncryptionKey(input.encryptionKeyFile);
  try {
    await backup(source, plaintextPath);
    chmodSync(plaintextPath, 0o600);
    const database = new DatabaseSync(plaintextPath, { readOnly: true });
    const schema = database.prepare("PRAGMA user_version").get() as { user_version: number };
    const integrity = database.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
    database.close();
    if (integrity.integrity_check !== "ok") throw new Error("backup_integrity_failed");
    const plaintext = readFileSync(plaintextPath);
    try {
      const artifact = encrypt(plaintext, key);
      mkdirSync(resolve(outputPath, ".."), { recursive: true, mode: 0o700 });
      writeFileSync(outputPath, artifact, { mode: 0o600, flag: "wx" });
      chmodSync(outputPath, 0o600);
      return { outputPath, bytes: artifact.length, schemaVersion: schema.user_version };
    } finally {
      plaintext.fill(0);
    }
  } finally {
    key.fill(0);
    source.close();
    removePlaintext(plaintextPath);
  }
}

export function restoreEncryptedLedgerForReview(input: {
  backupPath: string;
  encryptionKeyFile: string;
  reviewRoot: string;
  now?: number;
}): {
  reviewDirectory: string;
  databasePath: string;
  manifestPath: string;
  sourceBackupHash: string;
  gated: Record<string, number>;
} {
  const backupArtifact = readFileSync(resolve(input.backupPath));
  let plaintext: Buffer;
  try {
    const key = readEncryptionKey(input.encryptionKeyFile);
    try {
      plaintext = decrypt(backupArtifact, key);
    } finally {
      key.fill(0);
    }
  } catch (error) {
    backupArtifact.fill(0);
    throw error;
  }
  const now = input.now ?? Date.now();
  const reviewDirectory = join(resolve(input.reviewRoot), `review-${now}-${randomUUID()}`);
  const databaseDirectory = join(reviewDirectory, "collaboration");
  const databasePath = join(databaseDirectory, "collaboration.sqlite");
  try {
    mkdirSync(reviewDirectory, { recursive: true, mode: 0o700 });
    mkdirSync(databaseDirectory, { mode: 0o700 });
    writeFileSync(databasePath, plaintext, { mode: 0o600, flag: "wx" });
    chmodSync(databasePath, 0o600);
  } catch (error) {
    backupArtifact.fill(0);
    rmSync(reviewDirectory, { recursive: true, force: true });
    throw error;
  } finally {
    plaintext.fill(0);
  }

  let database: DatabaseSync;
  try {
    database = new DatabaseSync(databasePath);
  } catch (error) {
    backupArtifact.fill(0);
    rmSync(reviewDirectory, { recursive: true, force: true });
    throw error;
  }
  try {
    const schema = database.prepare("PRAGMA user_version").get() as { user_version: number };
    const integrity = database.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
    if (integrity.integrity_check !== "ok") throw new Error("restore_integrity_failed");
    if (schema.user_version !== COLLABORATION_SCHEMA_VERSION) throw new Error("restore_schema_mismatch");
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("BEGIN IMMEDIATE");
    try {
      const sourceBackupHash = markRestoredLedgerForReview(database, backupArtifact, now);
      const outbox = database
        .prepare(
          "UPDATE collaboration_outbox SET delivery_state = 'dead_letter', dead_lettered_at = ?, " +
            "last_error = 'restore_review_required', claim_owner = NULL, claim_fence = NULL, claim_expires_at = NULL " +
            "WHERE delivery_state IN ('pending', 'claimed')",
        )
        .run(now);
      const runs = database
        .prepare(
          "UPDATE collaboration_runs SET status = 'needs_configuration', recovery_state = 'unsafe_to_retry', " +
            "finished_at = ?, error = 'restore_review_required', version = version + 1 " +
            "WHERE status = 'running'",
        )
        .run(now);
      const nodes = database
        .prepare(
          "UPDATE collaboration_work_nodes SET runtime_state = 'needs_configuration', " +
            "execution_status = 'needs_configuration', lease_owner = NULL, lease_expires_at = NULL, " +
            "version = version + 1 WHERE runtime_state IN ('leased', 'running', 'validating')",
        )
        .run();
      const tokens = database.prepare("DELETE FROM collaboration_action_tokens WHERE consumed_at IS NULL").run();
      database.exec("COMMIT");
      const gated = {
        outbox: Number(outbox.changes),
        runs: Number(runs.changes),
        nodes: Number(nodes.changes),
        actionTokens: Number(tokens.changes),
      };
      const manifestPath = join(reviewDirectory, "RESTORE_REVIEW.json");
      writeFileSync(
        manifestPath,
        JSON.stringify(
          {
            state: "review_required",
            source: basename(input.backupPath),
            sourceBackupHash,
            schemaVersion: schema.user_version,
            gated,
            prohibitions: ["send", "execute", "accept", "merge", "deploy"],
          },
          null,
          2,
        ),
        { mode: 0o600, flag: "wx" },
      );
      return { reviewDirectory, databasePath, manifestPath, sourceBackupHash, gated };
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } catch (error) {
    database.close();
    rmSync(reviewDirectory, { recursive: true, force: true });
    throw error;
  } finally {
    backupArtifact.fill(0);
    try {
      database.close();
    } catch {}
  }
}

function isContained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

export function rearmReviewedLedger(input: {
  reviewRoot: string;
  reviewDatabasePath: string;
  expectedBackupHash: string;
  confirmation: "REARM_REVIEWED_LEDGER";
  localActor: string;
  now?: number;
}): { state: "live"; rearmedAt: number; rearmedBy: string } {
  if (input.confirmation !== "REARM_REVIEWED_LEDGER") throw new Error("restore_rearm_confirmation_required");
  const localActor = input.localActor.trim();
  if (!/^[a-zA-Z0-9_.:@-]{1,128}$/u.test(localActor)) throw new Error("restore_rearm_local_actor_invalid");
  if (!/^[0-9a-f]{64}$/u.test(input.expectedBackupHash)) throw new Error("restore_rearm_backup_hash_invalid");
  const root = realpathSync(resolve(input.reviewRoot));
  const requestedDatabasePath = resolve(input.reviewDatabasePath);
  const requestedDatabaseStat = lstatSync(requestedDatabasePath);
  const databasePath = realpathSync(requestedDatabasePath);
  const reviewDirectory = resolve(databasePath, "../..");
  if (
    !requestedDatabaseStat.isFile() ||
    requestedDatabaseStat.isSymbolicLink() ||
    !isContained(root, databasePath) ||
    basename(databasePath) !== "collaboration.sqlite" ||
    basename(resolve(databasePath, "..")) !== "collaboration" ||
    resolve(reviewDirectory, "collaboration", "collaboration.sqlite") !== databasePath
  ) {
    throw new Error("restore_rearm_requires_isolated_review_database");
  }
  const manifestRaw = readSecureCredentialFile(join(reviewDirectory, "RESTORE_REVIEW.json"));
  try {
    const manifest = JSON.parse(manifestRaw.toString("utf8")) as { state?: unknown; sourceBackupHash?: unknown };
    if (manifest.state !== "review_required" || manifest.sourceBackupHash !== input.expectedBackupHash) {
      throw new Error("restore_rearm_manifest_mismatch");
    }
  } finally {
    manifestRaw.fill(0);
  }
  const database = new DatabaseSync(databasePath);
  const now = input.now ?? Date.now();
  try {
    const integrity = database.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
    if (integrity.integrity_check !== "ok") throw new Error("restore_integrity_failed");
    database.exec("BEGIN IMMEDIATE");
    try {
      const guard = readRestoreGuard(database);
      if (guard.state !== "review_required" || guard.sourceBackupHash !== input.expectedBackupHash) {
        throw new Error("restore_rearm_guard_mismatch");
      }
      const changed = database
        .prepare(
          "UPDATE collaboration_restore_guard SET state = 'live', rearmed_at = ?, rearmed_by = ?, " +
            "version = version + 1 WHERE singleton = 1 AND state = 'review_required' AND source_backup_hash = ?",
        )
        .run(now, localActor, input.expectedBackupHash);
      if (changed.changes !== 1) throw new Error("restore_rearm_transition_failed");
      database.exec("COMMIT");
      return { state: "live", rearmedAt: now, rearmedBy: localActor };
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}
