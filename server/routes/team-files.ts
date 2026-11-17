// Team files' routes, for every member and admin of a Team Cloud (server/host/team-files.ts). Off a Team Cloud none of
// them exists: they answer 404 like any unknown path.
//   GET  /api/team-files?path=<folder>            the folder's entries, who changed each last, the space used and the caps
//   GET  /api/team-files/file?path=<file>         the file (?download=1 always as an attachment)
//   PUT  /api/team-files/file?path=<folder>&name=  an upload, the request body as is (at most 100 MB)
//   POST /api/team-files/folder {path}            a new folder
//   POST /api/team-files/rename {from, to}
//   POST /api/team-files/delete {path}            an admin anything; a member what they uploaded
// Security: every path goes through teamFilePath (no `..`, no control characters) and the folder never follows a link;
// a file is served as an attachment unless it is text or a common picture, and text is never served as HTML.
import { pipeline } from "node:stream/promises";

import type { RequestAuth } from "../request-auth.ts";
import type { TeamFileView } from "../../shared/team-files.ts";
import { teamFileName, teamFilePath, TeamFilesError, type TeamFileEntry, type TeamFiles, type TeamFilesActor } from "../host/team-files.ts";
import { PASS, type RouteContext, type RouteHandler } from "./table.ts";

export const TEAM_FILES_PATH = "/api/team-files";

export interface TeamFilesRouteDeps {
  files: TeamFiles | null;
  /** The signed-in person and whether they are the team's Owner or an Admin; null for a session that is no one. */
  actor(auth: RequestAuth): TeamFilesActor | null;
  personName(person: string): string | undefined;
  botName(botId: string): string | undefined;
}

const PREVIEW_TYPES: Record<string, string> = {
  txt: "text/plain; charset=utf-8", md: "text/plain; charset=utf-8", markdown: "text/plain; charset=utf-8", csv: "text/plain; charset=utf-8",
  tsv: "text/plain; charset=utf-8", json: "text/plain; charset=utf-8", log: "text/plain; charset=utf-8",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
};

/** How a file is served: a preview type for text and common pictures, else bytes to download. */
export function teamFileType(name: string): { type: string; preview: boolean } {
  const ext = name.includes(".") ? name.split(".").at(-1)!.toLowerCase() : "";
  const type = PREVIEW_TYPES[ext];
  return type ? { type, preview: true } : { type: "application/octet-stream", preview: false };
}

function disposition(kind: "inline" | "attachment", name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export function createTeamFilesRoutes(deps: TeamFilesRouteDeps): RouteHandler {
  const view = (files: TeamFiles, entry: TeamFileEntry, actor: TeamFilesActor): TeamFileView => {
    const { last, owner, ...rest } = entry;
    const named = last && {
      at: last.at, action: last.action,
      ...(last.person ? { person: deps.personName(last.person) ?? "" } : {}),
      ...(last.bot ? { bot: deps.botName(last.bot) ?? "" } : {}),
      ...(last.from ? { from: last.from } : {}),
    };
    return { ...rest, ...(named ? { last: named } : {}), canDelete: files.mayRemove(entry.path, actor), mine: owner === actor.person };
  };

  return async (ctx: RouteContext) => {
    const { req, res, url, path, method, auth, json, readBody } = ctx;
    if (path !== TEAM_FILES_PATH && !path.startsWith(`${TEAM_FILES_PATH}/`)) return PASS;
    const files = deps.files;
    if (!files) return PASS;
    const actor = deps.actor(auth);
    if (!actor) { req.resume(); return json(res, 403, { error: "Sign in to the team to use its files.", code: "forbidden" }); }
    try {
      if (path === TEAM_FILES_PATH && method === "GET") {
        const folder = teamFilePath(url.searchParams.get("path") ?? "");
        if (folder === null) return json(res, 400, { error: "That isn't a path in team files.", code: "bad_path" });
        const listed = files.list(folder, actor);
        return json(res, 200, {
          path: folder, entries: listed.entries.map((entry) => view(files, entry, actor)),
          used: files.used(), cap: files.cap, uploadMax: files.uploadMax, admin: actor.admin,
        });
      }
      if (path === `${TEAM_FILES_PATH}/file` && method === "GET") {
        const file = teamFilePath(url.searchParams.get("path") ?? "");
        if (!file) return json(res, 400, { error: "That isn't a file in team files.", code: "bad_path" });
        const opened = files.open(file);
        const served = teamFileType(opened.name);
        const download = url.searchParams.get("download") === "1" || !served.preview;
        res.writeHead(200, {
          "content-type": download ? "application/octet-stream" : served.type, "content-length": String(opened.size),
          "content-disposition": disposition(download ? "attachment" : "inline", opened.name),
          "x-content-type-options": "nosniff", "content-security-policy": "sandbox; default-src 'none'", "cache-control": "private, no-store",
        });
        await pipeline(files.stream(opened.fd), res).catch(() => {});
        return;
      }
      if (path === `${TEAM_FILES_PATH}/file` && method === "PUT") {
        const folder = teamFilePath(url.searchParams.get("path") ?? "");
        const name = teamFileName(url.searchParams.get("name") ?? "");
        if (folder === null || !name) { req.resume(); return json(res, 400, { error: "Name the file and the folder it goes in.", code: "bad_path" }); }
        const length = req.headers["content-length"];
        const declared = length === undefined ? null : Number(length);
        if (declared !== null && (!Number.isFinite(declared) || declared < 0)) { req.resume(); return json(res, 400, { error: "That upload has no usable length.", code: "bad_length" }); }
        const entry = await files.upload(folder, name, req, declared, actor);
        return json(res, 201, { entry: view(files, entry, actor), used: files.used() });
      }
      if (method !== "POST") { req.resume(); return json(res, 405, { error: "method not allowed" }); }
      const body = await readBody(req) as Record<string, unknown> | null;
      if (!body || typeof body !== "object") return json(res, 400, { error: "send a JSON object", code: "bad_path" });
      if (path === `${TEAM_FILES_PATH}/folder`) {
        const folder = teamFilePath(body.path);
        if (!folder) return json(res, 400, { error: "Name the new folder.", code: "bad_path" });
        files.folder(folder, actor);
        return json(res, 201, { ok: true });
      }
      if (path === `${TEAM_FILES_PATH}/rename`) {
        const from = teamFilePath(body.from), to = teamFilePath(body.to);
        if (!from || !to) return json(res, 400, { error: "Name the file and its new name.", code: "bad_path" });
        files.rename(from, to, actor);
        return json(res, 200, { ok: true });
      }
      if (path === `${TEAM_FILES_PATH}/delete`) {
        const target = teamFilePath(body.path);
        if (!target) return json(res, 400, { error: "Name what to delete.", code: "bad_path" });
        files.remove(target, actor);
        return json(res, 200, { ok: true, used: files.used() });
      }
      return json(res, 404, { error: "not found" });
    } catch (error) {
      if (error instanceof TeamFilesError) { if (!req.readableEnded) req.resume(); return json(res, error.status, { error: error.message, code: error.code }); }
      throw error;
    }
  };
}
