// @vitest-environment node
import { createCipheriv, createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { formatReport, migrate, MigrationError, type Report } from "../scripts/migrate-local-store-to-convex";
import { unseal } from "../convex/lib/sealing";
import { hashToken } from "../convex/lib/auth";
import { convexStore, revokedConnectors, seedWorkspace, signedBridge, type Backend } from "../testing/convex-store";

// Synthetic /data/origin built with the production DDL (origin-handoff/hetzner-local-store-schema). Every value is a fixture.

const ORIGIN_DDL = `CREATE TABLE chat_reads (team TEXT NOT NULL, conversation TEXT NOT NULL, user TEXT NOT NULL, seen INTEGER NOT NULL, PRIMARY KEY(team,conversation,user));
CREATE TABLE direct_conversations (id TEXT NOT NULL, team TEXT NOT NULL, user_a TEXT NOT NULL, user_b TEXT NOT NULL, PRIMARY KEY(team,id));
CREATE TABLE files (id TEXT PRIMARY KEY, team TEXT NOT NULL, author TEXT NOT NULL, payload TEXT NOT NULL, conversation TEXT NOT NULL DEFAULT '');
CREATE TABLE messages (id TEXT PRIMARY KEY, team TEXT NOT NULL, created INTEGER NOT NULL, payload TEXT NOT NULL, conversation TEXT NOT NULL DEFAULT '');
CREATE TABLE migrations (name TEXT PRIMARY KEY);
CREATE TABLE notification_outbox (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
CREATE TABLE participants (team TEXT NOT NULL, user TEXT NOT NULL, seen INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(team,user));
CREATE TABLE request_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE signals (id TEXT PRIMARY KEY, team TEXT NOT NULL, recipient TEXT NOT NULL, sender TEXT NOT NULL, created INTEGER NOT NULL, payload TEXT NOT NULL);`;
const INTEGRATIONS_DDL = `CREATE TABLE github_app (id INTEGER PRIMARY KEY CHECK(id=1), encrypted TEXT NOT NULL);
CREATE TABLE github_connections (project TEXT PRIMARY KEY, repo TEXT NOT NULL, login TEXT NOT NULL, encrypted TEXT NOT NULL, connected_by TEXT NOT NULL, updated INTEGER NOT NULL);
CREATE TABLE github_jobs (key TEXT PRIMARY KEY, state TEXT NOT NULL, payload TEXT, updated INTEGER NOT NULL);
CREATE TABLE github_oauth_states (hash TEXT PRIMARY KEY, browser_hash TEXT NOT NULL, encrypted TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE github_workspace (team TEXT PRIMARY KEY, login TEXT NOT NULL, account_id INTEGER NOT NULL, connected_by TEXT NOT NULL, encrypted TEXT NOT NULL);
CREATE TABLE instance_operator (id INTEGER PRIMARY KEY CHECK(id=1), user_id TEXT NOT NULL, recorded INTEGER NOT NULL);
CREATE TABLE mcp_clients (id TEXT PRIMARY KEY, name TEXT NOT NULL, redirects TEXT NOT NULL, created INTEGER NOT NULL);
CREATE TABLE mcp_codes (hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL, redirect TEXT NOT NULL, challenge TEXT NOT NULL, expires INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
CREATE TABLE mcp_grants (id TEXT PRIMARY KEY, client TEXT NOT NULL, encrypted TEXT NOT NULL, scope TEXT NOT NULL, resource TEXT NOT NULL, expires INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE mcp_revocations (grant_id TEXT PRIMARY KEY, encrypted TEXT NOT NULL, created INTEGER NOT NULL);
CREATE TABLE mcp_tokens (hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL, kind TEXT NOT NULL, expires INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0, scope TEXT);`;
const EXECUTION_DDL = `CREATE TABLE execution_accounts(account_id TEXT NOT NULL,host_id TEXT NOT NULL,local_id TEXT NOT NULL,team_id TEXT NOT NULL,owner_id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(account_id,host_id,local_id));
CREATE TABLE execution_audit(id TEXT PRIMARY KEY,team_id TEXT NOT NULL,user_id TEXT NOT NULL,created INTEGER NOT NULL,action TEXT NOT NULL,subject TEXT NOT NULL);
CREATE TABLE execution_cloud(id TEXT PRIMARY KEY,team_id TEXT NOT NULL,owner_id TEXT NOT NULL,project_id TEXT NOT NULL,provider TEXT NOT NULL,payload TEXT NOT NULL);
CREATE TABLE execution_controls(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,kind TEXT NOT NULL,created INTEGER NOT NULL,payload TEXT NOT NULL,acknowledged INTEGER NOT NULL DEFAULT 0);
CREATE TABLE execution_enrollments(hash TEXT PRIMARY KEY,expires INTEGER NOT NULL,payload TEXT NOT NULL);
CREATE TABLE execution_events(id INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL,created INTEGER NOT NULL,payload TEXT NOT NULL);
CREATE TABLE execution_hosts(id TEXT PRIMARY KEY,team_id TEXT NOT NULL,owner_id TEXT NOT NULL,token_hash TEXT UNIQUE,payload TEXT NOT NULL);
CREATE TABLE execution_locks(name TEXT PRIMARY KEY,expires INTEGER NOT NULL,owner TEXT NOT NULL);
CREATE TABLE execution_runs(id TEXT PRIMARY KEY,team_id TEXT NOT NULL,project_id TEXT NOT NULL,task_id TEXT NOT NULL,host_id TEXT,status TEXT NOT NULL,updated INTEGER NOT NULL,payload TEXT NOT NULL);
CREATE TABLE execution_settings(team_id TEXT NOT NULL,kind TEXT NOT NULL,reference TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(team_id,kind,reference));`;

/** How lib/githubConnection.ts sealed values before this release. */
function sealLegacy(key: Buffer, value: string, purpose: string) {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(purpose));
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
}
function database(file: string, ddl: string, fill: (db: DatabaseSync) => void) {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode=WAL;"); db.exec(ddl); fill(db); db.close();
}
const SECRETS = ["fixture-app-client-secret", "fixture-app-pem", "fixture-webhook-secret", "fixture-workspace-access", "fixture-project-token", "origin_oauth_fixture_grant", "FIXTURE_ENV_VALUE", "fixture-git-token", "fixture-cloud-api-key", "fixture-enroll-token"];

