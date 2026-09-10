import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { WORKSPACE_BACKUP_CLIENT_KEYS } from "../shared/workspace-backup-client.ts";
import {
  createWorkspaceBackup, stageWorkspaceBackup, commitPendingWorkspaceRestore,
  MAX_WORKSPACE_BACKUP_UPLOAD_BYTES,
  removeWorkspaceBackupJob,
  type WorkspaceBackupSummary,
} from "./workspace-backup.ts";
import type { RequestAuth } from "./request-auth.ts";

const PREFIX = "/api/workspace-backup";
const MAX_UPLOAD_BYTES = MAX_WORKSPACE_BACKUP_UPLOAD_BYTES;
const MAX_CLIENT_STATE_BYTES = 2 * 1024 ** 2;
const EXPIRES_MS = 60 * 60_000;
const passwordSchema = z.string().min(12, "Use a password of at least 12 characters.").max(1024);
const failure = (message: string, status = 400) => Object.assign(new Error(message), { status });
type Artifact = { owner: string; kind: "download" | "upload" | "staged"; path?: string; expires: number; summary?: WorkspaceBackupSummary };
type RestoreResult = { id?: string; restored?: boolean; safetyCopyPath?: string; clientState?: Record<string, string> };

/** Session-only controls remain usable while the workspace is locked. Their
 * excluded session file is not part of the snapshot or replacement. */
export function isWorkspaceBackupSessionControl(method: string, path: string): boolean {
  return (method === "GET" && path === "/api/auth/sessions") ||
    (method === "POST" && path === "/api/auth/logout") ||
    (method === "DELETE" && /^\/api\/auth\/sessions\/[\w-]+$/.test(path));
}

/** All routes remain admin-only in request-auth. Passwords and raw credential
 * metadata never appear in URLs, responses, logs, or event broadcasts. */
