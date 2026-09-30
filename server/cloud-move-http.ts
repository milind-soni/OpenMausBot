// Move to Cloud's routes (server/cloud-move.ts, docs/cloud-pro.md).
//
//   GET  /api/cloud-move/estimate   any server: what a move of this workspace carries
//   GET  /api/cloud-move            Cloud home: contents, free space, upload, job, previous Cloud
//   POST /api/cloud-move/upload     start or continue an upload {sha256, bytes, files}
//   PUT  /api/cloud-move/upload/<sha256>?offset=n   one part
//   POST /api/cloud-move/preview    {sha256, password}: check it is a valid backup and stage it
//   POST /api/cloud-move/restore    {id}: back up the Cloud, restore, restart
//   POST /api/cloud-move/undo       swap back to the previous Cloud, restart
//   POST /api/cloud-move/discard    drop what a stopped move staged
//
// Preview, restore and undo can take minutes on a large workspace, longer
// than a proxy keeps a quiet request open, so each starts one job (202) and
// the app follows it in GET /api/cloud-move.
//
// Every Cloud route needs a paired session with admin scope, and refuses a
// client-scope device and the machine's own loopback. That is not a wall
// against the machine itself: a process there runs as the same user, can
// already read and write /data, and could pair itself as the owner. Nothing
// here logs a body, a password or a file name.
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  backupsBytes, beginUpload, CLOUD_MOVE_MAX_BYTES, CLOUD_MOVE_MAX_PART_BYTES, CLOUD_MOVE_PART_BYTES, completedUpload, discardNextPreviousCloud,
  discardUpload, forgetMoveRestore, freeVolumeBytes, isEmptyWorkspace, moveSpaceNeeded, noteMoveRestore, prepareNextPreviousCloud,
  previousCloud, previousCloudArchiveBytes, removeMoveFiles, stagePreviousCloud, tidyCloudMoveStorage, uploadStatus, validUploadDeclaration,
  workspaceContents, workspaceMoveSize, writeUploadPart, type PreviousCloud,
} from "./cloud-move.ts";
import { commitPendingWorkspaceRestore, createWorkspaceBackup, stageWorkspaceBackup } from "./workspace-backup.ts";
import type { RequestAuth } from "./request-auth.ts";

export const CLOUD_MOVE_PREFIX = "/api/cloud-move";
const failure = (message: string, status: number) => Object.assign(new Error(message), { status });
const HELD_CACHE_MS = 30_000;

type MoveSummary = { appVersion: string; files: number; bytes: number; bots: number; groups: number; threads: number; messages: number };
export type CloudMoveJob =
  | { kind: "preview" | "restore" | "undo"; state: "running" }
  | { kind: "preview"; state: "done"; id: string; summary: MoveSummary }
  | { kind: "restore" | "undo"; state: "done"; id: string; previous?: Omit<PreviousCloud, "bytes"> | null }
  | { kind: "preview" | "restore" | "undo"; state: "failed"; error: string };