let dir: string, backend: Backend, team: { userId: string; teamId: string }, ids: { kept: string; deletedLocally: string; edited: string; file: string; dm: string };
const transport = (operation: string, args: Record<string, unknown>) => signedBridge(backend, operation, args);
const upload = (bytes: Uint8Array, contentType: string) => backend.run(async ctx => ctx.storage.store(new Blob([new Uint8Array(bytes)], { type: contentType })));
const later = Date.now() + 86400000;

beforeEach(async () => {
  backend = convexStore();
  vi.stubEnv("ORIGIN_PUBLIC_URL", "https://origin.fixture.test");
  team = await seedWorkspace(backend, ["origin_oauth_fixture_grant", "origin_oauth_fixture_revoked"]);
  const { teamId, userId } = team;
  const other = await backend.run(ctx => ctx.db.insert("users", { email: "other@fixture.test", name: "Other", passwordHash: "x", salt: "x", iterations: 1, role: "user", status: "active", createdAt: 0, updatedAt: 0 }));
  ids = { kept: randomUUID(), deletedLocally: randomUUID(), edited: randomUUID(), file: randomUUID(), dm: `dm:${[userId, other].sort().join(":")}` };
  // Chat the desktop app left in Convex, which the old store copied (migration convex-chat:<team>) and then changed.
  await backend.run(async ctx => {
    for (const [messageId, body] of [[ids.deletedLocally, "deleted later"], [ids.edited, "before the edit"]] as const)
      await ctx.db.insert("teamChatMessages", { teamId: teamId as never, conversation: "", messageId, created: 1, payload: JSON.stringify({ id: messageId, body }) });
  });

  dir = mkdtempSync(path.join(tmpdir(), "origin-store-fixture-"));
  const key = randomBytes(32);
  writeFileSync(path.join(dir, "integrations.key"), key);
  writeFileSync(path.join(dir, "runner-signing.key"), generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }));
  writeFileSync(path.join(dir, "cloud-boxd-before-1700000000.json"), "{}");
  mkdirSync(path.join(dir, "maintenance")); writeFileSync(path.join(dir, "maintenance", "host.json"), "{}");
  mkdirSync(path.join(dir, "files")); writeFileSync(path.join(dir, "files", ids.file), "fixture attachment bytes");
  database(path.join(dir, "origin.sqlite"), ORIGIN_DDL, db => {
    const message = db.prepare("INSERT INTO messages VALUES(?,?,?,?,?)");
    message.run(ids.kept, teamId, 10, JSON.stringify({ id: ids.kept, authorUserId: userId, body: "hello" }), "");
    message.run(ids.edited, teamId, 1, JSON.stringify({ id: ids.edited, body: "after the edit" }), "");
    message.run(randomUUID(), teamId, 11, JSON.stringify({ body: "direct" }), ids.dm);
    message.run(randomUUID(), teamId, 12, JSON.stringify({ body: "with file", attachments: [{ id: ids.file }] }), "");
    db.prepare("INSERT INTO direct_conversations VALUES(?,?,?,?)").run(ids.dm, teamId, ...ids.dm.slice(3).split(":"));
    db.prepare("INSERT INTO chat_reads VALUES(?,?,?,?)").run(teamId, "", userId, 10);
    db.prepare("INSERT INTO chat_reads VALUES(?,?,?,?)").run(teamId, ids.dm, userId, 11);
    db.prepare("INSERT INTO files VALUES(?,?,?,?,?)").run(ids.file, teamId, userId, JSON.stringify({ id: ids.file, name: "a.txt", size: 24, contentType: "text/plain" }), "");
    for (const name of ["legacy-chat", `convex-chat:${teamId}`, "convex-chat:retired-team"]) db.prepare("INSERT INTO migrations VALUES(?)").run(name);
    db.prepare("INSERT INTO request_limits VALUES(?,?,?)").run("chat:live", 3, later);
    db.prepare("INSERT INTO request_limits VALUES(?,?,?)").run("chat:expired", 9, 1);
    db.prepare("INSERT INTO notification_outbox VALUES(?,?)").run(ids.kept, JSON.stringify({ teamId, actorId: userId, messageId: ids.kept, userIds: [other] }));
  });
  database(path.join(dir, "integrations.sqlite"), INTEGRATIONS_DDL, db => {
    db.prepare("INSERT INTO github_app VALUES(1,?)").run(sealLegacy(key, JSON.stringify({ clientId: "fixture-app", clientSecret: "fixture-app-client-secret", webhookSecret: "fixture-webhook-secret", privateKey: "fixture-app-pem" }), "github-app"));
    db.prepare("INSERT INTO github_workspace VALUES(?,?,?,?,?)").run(teamId, "octo", 7, userId, sealLegacy(key, JSON.stringify({ access_token: "fixture-workspace-access" }), `github-team:${teamId}`));
    for (let i = 0; i < 3; i++) db.prepare("INSERT INTO github_jobs VALUES(?,?,?,?)").run(`issue:fixture-${i}`, "done", JSON.stringify({ issue: i }), 5);
    db.prepare("INSERT INTO instance_operator VALUES(1,?,?)").run(userId, 5);
    db.prepare("INSERT INTO mcp_clients VALUES(?,?,?,?)").run("client-1", "Fixture CLI", JSON.stringify(["http://127.0.0.1/cb"]), 5);
    db.prepare("INSERT INTO mcp_grants VALUES(?,?,?,?,?,?,0)").run("grant-1", "client-1", sealLegacy(key, "origin_oauth_fixture_grant", "mcp:grant-1"), "origin:read origin:write", "https://origin.fixture.test/api/mcp", later);
    db.prepare("INSERT INTO mcp_tokens VALUES(?,?,?,?,0,?)").run(createHash("sha256").update("fixture-access").digest("hex"), "grant-1", "access", later, "origin:read origin:write");
    db.prepare("INSERT INTO mcp_tokens VALUES(?,?,?,?,0,NULL)").run(createHash("sha256").update("fixture-refresh").digest("hex"), "grant-1", "refresh", later);
    db.prepare("INSERT INTO mcp_revocations VALUES(?,?,?)").run("grant-0", sealLegacy(key, "origin_oauth_fixture_revoked", "mcp:grant-0"), 5);
  });
  database(path.join(dir, "execution.sqlite"), EXECUTION_DDL, db => {
    db.prepare("INSERT INTO execution_hosts VALUES(?,?,?,?,?)").run("host-1", teamId, userId, "f".repeat(64), JSON.stringify({ id: "host-1", name: "mac" }));
    db.prepare("INSERT INTO execution_accounts VALUES(?,?,?,?,?,?)").run("account-1", "host-1", "local-1", teamId, userId, JSON.stringify({ provider: "claude" }));
    db.prepare("INSERT INTO execution_runs VALUES(?,?,?,?,?,?,?,?)").run("run-1", teamId, "project-1", "task-1", "host-1", "merged", 5, JSON.stringify({
      run: { id: "run-1" }, sealedEnvironment: sealLegacy(key, JSON.stringify({ TOKEN: "FIXTURE_ENV_VALUE" }), "execution-env:run-1"), sealedGitCredential: sealLegacy(key, JSON.stringify({ token: "fixture-git-token" }), "execution-git:run-1"),
    }));
    db.prepare("INSERT INTO execution_settings VALUES(?,?,?,?)").run(teamId, "environment", "env-1", JSON.stringify({ id: "env-1", sealed: sealLegacy(key, JSON.stringify({ A: "1" }), `execution-environment:${teamId}:env-1`) }));
    db.prepare("INSERT INTO execution_settings VALUES(?,?,?,?)").run(teamId, "cloud", "boxd", JSON.stringify({ provider: "boxd", sealedKey: sealLegacy(key, "fixture-cloud-api-key", `execution-cloud:${teamId}:boxd`) }));
    db.prepare("INSERT INTO execution_settings VALUES(?,?,?,?)").run(teamId, "policy", "workspace", JSON.stringify({ allow: true }));
    db.prepare("INSERT INTO execution_cloud VALUES(?,?,?,?,?,?)").run("alloc-1", teamId, userId, "project-1", "boxd", JSON.stringify({ id: "alloc-1", enrollment: { sealedToken: sealLegacy(key, "fixture-enroll-token", "cloud-enrollment:alloc-1"), expiresAt: 1 } }));
    db.prepare("INSERT INTO execution_events(run_id,created,payload) VALUES(?,?,?)").run("run-1", 5, JSON.stringify({ type: "log" }));
    db.prepare("INSERT INTO execution_events(run_id,created,payload) VALUES(?,?,?)").run("run-1", 6, JSON.stringify({ type: "done" }));
    db.prepare("INSERT INTO execution_audit VALUES(?,?,?,?,?,?)").run("audit-1", teamId, userId, 5, "save_policy", "workspace");
    db.prepare("INSERT INTO execution_locks VALUES(?,?,?)").run("controller", later, "owner-1");
  });
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); });