export function createWorkspaceBackupRoutes(options: {
  dataDir: string;
  appVersion: string;
  readBody: (req: IncomingMessage, limit?: number) => Promise<unknown>;
  exclusive: <T>(work: () => Promise<T>, keepLocked?: boolean) => Promise<T>;
  authorized: (req: IncomingMessage, auth: RequestAuth) => boolean;
  status: () => { busy: boolean; pendingRestore: boolean };
  restored: RestoreResult;
}) {
  // ponytail: one bounded set per server; transfers expire after an hour.
  const artifacts = new Map<string, Artifact>();
  let operating = false;
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  const owner = (auth: RequestAuth) => auth.kind === "session" ? auth.session.id : "local-owner";
  const check = (req: IncomingMessage, auth: RequestAuth) => {
    if (!options.authorized(req, auth)) throw failure("Your session changed. Reopen Backups and try again.", 403);
  };
  function remove(id: string, artifact: Artifact) {
    if (artifact.path) { try { unlinkSync(artifact.path); } catch {} }
    if (artifact.kind !== "upload") { try { removeWorkspaceBackupJob(options.dataDir, id); } catch { /* Recovery jobs are deliberately protected. */ } }
    artifacts.delete(id);
  }
  // A crashed process has no in-memory transfer map. Reclaim only its old,
  // app-named jobs; never safety copies or pending/committed recovery state.
  function reclaimAbandoned() {
    const root = join(options.dataDir, ".backups");
    if (!existsSync(root) || lstatSync(root).isSymbolicLink()) return;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
      if (statSync(join(root, entry.name)).mtimeMs + EXPIRES_MS > Date.now()) continue;
      try { removeWorkspaceBackupJob(options.dataDir, entry.name); } catch { /* May belong to a recoverable restore. */ }
    }
    const uploads = join(root, "uploads");
    if (!existsSync(uploads) || lstatSync(uploads).isSymbolicLink()) return;
    for (const entry of readdirSync(uploads, { withFileTypes: true })) {
      if (!entry.isFile() || !/^[a-f0-9-]{36}\.ombbackup$/.test(entry.name)) continue;
      const file = join(uploads, entry.name);
      if (statSync(file).mtimeMs + EXPIRES_MS <= Date.now()) { try { unlinkSync(file); } catch {} }
    }
  }
  try { reclaimAbandoned(); } catch { /* Temporary-file cleanup must not prevent normal server startup. */ }
  function expire() {
    for (const [id, artifact] of artifacts) {
      if (artifact.expires > Date.now()) continue;
      remove(id, artifact);
    }
  }
  function replacePrevious(auth: RequestAuth, kinds: Artifact["kind"][]) {
    expire();
    for (const [id, artifact] of artifacts) if (artifact.owner === owner(auth) && kinds.includes(artifact.kind)) remove(id, artifact);
  }
  const get = (id: unknown, auth: RequestAuth, kind: Artifact["kind"]) => {
    expire();
    const artifact = typeof id === "string" ? artifacts.get(id) : undefined;
    if (!artifact || artifact.owner !== owner(auth) || artifact.kind !== kind) {
      throw failure("This backup has expired or belongs to another session. Select the file again.", 404);
    }
    return artifact;
  };
  async function operate<T>(work: () => Promise<T>): Promise<T> {
    if (operating) throw failure("Another backup operation is in progress. Wait for it to finish.", 409);
    operating = true;
    try { return await work(); } finally { operating = false; }
  }
  return async (req: IncomingMessage, res: ServerResponse, path: string, auth: RequestAuth): Promise<boolean> => {
    if (!path.startsWith(`${PREFIX}/`)) return false;
    res.setHeader("cache-control", "no-store");
    const method = req.method;
    try {
      check(req, auth);
      if (method === "GET" && path === `${PREFIX}/status`) {
        json(res, 200, {
          ...options.status(),
          lastRestoreId: options.restored.restored ? options.restored.id : null,
          safetyCopyPath: options.restored.safetyCopyPath ?? null,
        });
        return true;
      }
      if (method === "POST" && path === `${PREFIX}/client-state`) {
        const body = z.object({ restoreId: z.string().uuid() }).parse(await options.readBody(req));
        check(req, auth);
        if (!options.restored.restored || body.restoreId !== options.restored.id) throw failure("This restore has not completed. Restart OpenMausBot first.", 409);
        json(res, 200, { clientState: options.restored.clientState ?? {} });
        return true;
      }
      if (method === "POST" && path === `${PREFIX}/export`) {
        // Allow the full preference budget plus the JSON envelope/password.
        const body = z.object({ password: passwordSchema, clientState: z.record(z.string(), z.string()).default({}) }).parse(await options.readBody(req, MAX_CLIENT_STATE_BYTES + 8 * 1024));
        if (Buffer.byteLength(JSON.stringify(body.clientState)) > MAX_CLIENT_STATE_BYTES) throw failure("Saved drafts exceed the 2 MB backup preference limit.", 413);
        const clientState = Object.fromEntries(Object.entries(body.clientState).filter(([key]) => WORKSPACE_BACKUP_CLIENT_KEYS.includes(key as typeof WORKSPACE_BACKUP_CLIENT_KEYS[number])));
        const result = await operate(() => options.exclusive(async () => {
          check(req, auth);
          replacePrevious(auth, ["download"]);
          if (artifacts.size >= 4) throw failure("There are already four backup files in progress. Restart or wait an hour before creating another.", 409);
          return createWorkspaceBackup(options.dataDir, { password: body.password, clientState, appVersion: options.appVersion });
        }));
        try { check(req, auth); } catch (error) { removeWorkspaceBackupJob(options.dataDir, result.id); throw error; }
        artifacts.set(result.id, { owner: owner(auth), kind: "download", path: result.path, summary: result.summary, expires: Date.now() + EXPIRES_MS });
        json(res, 200, { id: result.id, filename: `OpenMausBot-${result.summary.createdAt.slice(0, 10)}.ombbackup`, bytes: statSync(result.path).size, summary: result.summary });
        return true;
      }
      const download = /^\/api\/workspace-backup\/download\/([\w-]+)$/.exec(path);
      if (method === "GET" && download) {
        const artifact = get(download[1], auth, "download");
        const file = artifact.path!;
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": statSync(file).size,
          "content-disposition": `attachment; filename="OpenMausBot-${artifact.summary!.createdAt.slice(0, 10)}.ombbackup"`,
          "x-content-type-options": "nosniff",
        });
        await pipeline(createReadStream(file), res);
        return true;
      }
      if (method === "POST" && path === `${PREFIX}/upload`) {
        await operate(async () => {
          const length = Number(req.headers["content-length"]);
          if (!Number.isSafeInteger(length) || length <= 0 || length > MAX_UPLOAD_BYTES) throw failure("Select a backup containing no more than 10 GB of workspace data.", 413);
          replacePrevious(auth, ["upload", "staged"]);
          if (artifacts.size >= 4) throw failure("There are already four backup files in progress. Restart or wait an hour before uploading another.", 409);
          const root = join(options.dataDir, ".backups");
          mkdirSync(root, { recursive: true, mode: 0o700 });
          if (lstatSync(root).isSymbolicLink()) throw failure("Backup storage must not be a symbolic link.");
          const directory = join(root, "uploads");
          mkdirSync(directory, { recursive: true, mode: 0o700 });
          if (lstatSync(directory).isSymbolicLink()) throw failure("Backup storage must not be a symbolic link.");
          const id = randomUUID();
          const file = join(directory, `${id}.ombbackup`);
          let bytes = 0;
          try {
            const limit = new Transform({ transform(chunk, _encoding, callback) {
              bytes += chunk.length;
              callback(bytes > MAX_UPLOAD_BYTES ? failure("The backup is too large.", 413) : null, chunk);
            } });
            await pipeline(req.iterator({ destroyOnReturn: false }), limit, createWriteStream(file, { flags: "wx", mode: 0o600 }));
            if (bytes !== length) throw failure("The upload was incomplete. Select the file again.");
            check(req, auth);
            artifacts.set(id, { owner: owner(auth), kind: "upload", path: file, expires: Date.now() + EXPIRES_MS });
            json(res, 200, { id });
          } catch (error) { try { unlinkSync(file); } catch {} throw error; }
        });
        return true;
      }
      if (method === "POST" && path === `${PREFIX}/preview`) {
        const body = z.object({ id: z.string().uuid(), password: passwordSchema }).parse(await options.readBody(req));
        const artifact = get(body.id, auth, "upload");
        const result = await operate(() => stageWorkspaceBackup(options.dataDir, artifact.path!, { password: body.password, currentAppVersion: options.appVersion }));
        try { check(req, auth); } catch (error) { removeWorkspaceBackupJob(options.dataDir, result.id); throw error; }
        try { unlinkSync(artifact.path!); } catch {}
        artifacts.delete(body.id);
        artifacts.set(result.id, { owner: owner(auth), kind: "staged", summary: result.summary, expires: Date.now() + EXPIRES_MS });
        json(res, 200, { id: result.id, summary: result.summary });
        return true;
      }
      if (method === "POST" && path === `${PREFIX}/restore`) {
        const body = z.object({ id: z.string().uuid(), confirmation: z.literal("REPLACE") }).parse(await options.readBody(req));
        get(body.id, auth, "staged");
        const result = await operate(() => options.exclusive(async () => {
          check(req, auth);
          return commitPendingWorkspaceRestore(options.dataDir, body.id);
        }, true));
        artifacts.delete(body.id);
        json(res, 200, { ...result, restoreId: body.id });
        return true;
      }
      json(res, 404, { error: "Unknown backup operation." });
    } catch (error) {
      if (res.headersSent) { res.destroy(); return true; }
      json(res, error instanceof z.ZodError ? 400 : (error as { status?: number }).status ?? 400, {
        error: error instanceof z.ZodError ? error.issues[0]?.message ?? "Invalid backup request." : error instanceof Error ? error.message : "Backup failed.",
      });
    }
    return true;
  };
}
