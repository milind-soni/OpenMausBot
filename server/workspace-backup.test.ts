import { createCipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
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
  json(join(root, "config.json"), { language: "ja", instances: { custom: { driver: "claudeAgent", config: { configDir: join(root, "providers", "account") } } }, apiKey: "private-key-in-config" });
  json(join(root, "bots.json"), [{ id: "bot", threadId: "thread", cwd: join(root, "task-workspaces", "bot", "thread"), soul: `Do not rewrite this prose mentioning ${root}.`, tasks: [{ threadId: "thread", cwd: join(root, "task-workspaces", "bot", "thread") }] }]);
  json(join(root, "groups.json"), [{ id: "room", memberIds: ["bot"], cwd: "/external/project" }]);
  json(join(root, "routines.json"), { version: 1, routines: [{ id: "routine", enabled: true }], runs: [{ id: "waiting", status: "queued" }, { id: "historical", status: "completed" }] });
  json(join(root, "webhooks.json"), { version: 1, webhooks: [{ id: "hook", endpointId: "endpoint", enabled: true, secretHash: "a".repeat(64) }], deliveries: [{ id: "delivery" }] });
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
  db.exec("CREATE TABLE chat_followups(id TEXT PRIMARY KEY, kind TEXT, owner_id TEXT, thread_id TEXT, send_id TEXT, status TEXT, payload TEXT)");
  for (const status of ["pending", "dispatching", "cancelled"]) {
    db.prepare("INSERT INTO chat_followups VALUES (?, 'bot', 'bot', 'thread', ?, ?, ?)").run(status, `send-${status}`, status,
      JSON.stringify({ text: message.text, replyToId: "message", prompt: "Source-only reply context" }));
  }
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
  it("round-trips WAL conversations, binary files, drafts and IDs; preserves destination identity and connections", async () => {
    const source = directory();
    const db = fixture(source);
    // Production closes its sole live message handle after draining writes,
    // while the maintenance gate is held. No server mutation can reopen it.
    db.close();
    try {
      const originalDb = readFileSync(join(source, "messages.db"));
      const exported = await createWorkspaceBackup(source, {
        password: PASSWORD, appVersion: "test",
        clientState: { "omb-drafts": '{"thread":"unsent"}', "omb-draft-attachments": JSON.stringify({ thread: [{ kind: "file", path: join(source, "attachments", "image.png") }] }) },
      });
      expect(exported.summary).toMatchObject({ bots: 1, groups: 1, threads: 1, messages: 1 });
      expect(exported.summary).not.toHaveProperty("includesCredentials");
      const encrypted = readFileSync(exported.path);
      expect(encrypted.includes(Buffer.from("private-secret"))).toBe(false);
      expect(encrypted.includes(Buffer.from("private-key-in-config"))).toBe(false);
      expect(readFileSync(join(source, "messages.db"))).toEqual(originalDb);
      const target = directory();
      const connections = { xai: { key: "destination-key", url: "https://destination.example" }, instances: { local: { driver: "claudeAgent", config: { configDir: join(target, "providers", "local") } } } };
      json(join(target, "config.json"), { ...connections, language: "en" });
      json(join(target, "bots.json"), [{ id: "old" }]);
      json(join(target, "sessions.json"), { identity: "target-session" });
      writeFileSync(join(target, "environment-id"), "target-environment");
      writeFileSync(join(target, "openmausbot-server.lease"), "live-lease");
      writeFileSync(join(target, "messages.db-wal"), "old database WAL must not enter the new DB");
      writeFileSync(join(target, "messages.db-shm"), "old database shared memory");
      const staged = await stageWorkspaceBackup(target, exported.path, { password: PASSWORD });
      expect(staged.summary).toEqual(exported.summary);
      expect(readJson(join(target, "bots.json"))).toEqual([{ id: "old" }]);
      expect(readStagedWorkspaceBackup(target, staged.id)).not.toHaveProperty("credentials");
      const data = join(target, ".backups", staged.id, "staged", "data");
      expect(readJson(join(data, "config.json"))).toEqual({ language: "ja" });
      expect(readJson(join(data, "webhooks.json")).webhooks[0]).not.toHaveProperty("secretHash");
      expect(commitPendingWorkspaceRestore(target, staged.id)).toMatchObject({ id: staged.id, restartRequired: true });
      expect(readPendingWorkspaceRestoreMetadata(target)?.id).toBe(staged.id);
      const result = applyPendingWorkspaceRestore(target);
      expect(result).toMatchObject({ restored: true, id: staged.id });
      expect(readJson(join(target, "bots.json"))[0]).toMatchObject({ id: "bot", cwd: join(target, "task-workspaces", "bot", "thread"), soul: `Do not rewrite this prose mentioning ${source}.` });
      expect(readJson(join(target, "groups.json"))[0].cwd).toBe("/external/project");
      expect(readJson(join(target, "config.json"))).toEqual({ ...connections, language: "ja" });
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
        expect(restoredDb.prepare("SELECT id, status FROM chat_followups ORDER BY rowid").all()).toEqual([
          { id: "pending", status: "interrupted" }, { id: "dispatching", status: "interrupted" }, { id: "cancelled", status: "cancelled" },
        ]);
        const followup = JSON.parse(String(restoredDb.prepare("SELECT payload FROM chat_followups WHERE id = 'pending'").get()!.payload));
        expect(followup).toMatchObject({ replyToId: "message", text: expect.stringContaining(join(target, "attachments", "image.png")) });
        expect(followup).not.toHaveProperty("prompt");
      } finally { restoredDb.close(); }
      expect(readJson(join(target, "routines.json"))).toMatchObject({ routines: [{ enabled: false }], runs: [{ status: "failed" }, { status: "completed" }] });
      expect(readJson(join(target, "webhooks.json"))).toMatchObject({ webhooks: [{ enabled: false }], deliveries: [{ id: "delivery" }] });
      expect(readJson(join(target, "webhooks.json")).webhooks[0].secretHash).toMatch(/^[a-f0-9]{64}$/);
      expect(readJson(join(target, "webhooks.json")).webhooks[0].secretHash).not.toBe("a".repeat(64));
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

  it("also pauses pending chat follow-ups when restoring into the original home", async () => {
    const source = directory();
    fixture(source).close();
    const exported = await createWorkspaceBackup(source, { password: PASSWORD });
    const staged = await stageWorkspaceBackup(source, exported.path, { password: PASSWORD });
    commitPendingWorkspaceRestore(source, staged.id);
    applyPendingWorkspaceRestore(source);
    const db = new DatabaseSync(join(source, "messages.db"), { readOnly: true });
    try {
      expect(db.prepare("SELECT id, status FROM chat_followups ORDER BY rowid").all()).toEqual([
        { id: "pending", status: "interrupted" }, { id: "dispatching", status: "interrupted" }, { id: "cancelled", status: "cancelled" },
      ]);
    } finally { db.close(); }
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

  it("leaves owned authentication stores out of the archive and retains only the destination copies", async () => {
    const source = directory();
    const target = directory();
    const authPaths = [
      "workspace-credentials.json", "browser-engine-key", "config.json.123.tmp",
      "providers/account/auth.json", "providers/antigravity/account/acp_token.json",
      "caddy/data/private.key", "chrome-profile/Cookies", ".agent-browser/auth.json",
      "vm-home/.browser-profiles/chrome/Cookies", "vm-homes/abc/.browser-profiles/chromium/Cookies",
      "tmp/omb-mcp-123/mcp.json", ".tmp/secret",
    ];
    for (const root of [source, target]) {
      for (const path of authPaths) {
        mkdirSync(join(root, path, ".."), { recursive: true });
        writeFileSync(join(root, path), root === source ? "SOURCE_SAVED_SECRET" : "DESTINATION_SAVED_SECRET");
      }
    }
    mkdirSync(join(source, "attachments"));
    writeFileSync(join(source, "attachments", "user-note.txt"), "A user-pasted secret is not silently redacted.");
    writeFileSync(join(source, "vm-home", "project.txt"), "ordinary managed VM file");
    json(join(source, "config.json"), { xai: { key: "SOURCE_SAVED_SECRET", url: "https://source.example" }, language: "ja" });
    json(join(source, "webhooks.json"), { webhooks: [{ id: "same", endpointId: "same-endpoint", secretHash: "a".repeat(64), enabled: true, verificationPending: true }] });
    json(join(target, "config.json"), { xai: { key: "DESTINATION_SAVED_SECRET", url: "https://destination.example" }, language: "en" });
    json(join(target, "webhooks.json"), { webhooks: [{ id: "same", endpointId: "same-endpoint", secretHash: "b".repeat(64) }] });
    const exported = await createWorkspaceBackup(source, { password: PASSWORD });
    const staged = await stageWorkspaceBackup(target, exported.path, { password: PASSWORD });
    const staging = join(target, ".backups", staged.id, "staged");
    const manifest = readJson(join(staging, "manifest.json"));
    expect(manifest).not.toHaveProperty("credentials");
    expect(manifest.summary).not.toHaveProperty("includesCredentials");
    for (const path of authPaths) expect(existsSync(join(staging, "data", path))).toBe(false);
    for (const entry of manifest.entries) if (entry.type === "file") expect(readFileSync(join(staging, "data", entry.path), "utf8")).not.toContain("SOURCE_SAVED_SECRET");
    commitPendingWorkspaceRestore(target, staged.id);
    applyPendingWorkspaceRestore(target);
    for (const path of authPaths) expect(readFileSync(join(target, path), "utf8")).toBe("DESTINATION_SAVED_SECRET");
    expect(readFileSync(join(target, "vm-home", "project.txt"), "utf8")).toBe("ordinary managed VM file");
    expect(readFileSync(join(target, "attachments", "user-note.txt"), "utf8")).toBe("A user-pasted secret is not silently redacted.");
    expect(readJson(join(target, "config.json"))).toEqual({ xai: { key: "DESTINATION_SAVED_SECRET", url: "https://destination.example" }, language: "ja" });
    expect(readJson(join(target, "webhooks.json")).webhooks[0]).toMatchObject({ secretHash: "b".repeat(64), enabled: false, verificationPending: false });
    // Export is read-only: the original login stores and webhook hash remain.
    for (const path of authPaths) expect(readFileSync(join(source, path), "utf8")).toBe("SOURCE_SAVED_SECRET");
    expect(readJson(join(source, "webhooks.json")).webhooks[0].secretHash).toBe("a".repeat(64));
  });

  it("rejects authenticated credential metadata, saved auth paths, and connection-bearing config", async () => {
    const source = directory();
    const exported = await createWorkspaceBackup(source, { password: PASSWORD });
    const staged = await stageWorkspaceBackup(source, exported.path, { password: PASSWORD });
    const base = readJson(join(source, ".backups", staged.id, "staged", "manifest.json"));
    for (const variant of [
      { credentials: { xaiApiKey: "secret" } },
      { summary: { ...base.summary, includesCredentials: false } },
    ]) {
      const path = encryptedPayload(source, Buffer.concat([tarEntry("manifest.json", "File", JSON.stringify({ ...base, ...variant })), tarEntry("data", "Directory"), Buffer.alloc(1024)]));
      await expect(stageWorkspaceBackup(directory(), path, { password: PASSWORD })).rejects.toThrow(/metadata/);
    }
    for (const [name, content] of [
      ["workspace-credentials.json", '{"xaiApiKey":"secret"}'],
      ["Sessions.json", "secret"],
      ["Providers", "secret"],
      ["Caddy", "secret"],
      ["Browser-Engine-Key", "secret"],
      ["vm-home/.Browser-Profiles", "secret"],
      ["vm-homes/bot/.BROWSER-PROFILES", "secret"],
      ["Config.json", '{"xai":{"key":"secret"}}'],
      ["Webhooks.json", '{"webhooks":[{"secretHash":"secret"}]}'],
      ["browser-engine-key", "secret"],
      ["config.json", '{"xai":{"key":"secret","url":"https://source.example"}}'],
      ["config.json", '{"futureAuth":{"field":"secret"}}'],
      ["webhooks.json", '{"webhooks":[{"secretHash":"secret"}]}'],
    ]) {
      const entry = { path: name, type: "file", size: Buffer.byteLength(content), mode: 0o600, sha256: createHash("sha256").update(content).digest("hex") };
      const parents = name.split("/").slice(0, -1).map((_part, index) => name.split("/").slice(0, index + 1).join("/"));
      const manifest = { ...base, entries: [...parents.map((path) => ({ path, type: "directory", size: 0, mode: 0o700 })), entry], summary: { ...base.summary, directories: parents.length, files: 1, bytes: entry.size } };
      const path = encryptedPayload(source, Buffer.concat([tarEntry("manifest.json", "File", JSON.stringify(manifest)), tarEntry("data", "Directory"), ...parents.map((parent) => tarEntry(`data/${parent}`, "Directory")), tarEntry(`data/${name}`, "File", content), Buffer.alloc(1024)]));
      await expect(stageWorkspaceBackup(directory(), path, { password: PASSWORD })).rejects.toThrow(/Unsafe|connection settings|webhook credentials/);
    }
  });

  it("retains differently cased destination auth roots and refuses them in recovery journals", async () => {
    const source = directory();
    const exported = await createWorkspaceBackup(source, { password: PASSWORD });
    const target = directory();
    mkdirSync(join(target, "Providers"));
    writeFileSync(join(target, "Providers", "auth.json"), "destination-login");
    writeFileSync(join(target, "Sessions.json"), "destination-session");
    const staged = await stageWorkspaceBackup(target, exported.path, { password: PASSWORD });
    commitPendingWorkspaceRestore(target, staged.id);
    applyPendingWorkspaceRestore(target);
    expect(readFileSync(join(target, "Providers", "auth.json"), "utf8")).toBe("destination-login");
    expect(readFileSync(join(target, "Sessions.json"), "utf8")).toBe("destination-session");
    json(join(target, ".backups", "restore-journal.json"), { id: staged.id, phase: "applying", existing: [], incoming: ["Sessions.json"] });
    expect(() => applyPendingWorkspaceRestore(target)).toThrow(/recovery paths/);
    expect(readFileSync(join(target, "Sessions.json"), "utf8")).toBe("destination-session");
  });

  it("fails explicitly on noncanonical source auth paths rather than silently skipping them", async () => {
    const source = directory();
    mkdirSync(join(source, "vm-home", ".Browser-Profiles"), { recursive: true });
    writeFileSync(join(source, "vm-home", ".Browser-Profiles", "Cookies"), "source-login");
    await expect(createWorkspaceBackup(source, { password: PASSWORD })).rejects.toThrow(/protected authentication/);
    expect(readFileSync(join(source, "vm-home", ".Browser-Profiles", "Cookies"), "utf8")).toBe("source-login");
  });

  it("refuses registered custom auth homes inside ordinary workspace files before export or restore", async () => {
    const source = directory();
    const config = (field: string) => ({ instances: { custom: { driver: "claudeAgent", ...(field === "configDir" ? { config: { configDir: join(source, "custom-login") } } : { environment: { [field]: join(source, "custom-login") } }) } } });
    mkdirSync(join(source, "custom-login"));
    writeFileSync(join(source, "custom-login", "auth.json"), "registered-source-secret");
    for (const field of ["configDir", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "HOME", "XDG_DATA_HOME"]) {
      json(join(source, "config.json"), config(field));
      await expect(createWorkspaceBackup(source, { password: PASSWORD })).rejects.toThrow(/Provider authentication storage/);
      expect(existsSync(join(source, ".backups"))).toBe(false);
    }
    rmSync(join(source, "custom-login"), { recursive: true });
    json(join(source, "config.json"), { instances: { custom: { driver: "claudeAgent", config: { configDir: join(source, "providers", "custom") } } } });
    const exported = await createWorkspaceBackup(source, { password: PASSWORD });
    const target = directory();
    json(join(target, "config.json"), { instances: { custom: { driver: "claudeAgent", config: { configDir: join(target, "custom-login") } } } });
    mkdirSync(join(target, "custom-login"));
    writeFileSync(join(target, "custom-login", "auth.json"), "registered-destination-secret");
    const staged = await stageWorkspaceBackup(target, exported.path, { password: PASSWORD });
    expect(() => commitPendingWorkspaceRestore(target, staged.id)).toThrow(/Provider authentication storage/);
    expect(readPendingWorkspaceRestoreMetadata(target)).toBeNull();
    expect(readFileSync(join(target, "custom-login", "auth.json"), "utf8")).toBe("registered-destination-secret");
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

  it("validates password strength, client preferences and downgrade compatibility", async () => {
    const root = directory();
    await expect(createWorkspaceBackup(root, { password: "short-password".slice(0, 11) })).rejects.toThrow(/at least 12/);
    await expect(createWorkspaceBackup(root, { password: PASSWORD, clientState: { untrusted: "not an app preference" } })).rejects.toThrow(/preferences/);
    const exported = await createWorkspaceBackup(root, { password: PASSWORD, appVersion: "2.0.0" });
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
