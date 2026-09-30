// Move to Cloud's Cloud side in isolation: the resumable upload slot, what
// counts as an empty Cloud, the space check, the routes' owner-only gate, and
// the previous Cloud. The whole move over two real servers is
// cloud-move.e2e.test.ts.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  beginUpload, CLOUD_MOVE_MAX_BYTES, CLOUD_MOVE_SPACE_MARGIN, completedUpload, isEmptyWorkspace, moveSpaceNeeded, noteMoveRestore,
  prepareNextPreviousCloud, previousCloud, stagePreviousCloud, tidyCloudMoveStorage, uploadStatus, validUploadDeclaration, workspaceContents,
  workspaceMoveSize, writeUploadPart,
} from "./cloud-move.ts";
import { createCloudMoveRoutes } from "./cloud-move-http.ts";
import { readBody } from "./harness/http.ts";
import { resolveRequestAuth, type RequestAuth } from "./request-auth.ts";
import { SessionRegistry } from "./sessions.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { createWorkspaceBackupSnapshot } from "./workspace-backup.ts";

let dataDir: string, desktop: string;
beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), "omb-cloud-move-")); desktop = mkdtempSync(join(tmpdir(), "omb-cloud-move-desktop-")); });
afterEach(async () => { await removeTempDir(dataDir); await removeTempDir(desktop); });

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
async function* body(...parts: Buffer[]) { for (const part of parts) yield part; }
function messages(rows: Array<{ thread: string; role: string }>) {
  const db = new DatabaseSync(join(dataDir, "messages.db"));
  db.exec("CREATE TABLE messages(thread_id TEXT, id TEXT, at INTEGER, role TEXT, kind TEXT, text TEXT, json TEXT, PRIMARY KEY(thread_id, id)); CREATE TABLE thread_state(thread_id TEXT PRIMARY KEY, active_leaf_id TEXT);");
  const insert = db.prepare("INSERT INTO messages VALUES (?, ?, 1, ?, 'text', 'hi', ?)");
  for (const row of rows) insert.run(row.thread, randomUUID(), row.role, JSON.stringify({ role: row.role, text: "hi" }));
  db.close();
}

it("resumes an upload by its SHA-256, accepts a repeated part without writing it twice, and answers where it stands", async () => {
  const file = randomBytes(3000), declared = { sha256: sha(file), bytes: file.length };
  expect(beginUpload(dataDir, declared)).toMatchObject({ received: 0 });
  expect(await writeUploadPart(dataDir, declared.sha256, 0, 1000, body(file.subarray(0, 600), file.subarray(600, 1000)))).toBe(1000);
  // A retry of a part the Cloud already stored (its answer was lost) is a no-op.
  expect(await writeUploadPart(dataDir, declared.sha256, 0, 1000, body(file.subarray(0, 1000)))).toBe(1000);
  await expect(writeUploadPart(dataDir, declared.sha256, 2000, 1000, body(file.subarray(2000)))).rejects.toMatchObject({ status: 409, received: 1000 });
  // The same file again continues; nothing already received is lost.
  expect(beginUpload(dataDir, declared)).toMatchObject({ received: 1000 });
  expect(await writeUploadPart(dataDir, declared.sha256, 1000, 2000, body(file.subarray(1000)))).toBe(3000);
  expect(readFileSync(await completedUpload(dataDir, declared.sha256)).equals(file)).toBe(true);
  // A different file replaces the slot.
  const other = randomBytes(100);
  expect(beginUpload(dataDir, { sha256: sha(other), bytes: 100 })).toMatchObject({ received: 0 });
  expect(uploadStatus(dataDir)).toEqual({ sha256: sha(other), bytes: 100, received: 0 });
});