function fingerprint(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string) => { for (const entry of readdirSync(at)) { const full = path.join(at, entry); if (statSync(full).isDirectory()) walk(full); else out[path.relative(root, full)] = createHash("sha256").update(readFileSync(full)).digest("hex"); } };
  walk(root);
  return out;
}
const byKind = (report: Report, source: string) => report.rows.find(row => row.source === source)!;
const newTables = ["githubAppRegistrations", "githubWorkspaceConnections", "githubJobs", "mcpOAuthClients", "mcpOAuthGrants", "mcpOAuthTokens", "localStoreArchive", "localStoreMarkers", "requestLimits", "serverLeases", "teamChatFiles", "teamDirectConversations", "teamChatReads"] as const;
const counts = () => backend.run(async ctx => {
  const result: Record<string, number> = {};
  for (const table of [...newTables, "teamChatMessages"] as const) result[table] = (await ctx.db.query(table).take(1000)).length;
  return result;
});

test("offline dry run prints source counts and writes nothing, not even to the data directory", async () => {
  const before = fingerprint(dir);
  const report = await migrate(dir, { apply: false });
  expect(report).toMatchObject({ mode: "dry-run", compared: false });
  expect(byKind(report, "origin.messages")).toMatchObject({ rows: 4, insert: 4 });
  expect(byKind(report, "origin.request_limits")).toMatchObject({ rows: 2, insert: 1, skip: 1 });
  expect(byKind(report, "integrations.mcp_tokens")).toMatchObject({ rows: 2 });
  expect(byKind(report, "execution.execution_settings")).toMatchObject({ rows: 3 });
  expect(byKind(report, "execution.execution_events")).toMatchObject({ rows: 2 });
  expect(byKind(report, "origin.files + files/")).toMatchObject({ rows: 1 });
  expect(report.ignored.sort()).toEqual(["cloud-boxd-before-1700000000.json", "maintenance/"]);
  const text = formatReport(report);
  expect(text).toContain("nothing was written");
  expect(text).toMatch(/runner-signing\.key: Ed25519, public key SHA-256 [a-f0-9]{64}/);
  for (const secret of SECRETS) expect(text).not.toContain(secret);
  expect(fingerprint(dir)).toEqual(before);
  expect(await counts()).toMatchObject({ teamChatMessages: 2, githubAppRegistrations: 0 });
});

