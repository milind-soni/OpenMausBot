// Real HTTP/auth/maintenance and disposable files; archive work is mocked so
// revocation can be held at a deterministic boundary. The archive/restart
// workflow is covered separately by workspace-backup-workflow.test.ts.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WorkspaceBackupSummary } from "../shared/workspace-backup.ts";
import { resolveRequestAuth } from "./request-auth.ts";
import { SessionRegistry } from "./sessions.ts";
import { WorkspaceBackupMaintenance } from "./workspace-backup-maintenance.ts";

const archive = vi.hoisted(() => ({ create: vi.fn(), stage: vi.fn(), commit: vi.fn(), remove: vi.fn() }));
vi.mock("./workspace-backup.ts", async (original) => ({
  ...await original<typeof import("./workspace-backup.ts")>(),
  createWorkspaceBackup: archive.create, stageWorkspaceBackup: archive.stage,
  commitPendingWorkspaceRestore: archive.commit, removeWorkspaceBackupJob: archive.remove,
}));
import { createWorkspaceBackupRoutes, isWorkspaceBackupSessionControl } from "./workspace-backup-http.ts";

const PASSWORD = "fixture password 123";
let dataDir: string;
let server: Server;
let url: string;
let sessions: SessionRegistry;
let maintenance: WorkspaceBackupMaintenance;
let admin: ReturnType<SessionRegistry["issue"]>;

function fakeArchive() {
  const id = randomUUID();
  const directory = join(dataDir, ".backups", id);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "workspace.ombbackup");
  writeFileSync(path, "fixture encrypted bytes", { mode: 0o600 });
  const summary: WorkspaceBackupSummary = { format: "openmaus.workspace-backup", version: 1, id, createdAt: "2026-09-11T00:00:00Z", appVersion: "0.1.71", files: 1, directories: 0, bytes: 23, bots: 0, groups: 0, threads: 0, messages: 0, exclusions: [], warnings: [] };
  return { id, path, summary };
}

beforeEach(async () => {
  vi.resetAllMocks();
  dataDir = mkdtempSync(join(tmpdir(), "omb-backup-http-"));
  maintenance = new WorkspaceBackupMaintenance();
  sessions = new SessionRegistry({ file: join(dataDir, "sessions.json") });
  admin = sessions.issue({ label: "Fixture admin", scopes: ["admin", "client"] });
  archive.create.mockImplementation(async () => fakeArchive());
  archive.stage.mockImplementation(async () => fakeArchive());
  archive.commit.mockImplementation((_dataDir: string, id: string) => ({ id, restartRequired: true }));
  archive.remove.mockImplementation((_dataDir: string, id: string) => rmSync(join(dataDir, ".backups", id), { recursive: true, force: true }));
  const authenticate = (req: IncomingMessage) => resolveRequestAuth(req, { sessions, cookieName: "fixture", streamPath: "/api/events", url: new URL(req.url!, url) });
  const routes = createWorkspaceBackupRoutes({
    dataDir, appVersion: "0.1.71", restored: {},
    readBody: async (req, limit = 1_000_000) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        bytes += chunk.length;
        if (bytes > limit) throw Object.assign(new Error("body too large"), { status: 413 });
        chunks.push(chunk);
      }
      return JSON.parse(Buffer.concat(chunks).toString() || "{}");
    },
    authorized: (req, original) => {
      const current = authenticate(req).auth;
      return Boolean(current?.scopes.includes("admin") && current.kind === original.kind &&
        (current.kind !== "session" || (original.kind === "session" && current.session.id === original.session.id)));
    },
    status: () => ({ busy: maintenance.active, pendingRestore: maintenance.pendingRestore }),
    exclusive: (work, keepLocked) => maintenance.run(work, { idle: () => true, pause: () => {}, resume: () => {}, flush: async () => {} }, keepLocked),
  });
  server = createServer(async (req, res) => {
    const path = new URL(req.url!, url).pathname;
    const method = req.method!;
    const json = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    let release: (() => void) | undefined;
    try {
      const gate = authenticate(req);
      if (!gate.auth) return json(gate.status, { error: gate.error });
      if (await routes(req, res, path, gate.auth)) return;
      if (!isWorkspaceBackupSessionControl(method, path)) release = maintenance.request();
      if (method === "GET" && path === "/api/auth/sessions") return json(200, { sessions: sessions.list() });
      if (method === "POST" && path === "/api/auth/logout") {
        if (gate.auth.kind === "session") sessions.revoke(gate.auth.session.id);
        return json(200, { ok: true });
      }
      if (method === "DELETE" && /^\/api\/auth\/sessions\/[\w-]+$/.test(path)) return json(200, { ok: sessions.revoke(path.split("/").at(-1)!) });
      json(404, { error: "Fixture route not found" });
    } catch (error) { json((error as { status?: number }).status ?? 500, { error: error instanceof Error ? error.message : String(error) }); }
    finally { release?.(); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not listen");
  url = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  server?.closeAllConnections();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dataDir, { recursive: true, force: true });
});