it("never lets an upload grow past what it declared, and cuts a failed part back off", async () => {
  const file = randomBytes(1000), declared = { sha256: sha(file), bytes: file.length };
  beginUpload(dataDir, declared);
  await expect(writeUploadPart(dataDir, declared.sha256, 0, 1001, body(file, Buffer.alloc(1)))).rejects.toMatchObject({ status: 413 });
  // A part that brings more than its declared length is refused and removed.
  await expect(writeUploadPart(dataDir, declared.sha256, 0, 500, body(file))).rejects.toMatchObject({ status: 413 });
  expect(uploadStatus(dataDir)?.received).toBe(0);
  // A part that ends early is incomplete, and removed too.
  await expect(writeUploadPart(dataDir, declared.sha256, 0, 500, body(file.subarray(0, 200)))).rejects.toMatchObject({ status: 400 });
  expect(uploadStatus(dataDir)?.received).toBe(0);
  await expect(writeUploadPart(dataDir, sha(randomBytes(8)), 0, 10, body(file.subarray(0, 10)))).rejects.toMatchObject({ status: 404 });
});

it("discards an upload whose bytes do not match its SHA-256", async () => {
  const file = randomBytes(64), declared = { sha256: sha(randomBytes(64)), bytes: file.length };
  beginUpload(dataDir, declared);
  await writeUploadPart(dataDir, declared.sha256, 0, 64, body(file));
  await expect(completedUpload(dataDir, declared.sha256)).rejects.toMatchObject({ status: 400 });
  expect(uploadStatus(dataDir)).toBeNull();
});

it("bounds a declared upload by size and file count", () => {
  expect(() => validUploadDeclaration({ sha256: "a".repeat(64), bytes: CLOUD_MOVE_MAX_BYTES + 1 })).toThrow(expect.objectContaining({ status: 413 }));
  expect(() => validUploadDeclaration({ sha256: "a".repeat(64), bytes: 4096, files: 100_001 })).toThrow(expect.objectContaining({ status: 413 }));
  expect(() => validUploadDeclaration({ sha256: "not-a-hash", bytes: 4096 })).toThrow(expect.objectContaining({ status: 400 }));
  expect(() => validUploadDeclaration({ sha256: "a".repeat(64), bytes: 10 })).toThrow(expect.objectContaining({ status: 400 }));
  expect(validUploadDeclaration({ sha256: "a".repeat(64), bytes: CLOUD_MOVE_MAX_BYTES, files: 100_000 })).toEqual({ sha256: "a".repeat(64), bytes: CLOUD_MOVE_MAX_BYTES });
});

it("calls a Cloud empty only with its starter bot at most, no rooms, and nobody's chat", () => {
  expect(isEmptyWorkspace(workspaceContents(dataDir))).toBe(true);
  writeFileSync(join(dataDir, "bots.json"), JSON.stringify([{ id: "starter" }]));
  messages([{ thread: "t1", role: "bot" }]);
  expect(workspaceContents(dataDir)).toEqual({ bots: 1, rooms: 0, chats: 0 });
  expect(isEmptyWorkspace(workspaceContents(dataDir))).toBe(true);
  writeFileSync(join(dataDir, "groups.json"), JSON.stringify([{ id: "room" }]));
  expect(isEmptyWorkspace(workspaceContents(dataDir))).toBe(false);
  writeFileSync(join(dataDir, "groups.json"), "[]");
  writeFileSync(join(dataDir, "bots.json"), JSON.stringify([{ id: "starter" }, { id: "second" }]));
  expect(isEmptyWorkspace(workspaceContents(dataDir))).toBe(false);
});

it("counts a conversation someone took part in as a chat", () => {
  writeFileSync(join(dataDir, "bots.json"), JSON.stringify([{ id: "starter" }]));
  messages([{ thread: "t1", role: "bot" }, { thread: "t1", role: "user" }, { thread: "t2", role: "user" }, { thread: "t3", role: "bot" }]);
  expect(workspaceContents(dataDir)).toEqual({ bots: 1, rooms: 0, chats: 2 });
  expect(isEmptyWorkspace(workspaceContents(dataDir))).toBe(false);
});

it("sizes a move by the backup's own rules: credentials, sessions and caches are not counted", () => {
  writeFileSync(join(dataDir, "bots.json"), "x".repeat(100));
  mkdirSync(join(dataDir, "attachments"));
  writeFileSync(join(dataDir, "attachments", "a.png"), "x".repeat(1000));
  writeFileSync(join(dataDir, "sessions.json"), "x".repeat(5000));
  writeFileSync(join(dataDir, "workspace-credentials.json"), "x".repeat(5000));
  mkdirSync(join(dataDir, "providers", "claude"), { recursive: true });
  writeFileSync(join(dataDir, "providers", "claude", ".credentials.json"), "x".repeat(5000));
  mkdirSync(join(dataDir, "cache"));
  writeFileSync(join(dataDir, "cache", "big.bin"), "x".repeat(5000));
  expect(workspaceMoveSize(dataDir)).toEqual({ bytes: 1100, files: 2 });
});