export function createCloudMoveRoutes(options: {
  dataDir: string;
  appVersion: string;
  /** Only an OMB Cloud home receives a move. */
  cloudHome: boolean;
  readBody: (req: IncomingMessage, limit?: number) => Promise<unknown>;
  /** The workspace-backup maintenance gate (quiet bots, writers flushed). */
  exclusive: <T>(work: () => Promise<T>, keepLocked?: boolean) => Promise<T>;
  /** The request's session is still live and still admin. */
  authorized: (req: IncomingMessage, auth: RequestAuth) => boolean;
  status: () => { busy: boolean; pendingRestore: boolean };
  /** What this boot's restore did, for the app waiting on the restart. */
  restored: { id?: string; restored?: boolean; rolledBack?: boolean; safetyCopyPath?: string };
  /** Stop so the launcher starts this server again; startup installs the restore. */
  restart: () => void;
  freeBytes?: (path: string) => number;
  restartDelayMs?: number;
  gateRetryMs?: number;
}) {
  const freeBytes = options.freeBytes ?? freeVolumeBytes;
  // A move's restore that startup has installed keeps no safety copy or
  // staged files; an abandoned upload goes after a day.
  if (options.cloudHome) {
    try { tidyCloudMoveStorage(options.dataDir, options.restored); } catch (error) {
      console.warn(`cloud move: could not tidy backup storage (${error instanceof Error ? error.message : "unknown"})`);
    }
  }
  // Staged here by a preview; restore accepts nothing else.
  const staged = new Set<string>();
  let job: CloudMoveJob | null = null;
  let writing = false, discardPreview = false;
  let held: { at: number; bytes: number } | null = null;
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  const check = (req: IncomingMessage, auth: RequestAuth) => {
    if (!options.authorized(req, auth)) throw failure("Your session changed. Start the move again.", 403);
  };
  const ready = () => {
    if (job?.state === "running" || writing) throw failure("Another move step is running on your Cloud. Wait for it to finish.", 409);
    const status = options.status();
    if (status.pendingRestore) throw failure("Your Cloud is restarting to finish a restore. Try again in a minute.", 409);
    if (status.busy) throw failure("Your Cloud is busy with a backup. Try again when it finishes.", 409);
  };
  /** Delete what earlier previews staged and no restore took. */
  const dropStaged = () => {
    for (const id of staged) removeMoveFiles(options.dataDir, id);
    staged.clear();
    if (job?.kind === "preview" && job.state === "done") job = null;
  };
  function start(kind: CloudMoveJob["kind"], work: () => Promise<CloudMoveJob>, after?: (result: CloudMoveJob) => void) {
    const current: CloudMoveJob = { kind, state: "running" };
    job = current;
    held = null;
    void work().then((result) => {
      if (job !== current) return;
      job = result;
      after?.(result);
    }, (error: unknown) => {
      if (job === current) job = { kind, state: "failed", error: error instanceof Error ? error.message : "The move could not finish." };
    });
  }
  // A person's own page can hold the workspace gate for a moment (an ordinary
  // request in flight); try the gate a few times before giving up.
  const quietly = async <T>(work: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      try { return await options.exclusive(work, true); } catch (error) {
        if (attempt >= 4 || (error as { status?: number }).status !== 409) throw error;
        await new Promise((resolve) => setTimeout(resolve, options.gateRetryMs ?? 2_000));
      }
    }
  };
  /** Back up the workspace about to be replaced, then commit `id`. On any
   * failure nothing is left behind: not the new backup, not the staged files. */
  async function replaceWith(id: string, req: IncomingMessage, auth: RequestAuth) {
    noteMoveRestore(options.dataDir, id);
    try {
      return await quietly(async () => {
        check(req, auth);
        const previous = await prepareNextPreviousCloud(options.dataDir, id, (password) =>
          createWorkspaceBackup(options.dataDir, { password, appVersion: options.appVersion }));
        return { committed: commitPendingWorkspaceRestore(options.dataDir, id), previous };
      });
    } catch (error) {
      discardNextPreviousCloud(options.dataDir);
      forgetMoveRestore(options.dataDir, id);
      removeMoveFiles(options.dataDir, id);
      throw error;
    } finally { staged.delete(id); }
  }
  /** Room for staging `archive` bytes and installing them, plus a backup of the
   * workspace they replace; 507 with both numbers otherwise. */
  const roomFor = (archive: number, already = 0) => {
    const needed = moveSpaceNeeded(archive, workspaceMoveSize(options.dataDir).bytes, true) - already;
    const free = freeBytes(options.dataDir);
    return free >= needed ? null : { error: "Your Cloud does not have enough free space for this.", freeBytes: free, neededBytes: needed };
  };
  // The answer that the restore is ready goes out first; then the launcher
  // starts the server again, and startup installs the restore before anything else loads.
  const restartSoon = () => { setTimeout(() => options.restart(), options.restartDelayMs ?? 1_500).unref?.(); };

  return async (req: IncomingMessage, res: ServerResponse, path: string, auth: RequestAuth): Promise<boolean> => {
    if (path !== CLOUD_MOVE_PREFIX && !path.startsWith(`${CLOUD_MOVE_PREFIX}/`)) return false;
    const method = req.method ?? "GET";
    try {
      if (!auth.scopes.includes("admin")) throw failure("Only the owner can move a workspace.", 403);
      if (method === "GET" && path === `${CLOUD_MOVE_PREFIX}/estimate`) {
        json(res, 200, { ...workspaceContents(options.dataDir), ...workspaceMoveSize(options.dataDir), maxBytes: CLOUD_MOVE_MAX_BYTES });
        return true;
      }
      if (!options.cloudHome) throw failure("Only an OMB Cloud home receives a moved workspace.", 404);
      if (auth.kind !== "session") throw failure("Move to Cloud needs the owner's signed-in app.", 403);
      check(req, auth);
      if (method === "GET" && path === CLOUD_MOVE_PREFIX) {
        const contents = workspaceContents(options.dataDir);
        if (!held || held.at + HELD_CACHE_MS < Date.now()) held = { at: Date.now(), bytes: backupsBytes(options.dataDir) };
        json(res, 200, {
          contents, empty: isEmptyWorkspace(contents), freeBytes: freeBytes(options.dataDir), maxBytes: CLOUD_MOVE_MAX_BYTES,
          partBytes: CLOUD_MOVE_PART_BYTES, upload: uploadStatus(options.dataDir), previous: previousCloud(options.dataDir), job,
          // What backups and the previous Cloud hold on the volume.
          heldBytes: held.bytes,
          ...options.status(),
          lastRestoreId: options.restored.restored ? options.restored.id ?? null : null,
          rolledBackId: options.restored.rolledBack ? options.restored.id ?? null : null,
        });
        return true;
      }
      if (method === "POST" && path === `${CLOUD_MOVE_PREFIX}/upload`) {
        const declared = validUploadDeclaration(z.object({ sha256: z.unknown(), bytes: z.unknown(), files: z.unknown().optional() }).parse(await options.readBody(req, 4096)));
        ready();
        // A new upload ends any earlier attempt: its staged files go, and a
        // stored part (whichever file it was) counts as space about to be freed.
        dropStaged();
        const refused = roomFor(declared.bytes, uploadStatus(options.dataDir)?.received ?? 0);
        if (refused) { json(res, 507, refused); return true; }
        check(req, auth);
        held = null;
        json(res, 200, { ...beginUpload(options.dataDir, declared), partBytes: CLOUD_MOVE_PART_BYTES });
        return true;
      }
      const part = /^\/api\/cloud-move\/upload\/([a-f0-9]{64})$/.exec(path);
      if (method === "PUT" && part) {
        const offset = Number(new URL(req.url ?? "/", "http://cloud-move.invalid").searchParams.get("offset"));
        const length = Number(req.headers["content-length"]);
        if (!Number.isSafeInteger(length) || length <= 0 || length > CLOUD_MOVE_MAX_PART_BYTES) throw failure("Send each part with its length, at most 64 MB.", 411);
        ready();
        writing = true;
        let received: number;
        try { received = await writeUploadPart(options.dataDir, part[1], offset, length, req.iterator({ destroyOnReturn: false }) as AsyncIterable<Buffer>); }
        finally { writing = false; }
        json(res, 200, { received });
        return true;
      }
      if (method === "POST" && path === `${CLOUD_MOVE_PREFIX}/preview`) {
        const body = z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/), password: z.string().min(12).max(1024) }).parse(await options.readBody(req, 8192));
        ready();
        discardPreview = false;
        start("preview", async () => {
          const file = await completedUpload(options.dataDir, body.sha256);
          let result;
          try {
            result = await stageWorkspaceBackup(options.dataDir, file, { password: body.password, currentAppVersion: options.appVersion });
          } finally { discardUpload(options.dataDir); }
          if (discardPreview) {
            removeMoveFiles(options.dataDir, result.id);
            throw failure("The move was stopped; what it staged was removed.", 409);
          }
          try { check(req, auth); } catch (error) { removeMoveFiles(options.dataDir, result.id); throw error; }
          staged.add(result.id);
          const { summary } = result;
          return { kind: "preview", state: "done", id: result.id, summary: {
            appVersion: summary.appVersion, files: summary.files, bytes: summary.bytes, bots: summary.bots,
            groups: summary.groups, threads: summary.threads, messages: summary.messages,
          } };
        });
        json(res, 202, { job });
        return true;
      }
      if (method === "POST" && path === `${CLOUD_MOVE_PREFIX}/discard`) {
        await options.readBody(req, 4096);
        if (job?.state === "running" && job.kind !== "preview") throw failure("Your Cloud is already replacing its workspace.", 409);
        // A preview still running removes what it stages when it ends.
        if (job?.state === "running") discardPreview = true;
        dropStaged();
        held = null;
        json(res, 200, { ok: true });
        return true;
      }
      if (method === "POST" && path === `${CLOUD_MOVE_PREFIX}/restore`) {
        const body = z.object({ id: z.string().uuid() }).parse(await options.readBody(req, 4096));
        ready();
        if (!staged.has(body.id)) throw failure("This move is no longer ready on your Cloud. Start it again.", 404);
        start("restore", async () => {
          const { committed, previous } = await replaceWith(body.id, req, auth);
          return { kind: "restore", state: "done", id: committed.id, previous };
        }, restartSoon);
        json(res, 202, { job });
        return true;
      }
      if (method === "POST" && path === `${CLOUD_MOVE_PREFIX}/undo`) {
        await options.readBody(req, 4096);
        ready();
        if (!previousCloud(options.dataDir)) throw failure("There is no previous Cloud to restore.", 404);
        const refused = roomFor(previousCloudArchiveBytes(options.dataDir));
        if (refused) { json(res, 507, refused); return true; }
        dropStaged();
        // A swap: what the Cloud has now becomes the previous Cloud, so this
        // can be undone the same way.
        start("undo", async () => {
          const prepared = await stagePreviousCloud(options.dataDir, options.appVersion);
          const { committed, previous } = await replaceWith(prepared.id, req, auth);
          return { kind: "undo", state: "done", id: committed.id, previous };
        }, restartSoon);
        json(res, 202, { job });
        return true;
      }
      json(res, 404, { error: "Unknown move operation." });
    } catch (error) {
      if (res.headersSent) { res.destroy(); return true; }
      const status = error instanceof z.ZodError ? 400 : (error as { status?: number }).status ?? 400;
      const received = (error as { received?: unknown }).received;
      json(res, status, {
        error: error instanceof z.ZodError ? "Invalid move request." : error instanceof Error ? error.message : "The move failed.",
        ...(Number.isSafeInteger(received) ? { received } : {}),
      });
    }
    return true;
  };
}