function post(path: string, body: unknown, token = admin.token) {
  return fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
}

it.each(["revoke", "logout"])("keeps session controls authenticated and usable during a held export (%s)", async (action) => {
  let started!: () => void;
  let release!: () => void;
  const starting = new Promise<void>((resolve) => { started = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const output = fakeArchive();
  archive.create.mockImplementationOnce(async () => { started(); await held; return output; });
  const exporting = post("/api/workspace-backup/export", { password: PASSWORD });
  try {
    await starting;
    expect(maintenance.active).toBe(true);
    const member = sessions.issue({ label: "Fixture member", scopes: ["client"] });
    expect((await fetch(`${url}/api/auth/sessions`, { headers: { authorization: `Bearer ${member.token}` } })).status).toBe(403);
    expect((await fetch(`${url}/api/auth/sessions`)).status).toBe(200);
    expect((await fetch(`${url}/api/bots`)).status).toBe(503);
    const response = action === "logout"
      ? await post("/api/auth/logout", {})
      : await fetch(`${url}/api/auth/sessions/${admin.session.id}`, { method: "DELETE" });
    expect(response.status).toBe(200);
  } finally { release(); }
  expect((await exporting).status).toBe(403);
  expect(archive.remove).toHaveBeenCalledWith(dataDir, output.id);
  expect(existsSync(join(dataDir, ".backups", output.id))).toBe(false);
  expect(maintenance.active).toBe(false);
});

it("does not broaden maintenance exemptions beyond the three exact session routes", () => {
  for (const [method, path] of [["GET", "/api/auth/sessions"], ["POST", "/api/auth/logout"], ["DELETE", "/api/auth/sessions/fixture-id"]]) expect(isWorkspaceBackupSessionControl(method, path)).toBe(true);
  for (const [method, path] of [["POST", "/api/auth/sessions"], ["GET", "/api/auth/logout"], ["DELETE", "/api/auth/sessions"], ["DELETE", "/api/auth/sessions/id/extra"], ["GET", "/api/auth/sessions/"], ["POST", "/api/auth/pairing"], ["PATCH", "/api/settings"]]) expect(isWorkspaceBackupSessionControl(method, path)).toBe(false);
});

it("keeps a validated stage after rejecting a malformed or oversized upload", async () => {
  const uploaded = await fetch(`${url}/api/workspace-backup/upload`, { method: "POST", headers: { authorization: `Bearer ${admin.token}` }, body: "fixture bytes" }).then((response) => response.json()) as { id: string };
  const preview = await post("/api/workspace-backup/preview", { id: uploaded.id, password: PASSWORD }).then((response) => response.json()) as { id: string };
  for (const length of ["0", String(11 * 1024 ** 3)]) {
    const status = await new Promise<number>((resolve, reject) => {
      const upload = request(`${url}/api/workspace-backup/upload`, { method: "POST", headers: { authorization: `Bearer ${admin.token}`, "content-length": length }, signal: AbortSignal.timeout(5000) }, (response) => { response.resume(); resolve(response.statusCode!); });
      upload.on("error", reject);
      upload.end();
    });
    expect(status).toBe(413);
    expect(existsSync(join(dataDir, ".backups", preview.id))).toBe(true);
  }
  expect((await post("/api/workspace-backup/restore", { id: preview.id, confirmation: "REPLACE" })).status).toBe(200);
  expect(archive.commit).toHaveBeenCalledWith(dataDir, preview.id);
});

it("accepts drafts between 1 and 2 MiB and enforces the preference cap in UTF-8 bytes", async () => {
  const clientState = { "omb-drafts": "a".repeat(1536 * 1024) };
  expect((await post("/api/workspace-backup/export", { password: PASSWORD, clientState })).status).toBe(200);
  expect(archive.create.mock.calls[0][1].clientState).toEqual(clientState);
  // Fits the request framing allowance but exceeds the preference byte cap;
  // JavaScript string.length alone would accept it.
  const tooLarge = { "omb-drafts": "é".repeat(1024 ** 2) };
  const rejected = await post("/api/workspace-backup/export", { password: PASSWORD, clientState: tooLarge });
  expect(rejected.status).toBe(413);
  expect((await rejected.json() as { error: string }).error).toContain("2 MB backup preference limit");
  expect(archive.create).toHaveBeenCalledOnce();
  expect(readdirSync(join(dataDir, ".backups"))).toHaveLength(1);
});
