import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  BACKUP_KEY_FIELD,
  createEncryptedBackup,
  ensureBackupEncryptionKey,
  inspectEncryptedBackups,
  normalizeBackupKeep,
  pruneEncryptedBackups,
  restoreEncryptedBackup,
  rollbackEncryptedRestore,
  validateDataRootIntegrity,
  verifyEncryptedBackup,
  writeBackupRecoveryKey,
} from "./encrypted-backup.mjs";

const OFFLINE_RESTORE_COMMAND = path.resolve("scripts/offline-restore.mjs");

function dataRootIdentity(dataDirectory) {
  const resolved = fs.existsSync(dataDirectory) ? fs.realpathSync(dataDirectory) : path.resolve(dataDirectory);
  const normalized = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  return createHash("sha256").update(`openmausbot-data-root-v1\0${normalized}`).digest("hex");
}

function runOfflineRestore(args, environment = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [OFFLINE_RESTORE_COMMAND, ...args], {
      env: { ...process.env, ...environment },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function temporaryRoot(prefix) {
  const base = process.env.OMB_RECOVERY_PROOF_BASE
    ? path.resolve(process.env.OMB_RECOVERY_PROOF_BASE)
    : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, prefix));
}

function traceRecoveryProof(label, payload) {
  if (process.env.OMB_RECOVERY_DRILL_TRACE === "1") {
    console.log(`[recovery-proof:${label}] ${JSON.stringify(payload)}`);
  }
}