it("needs room for the upload three times over, plus a backup of a Cloud it replaces", () => {
  expect(moveSpaceNeeded(1000, 500, false)).toBe(3000 + CLOUD_MOVE_SPACE_MARGIN);
  expect(moveSpaceNeeded(1000, 500, true)).toBe(4000 + CLOUD_MOVE_SPACE_MARGIN);
});

const backup = (root: string) => (password: string) => createWorkspaceBackupSnapshot(root, { password, appVersion: "0.1.90" });

it("keeps one previous Cloud: a new one takes its place only once its restore is installed, and never shows its password", async () => {
  writeFileSync(join(dataDir, "bots.json"), JSON.stringify([{ id: "one" }, { id: "two" }]));
  const first = randomUUID();
  const saved = await prepareNextPreviousCloud(dataDir, first, backup(dataDir));
  expect(saved).toMatchObject({ bots: 2, rooms: 0, chats: 0 });
  // Waiting for its restore: not the previous Cloud yet.
  expect(previousCloud(dataDir)).toBeNull();
  tidyCloudMoveStorage(dataDir, { restored: true, id: first });
  expect(previousCloud(dataDir)).toMatchObject({ ...saved, bytes: expect.any(Number) });
  expect(JSON.stringify(previousCloud(dataDir))).not.toMatch(/password/);
  // A later backup whose restore rolled back (or never came) is dropped; the previous stays.
  writeFileSync(join(dataDir, "bots.json"), JSON.stringify([{ id: "three" }]));
  const second = randomUUID();
  await prepareNextPreviousCloud(dataDir, second, backup(dataDir));
  tidyCloudMoveStorage(dataDir, { rolledBack: true, id: second });
  expect(previousCloud(dataDir)).toMatchObject({ bots: 2 });
  expect(existsSync(join(dataDir, ".backups", "cloud-previous.next"))).toBe(false);
  const staged = await stagePreviousCloud(dataDir, "0.1.90");
  expect(staged.summary.bots).toBe(2);
  // A fresh Cloud's backup (its starter bot) is kept but not offered.
  const third = randomUUID();
  await prepareNextPreviousCloud(dataDir, third, backup(dataDir));
  tidyCloudMoveStorage(dataDir, { restored: true, id: third });
  expect(previousCloud(dataDir)).toBeNull();
  await expect(stagePreviousCloud(dataDir, "0.1.90")).rejects.toMatchObject({ status: 404 });
}, 60_000);

it("once a move's restore is installed, deletes its safety copy and staged files, never a pending one's, and a day-old upload", () => {
  const [done, older, pending, other] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  for (const id of [done, older, pending, other]) {
    mkdirSync(join(dataDir, ".backups", id, "staged", "data"), { recursive: true });
    mkdirSync(join(dataDir, ".backups", `safety-${id}`, "data"), { recursive: true });
    writeFileSync(join(dataDir, ".backups", `safety-${id}`, "data", "bots.json"), "[]");
  }
  for (const id of [done, older, pending]) noteMoveRestore(dataDir, id);
  writeFileSync(join(dataDir, ".backups", "pending-restore.json"), JSON.stringify({ id: pending }));
  writeFileSync(join(dataDir, ".backups", "last-restore.json"), JSON.stringify({ restored: true, id: done, safetyCopyPath: join(dataDir, ".backups", `safety-${done}`) }));
  beginUpload(dataDir, { sha256: "a".repeat(64), bytes: 4096 }, Date.now() - 25 * 3600_000);
  const restored = { restored: true, id: done, safetyCopyPath: join(dataDir, ".backups", `safety-${done}`) };
  tidyCloudMoveStorage(dataDir, restored);
  const left = readdirSync(join(dataDir, ".backups"));
  for (const id of [done, older]) { expect(left).not.toContain(id); expect(left).not.toContain(`safety-${id}`); }
  // A restore still waiting to be applied, and anything that is not a move's, are left alone.
  for (const id of [pending, other]) { expect(left).toContain(id); expect(left).toContain(`safety-${id}`); }
  expect(restored).not.toHaveProperty("safetyCopyPath");
  expect(JSON.parse(readFileSync(join(dataDir, ".backups", "last-restore.json"), "utf8"))).toEqual({ restored: true, id: done });
  expect(uploadStatus(dataDir)).toBeNull();
  // A fresh upload stays.
  beginUpload(dataDir, { sha256: "b".repeat(64), bytes: 4096 });
  tidyCloudMoveStorage(dataDir, restored);
  expect(uploadStatus(dataDir)).toMatchObject({ sha256: "b".repeat(64) });
});

