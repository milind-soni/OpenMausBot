// Owns two disposable fake-engine workspaces; accepts no live URL or home.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launchVerificationServer, runControlOmb, type VerificationServer } from "./control-omb.ts";
import { waitForExit } from "../server/testing/cleanup.ts";
import { escapeAttribute } from "../src/lib/composer-attachments.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PASSWORD = "fixture-backup-password-only";

/** Same temporary home and exact port, but a new process. The launcher's
 * close() still owns cleanup; stop this replacement before calling it. */
async function restartFixture(fixture: VerificationServer): Promise<ChildProcess> {
  await waitForExit(fixture.child, { signal: "SIGTERM" });
  const dataDir = fixture.info.dataDir;
  const config = JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8"));
  assert.equal(resolve(config.instances.claude.config.cli), join(ROOT, "server", "testing", "fake-claude-cli.ts"));
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "LANG", "LC_ALL", "TZ"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  const temp = join(dataDir, "tmp");
  const home = join(dataDir, "providers", "fixture-home");
  mkdirSync(temp, { recursive: true });
  mkdirSync(home, { recursive: true });
  Object.assign(env, {
    HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"), XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"), XDG_DATA_HOME: join(home, ".local", "share"),
    TEMP: temp, TMP: temp, TMPDIR: temp, HERMES_HOME: join(home, ".hermes"),
    OMB_DATA_DIR: dataDir, OMB_PORT: new URL(fixture.info.url).port,
    OMB_WEBHOOK_PORT: String(Number(new URL(fixture.info.url).port) + 1),
    FAKE_CLAUDE_MODE: "happy", FAKE_CLAUDE_DUMP: fixture.fixtureDumpPath,
    PATH: dirname(process.execPath),
  });
  const log = openSync(fixture.info.logPath, "a", 0o600);
  const child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "server", "index.ts")], {
    cwd: ROOT, env, stdio: ["ignore", log, log],
  });
  closeSync(log);
  try {
    const deadline = Date.now() + 30_000;
    for (;;) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Restored fixture exited; see ${fixture.info.logPath}`);
      try {
        const response = await fetch(`${fixture.info.url}/api/health`, { signal: AbortSignal.timeout(1_000) });
        const health = await response.json() as { app?: string; pid?: number };
        if (response.ok && health.app === "openmausbot" && health.pid === child.pid) return child;
      } catch { /* Only this owned child can satisfy the PID handshake. */ }
      if (Date.now() >= deadline) throw new Error(`Restored fixture did not start; see ${fixture.info.logPath}`);
      await new Promise((done) => setTimeout(done, 100));
    }
  } catch (error) {
    await waitForExit(child, { signal: "SIGTERM" });
    throw error;
  }
}

async function launchBackupFixture(): Promise<VerificationServer> {
  const fixture = await launchVerificationServer({});
  try {
    // The general fixture uses DATA_DIR as HOME. Backups intentionally reject
    // auth homes among portable files, so keep this fixture's home excluded.
    const child = await restartFixture(fixture);
    return { ...fixture, child, info: { ...fixture.info, pid: child.pid! }, close: async () => {
      await waitForExit(child, { signal: "SIGTERM" });
      await fixture.close();
    } };
  } catch (error) { await fixture.close(); throw error; }
}

export async function verifyWorkspaceBackup(report: (event: unknown) => void = () => {}) {
  const events: unknown[] = [];
  const record = (event: unknown) => { events.push(event); report(event); };
  const source = await launchBackupFixture();
  let destination: VerificationServer | undefined;
  let restarted: ChildProcess | undefined;
  const evidencePath = `${source.info.logPath}.workspace-backup.json`;
  record({ source: source.info });
  const control = async (fixture: VerificationServer, ...args: string[]) => {
    const result = await runControlOmb([...args, "--url", fixture.info.url]);
    record({ command: [...args, "--url", fixture.info.url], result });
    return result;
  };
  const api = async (fixture: VerificationServer, method: string, path: string, body?: unknown, token?: string) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60_000),
    });
    const result = await response.json() as Record<string, any>;
    record({ method, path, status: response.status });
    return { status: response.status, body: result };
  };
  try {
    destination = await launchBackupFixture();
    record({ destination: destination.info });
    assert.equal((await control(source, "doctor") as { ok: boolean }).ok, true);
    const { bot } = await control(source, "new-bot", "--name", "Full backup probe", "--section", "Fixture team") as { bot: { id: string; threadId: string } };
    const { bot: oldBot } = await control(destination, "new-bot", "--name", "Original destination") as { bot: { id: string } };
    const soul = "Retain these exact standing instructions. 🐭\n";
    assert.equal((await api(source, "PATCH", `/api/bots/${bot.id}/profile`, { soul })).status, 200);
    const settings = await api(source, "PUT", "/api/config", { profile: { name: "Workspace backup fixture" } });
    assert.equal(settings.status, 200, JSON.stringify(settings.body));
    // A synthetic saved key, not a provider sign-in/probe. Config API key
    // saves deliberately contact the provider, so seed only this owned file.
    const configPath = join(source.info.dataDir, "config.json");
    const savedConfig = JSON.parse(readFileSync(configPath, "utf8"));
    savedConfig.tts = { ...savedConfig.tts, key: "fixture-voice-key" };
    writeFileSync(configPath, JSON.stringify(savedConfig), { mode: 0o600 });
    const destinationConfigPath = join(destination.info.dataDir, "config.json");
    const destinationConfig = JSON.parse(readFileSync(destinationConfigPath, "utf8"));
    destinationConfig.tts = { key: "destination-voice-key", provider: "elevenlabs", voice: "destination-voice" };
    writeFileSync(destinationConfigPath, JSON.stringify(destinationConfig), { mode: 0o600 });

    // A reviewed skill and memory seed are written only into our fixture;
    // the real server must list/enable and later restore the exact content.
    const skill = "---\nname: backup-check\ndescription: Verify restored fixture files.\n---\nWORKSPACE_SKILL_MARKER\n";
    const skillDir = join(source.info.dataDir, "workspaces", bot.id, "skills", "backup-check");
    const stateDir = join(source.info.dataDir, "skill-state", bot.id);
    mkdirSync(skillDir, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), skill, { mode: 0o600 });
    writeFileSync(join(stateDir, "skills.json"), JSON.stringify({ "backup-check": {
      description: "Verify restored fixture files.", enabled: false, source: "package:fixture",
      sha256: createHash("sha256").update(skill).digest("hex"), importedAt: "2026-01-01T00:00:00.000Z",
      warnings: [], skippedFiles: [],
    } }), { mode: 0o600 });
    const memory = "WORKSPACE_MEMORY_MARKER: preserve this memory.\n";
    writeFileSync(join(source.info.dataDir, "workspaces", bot.id, "MEMORY.md"), memory, { mode: 0o600 });
    assert.equal((await api(source, "PATCH", `/api/bots/${bot.id}/skills/backup-check`, { enabled: true })).status, 200);
    const sourceSkills = (await api(source, "GET", `/api/bots/${bot.id}/skills`)).body;
    assert.equal(sourceSkills.skills[0].enabled, true);
    const attachment = Buffer.from("Full workspace attachment ✓\n", "utf8");
    const uploaded = await fetch(`${source.info.url}/api/files?name=backup-note.txt`, {
      method: "POST", headers: { "content-type": "text/plain" }, body: attachment,
    });
    assert.equal(uploaded.status, 201);
    const attached = await uploaded.json() as { path: string; bytes: number };
    record({ method: "POST", path: "/api/files", status: 201, bytes: attached.bytes });
    const text = `Keep this backup conversation.\n<attached-file path="${escapeAttribute(attached.path)}" name="backup-note.txt" />`;
    await control(source, "send", "--bot", bot.id, "--text", text);
    assert.equal((await control(source, "wait", "--bot", bot.id, "--timeout", "30") as { status: string }).status, "settled");
    await control(source, "messages", "--bot", bot.id, "--limit", "20");
    const before = (await api(source, "GET", "/api/bots?messages=200")).body;
    const original = before.bots.find((candidate: { id: string }) => candidate.id === bot.id);
    assert.ok(original.messages.some((message: { text?: string }) => message.text?.includes("hello from fake claude")));
    const oldBytes = readFileSync(join(destination.info.dataDir, "bots.json"));
    const clientState = { "omb-skin": "default", "omb-drafts": JSON.stringify({ [bot.threadId]: "Keep draft" }), "omb-webhook-credentials": "private-source-webhook-url", "unrelated-auth-token": "must-not-transfer" };
    const exported = await api(source, "POST", "/api/workspace-backup/export", { password: PASSWORD, clientState });
    assert.equal(exported.status, 200, JSON.stringify(exported.body));
    assert.equal(exported.body.summary.bots, before.bots.length);
    assert.equal(Object.hasOwn(exported.body.summary, "includesCredentials"), false);
    const download = await fetch(`${source.info.url}/api/workspace-backup/download/${exported.body.id}`);
    assert.equal(download.status, 200);
    const encrypted = Buffer.from(await download.arrayBuffer());
    assert.equal(encrypted.byteLength, exported.body.bytes);
    for (const privateText of [soul, "fixture-voice-key", "WORKSPACE_SKILL_MARKER", "Keep draft"]) assert.equal(encrypted.includes(Buffer.from(privateText)), false);
    record({ command: "download encrypted workspace", bytes: encrypted.length, summary: exported.body.summary });

    const pairing = await api(destination, "POST", "/api/auth/pairing", { scopes: ["client"] });
    const paired = await api(destination, "POST", "/api/auth/pair", { code: pairing.body.code, label: "Fixture client" });
    assert.equal((await api(destination, "POST", "/api/workspace-backup/export", { password: PASSWORD }, paired.body.token)).status, 403);
    const upload = await fetch(`${destination.info.url}/api/workspace-backup/upload`, {
      method: "POST", headers: { "content-type": "application/octet-stream" }, body: encrypted,
    });
    assert.equal(upload.status, 200);
    const incoming = await upload.json() as { id: string };
    record({ method: "POST", path: "/api/workspace-backup/upload", status: upload.status, bytes: encrypted.length });
    assert.equal((await api(destination, "POST", "/api/workspace-backup/preview", { id: incoming.id, password: "wrong-password-fixture" })).status, 400);
    assert.deepEqual(readFileSync(join(destination.info.dataDir, "bots.json")), oldBytes);
    const preview = await api(destination, "POST", "/api/workspace-backup/preview", { id: incoming.id, password: PASSWORD });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.notEqual(preview.body.id, incoming.id);
    assert.equal(preview.body.summary.bots, before.bots.length);
    const staged = join(destination.info.dataDir, ".backups", preview.body.id, "staged");
    const stagedConfig = JSON.parse(readFileSync(join(staged, "data", "config.json"), "utf8"));
    assert.equal(Object.hasOwn(stagedConfig, "tts"), false);
    assert.equal(Object.hasOwn(stagedConfig, "instances"), false);
    const manifest = JSON.parse(readFileSync(join(staged, "manifest.json"), "utf8"));
    assert.equal(Object.hasOwn(manifest, "credentials"), false);
    assert.equal(JSON.stringify(manifest).includes("private-source-webhook-url"), false);
    assert.equal((await api(destination, "POST", "/api/workspace-backup/restore", { id: preview.body.id, confirmation: "replace" })).status, 400);
    assert.deepEqual(readFileSync(join(destination.info.dataDir, "bots.json")), oldBytes);
    const committed = await api(destination, "POST", "/api/workspace-backup/restore", { id: preview.body.id, confirmation: "REPLACE" });
    assert.equal(committed.status, 200, JSON.stringify(committed.body));
    assert.equal(committed.body.restartRequired, true);
    assert.equal((await api(destination, "POST", "/api/bots", { name: "Must wait for restart" })).status, 503);
    assert.deepEqual(readFileSync(join(destination.info.dataDir, "bots.json")), oldBytes);

    restarted = await restartFixture(destination);
    record({ command: "restart exact destination fixture", oldPid: destination.info.pid, newPid: restarted.pid, url: destination.info.url, logPath: destination.info.logPath });
    const after = (await api(destination, "GET", "/api/bots?messages=200")).body;
    assert.deepEqual(after.bots.map((candidate: { id: string }) => candidate.id).sort(), before.bots.map((candidate: { id: string }) => candidate.id).sort());
    assert.equal(after.bots.some((candidate: { id: string }) => candidate.id === oldBot.id), false);
    const restored = after.bots.find((candidate: { id: string }) => candidate.id === bot.id);
    record({ command: "read restored transcript", botId: bot.id, threadId: restored.threadId, messages: restored.messages });
    assert.equal(restored.soul, soul);
    assert.equal(restored.threadId, original.threadId);
    const destinationAttachment = join(destination.info.dataDir, relative(source.info.dataDir, attached.path));
    assert.deepEqual(restored.messages, JSON.parse(JSON.stringify(original.messages)
      .split(JSON.stringify(source.info.dataDir).slice(1, -1)).join(JSON.stringify(destination.info.dataDir).slice(1, -1))));
    assert.deepEqual(readFileSync(destinationAttachment), attachment);
    record({ command: "read restored attachment", path: destinationAttachment, bytes: attachment.length, sha256: createHash("sha256").update(readFileSync(destinationAttachment)).digest("hex") });
    assert.equal(basename(destinationAttachment), basename(attached.path));
    assert.equal(readFileSync(join(destination.info.dataDir, "workspaces", bot.id, "MEMORY.md"), "utf8"), memory);
    assert.equal((await api(destination, "GET", `/api/bots/${bot.id}/skills/backup-check`)).body.text, skill);
    assert.deepEqual((await api(destination, "GET", `/api/bots/${bot.id}/skills`)).body, sourceSkills);
    const restoredConfig = JSON.parse(readFileSync(join(destination.info.dataDir, "config.json"), "utf8"));
    assert.equal(restoredConfig.profile.name, "Workspace backup fixture");
    assert.deepEqual(restoredConfig.tts, destinationConfig.tts);
    assert.deepEqual(restoredConfig.instances, destinationConfig.instances);
    assert.equal((await api(destination, "GET", "/api/config")).body.tts.configured, true);
    const status = (await api(destination, "GET", "/api/workspace-backup/status")).body;
    assert.equal(status.lastRestoreId, preview.body.id);
    assert.ok(status.safetyCopyPath.startsWith(join(destination.info.dataDir, ".backups")));
    assert.deepEqual(readFileSync(join(status.safetyCopyPath, "data", "bots.json")), oldBytes);
    const preferences = await api(destination, "POST", "/api/workspace-backup/client-state", { restoreId: preview.body.id });
    assert.deepEqual(preferences.body.clientState, { "omb-skin": "default", "omb-drafts": clientState["omb-drafts"] });
    await control(destination, "send", "--bot", bot.id, "--text", "Continue this restored conversation. Reply once.");
    assert.equal((await control(destination, "wait", "--bot", bot.id, "--timeout", "30") as { status: string }).status, "settled");
    await control(destination, "messages", "--bot", bot.id, "--limit", "20");
    const continued = (await api(destination, "GET", "/api/bots?messages=200")).body.bots.find((candidate: { id: string }) => candidate.id === bot.id);
    assert.ok(continued.messages.length > restored.messages.length);
    for (const message of restored.messages) assert.deepEqual(continued.messages.find((candidate: { id: string }) => candidate.id === message.id), message);
    const result = { ok: true, identicalIds: true, transcriptPreserved: true, conversationContinued: true, attachmentBytesPreserved: true, skillAndProfilePreserved: true, sourceCredentialsExcluded: true, destinationCredentialsUnchanged: true, clientStateAllowlisted: true, oldDataSafetyCopy: true, evidencePath, logs: [source.info.logPath, destination.info.logPath] };
    record(result);
    return result;
  } finally {
    await waitForExit(restarted, { signal: "SIGTERM" });
    await destination?.close();
    await source.close();
    record({ cleanup: true, sourceRemoved: !existsSync(source.info.dataDir), destinationRemoved: !destination || !existsSync(destination.info.dataDir) });
    writeFileSync(evidencePath, JSON.stringify(events, null, 2), { mode: 0o600 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyWorkspaceBackup((event) => console.log(JSON.stringify(event))).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
