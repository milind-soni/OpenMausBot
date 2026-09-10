import { createCipheriv, randomBytes, scryptSync } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gzipSync } from "node:zlib";
import { Header } from "tar";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyPendingWorkspaceRestore, commitPendingWorkspaceRestore, createWorkspaceBackup,
  readLastWorkspaceRestore, readPendingWorkspaceRestoreMetadata, readStagedWorkspaceBackup,
  removeWorkspaceBackupJob, stageWorkspaceBackup,
} from "./workspace-backup.ts";

const PASSWORD = "correct horse battery staple";
const scratch: string[] = [];
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "omb-workspace-backup-"));
  scratch.push(path);
  return path;
}
function json(path: string, value: unknown): void { writeFileSync(path, JSON.stringify(value)); }
function readJson(path: string): any { return JSON.parse(readFileSync(path, "utf8")); }
function fixture(root: string): DatabaseSync {
  mkdirSync(join(root, "attachments"));
  writeFileSync(join(root, "attachments", "image.png"), Buffer.from([0, 1, 2, 255, 0, 128]));
  mkdirSync(join(root, "task-workspaces", "bot", "thread"), { recursive: true });
  writeFileSync(join(root, "task-workspaces", "bot", "thread", "binary.bin"), Buffer.alloc(2 * 1024 * 1024, 0xa5));
  json(join(root, "config.json"), { instances: { custom: { driver: "claudeAgent", config: { configDir: join(root, "providers", "account") } } }, apiKey: "private-key-in-config" });
  json(join(root, "bots.json"), [{ id: "bot", threadId: "thread", cwd: join(root, "task-workspaces", "bot", "thread"), soul: `Do not rewrite this prose mentioning ${root}.`, tasks: [{ threadId: "thread", cwd: join(root, "task-workspaces", "bot", "thread") }] }]);
  json(join(root, "groups.json"), [{ id: "room", memberIds: ["bot"], cwd: "/external/project" }]);
  json(join(root, "routines.json"), { version: 1, routines: [{ id: "routine", enabled: true }], runs: [{ id: "waiting", status: "queued" }, { id: "historical", status: "completed" }] });
  json(join(root, "webhooks.json"), { version: 1, webhooks: [{ id: "hook", enabled: true }], deliveries: [{ id: "delivery" }] });
  json(join(root, "calendar-calls.json"), { version: 1, calls: [{ id: "call", nextRunAt: 100 }] });
  json(join(root, "delegations.json"), { thread: [{ id: "pending" }] });
  json(join(root, "delegation-receipts.json"), [{ id: "receipt" }]);
  json(join(root, "sessions.json"), { identity: "source-session" });
  writeFileSync(join(root, "environment-id"), "source-environment");
  mkdirSync(join(root, "tools"));
  writeFileSync(join(root, "tools", "downloaded"), "reinstallable");
  const db = new DatabaseSync(join(root, "messages.db"));
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE messages(thread_id TEXT, id TEXT, text TEXT, json TEXT, PRIMARY KEY(thread_id,id)); CREATE TABLE thread_state(thread_id TEXT PRIMARY KEY, active_leaf_id TEXT);");
  const message = {
    id: "message", role: "user", kind: "text", at: 123,
    text: `Keep prose ${root}.\n<attached-image path="${join(root, "attachments", "image.png")}" name="image.png" />\n\n\`\`\`\n<attached-image path="${join(root, "attachments", "image.png")}" />\n\`\`\``,
    attachments: [{ kind: "image", path: join(root, "attachments", "image.png"), mime: "image/png" }],
  };
  db.prepare("INSERT INTO messages VALUES (?, ?, ?, ?)").run("thread", message.id, message.text, JSON.stringify(message));
  db.prepare("INSERT INTO thread_state VALUES (?, ?)").run("thread", "message");
  return db;
}
function encryptedPayload(root: string, plaintext: Buffer): string {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const header = Buffer.concat([Buffer.from("OMB-WORKSPACE-1\n"), salt, iv]);
  const cipher = createCipheriv("aes-256-gcm", scryptSync(PASSWORD, salt, 32, { N: 131_072, r: 8, p: 1, maxmem: 256 * 1024 ** 2 }), iv);
  cipher.setAAD(header);
  const path = join(root, "malicious.ombbackup");
  writeFileSync(path, Buffer.concat([header, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]));
  return path;
}
function tarEntry(path: string, type: "File" | "Directory" | "SymbolicLink" | "Link" | "FIFO" = "File", content = "", size = Buffer.byteLength(content)): Buffer {
  const header = new Header({ path, type, size, mode: 0o600, ...(type === "Link" || type === "SymbolicLink" ? { linkpath: "/outside" } : {}) });
  const block = Buffer.alloc(512);
  header.encode(block);
  const body = Buffer.from(content);
  return Buffer.concat([block, body, Buffer.alloc((512 - body.length % 512) % 512)]);
}
afterEach(() => { for (const root of scratch.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("encrypted full workspace backups", () => {
  it("round-trips WAL conversations, binary files, private metadata and IDs; preserves destination identity", async () => {
    const source = directory();
    const db = fixture(source);
    // Production closes its sole live message handle after draining writes,
    // while the maintenance gate is held. No server mutation can reopen it.
    db.close();
    try {
      const originalDb = readFileSync(join(source, "messages.db"));
      const exported = await createWorkspaceBackup(source, {
        password: PASSWORD, appVersion: "test", credentials: { xaiApiKey: "private-secret" },
        clientState: { "omb-drafts": '{"thread":"unsent"}', "omb-draft-attachments": JSON.stringify({ thread: [{ kind: "file", path: join(source, "attachments", "image.png") }] }) },
      });
      expect(exported.summary).toMatchObject({ bots: 1, groups: 1, threads: 1, messages: 1, includesCredentials: true });
      const encrypted = readFileSync(exported.path);
      expect(encrypted.includes(Buffer.from("private-secret"))).toBe(false);
      expect(encrypted.includes(Buffer.from("private-key-in-config"))).toBe(false);
      expect(readFileSync(join(source, "messages.db"))).toEqual(originalDb);
      const target = directory();
      json(join(target, "bots.json"), [{ id: "old" }]);
      json(join(target, "sessions.json"), { identity: "target-session" });
      writeFileSync(join(target, "environment-id"), "target-environment");
      writeFileSync(join(target, "openmausbot-server.lease"), "live-lease");
      writeFileSync(join(target, "messages.db-wal"), "old database WAL must not enter the new DB");
      writeFileSync(join(target, "messages.db-shm"), "old database shared memory");
      const staged = await stageWorkspaceBackup(target, exported.path, { password: PASSWORD });
      expect(staged.summary).toEqual(exported.summary);
      expect(readJson(join(target, "bots.json"))).toEqual([{ id: "old" }]);
      expect(readStagedWorkspaceBackup(target, staged.id).credentials).toEqual({ xaiApiKey: "private-secret" });
      expect(commitPendingWorkspaceRestore(target, staged.id)).toMatchObject({ id: staged.id, restartRequired: true });
      expect(readPendingWorkspaceRestoreMetadata(target)?.id).toBe(staged.id);
      const result = applyPendingWorkspaceRestore(target);
      expect(result).toMatchObject({ restored: true, id: staged.id });
      expect(readJson(join(target, "bots.json"))[0]).toMatchObject({ id: "bot", cwd: join(target, "task-workspaces", "bot", "thread"), soul: `Do not rewrite this prose mentioning ${source}.` });
      expect(readJson(join(target, "groups.json"))[0].cwd).toBe("/external/project");
      expect(readJson(join(target, "config.json")).instances.custom.config.configDir).toBe(join(target, "providers", "account"));
      expect(readFileSync(join(target, "task-workspaces", "bot", "thread", "binary.bin"))).toEqual(Buffer.alloc(2 * 1024 * 1024, 0xa5));
      expect(readJson(join(target, "sessions.json"))).toEqual({ identity: "target-session" });
      expect(readFileSync(join(target, "environment-id"), "utf8")).toBe("target-environment");
      expect(readFileSync(join(target, "openmausbot-server.lease"), "utf8")).toBe("live-lease");
      expect(existsSync(join(target, "messages.db-wal"))).toBe(false);
      expect(readFileSync(join(result.safetyCopyPath!, "data", "messages.db-wal"), "utf8")).toBe("old database WAL must not enter the new DB");
      expect(existsSync(join(target, "tools"))).toBe(false);
      expect(readJson(join(result.safetyCopyPath!, "data", "bots.json"))).toEqual([{ id: "old" }]);
      const restoredDb = new DatabaseSync(join(target, "messages.db"), { readOnly: true });
      try {
        const row = restoredDb.prepare("SELECT json FROM messages WHERE id='message'").get()!;
        const message = JSON.parse(String(row.json));
        expect(message.attachments[0].path).toBe(join(target, "attachments", "image.png"));
        expect(readFileSync(message.attachments[0].path)).toEqual(Buffer.from([0, 1, 2, 255, 0, 128]));
        expect(message.text).toContain(`Keep prose ${source}.`);
        expect(message.text).toContain(`<attached-image path="${join(target, "attachments", "image.png")}" name="image.png" />`);
        expect(message.text).toContain(`\`\`\`\n<attached-image path="${join(source, "attachments", "image.png")}" />\n\`\`\``);
        expect(restoredDb.prepare("SELECT active_leaf_id FROM thread_state").get()?.active_leaf_id).toBe("message");
      } finally { restoredDb.close(); }
      expect(readJson(join(target, "routines.json"))).toMatchObject({ routines: [{ enabled: false }], runs: [{ status: "failed" }, { status: "completed" }] });
      expect(readJson(join(target, "webhooks.json"))).toMatchObject({ webhooks: [{ enabled: false }], deliveries: [{ id: "delivery" }] });
      expect(readJson(join(target, "calendar-calls.json")).calls[0].nextRunAt).toBeNull();
      expect(readJson(join(target, "delegations.json"))).toEqual({});
      expect(readJson(join(target, "delegation-receipts.json"))).toEqual([{ id: "receipt" }]);
      const receipt = readLastWorkspaceRestore(target)!;
      expect(receipt.id).toBe(staged.id);
      expect(receipt).not.toHaveProperty("credentials");
      expect(JSON.parse(receipt.clientState!["omb-draft-attachments"]).thread[0].path).toBe(join(target, "attachments", "image.png"));
      expect(applyPendingWorkspaceRestore(target)).toEqual({ restored: false });
      if (process.platform !== "win32") {
        expect(statSync(exported.path).mode & 0o777).toBe(0o600);
        expect(statSync(join(target, "attachments", "image.png")).mode & 0o777).toBe(0o600);
      }
    } finally { if (db.isOpen) db.close(); }
  });

  it("authenticates before extraction and leaves the existing workspace unchanged for wrong passwords or damaged ciphertext", async () => {
    const source = directory();
    json(join(source, "bots.json"), []);
    const exported = await createWorkspaceBackup(source, { password: PASSWORD });
    const target = directory();
    writeFileSync(join(target, "untouched"), "original");
    await expect(stageWorkspaceBackup(target, exported.path, { password: "incorrect-password" })).rejects.toThrow(/password is incorrect/);
    expect(readdirSync(join(target, ".backups"))).toEqual([]);
    const corrupted = readFileSync(exported.path);
    corrupted[corrupted.length - 1] ^= 1;
    const path = join(source, "corrupted.ombbackup");
    writeFileSync(path, corrupted);
    await expect(stageWorkspaceBackup(target, path, { password: PASSWORD })).rejects.toThrow(/damaged/);
    expect(readFileSync(join(target, "untouched"), "utf8")).toBe("original");
    expect(readdirSync(join(target, ".backups"))).toEqual([]);
  });

  it.each([
    ["traversal", () => tarEntry("../escape")],
    ["absolute", () => tarEntry("/escape")],
    ["backslash", () => tarEntry("data\\escape")],
    ["symbolic link", () => tarEntry("data/link", "SymbolicLink")],
    ["hard link", () => tarEntry("data/link", "Link")],
    ["special entry", () => tarEntry("data/pipe", "FIFO")],
    ["duplicate", () => Buffer.concat([tarEntry("data/file"), tarEntry("data/file")])],
    ["case collision", () => Buffer.concat([tarEntry("data/FILE"), tarEntry("data/file")])],
    ["gzip payload", () => gzipSync(Buffer.alloc(1024))],
  ] as const)("rejects authenticated hostile archives: %s", async (_name, payload) => {
    const root = directory();
    const path = encryptedPayload(root, Buffer.concat([payload(), Buffer.alloc(1024)]));
    await expect(stageWorkspaceBackup(root, path, { password: PASSWORD })).rejects.toThrow(/unsafe|unsupported entries|Compressed payloads/);
    expect(readdirSync(join(root, ".backups"))).toEqual([]);
  });

  it("refuses external and arbitrary internal symlinks while reporting omitted managed discovery links", async () => {
    const root = directory();
    const outside = directory();
    writeFileSync(join(outside, "secret"), "must never be read");
    symlinkSync(join(outside, "secret"), join(root, "external"));
    await expect(createWorkspaceBackup(root, { password: PASSWORD })).rejects.toThrow(/outside the workspace/);
    rmSync(join(root, "external"));
    writeFileSync(join(root, "regular"), "data");
    symlinkSync(join(root, "regular"), join(root, "internal"));
    await expect(createWorkspaceBackup(root, { password: PASSWORD })).rejects.toThrow(/user-created symbolic link/);
    rmSync(join(root, "internal"));
    const skill = join(root, "workspaces", "bot", "skills", "example");
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, "SKILL.md"), "# Example");
    const native = join(root, "workspaces", "bot", ".claude", "skills");
    mkdirSync(native, { recursive: true });
    symlinkSync(skill, join(native, "example"), process.platform === "win32" ? "junction" : "dir");
    const exported = await createWorkspaceBackup(root, { password: PASSWORD });
    expect(exported.summary.warnings.some((warning) => warning.includes("1 managed skill"))).toBe(true);
  });

  it("rolls back every original entry when credential persistence fails after installation", async () => {
    const source = directory();
    json(join(source, "config.json"), { incoming: true });
    json(join(source, "bots.json"), []);
    const exported = await createWorkspaceBackup(source, { password: PASSWORD });
    const target = directory();
    json(join(target, "config.json"), { original: true });
    writeFileSync(join(target, "original-only"), "keep this");
    const staged = await stageWorkspaceBackup(target, exported.path, { password: PASSWORD });
    commitPendingWorkspaceRestore(target, staged.id);
    expect(() => applyPendingWorkspaceRestore(target, { beforeCommit() {
      json(join(target, "config.json"), { partialCredentialWrite: true });
      json(join(target, "workspace-credentials.json"), { xaiApiKey: "new-key" });
      throw new Error("credential store unavailable");
    } })).toThrow(/previous workspace was recovered/);
    expect(readJson(join(target, "config.json"))).toEqual({ original: true });
    expect(readFileSync(join(target, "original-only"), "utf8")).toBe("keep this");
    expect(existsSync(join(target, "bots.json"))).toBe(false);
    expect(existsSync(join(target, "workspace-credentials.json"))).toBe(false);
    expect(readLastWorkspaceRestore(target)).toBeNull();
    expect(readPendingWorkspaceRestoreMetadata(target)).toBeNull();
  });

  it("recovers an interrupted top-level swap before any application state is loaded", async () => {
    const source = directory();
    json(join(source, "bots.json"), []);
    const exported = await createWorkspaceBackup(source, { password: PASSWORD });
    const target = directory();
    json(join(target, "bots.json"), [{ id: "original" }]);
    const staged = await stageWorkspaceBackup(target, exported.path, { password: PASSWORD });
    commitPendingWorkspaceRestore(target, staged.id);
    const root = join(target, ".backups");
    const apply = join(root, staged.id, "apply", "data");
    cpSync(join(root, staged.id, "staged", "data"), apply, { recursive: true });
    const saved = join(root, `safety-${staged.id}`, "data");
    mkdirSync(saved, { recursive: true });
    json(join(root, "restore-journal.json"), { id: staged.id, phase: "applying", existing: ["bots.json"], incoming: ["bots.json"] });
    renameSync(join(target, "bots.json"), join(saved, "bots.json"));
    renameSync(join(apply, "bots.json"), join(target, "bots.json"));
    expect(applyPendingWorkspaceRestore(target)).toMatchObject({ restored: false, rolledBack: true, id: staged.id });
    expect(readJson(join(target, "bots.json"))).toEqual([{ id: "original" }]);
    expect(applyPendingWorkspaceRestore(target)).toEqual({ restored: false });
  });

  it("detects staged-file tampering before committing or replacing original data", async () => {
    const source = directory();
    json(join(source, "bots.json"), []);
    const exported = await createWorkspaceBackup(source, { password: PASSWORD });
    const target = directory();
    const staged = await stageWorkspaceBackup(target, exported.path, { password: PASSWORD });
    writeFileSync(join(target, ".backups", staged.id, "staged", "data", "bots.json"), "[{}]");
    expect(() => commitPendingWorkspaceRestore(target, staged.id)).toThrow(/match|checksum/);
    expect(readPendingWorkspaceRestoreMetadata(target)).toBeNull();
  });

  it("validates password strength, portable credentials, client preferences and downgrade compatibility", async () => {
    const root = directory();
    await expect(createWorkspaceBackup(root, { password: "short-password".slice(0, 11) })).rejects.toThrow(/at least 12/);
    await expect(createWorkspaceBackup(root, { password: PASSWORD, credentials: { unknownKey: "not allowed" } })).rejects.toThrow(/credentials/);
    await expect(createWorkspaceBackup(root, { password: PASSWORD, clientState: { untrusted: "not an app preference" } })).rejects.toThrow(/preferences/);
    const exported = await createWorkspaceBackup(root, { password: PASSWORD, appVersion: "2.0.0", credentials: { xaiApiKey: "" } });
    expect(exported.summary.includesCredentials).toBe(false);
    await expect(stageWorkspaceBackup(directory(), exported.path, { password: PASSWORD, currentAppVersion: "1.99.99" })).rejects.toThrow(/newer/);
    expect((await stageWorkspaceBackup(directory(), exported.path, { password: PASSWORD, currentAppVersion: "2.0.0" })).summary.appVersion).toBe("2.0.0");
  });

  it("cleans only unreferenced jobs and refuses traversal or pending/last/safety restore jobs", async () => {
    const root = directory();
    const exported = await createWorkspaceBackup(root, { password: PASSWORD });
    const staged = await stageWorkspaceBackup(root, exported.path, { password: PASSWORD });
    removeWorkspaceBackupJob(root, exported.id);
    expect(existsSync(exported.path)).toBe(false);
    expect(() => removeWorkspaceBackupJob(root, "../escape")).toThrow(/identifier/);
    commitPendingWorkspaceRestore(root, staged.id);
    expect(() => removeWorkspaceBackupJob(root, staged.id)).toThrow(/needed/);
    applyPendingWorkspaceRestore(root);
    expect(() => removeWorkspaceBackupJob(root, staged.id)).toThrow(/needed/);
  });
});