test("a dry run against Convex plans inserts, updates and deletes using read-only calls only", async () => {
  const before = fingerprint(dir), stored = await counts();
  const operations: string[] = [];
  const report = await migrate(dir, { apply: false, transport: (operation, args) => { operations.push(operation); return transport(operation, args); } });
  expect(new Set(operations)).toEqual(new Set(["migrate.inspect", "migrate.chatMessageIds"]));
  expect(byKind(report, "origin.messages")).toMatchObject({ rows: 4, insert: 3, update: 1 });
  expect(byKind(report, "origin.messages deleted after the Convex copy")).toMatchObject({ delete: 1 });
  expect(byKind(report, "integrations.github_app")).toMatchObject({ insert: 1 });
  expect(await counts()).toEqual(stored);
  expect(fingerprint(dir)).toEqual(before);
});

test("apply imports everything, re-sealed with ORIGIN_SEALING_KEY, and a second run changes nothing", async () => {
  const report = await migrate(dir, { apply: true, transport, upload });
  expect(byKind(report, "origin.messages")).toMatchObject({ insert: 3, update: 1 });
  expect(byKind(report, "origin.messages deleted after the Convex copy")).toMatchObject({ delete: 1 });
  expect(byKind(report, "origin.files + files/")).toMatchObject({ insert: 1 });
  const after = await counts();
  expect(after).toMatchObject({
    teamChatMessages: 4, teamChatFiles: 1, teamDirectConversations: 1, teamChatReads: 2, localStoreMarkers: 3, requestLimits: 1, serverLeases: 1,
    githubAppRegistrations: 1, githubWorkspaceConnections: 1, githubJobs: 3, mcpOAuthClients: 1, mcpOAuthGrants: 1, mcpOAuthTokens: 2,
    localStoreArchive: 1 + 1 + 1 + 3 + 1 + 2 + 1 + 1,
  });

  // No plaintext secret and no old-key ciphertext in any document; Convex can open what it sealed.
  const documents = await backend.run(async ctx => JSON.stringify(await Promise.all(newTables.map(table => ctx.db.query(table).take(1000)))));
  for (const secret of SECRETS) expect(documents).not.toContain(secret);
  expect(JSON.parse(await signedBridge<string>(backend, "store.githubApp", {}))).toMatchObject({ clientSecret: "fixture-app-client-secret", privateKey: "fixture-app-pem" });
  const run = await backend.run(ctx => ctx.db.query("localStoreArchive").withIndex("by_source_and_key", q => q.eq("source", "execution.execution_runs").eq("key", JSON.stringify(["run-1"]))).unique());
  const archived = JSON.parse(run!.payload);
  expect(JSON.parse(await unseal(archived.payload.sealedGitCredential, "execution-git:run-1"))).toEqual({ token: "fixture-git-token" });
  const resolved = await signedBridge<{ connectorToken: string }>(backend, "mcp.resolve", { accessHash: createHash("sha256").update("fixture-access").digest("hex"), resource: "https://origin.fixture.test/api/mcp" });
  expect(resolved.connectorToken).toBe("origin_oauth_fixture_grant");
  const grant = await backend.run(ctx => ctx.db.query("mcpOAuthGrants").take(1));
  expect(grant[0].connectorTokenHash).toBe(await hashToken("origin_oauth_fixture_grant"));
  expect(await revokedConnectors(backend, ["origin_oauth_fixture_grant", "origin_oauth_fixture_revoked"])).toEqual(["origin_oauth_fixture_revoked"]);
  const messages = await backend.run(ctx => ctx.db.query("teamChatMessages").take(10));
  expect(messages.map(row => row.messageId)).not.toContain(ids.deletedLocally);
  expect(JSON.parse(messages.find(row => row.messageId === ids.edited)!.payload).body).toBe("after the edit");

  const again = await migrate(dir, { apply: true, transport, upload });
  for (const row of again.rows.filter(row => !["notifyMentions", "revokeConnector"].includes(row.kind))) expect({ source: row.source, insert: row.insert, update: row.update, delete: row.delete }).toEqual({ source: row.source, insert: 0, update: 0, delete: 0 });
  expect(await counts()).toEqual(after);
});

test("the import refuses an unknown sealed field or a wrong integrations.key instead of copying ciphertext", async () => {
  const db = new DatabaseSync(path.join(dir, "execution.sqlite"));
  db.prepare("INSERT INTO execution_hosts VALUES(?,?,?,?,?)").run("host-2", team.teamId, team.userId, null, JSON.stringify({ sealedSomething: "opaque" }));
  db.close();
  await expect(migrate(dir, { apply: false })).rejects.toThrow(/execution_hosts has sealed fields .*payload\.sealedSomething/);
  const clean = new DatabaseSync(path.join(dir, "execution.sqlite"));
  clean.prepare("DELETE FROM execution_hosts WHERE id='host-2'").run();
  clean.close();
  writeFileSync(path.join(dir, "integrations.key"), randomBytes(32));
  await expect(migrate(dir, { apply: false })).rejects.toBeInstanceOf(MigrationError);
});
