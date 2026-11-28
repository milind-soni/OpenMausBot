// A bot's saved sign-ins as they were when each of its sessions in the Cloud's browser sandbox opened (browser-sites.ts
// backupSignIns), for the owner to put back after a session that changed them wrongly:
//   GET  /api/bots/<id>/browser-sign-ins/backups            the backups, newest first: id, when, size (never a cookie)
//   POST /api/bots/<id>/browser-sign-ins/restore {backup}   the sign-ins put back as that backup holds them
// The owner's (or an admin's) only. No screen uses it yet.
import type { SignInBackup } from "../browser-sites.ts";
import { ownerOrAdmin, type RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

export type SignInRestore = "restored" | "no-bot" | "no-backup" | "open";

export interface SignInBackupDeps {
  /** The bot's backups, or null when there is no such bot. */
  backups(botId: string): SignInBackup[] | null;
  restore(botId: string, id: string): Promise<SignInRestore>;
  isOwner?(auth: RequestAuth): boolean;
}

const ROUTE = /^\/api\/bots\/([^/]{1,200})\/browser-sign-ins\/(backups|restore)$/;
const BACKUP_ID = /^\d{13}$/;

export function createSignInBackupRoutes(deps: SignInBackupDeps): RouteHandler {
  const isOwner = deps.isOwner ?? ownerOrAdmin;
  return async ({ req, res, path, method, auth, json, readBody }) => {
    const match = ROUTE.exec(path);
    if (!match) return PASS;
    let botId: string;
    try { botId = decodeURIComponent(match[1]!); } catch { return json(res, 404, { error: "No such bot." }); }
    if (!isOwner(auth)) return json(res, 403, { error: "Only the owner can see or restore a bot's saved sign-ins." });
    if (match[2] === "backups") {
      if (method !== "GET") return json(res, 405, { error: "Use GET." });
      const backups = deps.backups(botId);
      if (!backups) return json(res, 404, { error: "No such bot." });
      return json(res, 200, { backups: backups.map((backup) => ({ id: backup.id, takenAt: new Date(backup.takenAt).toISOString(), bytes: backup.bytes })) });
    }
    if (method !== "POST") return json(res, 405, { error: "Use POST." });
    const body: unknown = await readBody(req, 1024).catch(() => null);
    const id = (body as { backup?: unknown } | null)?.backup;
    if (typeof id !== "string" || !BACKUP_ID.test(id)) return json(res, 400, { error: "Send {backup: <id>}, an id from the backups list." });
    const outcome = await deps.restore(botId, id);
    if (outcome === "restored") return json(res, 200, { ok: true });
    if (outcome === "open") return json(res, 409, { error: "This bot's browser is open. Close it first, then restore its sign-ins." });
    return json(res, 404, { error: outcome === "no-bot" ? "No such bot." : "No such backup of this bot's sign-ins." });
  };
}