test("creates an authenticated backup and verifies every restored byte", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omb-backup-test-"));
  try {
    const data = path.join(root, "data");
    const output = path.join(root, "backups");
    fs.mkdirSync(data);
    fs.writeFileSync(path.join(data, "bots.json"), JSON.stringify({ bots: [{ id: "chief" }] }));
    const db = new DatabaseSync(path.join(data, "capture.db"));
    db.exec("CREATE TABLE events (id TEXT); INSERT INTO events VALUES ('one')");
    db.close();
    const credentials = ensureBackupEncryptionKey({}, () => Buffer.alloc(32, 7));
    const result = createEncryptedBackup({
      dataDirectory: data,
      destinationDirectory: output,
      keyBase64: credentials[BACKUP_KEY_FIELD],
      now: 1_756_000_000_000,
    });
    assert.equal(result.files, 2);
    assert.deepEqual(verifyEncryptedBackup(result.file, credentials[BACKUP_KEY_FIELD]), {
      createdAt: 1_756_000_000_000,
      files: 2,
    });
    const text = fs.readFileSync(result.file, "utf8");
    assert.equal(text.includes("chief"), false);
    assert.throws(() => verifyEncryptedBackup(result.file, Buffer.alloc(32, 8).toString("base64")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("reports the newest backup as verified without exposing its contents", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omb-backup-status-test-"));
  try {
    const data = path.join(root, "data");
    const output = path.join(root, "backups");
    fs.mkdirSync(data);
    fs.writeFileSync(path.join(data, "bots.json"), JSON.stringify({ bots: [{ id: "private-agent" }] }));
    const credentials = ensureBackupEncryptionKey({}, () => Buffer.alloc(32, 4));
    createEncryptedBackup({
      dataDirectory: data,
      destinationDirectory: output,
      keyBase64: credentials[BACKUP_KEY_FIELD],
      now: 1_756_000_000_000,
    });

    const status = inspectEncryptedBackups({
      destinationDirectory: output,
      keyBase64: credentials[BACKUP_KEY_FIELD],
    });
    assert.equal(status.count, 1);
    assert.deepEqual(status.latest && {
      createdAt: status.latest.createdAt,
      files: status.latest.files,
      verified: status.latest.verified,
    }, {
      createdAt: 1_756_000_000_000,
      files: 1,
      verified: true,
    });
    assert.equal(JSON.stringify(status).includes("private-agent"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("exports a validated recovery key file that the offline command can consume", () => {
  const root = temporaryRoot("omb-backup-recovery-key-");
  try {
    const destination = path.join(root, "recovery.key");
    const keyBase64 = Buffer.alloc(32, 17).toString("base64");
    fs.writeFileSync(destination, "replace only after validation");
    assert.equal(writeBackupRecoveryKey(destination, keyBase64), destination);
    assert.equal(fs.readFileSync(destination, "utf8"), `${keyBase64}\n`);
    assert.throws(() => writeBackupRecoveryKey(destination, "not-a-key"), /Backup encryption key is unavailable/);
    assert.equal(fs.readFileSync(destination, "utf8"), `${keyBase64}\n`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("retention accepts a bounded integer and falls back for unsafe values", () => {
  assert.equal(normalizeBackupKeep(30), 30);
  assert.equal(normalizeBackupKeep("7"), 7);
  assert.equal(normalizeBackupKeep(2), 14);
  assert.equal(normalizeBackupKeep(91), 14);
  assert.equal(normalizeBackupKeep("not-a-number"), 14);
});

test("retention pruning removes only extra backup files and keeps unrelated files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omb-backup-prune-test-"));
  try {
    const output = path.join(root, "backups");
    fs.mkdirSync(output);
    for (const stamp of [1, 2, 3, 4]) {
      fs.writeFileSync(path.join(output, `openmausbot-2026-08-26T00-00-0${stamp}.000Z.omb-backup`), "backup");
    }
    fs.writeFileSync(path.join(output, "keep-me.txt"), "unrelated");
    assert.equal(pruneEncryptedBackups(output, 3), 3);
    assert.equal(fs.existsSync(path.join(output, "keep-me.txt")), true);
    assert.equal(fs.readdirSync(output).filter((name) => name.endsWith(".omb-backup")).length, 3);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("authenticated backup creation enforces bounded retention", () => {
  const root = temporaryRoot("omb-backup-create-retention-");
  try {
    const data = path.join(root, "data");
    const output = path.join(root, "backups");
    fs.mkdirSync(data);
    fs.mkdirSync(output);
    fs.writeFileSync(path.join(data, "bots.json"), JSON.stringify({ bots: [{ id: "retained" }] }));
    fs.writeFileSync(path.join(output, "keep-me.txt"), "unrelated");
    const keyBase64 = Buffer.alloc(32, 19).toString("base64");
    for (const now of [1_756_000_000_000, 1_756_000_001_000, 1_756_000_002_000, 1_756_000_003_000]) {
      createEncryptedBackup({ dataDirectory: data, destinationDirectory: output, keyBase64, keep: 3, now });
    }
    const retained = fs.readdirSync(output).filter((name) => name.endsWith(".omb-backup"));
    assert.equal(retained.length, 3);
    for (const name of retained) assert.equal(verifyEncryptedBackup(path.join(output, name), keyBase64).files, 1);
    assert.equal(fs.readFileSync(path.join(output, "keep-me.txt"), "utf8"), "unrelated");
    traceRecoveryProof("retention", {
      syntheticRoot: path.relative(process.cwd(), root),
      retained: retained.sort().map((name) => ({
        name,
        sha256: createHash("sha256").update(fs.readFileSync(path.join(output, name))).digest("hex"),
      })),
      unrelatedFilePreserved: true,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("offline restore validates staged state and preserves a rollback", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omb-backup-restore-drill-"));
  try {
    const source = path.join(root, "source");
    const live = path.join(root, "live");
    const output = path.join(root, "backups");
    fs.mkdirSync(source);
    fs.mkdirSync(live);
    fs.writeFileSync(path.join(source, "bots.json"), JSON.stringify({ bots: [{ id: "chief", version: 2 }] }));
    fs.writeFileSync(path.join(source, "config.json"), JSON.stringify({ profile: { name: "Agent Centipede" } }));
    const sourceDb = new DatabaseSync(path.join(source, "capture.db"));
    sourceDb.exec("CREATE TABLE events (id TEXT); INSERT INTO events VALUES ('verified')");
    sourceDb.close();
    fs.copyFileSync(path.join(source, "bots.json"), path.join(live, "bots.json"));
    fs.copyFileSync(path.join(source, "config.json"), path.join(live, "config.json"));
    fs.writeFileSync(path.join(live, "keep-me.txt"), "unrelated live state");
    const liveDb = new DatabaseSync(path.join(live, "capture.db"));
    liveDb.exec("CREATE TABLE events (id TEXT); INSERT INTO events VALUES ('corruptible')");
    liveDb.close();
    const keyBase64 = ensureBackupEncryptionKey({}, () => Buffer.alloc(32, 3))[BACKUP_KEY_FIELD];
    const backup = createEncryptedBackup({ dataDirectory: source, destinationDirectory: output, keyBase64, now: 1_756_000_000_000 });
    fs.writeFileSync(path.join(live, "bots.json"), JSON.stringify({ corrupt: true }));
    const restored = restoreEncryptedBackup({ backupFile: backup.file, dataDirectory: live, keyBase64, now: 1_756_000_000_001 });
    assert.equal(restored.restored, 3);
    assert.deepEqual(validateDataRootIntegrity(live), { files: 3 });
    assert.equal(fs.readFileSync(path.join(live, "keep-me.txt"), "utf8"), "unrelated live state");
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(live, "bots.json"), "utf8")), { bots: [{ id: "chief", version: 2 }] });
    const rolledBack = rollbackEncryptedRestore({ dataDirectory: live, rollbackDirectory: restored.rollbackDirectory, keyBase64 });
    assert.equal(rolledBack.rolledBack, 3);
    assert.deepEqual(validateDataRootIntegrity(live), { files: 3 });
    assert.equal(fs.readFileSync(path.join(live, "bots.json"), "utf8"), JSON.stringify({ corrupt: true }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("offline restore refuses a live owner before decrypting or mutating", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omb-backup-live-guard-"));
  try {
    const live = path.join(root, "live");
    fs.mkdirSync(live);
    fs.writeFileSync(path.join(live, "bots.json"), JSON.stringify({ before: true }));
    assert.throws(
      () => restoreEncryptedBackup({ backupFile: path.join(root, "missing.omb-backup"), dataDirectory: live, keyBase64: Buffer.alloc(32, 1).toString("base64"), isLiveServer: () => true }),
      /cannot restore while Agent Centipede owns/,
    );
    assert.equal(fs.readFileSync(path.join(live, "bots.json"), "utf8"), JSON.stringify({ before: true }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("offline command authenticates rollback and completes the disposable recovery drill", async () => {
  const root = temporaryRoot("omb-offline-command-drill-");
  const otherOwner = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      app: "openmausbot",
      dataRootIdentity: dataRootIdentity(path.join(root, "different-live-root")),
      pid: process.pid,
      static: true,
    }));
  });
  await new Promise((resolve, reject) => {
    otherOwner.once("error", reject);
    otherOwner.listen(0, "127.0.0.1", resolve);
  });
  try {
    const source = path.join(root, "source");
    const live = path.join(root, "live");
    const output = path.join(root, "backups");
    const keyFile = path.join(root, "backup.key");
    const wrongKeyFile = path.join(root, "wrong.key");
    fs.mkdirSync(source);
    fs.mkdirSync(live);
    fs.writeFileSync(path.join(source, "bots.json"), JSON.stringify({ bots: [{ id: "restored", version: 2 }] }));
    const sourceDb = new DatabaseSync(path.join(source, "capture.db"));
    sourceDb.exec("CREATE TABLE events (id TEXT); INSERT INTO events VALUES ('restored')");
    sourceDb.close();

    const staleBots = JSON.stringify({ bots: [{ id: "stale", version: 1 }] });
    fs.writeFileSync(path.join(live, "bots.json"), staleBots);
    const liveDb = new DatabaseSync(path.join(live, "capture.db"));
    liveDb.exec("CREATE TABLE events (id TEXT); INSERT INTO events VALUES ('stale')");
    liveDb.close();
    fs.writeFileSync(path.join(live, "keep-me.txt"), "unrelated live state");

    const keyBase64 = Buffer.alloc(32, 21).toString("base64");
    writeBackupRecoveryKey(keyFile, keyBase64);
    writeBackupRecoveryKey(wrongKeyFile, Buffer.alloc(32, 22).toString("base64"));
    const backup = createEncryptedBackup({
      dataDirectory: source,
      destinationDirectory: output,
      keyBase64,
      now: 1_756_000_100_000,
    });
    const otherOwnerPort = otherOwner.address()?.port;
    assert(Number.isInteger(otherOwnerPort));
    const commandEnvironment = { OMB_PORT: String(otherOwnerPort) };

    const restore = await runOfflineRestore([
      "restore",
      "--backup", backup.file,
      "--data-dir", live,
      "--key-file", keyFile,
    ], commandEnvironment);
    assert.equal(restore.code, 0, restore.stderr);
    const restoreResult = JSON.parse(restore.stdout);
    assert.equal(restoreResult.command, "restore");
    assert.equal(restoreResult.restored, 2);
    assert.deepEqual(validateDataRootIntegrity(live), { files: 2 });
    assert.equal(JSON.parse(fs.readFileSync(path.join(live, "bots.json"), "utf8")).bots[0].id, "restored");
    assert.equal(fs.readFileSync(path.join(live, "keep-me.txt"), "utf8"), "unrelated live state");
    const restoredBotsSha256 = createHash("sha256").update(fs.readFileSync(path.join(live, "bots.json"))).digest("hex");

    const rollbackDirectory = restoreResult.rollbackDirectory;
    const rollbackManifest = JSON.parse(fs.readFileSync(path.join(rollbackDirectory, "manifest.json"), "utf8"));
    assert.match(rollbackManifest.authentication, /^[a-f0-9]{64}$/);

    const rejectedKey = await runOfflineRestore([
      "rollback",
      "--rollback-dir", rollbackDirectory,
      "--data-dir", live,
      "--key-file", wrongKeyFile,
    ], commandEnvironment);
    assert.equal(rejectedKey.code, 1);
    assert.match(rejectedKey.stderr, /rollback authentication failed/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(live, "bots.json"), "utf8")).bots[0].id, "restored");
    assert.equal(fs.existsSync(rollbackDirectory), true);

    const rollbackBots = path.join(rollbackDirectory, "bots.json");
    const originalRollbackBots = fs.readFileSync(rollbackBots);
    fs.writeFileSync(rollbackBots, JSON.stringify({ bots: [{ id: "tampered" }] }));
    const rejectedTamper = await runOfflineRestore([
      "rollback",
      "--rollback-dir", rollbackDirectory,
      "--data-dir", live,
      "--key-file", keyFile,
    ], commandEnvironment);
    assert.equal(rejectedTamper.code, 1);
    assert.match(rejectedTamper.stderr, /rollback verification failed/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(live, "bots.json"), "utf8")).bots[0].id, "restored");
    assert.equal(fs.existsSync(rollbackDirectory), true);
    fs.writeFileSync(rollbackBots, originalRollbackBots);

    const rollback = await runOfflineRestore([
      "rollback",
      "--rollback-dir", rollbackDirectory,
      "--data-dir", live,
      "--key-file", keyFile,
    ], commandEnvironment);
    assert.equal(rollback.code, 0, rollback.stderr);
    assert.equal(JSON.parse(rollback.stdout).rolledBack, 2);
    assert.equal(fs.readFileSync(path.join(live, "bots.json"), "utf8"), staleBots);
    const restoredDb = new DatabaseSync(path.join(live, "capture.db"), { readOnly: true });
    try {
      assert.equal(restoredDb.prepare("SELECT id FROM events").get().id, "stale");
      assert.equal(Object.values(restoredDb.prepare("PRAGMA integrity_check").get())[0], "ok");
    } finally {
      restoredDb.close();
    }
    assert.equal(fs.readFileSync(path.join(live, "keep-me.txt"), "utf8"), "unrelated live state");
    assert.equal(fs.existsSync(rollbackDirectory), false);
    traceRecoveryProof("drill", {
      syntheticRoot: path.relative(process.cwd(), root),
      dataRoot: path.relative(process.cwd(), live),
      backup: {
        file: path.relative(process.cwd(), backup.file),
        sha256: createHash("sha256").update(fs.readFileSync(backup.file)).digest("hex"),
      },
      restored: { files: 2, botsSha256: restoredBotsSha256, sqliteIntegrity: "ok" },
      rollback: {
        directory: path.relative(process.cwd(), rollbackDirectory),
        wrongKeyRefusedBeforeMutation: true,
        alteredBytesRefusedBeforeMutation: true,
        completed: true,
        botsSha256: createHash("sha256").update(fs.readFileSync(path.join(live, "bots.json"))).digest("hex"),
      },
      differentRootOwnerIgnored: true,
      unrelatedFilePreserved: true,
    });
  } finally {
    await new Promise((resolve) => otherOwner.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("offline command refuses a responding live owner before reading the backup", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omb-offline-command-live-owner-"));
  const live = path.join(root, "live");
  fs.mkdirSync(live);
  fs.writeFileSync(path.join(live, "bots.json"), JSON.stringify({ before: true }));
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      app: "openmausbot",
      dataRootIdentity: dataRootIdentity(live),
      pid: process.pid,
      static: true,
    }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const port = server.address()?.port;
    assert(Number.isInteger(port));
    const result = await runOfflineRestore([
      "restore",
      "--backup", path.join(root, "missing.omb-backup"),
      "--data-dir", live,
      "--key-file", path.join(root, "missing.key"),
    ], { OMB_PORT: String(port) });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /still running/);
    assert.equal(fs.readFileSync(path.join(live, "bots.json"), "utf8"), JSON.stringify({ before: true }));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