// ── the routes ──────────────────────────────────────────────────────────
let server: Server | undefined;
afterEach(async () => { await new Promise<void>((done) => server ? server.close(() => done()) : done()); server = undefined; });
async function routes(options: { cloudHome?: boolean; freeBytes?: number | (() => number); exclusive?: <T>(work: () => Promise<T>) => Promise<T> } = {}) {
  const sessions = new SessionRegistry({ file: join(dataDir, "sessions.json") });
  const owner = sessions.issue({ label: "Owner's app", scopes: ["admin", "client"] });
  const phone = sessions.issue({ label: "Phone", scopes: ["client"] });
  let base = "";
  const authenticate = (req: IncomingMessage) => resolveRequestAuth(req, { sessions, cookieName: "fixture", streamPath: "/api/events", url: new URL(req.url!, base) });
  const restarts: number[] = [];
  const handle = createCloudMoveRoutes({
    dataDir, appVersion: "0.1.90", cloudHome: options.cloudHome ?? true, readBody, restored: {},
    exclusive: options.exclusive ?? ((work) => work()), authorized: (req, auth) => authenticate(req).auth?.kind === auth.kind,
    status: () => ({ busy: false, pendingRestore: false }), restart: () => restarts.push(Date.now()),
    freeBytes: () => typeof options.freeBytes === "function" ? options.freeBytes() : options.freeBytes ?? 1024 ** 4, gateRetryMs: 0, restartDelayMs: 0,
  });
  server = createServer(async (req, res) => {
    const gate = authenticate(req);
    if (!gate.auth) { res.writeHead(gate.status); res.end(); return; }
    if (!(await handle(req, res, new URL(req.url!, base).pathname, gate.auth as RequestAuth))) { res.writeHead(404); res.end(); }
  });
  await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(server!.address() as { port: number }).port}`;
  const call = async (method: string, path: string, token?: string, value?: unknown, raw?: Buffer) => {
    const response = await fetch(`${base}${path}`, { method, headers: {
      ...(token ? { authorization: `Bearer ${token}`, "x-forwarded-proto": "https", "x-forwarded-for": "203.0.113.9", host: "cloud.example.test" } : {}),
      ...(value === undefined ? {} : { "content-type": "application/json" }) }, body: raw ?? (value === undefined ? undefined : JSON.stringify(value)) });
    return { status: response.status, body: await response.json().catch(() => null) as any };
  };
  return { call, owner: owner.token, phone: phone.token, restarts };
}

it("refuses a move that does not fit the Cloud's volume, counting a backup of what it replaces", async () => {
  writeFileSync(join(dataDir, "bots.json"), JSON.stringify([{ id: "a" }, { id: "b" }]));
  mkdirSync(join(dataDir, "attachments"));
  writeFileSync(join(dataDir, "attachments", "big.bin"), Buffer.alloc(1_000_000));
  // The session registry below writes its open marker first; it is not part of a backup.
  new SessionRegistry({ file: join(dataDir, "sessions.json") });
  const bytes = 50_000_000, needed = moveSpaceNeeded(bytes, workspaceMoveSize(dataDir).bytes, true);
  const tight = await routes({ freeBytes: needed - 1 });
  const refused = await tight.call("POST", "/api/cloud-move/upload", tight.owner, { sha256: "a".repeat(64), bytes });
  expect(refused).toEqual({ status: 507, body: { error: expect.stringMatching(/free space/), freeBytes: needed - 1, neededBytes: needed } });
  expect(uploadStatus(dataDir)).toBeNull();
  server!.close(); server = undefined;
  const roomy = await routes({ freeBytes: needed });
  expect((await roomy.call("POST", "/api/cloud-move/upload", roomy.owner, { sha256: "a".repeat(64), bytes })).status).toBe(200);
});

it("needs a paired admin session on a Cloud home: not the bare loopback, not a client device, not another server", async () => {
  const cloud = await routes();
  expect((await cloud.call("GET", "/api/cloud-move", cloud.owner)).status).toBe(200);
  expect((await cloud.call("GET", "/api/cloud-move")).status).toBe(403);
  expect((await cloud.call("POST", "/api/cloud-move/upload")).status).toBe(403);
  expect((await cloud.call("GET", "/api/cloud-move", cloud.phone)).status).toBe(403);
  expect((await cloud.call("POST", "/api/cloud-move/undo", cloud.phone, {})).status).toBe(403);
  // Every server sizes its own workspace for its desktop; none but a Cloud receives one.
  expect((await cloud.call("GET", "/api/cloud-move/estimate")).status).toBe(200);
  server!.close(); server = undefined;
  const desktop = await routes({ cloudHome: false });
  expect((await desktop.call("GET", "/api/cloud-move", desktop.owner)).status).toBe(404);
  expect((await desktop.call("POST", "/api/cloud-move/upload", desktop.owner, { sha256: "a".repeat(64), bytes: 4096 })).status).toBe(404);
  expect(existsSync(join(dataDir, ".backups", "cloud-move"))).toBe(false);
  expect(desktop.restarts).toEqual([]);
});

it("restores only what its own preview staged", async () => {
  const cloud = await routes();
  const restore = await cloud.call("POST", "/api/cloud-move/restore", cloud.owner, { id: randomUUID() });
  expect(restore.status).toBe(404);
  expect(cloud.restarts).toEqual([]);
  expect(statSync(dataDir).isDirectory()).toBe(true);
});

it("refuses a session without admin scope even if a gate in front let it through", async () => {
  const { Readable } = await import("node:stream");
  const handle = createCloudMoveRoutes({
    dataDir, appVersion: "0.1.90", cloudHome: true, readBody, restored: {}, exclusive: (work) => work(), authorized: () => true,
    status: () => ({ busy: false, pendingRestore: false }), restart: () => { throw new Error("must not restart"); },
  });
  const answer = async (auth: RequestAuth, method: string, path: string) => {
    const req = Object.assign(Readable.from([Buffer.from("{}")]), { method, url: path, headers: { "content-type": "application/json" } }) as unknown as IncomingMessage;
    let status = 0;
    const res = { headersSent: false, setHeader() {}, writeHead(code: number) { status = code; return res; }, end() {}, once() { return res; }, destroy() {} };
    await handle(req, res as never, path, auth);
    return status;
  };
  const session = { id: "s", label: "Phone", scopes: ["client"], createdAt: 0, lastSeenAt: 0, expiresAt: Date.now() + 60_000 };
  const client = { kind: "session", via: "bearer", scopes: ["client"], session } as unknown as RequestAuth;
  for (const [method, path] of [["GET", "/api/cloud-move"], ["POST", "/api/cloud-move/undo"], ["GET", "/api/cloud-move/estimate"]]) {
    expect(await answer(client, method, path)).toBe(403);
  }
  const owner = { ...client, scopes: ["admin", "client"] } as RequestAuth;
  expect(await answer(owner, "GET", "/api/cloud-move")).toBe(200);
});

it("swapping back waits out a moment of activity, then keeps what the Cloud has now as the next previous Cloud, commits and restarts", async () => {
  writeFileSync(join(dataDir, "bots.json"), JSON.stringify([{ id: "one" }, { id: "two" }]));
  const before = randomUUID();
  await prepareNextPreviousCloud(dataDir, before, backup(dataDir));
  tidyCloudMoveStorage(dataDir, { restored: true, id: before });
  writeFileSync(join(dataDir, "bots.json"), JSON.stringify([{ id: "moved" }, { id: "moved-too" }, { id: "and-this" }]));
  let refusals = 2;
  const cloud = await routes({ exclusive: async (work) => {
    if (refusals-- > 0) throw Object.assign(new Error("Wait for bot turns to finish."), { status: 409 });
    return work();
  } });
  expect((await cloud.call("POST", "/api/cloud-move/undo", cloud.owner, {})).status).toBe(202);
  await expect.poll(async () => (await cloud.call("GET", "/api/cloud-move", cloud.owner)).body.job?.state, { timeout: 30_000 }).toBe("done");
  expect(refusals).toBe(-1);
  await expect.poll(() => cloud.restarts.length).toBe(1);
  const pending = JSON.parse(readFileSync(join(dataDir, ".backups", "pending-restore.json"), "utf8")).id;
  // The swap: what the Cloud had becomes the previous Cloud once startup installs the restore.
  const next = JSON.parse(readFileSync(join(dataDir, ".backups", "cloud-previous.next", "previous.json"), "utf8"));
  expect(next).toMatchObject({ forRestore: pending, contents: { bots: 3 } });
}, 60_000);

/** A real encrypted backup of a small desktop workspace. */
async function desktopArchive(marker = "PLAINTEXT-MARKER") {
  writeFileSync(join(desktop, "bots.json"), JSON.stringify([{ id: "a" }, { id: "b" }]));
  mkdirSync(join(desktop, "attachments"), { recursive: true });
  writeFileSync(join(desktop, "attachments", "diary.txt"), `${marker} `.repeat(10_000));
  const created = await createWorkspaceBackupSnapshot(desktop, { password: "fixture password 123", appVersion: "0.1.90" });
  return readFileSync(created.path);
}
async function uploadAndPreview(cloud: Awaited<ReturnType<typeof routes>>, file: Buffer) {
  const digest = sha(file);
  expect((await cloud.call("POST", "/api/cloud-move/upload", cloud.owner, { sha256: digest, bytes: file.length })).status).toBe(200);
  expect((await cloud.call("PUT", `/api/cloud-move/upload/${digest}?offset=0`, cloud.owner, undefined, file)).body).toEqual({ received: file.length });
  expect((await cloud.call("POST", "/api/cloud-move/preview", cloud.owner, { sha256: digest, password: "fixture password 123" })).status).toBe(202);
  await expect.poll(async () => (await cloud.call("GET", "/api/cloud-move", cloud.owner)).body.job?.state, { timeout: 30_000 }).toBe("done");
  return (await cloud.call("GET", "/api/cloud-move", cloud.owner)).body.job.id as string;
}
const stagedJobs = () => readdirSync(join(dataDir, ".backups")).filter((name) => /^[0-9a-f-]{36}$/.test(name));

it("a restore the Cloud cannot start leaves nothing staged behind, and a new upload drops an earlier preview", async () => {
  const file = await desktopArchive();
  // The Cloud's bots never stop working: every attempt at the gate is refused.
  const cloud = await routes({ exclusive: async () => { throw Object.assign(new Error("Wait for bot turns to finish."), { status: 409 }); } });
  const first = await uploadAndPreview(cloud, file);
  expect(stagedJobs()).toEqual([first]);
  expect((await cloud.call("POST", "/api/cloud-move/restore", cloud.owner, { id: first })).status).toBe(202);
  await expect.poll(async () => (await cloud.call("GET", "/api/cloud-move", cloud.owner)).body.job?.state, { timeout: 30_000 }).toBe("failed");
  expect(stagedJobs()).toEqual([]);
  expect(existsSync(join(dataDir, ".backups", "cloud-previous.next"))).toBe(false);
  expect(cloud.restarts).toEqual([]);
  // Previewed, then abandoned: the next upload removes it.
  const second = await uploadAndPreview(cloud, file);
  expect(stagedJobs()).toEqual([second]);
  expect((await cloud.call("POST", "/api/cloud-move/upload", cloud.owner, { sha256: sha(file), bytes: file.length })).status).toBe(200);
  expect(stagedJobs()).toEqual([]);
  expect((await cloud.call("POST", "/api/cloud-move/restore", cloud.owner, { id: second })).status).toBe(404);
}, 120_000);

it("a stopped move's staged files are dropped, even when its preview finishes after the stop", async () => {
  const file = await desktopArchive();
  const cloud = await routes();
  const id = await uploadAndPreview(cloud, file);
  expect((await cloud.call("POST", "/api/cloud-move/discard", cloud.owner, {})).status).toBe(200);
  expect(stagedJobs()).toEqual([]);
  expect((await cloud.call("POST", "/api/cloud-move/restore", cloud.owner, { id })).status).toBe(404);
  // Stopped while the Cloud is still checking the upload.
  const digest = sha(file);
  await cloud.call("POST", "/api/cloud-move/upload", cloud.owner, { sha256: digest, bytes: file.length });
  await cloud.call("PUT", `/api/cloud-move/upload/${digest}?offset=0`, cloud.owner, undefined, file);
  expect((await cloud.call("POST", "/api/cloud-move/preview", cloud.owner, { sha256: digest, password: "fixture password 123" })).status).toBe(202);
  expect((await cloud.call("POST", "/api/cloud-move/discard", cloud.owner, {})).status).toBe(200);
  await expect.poll(async () => (await cloud.call("GET", "/api/cloud-move", cloud.owner)).body.job?.state, { timeout: 30_000 }).toBe("failed");
  expect(stagedJobs()).toEqual([]);
}, 120_000);

it("counts a stored part as space to be freed whichever file it was, so an abandoned upload never blocks the next", async () => {
  const volume = CLOUD_MOVE_SPACE_MARGIN + 40_000_000;
  const used = () => { try { return statSync(join(dataDir, ".backups", "cloud-move", "upload.part")).size; } catch { return 0; } };
  const cloud = await routes({ freeBytes: () => volume - used() });
  const bytes = 12_000_000;
  expect((await cloud.call("POST", "/api/cloud-move/upload", cloud.owner, { sha256: "c".repeat(64), bytes })).status).toBe(200);
  // The connection drops after 10 MB; later a new export (new password, new SHA-256) of the same workspace.
  expect((await cloud.call("PUT", `/api/cloud-move/upload/${"c".repeat(64)}?offset=0`, cloud.owner, undefined, Buffer.alloc(10_000_000))).body).toEqual({ received: 10_000_000 });
  const again = await cloud.call("POST", "/api/cloud-move/upload", cloud.owner, { sha256: "d".repeat(64), bytes });
  expect(again.status, JSON.stringify(again.body)).toBe(200);
  expect(used()).toBe(0);
});

it("swapping back needs room for the previous Cloud and a backup of this one", async () => {
  writeFileSync(join(dataDir, "bots.json"), JSON.stringify([{ id: "one" }, { id: "two" }]));
  const id = randomUUID();
  await prepareNextPreviousCloud(dataDir, id, backup(dataDir));
  tidyCloudMoveStorage(dataDir, { restored: true, id });
  const cloud = await routes({ freeBytes: 1_000 });
  const needed = moveSpaceNeeded(previousCloud(dataDir)!.bytes, workspaceMoveSize(dataDir).bytes, true);
  const refused = await cloud.call("POST", "/api/cloud-move/undo", cloud.owner, {});
  expect(refused).toEqual({ status: 507, body: { error: expect.stringMatching(/free space/), freeBytes: 1_000, neededBytes: needed } });
  expect(existsSync(join(dataDir, ".backups", "cloud-previous.next"))).toBe(false);
}, 60_000);

it("reports what backups hold on the volume", async () => {
  writeFileSync(join(dataDir, "bots.json"), JSON.stringify([{ id: "one" }, { id: "two" }]));
  const id = randomUUID();
  await prepareNextPreviousCloud(dataDir, id, backup(dataDir));
  tidyCloudMoveStorage(dataDir, { restored: true, id });
  const cloud = await routes();
  const status = (await cloud.call("GET", "/api/cloud-move", cloud.owner)).body;
  expect(status.previous.bytes).toBeGreaterThan(0);
  expect(status.heldBytes).toBeGreaterThanOrEqual(status.previous.bytes);
}, 60_000);
