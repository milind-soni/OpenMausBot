// /api/sync: Files with the owner's desktop, on a Cloud home only. Listed in ROUTES (table.ts): the service is built from
// the data folder on first use; index.ts only says when a bot's turn ends (`noteSyncBotTurn`).
import { createReadStream } from "node:fs";
import { cloudHomeConfigured } from "../cloud-home.ts";
import { DATA_DIR } from "../config.ts";
import { SyncError, createCloudSync, type CloudSync } from "../cloud-sync.ts";
import { createLentCopies, type LentCopies } from "../lent-copies.ts";
import { createLentClones, type LentClones } from "../lent-clone.ts";
import { answerAsleep, cloudPowerNow, type CloudPower } from "../cloud-power.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteContext, type RouteHandler } from "./table.ts";

const FOLDER = String.raw`([\w-]{1,200})`;
const UPLOAD = String.raw`([0-9a-f-]{36})`;

export function createCloudSyncRoutes(options: {
  dataDir: string;
  cloudHome: () => boolean;
  root?: string;
  statfs?: (path: string) => { totalBytes: number; freeBytes: number };
  /** A Cloud home that agreed to sleep answers the desktop's held changes poll "asleep" (server/cloud-power.ts). */
  power?: () => Pick<CloudPower, "sleeping" | "sleepSignal"> | null;
  /** Lent folders' copies and the changes waiting for their computer (server/lent-copies.ts). */
  lent?: LentCopies;
  /** A lent GitHub repository's copy, started as a clone (server/lent-clone.ts). */
  clones?: LentClones;
}): RouteHandler & { close(): void; noteBotTurn(botId: string, threadId: string): void; showFolders(shown: FolderFilter): void; lent: LentCopies; idle(): Promise<void> } {
  let sync: CloudSync | null = null;
  let folderFilter: FolderFilter = () => () => true;
  const service = () => sync ??= createCloudSync({ dataDir: options.dataDir, root: options.root, statfs: options.statfs });
  const lent = options.lent ?? createLentCopies({ dataDir: options.dataDir });
  // Built on first use too: its restart sweep writes to the data folder, which the server owns only once it started.
  let cloneService: LentClones | null = options.clones ?? null;
  const clones = () => cloneService ??= createLentClones({ dataDir: options.dataDir, changed: (syncId) => sync?.noteChange(syncId) });
  const handler = async ({ req, res, url, path, method, auth, json, readBody }: RouteContext): Promise<typeof PASS | void> => {
    if (path !== "/api/sync" && !path.startsWith("/api/sync/")) return PASS;
    if (!options.cloudHome()) return PASS;
    if (auth.kind !== "session" || !auth.scopes.includes("admin")) { json(res, 403, { error: "Only your own desktop can sync with My Cloud." }); return; }
    res.setHeader("cache-control", "no-store");
    const s = service();
    const shown = folderFilter(auth);
    const match = (pattern: string) => new RegExp(`^${pattern}$`).exec(path);
    let m: RegExpExecArray | null;
    // A bot's folder of someone else's private chat (a Team Cloud) answers as a folder that does not exist.
    const folder = /^\/api\/sync\/folders\/([\w-]{1,200})(?:\/|$)/.exec(path)?.[1];
    if (folder && !shown(folder)) { json(res, 404, { error: "no such synced folder" }); return; }
    try {
      if (method === "GET" && path === "/api/sync") {
        const summary = s.summary();
        lent.sweep();
        // `staged`: changes bots made to a lent folder while its computer was away, waiting for it.
        // `lentCopies`: this Cloud keeps lent folders' copies out of bots' reach and answers for them while their computer
        // is away; a desktop copies lent folders only to a Cloud that says so.
        json(res, 200, { ...summary, lentCopies: true, folders: summary.folders.filter((entry) => shown(entry.id)).map((entry) => entry.kind === "pc" ? { ...entry, staged: lent.stagedCount(entry.id), ...(clones().cloning(entry.id) ? { cloning: true } : {}) } : entry) });
        return;
      }
      if (method === "POST" && path === "/api/sync/lent") { lent.report(await readBody(req, 100_000)); json(res, 200, { ok: true }); return; }
      if (method === "POST" && (m = match(`/api/sync/folders/${FOLDER}/synced`))) {
        if (s.store.folder(m[1]!)?.kind !== "pc") { json(res, 404, { error: "no such synced folder" }); return; }
        lent.synced(m[1]!); json(res, 200, { ok: true }); return;
      }
      if (method === "GET" && (m = match(`/api/sync/folders/${FOLDER}/staged`))) { json(res, 200, { staged: lent.staged(m[1]!) }); return; }
      if (method === "POST" && (m = match(`/api/sync/folders/${FOLDER}/staged/${UPLOAD}`))) { lent.stagedDone(m[1]!, m[2]!, await readBody(req, 10_000)); json(res, 200, { ok: true }); return; }
      if (method === "GET" && (m = match(`/api/sync/folders/${FOLDER}/staged/${UPLOAD}`))) {
        const file = lent.stagedFile(m[1]!, m[2]!);
        res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(file.size), "x-omb-sha256": file.sha256,
          "x-content-type-options": "nosniff", "content-disposition": "attachment", "content-security-policy": "sandbox" });
        createReadStream(file.file).on("error", () => res.destroy()).pipe(res);
        return;
      }
      if (method === "GET" && path === "/api/sync/changes") {
        const power = options.power?.() ?? null;
        if (power?.sleeping()) { answerAsleep(res, json); return; }
        const abort = new AbortController();
        req.on("close", () => abort.abort());
        const changes = await s.changes(Number(url.searchParams.get("cursor") ?? 0), Number(url.searchParams.get("waitMs") ?? 60_000),
          power ? AbortSignal.any([abort.signal, power.sleepSignal()]) : abort.signal);
        if (power?.sleeping()) { answerAsleep(res, json); return; }
        json(res, 200, { ...changes, folderIds: changes.folderIds.filter(shown) });
        return;
      }
      if (method === "GET" && path === "/api/sync/trash") { json(res, 200, { entries: s.trash().entries.filter((entry) => shown(entry.folderId)) }); return; }
      if (method === "POST" && path === "/api/sync/trash/restore") { json(res, 200, await s.restore((await readBody(req, 10_000))?.entryId)); return; }
      if (method === "POST" && path === "/api/sync/folders") {
        const body = await readBody(req, 100_000);
        const folder = s.register(body);
        // A new copy of a lent GitHub repository starts as a clone; the desktop leaves it alone while it is `cloning`.
        const cloning = folder.lent === true && clones().start(folder.id, folder.cloudPath, (body as { git?: unknown } | null)?.git);
        json(res, 200, { folder: { ...folder, ...(cloning ? { cloning: true } : {}) } });
        return;
      }
      if (method === "DELETE" && (m = match(`/api/sync/folders/${FOLDER}`))) {
        await s.unregister(m[1]!, url.searchParams.get("keepCloudCopy") !== "0");
        res.writeHead(204).end();
        return;
      }
      if (method === "GET" && (m = match(`/api/sync/folders/${FOLDER}/files`))) { json(res, 200, { files: await s.files(m[1]!) }); return; }
      if (method === "POST" && (m = match(`/api/sync/folders/${FOLDER}/uploads`))) { json(res, 200, s.beginUpload(m[1]!, await readBody(req, 100_000))); return; }
      if (method === "PUT" && (m = match(`/api/sync/uploads/${UPLOAD}`))) {
        json(res, 200, await s.writePart(m[1]!, Number(url.searchParams.get("offset")), req as AsyncIterable<Buffer>));
        return;
      }
      if (method === "POST" && (m = match(`/api/sync/uploads/${UPLOAD}/commit`))) { json(res, 200, await s.commit(m[1]!)); return; }
      if (method === "GET" && (m = match(`/api/sync/folders/${FOLDER}/file`))) {
        const file = await s.download(m[1]!, url.searchParams.get("path"));
        const range = /^bytes=(\d+)-$/.exec(String(req.headers.range ?? ""));
        const start = range ? Math.min(Number(range[1]), file.size) : 0;
        res.writeHead(range ? 206 : 200, {
          "content-type": "application/octet-stream", "content-length": String(file.size - start), "x-omb-sha256": file.sha256,
          "x-content-type-options": "nosniff", "content-disposition": "attachment", "content-security-policy": "sandbox",
          ...(range ? { "content-range": `bytes ${start}-${Math.max(file.size - 1, start)}/${file.size}` } : {}),
        });
        if (file.size === start) { res.end(); return; }
        // A bot may remove or lock the file before it is read: end this response, never the server.
        const stream = createReadStream(file.file, { start });
        stream.on("error", () => res.destroy());
        res.on("close", () => stream.destroy());
        stream.pipe(res);
        return;
      }
      if (method === "POST" && (m = match(`/api/sync/folders/${FOLDER}/ops`))) { json(res, 200, await s.ops(m[1]!, await readBody(req, 4_000_000))); return; }
      json(res, 404, { error: `no route: ${method} ${path}` });
    } catch (error) {
      if (error instanceof SyncError) { json(res, error.status, error.body); return; }
      throw error;
    }
  };
  // Before the desktop's first call there is nobody to tell: its first pass reads every folder.
  return Object.assign(handler, { close: () => { sync?.close(); sync = null; }, noteBotTurn: (botId: string, threadId: string) => sync?.noteBotTurn(botId, threadId),
    showFolders: (next: FolderFilter) => { folderFilter = next; }, lent, idle: () => cloneService?.idle() ?? Promise.resolve() });
}

/** Which synced folders a session may reach (index.ts sets it on a Team Cloud: a bot's folder of someone else's chat never). */
type FolderFilter = (auth: RequestAuth) => (folderId: string) => boolean;

/** Lent folders' copies, for the sync routes and for bots' shared_computer while a lending computer is away. */
export const lentCopies = createLentCopies({ dataDir: DATA_DIR });
export const cloudSyncRoutes = createCloudSyncRoutes({ dataDir: DATA_DIR, cloudHome: () => cloudHomeConfigured(), power: cloudPowerNow, lent: lentCopies });
export const noteSyncBotTurn = (botId: string, threadId: string) => cloudSyncRoutes.noteBotTurn(botId, threadId);
