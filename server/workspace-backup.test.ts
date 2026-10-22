import { createCipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createServer as createNetServer } from "node:net";
import { gzipSync } from "node:zlib";
import { Header } from "tar";
import { browserProfilesRoot } from "./browser-engine.ts";
import { openRuntimeStore } from "./runtime/store.ts";
import type { Assignment } from "./runtime/types.ts";
import { SessionRegistry } from "./sessions.ts";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyPendingWorkspaceRestore, commitPendingWorkspaceRestore, createWorkspaceBackup,
  readLastWorkspaceRestore, readPendingWorkspaceRestoreMetadata, readStagedWorkspaceBackup,
  removeWorkspaceBackupJob, stageWorkspaceBackup,
} from "./workspace-backup.ts";

const PASSWORD = "correct horse battery staple";
const AVATAR_BYTES = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const RUNTIME_ROW: Assignment = {
  id: "handoff", rootId: "handoff", depth: 0,
  origin: { kind: "person", source: "chat", quote: "Ship it" },
  requester: { kind: "person", threadId: "thread" },
  assignee: { botId: "bot", destination: { kind: "standing_thread", threadId: "thread" } },
  mode: "work", reply: "resume", brief: "Ship it", status: "completed", outcome: "done", level: "ask", levelSource: "own",
  executions: 1, restarts: 0, createdAt: 1_000, lastActivityAt: 2_000, finishedAt: 2_000, result: "Built", rework: false, version: 1,
};
const RUNTIME_LIVE_ROW: Assignment = {
  ...RUNTIME_ROW, id: "live", rootId: "live", status: "running", executions: 1, restarts: 0, restart: "rerun", result: "",
  question: undefined, createdAt: 3_000, lastActivityAt: 3_000, startedAt: 3_000,
};
delete (RUNTIME_LIVE_ROW as { outcome?: unknown }).outcome;
delete (RUNTIME_LIVE_ROW as { finishedAt?: unknown }).finishedAt;
delete (RUNTIME_LIVE_ROW as { question?: unknown }).question;
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
  writeFileSync(join(root, "attachments", "avatar.png"), AVATAR_BYTES);
  mkdirSync(join(root, "task-workspaces", "bot", "thread"), { recursive: true });
  writeFileSync(join(root, "task-workspaces", "bot", "thread", "binary.bin"), Buffer.alloc(2 * 1024 * 1024, 0xa5));
  json(join(root, "config.json"), { language: "ja", instances: { custom: { driver: "claudeAgent", config: { configDir: join(root, "providers", "account") } } }, apiKey: "private-key-in-config" });
  json(join(root, "bots.json"), [{ id: "bot", threadId: "thread", cwd: join(root, "task-workspaces", "bot", "thread"), soul: `Each morning read ${root}/notes.md.`, avatarUrl: "/api/attachments/avatar.png", avatarCrop: "circle", voice: "source-provider-voice", tasks: [{ threadId: "thread", cwd: join(root, "task-workspaces", "bot", "thread") }] }]);
  json(join(root, "groups.json"), [{ id: "room", memberIds: ["bot"], cwd: "/external/project" }]);
  json(join(root, "routines.json"), { version: 1, routines: [{ id: "routine", enabled: true }], runs: [{ id: "waiting", status: "queued" }, { id: "historical", status: "completed" }] });
  json(join(root, "webhooks.json"), { version: 1, webhooks: [{ id: "hook", endpointId: "endpoint", enabled: true, secretHash: "a".repeat(64), sealedSecret: "sealed-webhook-secret" }], deliveries: [{ id: "delivery" }],
    deleted: [{ at: 1, webhook: { id: "gone", endpointId: "gone-endpoint", secretHash: "c".repeat(64), sealedSecret: "sealed-deleted-secret" } }] });
  json(join(root, "calendar-calls.json"), { version: 1, calls: [{ id: "call", nextRunAt: 100 }] });
  json(join(root, "delegations.json"), { thread: [{ id: "pending" }] });
  const runtime = openRuntimeStore(join(root, "runtime.db"));
  try {
    runtime.insert(RUNTIME_ROW, { kind: "enqueued", at: RUNTIME_ROW.createdAt });
    runtime.insert(RUNTIME_LIVE_ROW, { kind: "started", at: RUNTIME_LIVE_ROW.createdAt });
  } finally { runtime.close(); }
  json(join(root, "delegation-receipts.json"), [{ id: "receipt" }]);
  json(join(root, "sessions.json"), { identity: "source-session" });
  json(join(root, "cloud-owner.json"), { identity: "source-owner-record" });
  writeFileSync(join(root, "environment-id"), "source-environment");
  mkdirSync(join(root, "tools"));
  writeFileSync(join(root, "tools", "downloaded"), "reinstallable");
  mkdirSync(join(root, "decider-log"));
  writeFileSync(join(root, "decider-log", "2026-09.ndjson"), '{"seam":"roomRouting"}\n');
  mkdirSync(join(root, "evidence", "thread", "turn-0001"), { recursive: true });
  writeFileSync(join(root, "evidence", "thread", "turn-0001", "step-000001.jpg"), "a page screenshot");
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
function caseSensitiveTempFolder(): boolean {
  const probe = mkdtempSync(join(tmpdir(), "omb-case-probe-"));
  try {
    writeFileSync(join(probe, "probe"), "");
    return !existsSync(join(probe, "PROBE"));
  } finally { rmSync(probe, { recursive: true, force: true }); }
}
afterEach(() => { for (const root of scratch.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("encrypted full workspace backups", () => {
  it("leaves Sync with My Cloud's own records out of a backup", async () => {
    const source = directory();
    mkdirSync(join(source, "sync", "trash"), { recursive: true });
    writeFileSync(join(source, "sync", "folders.json"), "[]");
    writeFileSync(join(source, "notes.md"), "kept");
    const exported = await createWorkspaceBackup(source, { password: PASSWORD });
    const target = directory();
    const staged = await stageWorkspaceBackup(target, exported.path, { password: PASSWORD });
    const manifest = readJson(join(target, ".backups", staged.id, "staged", "manifest.json"));
    expect(manifest.entries.some((entry: { path: string }) => entry.path === "sync" || entry.path.startsWith("sync/"))).toBe(false);
    expect(manifest.entries.some((entry: { path: string }) => entry.path === "notes.md")).toBe(true);
  });

  it("round-trips WAL conversations, binary files, drafts and IDs; preserves destination identity and connections", async () => {
    const source = directory();
    const db = fixture(source);
    // Production closes its sole message handle after draining writes, while the maintenance gate is held.
    db.close();
    try {
      json(join(source, "team-computers.json"), { version: 1, environmentId: "source-environment", computers: [{ id: "source-computer", name: "Source desktop", section: "Design" }] });
      const originalDb = readFileSync(join(source, "messages.db"));
      const originalRuntimeDb = readFileSync(join(source, "runtime.db"));
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
      expect(readFileSync(join(source, "runtime.db"))).toEqual(originalRuntimeDb);
      const target = directory();
      const connections = { xai: { key: "destination-key", url: "https://destination.example" }, instances: { local: { driver: "claudeAgent", config: { configDir: join(target, "providers", "local") } } } };
      json(join(target, "config.json"), { ...connections, language: "en" });
      json(join(target, "bots.json"), [{ id: "old" }]);
      json(join(target, "sessions.json"), { identity: "target-session" });
      json(join(target, "cloud-owner.json"), { identity: "target-owner-record" });
      const targetComputers = { version: 1, environmentId: "target-environment", computers: [{ id: "target-computer", name: "Destination desktop", section: null }] };
      json(join(target, "team-computers.json"), targetComputers);
      writeFileSync(join(target, "environment-id"), "target-environment");
      writeFileSync(join(target, "openmausbot-server.lease"), "live-lease");
      writeFileSync(join(target, "messages.db-wal"), "old database WAL must not enter the new DB");
      writeFileSync(join(target, "messages.db-shm"), "old database shared memory");
      const staged = await stageWorkspaceBackup(target, exported.path, { password: PASSWORD });
      expect(staged.summary).toEqual(exported.summary);
      expect(readJson(join(target, "bots.json"))).toEqual([{ id: "old" }]);
      expect(readStagedWorkspaceBackup(target, staged.id)).not.toHaveProperty("credentials");
      const data = join(target, ".backups", staged.id, "staged", "data");
      expect(existsSync(join(data, "team-computers.json"))).toBe(false);
      expect(existsSync(join(data, "bots.json"))).toBe(true);
      expect(existsSync(join(data, "runtime.db"))).toBe(true);
      expect(existsSync(join(data, "cloud-owner.json"))).toBe(false);
      expect(readJson(join(data, "config.json"))).toEqual({ language: "ja" });
      expect(readJson(join(data, "webhooks.json")).webhooks[0]).not.toHaveProperty("secretHash");
      expect(readFileSync(join(data, "webhooks.json"), "utf8")).not.toContain("sealed-");
      expect(commitPendingWorkspaceRestore(target, staged.id)).toMatchObject({ id: staged.id, restartRequired: true });
      expect(readPendingWorkspaceRestoreMetadata(target)?.id).toBe(staged.id);
      const result = applyPendingWorkspaceRestore(target);
      expect(result).toMatchObject({ restored: true, id: staged.id });
      const restoredBot = readJson(join(target, "bots.json"))[0];
      expect(restoredBot).toMatchObject({ id: "bot", cwd: join(target, "task-workspaces", "bot", "thread"), soul: `Each morning read ${join(target, "notes.md")}.`, avatarUrl: "/api/attachments/avatar.png", avatarCrop: "circle" });
      expect(restoredBot).not.toHaveProperty("voice");
      expect(readFileSync(join(target, restoredBot.avatarUrl.slice("/api/".length)))).toEqual(AVATAR_BYTES);
      expect(readJson(join(target, "groups.json"))[0].cwd).toBe("/external/project");
      expect(readJson(join(target, "config.json"))).toEqual({ ...connections, language: "ja" });
      expect(readFileSync(join(target, "task-workspaces", "bot", "thread", "binary.bin"))).toEqual(Buffer.alloc(2 * 1024 * 1024, 0xa5));
      expect(readJson(join(target, "sessions.json"))).toEqual({ identity: "target-session" });
      expect(readJson(join(target, "cloud-owner.json"))).toEqual({ identity: "target-owner-record" });
      expect(readJson(join(target, "team-computers.json"))).toEqual(targetComputers);
      expect(readFileSync(join(target, "environment-id"), "utf8")).toBe("target-environment");
      expect(readFileSync(join(target, "openmausbot-server.lease"), "utf8")).toBe("live-lease");
      expect(existsSync(join(target, "messages.db-wal"))).toBe(false);
      expect(readFileSync(join(result.safetyCopyPath!, "data", "messages.db-wal"), "utf8")).toBe("old database WAL must not enter the new DB");
      expect(existsSync(join(target, "tools"))).toBe(false);
      expect(existsSync(join(target, "decider-log"))).toBe(false);
      expect(existsSync(join(target, "evidence"))).toBe(false);
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
      expect(existsSync(join(target, "runtime.db-wal"))).toBe(false);
      const restoredRuntime = new DatabaseSync(join(target, "runtime.db"), { readOnly: true });
      try {
        const rows = restoredRuntime.prepare("SELECT json FROM assignments ORDER BY created_at").all().map((row) => JSON.parse(String(row.json)));
        expect(rows[0]).toEqual(RUNTIME_ROW);
        expect(rows[1]).toMatchObject({ id: "live", status: "failed", outcome: "interrupted", result: "Not resumed after workspace restore." });
        expect(rows[1]).not.toHaveProperty("restart");
        expect(restoredRuntime.prepare("SELECT status FROM assignments WHERE id = 'live'").get()).toEqual({ status: "failed" });
        expect(restoredRuntime.prepare("SELECT kind FROM assignment_events ORDER BY id").all().map((row) => row.kind)).toEqual(["enqueued", "started", "settled"]);
      } finally { restoredRuntime.close(); }
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

  // A Windows PC moves to a Linux Cloud; restored on Windows, its paths are this computer's own and are kept.
  it.skipIf(process.platform === "win32")("brings a Windows computer's data folder over wherever it is written, and clears and lists the folders and files left on that PC", async () => {
    const source = directory();
    const windows = "C:\\Users\\Ada\\.openmausbot", site = "C:\\Users\\Ada\\Projects\\site";
    const soul = `Read ${windows}\\files\\brief.md before you start.`;
    json(join(source, "bots.json"), [
      { id: "bot", threadId: "thread", cwd: site, soul, tasks: [
        { threadId: "thread", cwd: "c:\\users\\ada\\.openmausbot\\task-workspaces\\bot\\thread", resumeCursors: { claude: "kept" } },
        { threadId: "other", cwd: site, resumeCursors: { claude: "only-on-that-pc" } },
      ] },
      { id: "helper", threadId: "helper-thread", soul: "No paths here.", tasks: [{ threadId: "helper-thread", cwd: null }] },
    ]);
    json(join(source, "groups.json"), [{ id: "room", memberIds: ["bot"], cwd: "C:\\Users\\Ada\\Shared", bulletin: `Shared notes live in ${windows}\\files.` }]);
    const prompt = `Each morning read ${windows}\\files\\brief.md, compare it with C:\\Users\\Ada\\Desktop\\x.docx, and save ${windows}\\files\\out\\report.md.`;
    json(join(source, "routines.json"), { version: 1, routines: [{ id: "routine", botId: "bot", enabled: true, prompt }], runs: [] });
    mkdirSync(join(source, "workspaces", "bot", "memory"), { recursive: true });
    writeFileSync(join(source, "workspaces", "bot", "MEMORY.md"),
      "- The brief: c:\\users\\ada\\.openmausbot\\files\\brief.md\n- Drafts go to C:/Users/Ada/.openmausbot/files/drafts/\n- C:\\Users\\Ada\\.openmausbot-old\\notes.md is an old copy\n");
    writeFileSync(join(source, "workspaces", "bot", "memory", "people.md"), "Ada prefers short replies.\n");
    mkdirSync(join(source, "bots", "bot"), { recursive: true });
    writeFileSync(join(source, "bots", "bot", "SOUL.md"), soul);
    const exported = await createWorkspaceBackup(source, { password: PASSWORD });
    const target = directory();
    const staged = await stageWorkspaceBackup(target, exported.path, { password: PASSWORD });
    const manifest = join(target, ".backups", staged.id, "staged", "manifest.json");
    json(manifest, { ...readJson(manifest), sourceDataDir: windows });
    commitPendingWorkspaceRestore(target, staged.id);
    const result = applyPendingWorkspaceRestore(target);

    const [bot, helper] = readJson(join(target, "bots.json"));
    expect(bot).not.toHaveProperty("cwd");
    expect(bot.soul).toBe(`Read ${target}/files/brief.md before you start.`);
    expect(bot.tasks).toEqual([
      { threadId: "thread", cwd: join(target, "task-workspaces", "bot", "thread"), resumeCursors: { claude: "kept" } },
      { threadId: "other", resumeCursors: {} },
    ]);
    expect(helper).toEqual({ id: "helper", threadId: "helper-thread", soul: "No paths here.", tasks: [{ threadId: "helper-thread", cwd: null }] });
    expect(readJson(join(target, "groups.json"))).toEqual([{ id: "room", memberIds: ["bot"], bulletin: `Shared notes live in ${target}/files.` }]);
    expect(readJson(join(target, "routines.json")).routines[0].prompt)
      .toBe(`Each morning read ${target}/files/brief.md, compare it with C:\\Users\\Ada\\Desktop\\x.docx, and save ${target}/files/out/report.md.`);
    expect(readFileSync(join(target, "workspaces", "bot", "MEMORY.md"), "utf8"))
      .toBe(`- The brief: ${target}/files/brief.md\n- Drafts go to ${target}/files/drafts/\n- C:\\Users\\Ada\\.openmausbot-old\\notes.md is an old copy\n`);
    expect(readFileSync(join(target, "workspaces", "bot", "memory", "people.md"), "utf8")).toBe("Ada prefers short replies.\n");
    expect(readFileSync(join(target, "bots", "bot", "SOUL.md"), "utf8")).toBe(bot.soul);
    const leftBehind = { bots: 1, paths: [site, "C:\\Users\\Ada\\Shared", "C:\\Users\\Ada\\.openmausbot-old\\notes.md", "C:\\Users\\Ada\\Desktop\\x.docx"] };
    expect(result.leftBehind).toEqual(leftBehind);
    expect(readLastWorkspaceRestore(target)!.leftBehind).toEqual(leftBehind);
    expect(readLastWorkspaceRestore(target)!.pathsRewritten).toBe(true);
  });

  it("lists nothing left behind, and keeps outside folders, when both computers write paths the same way", async () => {
    const source = directory();
    fixture(source).close();
    const exported = await createWorkspaceBackup(source, { password: PASSWORD });
    const target = directory();
    const staged = await stageWorkspaceBackup(target, exported.path, { password: PASSWORD });
    commitPendingWorkspaceRestore(target, staged.id);
    expect(applyPendingWorkspaceRestore(target)).not.toHaveProperty("leftBehind");
    expect(readJson(join(target, "groups.json"))[0].cwd).toBe("/external/project");
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
      "external-runtimes.json", "external-runtimes.json.123.tmp",
      "providers/account/auth.json", "providers/antigravity/account/acp_token.json",
      "caddy/data/private.key", "chrome-profile/Cookies", ".agent-browser/auth.json",
      `${basename(browserProfilesRoot())}/0123456789abcdef/Default/Cookies`,
      "vm-home/.browser-profiles/chrome/Cookies", "vm-homes/abc/.browser-profiles/chromium/Cookies",
      "tmp/omb-mcp-123/mcp.json", ".tmp/secret",
      "logins.json.enc", "logins-key", "logins.json.enc.123.05a7b3e0-1234.tmp",
      "highlevel.json.enc", "highlevel-key", "connected-apps-installation.json", "webhook-key",
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
    json(join(source, "webhooks.json"), { webhooks: [{ id: "same", endpointId: "same-endpoint", secretHash: "a".repeat(64), sealedSecret: "SOURCE_SAVED_SECRET", enabled: true, verificationPending: true }] });
    json(join(target, "config.json"), { xai: { key: "DESTINATION_SAVED_SECRET", url: "https://destination.example" }, language: "en" });
    json(join(target, "webhooks.json"), { webhooks: [{ id: "same", endpointId: "same-endpoint", secretHash: "b".repeat(64), sealedSecret: "DESTINATION_SEALED" }] });
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
    expect(readJson(join(target, "webhooks.json")).webhooks[0]).toMatchObject({ secretHash: "b".repeat(64), sealedSecret: "DESTINATION_SEALED", enabled: false, verificationPending: false });
    for (const path of authPaths) expect(readFileSync(join(source, path), "utf8")).toBe("SOURCE_SAVED_SECRET");
    expect(readJson(join(source, "webhooks.json")).webhooks[0].secretHash).toBe("a".repeat(64));
  });

  it("never lists a per-turn hook token directory in a backup manifest", async () => {
    const source = directory();
    mkdirSync(join(source, "hook-tokens"), { mode: 0o700 });
    writeFileSync(join(source, "hook-tokens", `${"a".repeat(24)}.token`), "SOURCE_TURN_BEARER", { mode: 0o600 });
    mkdirSync(join(source, "attachments"));
    writeFileSync(join(source, "attachments", "note.txt"), "ordinary user file");
    const exported = await createWorkspaceBackup(source, { password: PASSWORD });
    const staged = await stageWorkspaceBackup(source, exported.path, { password: PASSWORD });
    const staging = join(source, ".backups", staged.id, "staged");
    const paths: string[] = readJson(join(staging, "manifest.json")).entries.map((entry: { path: string }) => entry.path);
    expect(paths).toContain("attachments/note.txt");
    expect(paths.filter((path) => /token/i.test(path))).toEqual([]);
    expect(existsSync(join(staging, "data", "hook-tokens"))).toBe(false);
    for (const path of paths) {
      if (statSync(join(staging, "data", path)).isFile()) expect(readFileSync(join(staging, "data", path), "utf8")).not.toContain("SOURCE_TURN_BEARER");
    }
  });

  it("leaves the bot box's live sockets and filter out, so a Cloud home with the box on can still be backed up and brought home", async () => {
    // Seen in the real app on Oct 22: a Cloud that ended could not bring its chats home, because its export stopped at
    // "Cannot back up special or live runtime file: box/broker.sock" (the T0 credential broker's socket).
    const source = directory();
    mkdirSync(join(source, "box"), { mode: 0o700 });
    writeFileSync(join(source, "box", "seccomp.bpf"), Buffer.from([0x20, 0, 0, 0]), { mode: 0o600 });
    // The live socket is the Linux box's (a Cloud home): Windows refuses a unix socket at a file path, so there the
    // folder holds only the filter, and must still be left out.
    const broker = process.platform === "win32" ? null : createNetServer();
    if (broker) await new Promise<void>((resolve) => broker.listen(join(source, "box", "broker.sock"), resolve));
    try {
      mkdirSync(join(source, "attachments"));
      writeFileSync(join(source, "attachments", "note.txt"), "ordinary user file");
      const exported = await createWorkspaceBackup(source, { password: PASSWORD });
      const staged = await stageWorkspaceBackup(source, exported.path, { password: PASSWORD });
      const paths: string[] = readJson(join(source, ".backups", staged.id, "staged", "manifest.json")).entries.map((entry: { path: string }) => entry.path);
      expect(paths).toContain("attachments/note.txt");
      expect(paths.filter((path) => path === "box" || path.startsWith("box/"))).toEqual([]);
    } finally { if (broker) await new Promise<void>((resolve) => broker.close(() => resolve())); }
  });

  it("leaves the Organization library's downloaded catalog and release files out, and keeps what the runtime added", async () => {
    const source = directory(), library = join(source, "org-library"), sha = "b".repeat(64);
    mkdirSync(join(library, "blobs"), { recursive: true, mode: 0o700 });
    json(join(library, "state.json"), { version: 1, source: null, appliedDigest: null, installs: {} });
    json(join(library, "presets.json"), { version: 1, presets: [] });
    writeFileSync(join(library, "catalog.json"), "ORGANIZATION_CATALOG_BYTES", { mode: 0o600 });
    writeFileSync(join(library, `catalog.json.${"0".repeat(8)}-0000-4000-8000-${"0".repeat(12)}.tmp`), "ORGANIZATION_CATALOG_BYTES", { mode: 0o600 });
    writeFileSync(join(library, "blobs", `${sha}.json`), "ORGANIZATION_RELEASE_BYTES", { mode: 0o600 });
    const exported = await createWorkspaceBackup(source, { password: PASSWORD });
    const staged = await stageWorkspaceBackup(source, exported.path, { password: PASSWORD });
    const staging = join(source, ".backups", staged.id, "staged");
    const paths: string[] = readJson(join(staging, "manifest.json")).entries.map((entry: { path: string }) => entry.path);
    expect(paths.filter((path) => path.startsWith("org-library"))).toEqual(["org-library", "org-library/presets.json", "org-library/state.json"]);
    expect(existsSync(join(staging, "data", "org-library", "blobs"))).toBe(false);
    for (const path of paths) {
      if (statSync(join(staging, "data", path)).isFile()) expect(readFileSync(join(staging, "data", path), "utf8")).not.toMatch(/ORGANIZATION_(?:CATALOG|RELEASE)_BYTES/);
    }
  });

  it("leaves the destination's session open-marker in place, so a crash before a restore still ends account sign-ins", async () => {
    const source = directory(), target = directory();
    json(join(source, "bots.json"), [{ id: "bot" }]);
    writeFileSync(join(source, "sessions.json.open"), "Session registry is open.\n");
    const exported = await createWorkspaceBackup(source, { password: PASSWORD });
    const sessions = new SessionRegistry({ file: join(target, "sessions.json") });
    sessions.issue({ label: "Member", scopes: ["client"], userId: "user-1" });
    expect(existsSync(join(target, "sessions.json.open"))).toBe(true);
    const staged = await stageWorkspaceBackup(target, exported.path, { password: PASSWORD });
    expect(readJson(join(target, ".backups", staged.id, "staged", "manifest.json")).entries.map((entry: { path: string }) => entry.path)).not.toContain("sessions.json.open");
    commitPendingWorkspaceRestore(target, staged.id);
    expect(applyPendingWorkspaceRestore(target)).toMatchObject({ restored: true });
    expect(existsSync(join(target, "sessions.json.open"))).toBe(true);
    expect(existsSync(join(target, ".backups", `safety-${staged.id}`, "data", "sessions.json.open"))).toBe(false);
    expect(new SessionRegistry({ file: join(target, "sessions.json") }).list()).toEqual([]);
  });

  it("never lets tar decompress a payload: zstd is refused like gzip", async () => {
    const root = directory();
    const archive = encryptedPayload(root, Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), Buffer.alloc(1020)]));
    await expect(stageWorkspaceBackup(directory(), archive, { password: PASSWORD })).rejects.toThrow(/Compressed payloads are not supported/);
  });

  it("still restores an archive from a release that exported hook tokens, without installing them", async () => {
    const source = directory();
    const exported = await createWorkspaceBackup(source, { password: PASSWORD });
    const probe = await stageWorkspaceBackup(source, exported.path, { password: PASSWORD });
    const base = readJson(join(source, ".backups", probe.id, "staged", "manifest.json"));
    const token = "STALE_TURN_BEARER";
    const note = "kept";
    const file = (path: string, content: string) => ({ path, type: "file", size: Buffer.byteLength(content), mode: 0o600, sha256: createHash("sha256").update(content).digest("hex") });
    const manifest = {
      ...base,
      entries: [{ path: "hook-tokens", type: "directory", size: 0, mode: 0o700 }, file("hook-tokens/old.token", token), file("note.txt", note)],
      summary: { ...base.summary, directories: 1, files: 2, bytes: Buffer.byteLength(token) + Buffer.byteLength(note) },
    };
    const archive = encryptedPayload(source, Buffer.concat([
      tarEntry("manifest.json", "File", JSON.stringify(manifest)), tarEntry("data", "Directory"), tarEntry("data/hook-tokens", "Directory"),
      tarEntry("data/hook-tokens/old.token", "File", token), tarEntry("data/note.txt", "File", note), Buffer.alloc(1024),
    ]));
    const target = directory();
    const staged = await stageWorkspaceBackup(target, archive, { password: PASSWORD });
    commitPendingWorkspaceRestore(target, staged.id);
    expect(applyPendingWorkspaceRestore(target)).toMatchObject({ restored: true });
    expect(readFileSync(join(target, "note.txt"), "utf8")).toBe(note);
    expect(existsSync(join(target, "hook-tokens"))).toBe(false);
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
      ["team-computers.json", '{"computers":[{"id":"foreign-computer","section":"Design"}]}'],
      ["workspace-credentials.json", '{"xaiApiKey":"secret"}'],
      ["external-runtimes.json", '{"bot-id":"external-runtime-secret"}'],
      ["External-Runtimes.json", "external-runtime-secret"],
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
      ["webhooks.json", '{"webhooks":[{"sealedSecret":"secret"}]}'],
      ["webhooks.json", '{"webhooks":[],"deleted":[{"at":1,"webhook":{"sealedSecret":"secret"}}]}'],
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

  it.skipIf(process.platform === "win32").each([
    ["notes/report-2026-10-16T04:00:00Z.md", "notes/report-2026-10-16T04:00:00Z.md"],
    ["repo/aux/readme.txt", "repo/aux"],
  ])("names the work file %s that Windows cannot restore, instead of failing anonymously (Windows cannot create it)", async (file, named) => {
    const root = directory();
    const work = join(root, "task-workspaces", "bot", "thread");
    mkdirSync(join(work, file, ".."), { recursive: true });
    writeFileSync(join(work, file), "x");
    await expect(createWorkspaceBackup(root, { password: PASSWORD })).rejects.toThrow(`task-workspaces/bot/thread/${named}`);
    expect(readdirSync(join(root, ".backups"))).toEqual([]);
    rmSync(join(work, file));
    rmSync(join(work, named), { recursive: true, force: true });
    writeFileSync(join(work, "report.md"), "x");
    expect((await createWorkspaceBackup(root, { password: PASSWORD })).summary.files).toBeGreaterThan(0);
  });

  it.skipIf(!caseSensitiveTempFolder())("names both work files whose names differ only by letter case (needs a case-sensitive file system)", async () => {
    const root = directory();
    const repo = join(root, "task-workspaces", "bot", "thread", "repo");
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "README.md"), "upper");
    writeFileSync(join(repo, "readme.md"), "lower");
    const failure = createWorkspaceBackup(root, { password: PASSWORD });
    await expect(failure).rejects.toThrow("task-workspaces/bot/thread/repo/README.md");
    await expect(failure).rejects.toThrow("task-workspaces/bot/thread/repo/readme.md");
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

  it("leaves out node_modules and links in conversation work folders, and says so", async () => {
    const root = directory();
    const outside = directory();
    writeFileSync(join(outside, "secret"), "must never be read");
    const work = join(root, "task-workspaces", "bot", "thread");
    mkdirSync(work, { recursive: true });
    writeFileSync(join(work, "app.js"), "console.log(1)");
    symlinkSync(outside, join(work, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    symlinkSync(join(outside, "secret"), join(work, "linked-secret"));
    const installed = join(root, "workspaces", "bot", "project", "node_modules", "left-pad");
    mkdirSync(installed, { recursive: true });
    writeFileSync(join(installed, "index.js"), "module.exports = 1");
    const exported = await createWorkspaceBackup(root, { password: PASSWORD });
    expect(exported.summary.warnings.some((warning) => warning.startsWith("2 installed dependency folder(s) (node_modules)"))).toBe(true);
    expect(exported.summary.warnings.some((warning) => warning.startsWith("1 symbolic link(s) in conversation work folders"))).toBe(true);
    const target = directory();
    const staged = await stageWorkspaceBackup(target, exported.path, { password: PASSWORD });
    const data = join(target, ".backups", staged.id, "staged", "data");
    expect(readFileSync(join(data, "task-workspaces", "bot", "thread", "app.js"), "utf8")).toBe("console.log(1)");
    expect(existsSync(join(data, "task-workspaces", "bot", "thread", "node_modules"))).toBe(false);
    expect(existsSync(join(data, "task-workspaces", "bot", "thread", "linked-secret"))).toBe(false);
    expect(existsSync(join(data, "workspaces", "bot", "project", "node_modules"))).toBe(false);
    symlinkSync(join(outside, "secret"), join(root, "workspaces", "bot", "external"));
    await expect(createWorkspaceBackup(root, { password: PASSWORD })).rejects.toThrow(/outside the workspace/);
  });

  it("counts the app's skill links in work folders as managed, not as outside data", async () => {
    const root = directory();
    const outside = directory();
    const skill = join(root, "workspaces", "bot", "skills", "example");
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, "SKILL.md"), "# Example");
    const kind = process.platform === "win32" ? "junction" : "dir";
    for (const family of [".claude", ".agents", ".grok"]) {
      const native = join(root, "task-workspaces", "bot", "thread", family, "skills");
      mkdirSync(native, { recursive: true });
      symlinkSync(skill, join(native, "example"), kind);
    }
    // Same place and name, but another bot's store or outside: an agent's link.
    mkdirSync(join(root, "workspaces", "other", "skills", "theirs"), { recursive: true });
    symlinkSync(join(root, "workspaces", "other", "skills", "theirs"), join(root, "task-workspaces", "bot", "thread", ".claude", "skills", "theirs"), kind);
    symlinkSync(outside, join(root, "task-workspaces", "bot", "thread", ".agents", "skills", "away"), kind);
    const exported = await createWorkspaceBackup(root, { password: PASSWORD });
    expect(exported.summary.warnings.some((warning) => warning.startsWith("3 managed skill discovery link(s)"))).toBe(true);
    expect(exported.summary.warnings.some((warning) => warning.startsWith("2 symbolic link(s) in conversation work folders"))).toBe(true);
  });

  it("leaves out the link to the person's own Claude Code skills, which the app makes again on each turn", async () => {
    const root = directory();
    const outside = directory();
    writeFileSync(join(outside, "SKILL.md"), "the person's own skill");
    mkdirSync(join(root, "claude-user-skills", ".claude"), { recursive: true });
    symlinkSync(outside, join(root, "claude-user-skills", ".claude", "skills"), process.platform === "win32" ? "junction" : "dir");
    json(join(root, "bots.json"), []);
    const exported = await createWorkspaceBackup(root, { password: PASSWORD });
    const target = directory();
    const staged = await stageWorkspaceBackup(target, exported.path, { password: PASSWORD });
    expect(existsSync(join(target, ".backups", staged.id, "staged", "data", "claude-user-skills"))).toBe(false);
  });

  it("carries the skills brought in from this computer, and counts task folder links to them as the app's", async () => {
    const root = directory();
    const copy = join(root, "imported-skills", "pdf");
    mkdirSync(join(copy, "scripts"), { recursive: true });
    // Read-only as the app writes them; on Windows it keeps them writable.
    const readOnly = (mode: number) => (process.platform === "win32" ? {} : { mode });
    writeFileSync(join(copy, "SKILL.md"), "# pdf", readOnly(0o400));
    writeFileSync(join(copy, "scripts", "run.sh"), "echo run\n", readOnly(0o500));
    const kind = process.platform === "win32" ? "junction" : "dir";
    const task = join(root, "task-workspaces", "bot", "thread");
    for (const family of [".claude", ".agents", ".grok"]) mkdirSync(join(task, family, "skills"), { recursive: true });
    symlinkSync(copy, join(task, ".claude", "skills", "pdf"), kind);
    symlinkSync(copy, join(task, ".agents", "skills", "pdf"), kind);
    // Under another name it is not the app's link.
    symlinkSync(copy, join(task, ".grok", "skills", "renamed"), kind);
    const exported = await createWorkspaceBackup(root, { password: PASSWORD });
    expect(exported.summary.warnings.some((warning) => warning.startsWith("2 managed skill discovery link(s)"))).toBe(true);
    expect(exported.summary.warnings.some((warning) => warning.startsWith("1 symbolic link(s) in conversation work folders"))).toBe(true);
    const target = directory();
    const staged = await stageWorkspaceBackup(target, exported.path, { password: PASSWORD });
    const data = join(target, ".backups", staged.id, "staged", "data");
    expect(readFileSync(join(data, "imported-skills", "pdf", "scripts", "run.sh"), "utf8")).toBe("echo run\n");
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
