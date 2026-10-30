// A move's bot files: each bot's own folder (workspaces/<bot>/) and its conversations' folders (task-workspaces/<bot>/),
// by path, size and sha256, leaving out what the workspace backup leaves out and what a move carries otherwise (memory,
// skills, the engines' skill links). Both servers list theirs (GET /api/cloud-send/files, with My Cloud's free space);
// My Cloud takes a file in parts (POST, owner's session only), resumable from the bytes it holds, and never writes over
// a file it has: a file there that is not the one the move put there is a conflict, and the sender keeps both.
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, lstat, mkdir, open, readdir, rename, stat, unlink } from "node:fs/promises";
import { statfsSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { dirname, join } from "node:path";
import { z } from "zod";

import type { CloudOwner } from "./cloud-owner-lines.ts";
import type { RequestAuth } from "./request-auth.ts";
import type { RouteContext } from "./routes/table.ts";
import { omittedFromWorkspaceBackup } from "./workspace-backup.ts";
import { validRelative } from "./workspace-backup-paths.ts";

/** A part of a file, well under My Cloud's request limits. */
export const FILE_PART_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 200_000;
const PARTIAL_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SHA = /^[a-f0-9]{64}$/u;
/** A bot's own folder or one of its conversations' folders, and a path below it. */
const PLACE = /^(?:workspaces\/[\w-]{1,128}|task-workspaces\/[\w-]{1,128}\/[\w-]{1,200})\/./u;
/** Carried otherwise: memory (merged), skills (by their own route), and the skill links engines read. */
const CARRIED_OTHERWISE = /^workspaces\/[\w-]{1,128}\/(?:MEMORY\.md$|memory(?:\/|$)|skills(?:\/|$))|^(?:workspaces\/[\w-]{1,128}|task-workspaces\/[\w-]{1,128}\/[\w-]{1,200})\/\.(?:claude|agents|grok)(?:\/|$)/u;

export interface BotFile { path: string; size: number; sha256: string }

export interface MoveFilesDeps {
  dataDir: string;
  bots(): ReadonlyArray<{ id: string }>;
  owner(auth: RequestAuth): CloudOwner | null;
}

/** Whether a move carries the file at this data-folder path as a bot file. */
export function movedFilePath(path: string): boolean {
  return PLACE.test(path) && validRelative(path) && !CARRIED_OTHERWISE.test(path) && !omittedFromWorkspaceBackup(path) && !path.split("/").includes("node_modules");
}

const hashes = new Map<string, string>();
async function fileSha256(full: string, size: number, mtimeMs: number): Promise<string> {
  const key = `${full}\0${size}\0${mtimeMs}`;
  const known = hashes.get(key);
  if (known) return known;
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(full)) hash.update(chunk as Buffer);
  const digest = hash.digest("hex");
  if (hashes.size > 50_000) hashes.clear();
  hashes.set(key, digest);
  return digest;
}

/** Every bot file on this server, links never followed. */
export async function listBotFiles(dataDir: string, botIds: readonly string[]): Promise<BotFile[]> {
  const out: BotFile[] = [];
  const walk = async (relative: string): Promise<void> => {
    let names: string[];
    try { names = (await readdir(join(dataDir, relative))).sort(); } catch { return; }
    for (const name of names) {
      if (out.length >= MAX_FILES) return;
      const path = `${relative}/${name}`;
      const info = await lstat(join(dataDir, path)).catch(() => null);
      if (!info || name === "node_modules") continue;
      if (info.isDirectory()) { if (!CARRIED_OTHERWISE.test(`${path}/`) && !omittedFromWorkspaceBackup(path)) await walk(path); continue; }
      if (info.isFile() && movedFilePath(path)) out.push({ path, size: info.size, sha256: await fileSha256(join(dataDir, path), info.size, info.mtimeMs) });
    }
  };
  for (const id of botIds) {
    if (!/^[\w-]{1,128}$/u.test(id)) continue;
    await walk(`workspaces/${id}`);
    await walk(`task-workspaces/${id}`);
  }
  return out;
}

function space(dataDir: string): { freeBytes: number; volumeBytes: number } | null {
  try {
    const disk = statfsSync(dataDir, { bigint: true });
    const clamp = (value: bigint) => (value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(value));
    return { freeBytes: clamp(disk.bavail * disk.bsize), volumeBytes: clamp(disk.blocks * disk.bsize) };
  } catch { return null; }
}

const staging = (dataDir: string) => join(dataDir, "tmp", "move-files");
const partialPath = (dataDir: string, sha256: string, size: number) => join(staging(dataDir), `${sha256}-${size}.partial`);

/** Partial files a move left more than a day ago. */
async function tidyPartials(dataDir: string, now = Date.now()): Promise<void> {
  const folder = staging(dataDir);
  for (const name of await readdir(folder).catch(() => [] as string[])) {
    if (!name.endsWith(".partial")) continue;
    const info = await stat(join(folder, name)).catch(() => null);
    if (info && now - info.mtimeMs > PARTIAL_MAX_AGE_MS) await unlink(join(folder, name)).catch(() => {});
  }
}

/** The request's bytes, or null past `limit` (read to the end either way, so the answer still reaches the sender). */
function rawBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    req.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes <= limit) chunks.push(chunk); });
    req.on("end", () => resolve(bytes > limit ? null : Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Each folder from the data folder down to the file's is a real folder, made when missing: never a link. */
async function realFolders(dataDir: string, path: string): Promise<boolean> {
  let at = dataDir;
  for (const part of dirname(path).split("/")) {
    at = join(at, part);
    const info = await lstat(at).catch(() => null);
    if (!info) await mkdir(at, { mode: 0o700 }).catch(() => {});
    else if (!info.isDirectory() || info.isSymbolicLink()) return false;
  }
  return (await lstat(at).catch(() => null))?.isDirectory() === true;
}

async function sha256Of(full: string): Promise<string | null> {
  try {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(full)) hash.update(chunk as Buffer);
    return hash.digest("hex");
  } catch { return null; }
}

const putSchema = z.object({ path: z.string().max(4096), size: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER), sha256: z.string().regex(SHA),
  offset: z.coerce.number().int().min(0), mode: z.enum(["new", "replace"]), expect: z.string().regex(SHA).optional() });

const partSchema = z.object({ path: z.string().max(4096), offset: z.coerce.number().int().min(0), length: z.coerce.number().int().min(1).max(FILE_PART_BYTES) });

/** Up to `length` bytes of a bot file from `offset`, never through a link. */
async function readPart(dataDir: string, { path, offset, length }: z.infer<typeof partSchema>): Promise<Buffer | null> {
  let at = dataDir;
  for (const part of path.split("/")) {
    at = join(at, part);
    const info = await lstat(at).catch(() => null);
    if (!info || info.isSymbolicLink()) return null;
  }
  const handle = await open(at, "r").catch(() => null);
  if (!handle) return null;
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return buffer.subarray(0, bytesRead);
  } finally { await handle.close(); }
}

/** One part of a file: 200 `{ received }` until the last, then 201 `{ stored }`, or 409 `{ conflict }` when the path holds a
 * file the move may not replace; 409 `{ received }` when the part does not start where My Cloud's copy ends. */
async function takePart(deps: MoveFilesDeps, req: IncomingMessage, query: z.infer<typeof putSchema>): Promise<{ status: number; body: Record<string, unknown> }> {
  const { path, size, sha256, offset, mode, expect } = query;
  const botId = /^(?:workspaces|task-workspaces)\/([\w-]{1,128})\//u.exec(path)?.[1];
  if (!movedFilePath(path) || !botId) return { status: 400, body: { error: "not a bot file a move carries" } };
  if (!deps.bots().some((bot) => bot.id === botId)) return { status: 409, body: { error: "This file's bot is not on My Cloud yet." } };
  const partial = partialPath(deps.dataDir, sha256, size);
  await mkdir(staging(deps.dataDir), { recursive: true, mode: 0o700 });
  const held = (await stat(partial).catch(() => null))?.size ?? 0;
  if (offset !== held) { await rawBody(req, 0); return { status: 409, body: { received: held } }; }
  const bytes = await rawBody(req, Math.min(FILE_PART_BYTES, size - held));
  if (!bytes) return { status: 413, body: { error: "the part runs past the file's size", received: held } };
  if (bytes.length) {
    const handle = await open(partial, "a", 0o600);
    try { await handle.write(bytes); } finally { await handle.close(); }
  }
  const received = held + bytes.length;
  if (received < size) return { status: 200, body: { received } };
  if (await sha256Of(partial) !== sha256) { await unlink(partial).catch(() => {}); return { status: 422, body: { error: "the file arrived different from what was sent" } }; }
  const target = join(deps.dataDir, path);
  if (!(await realFolders(deps.dataDir, path))) return { status: 409, body: { conflict: true } };
  const there = await lstat(target).catch(() => null);
  if (there && !there.isFile()) return { status: 409, body: { conflict: true } };
  if (there && await sha256Of(target) === sha256) { await unlink(partial).catch(() => {}); return { status: 201, body: { stored: false } }; }
  if (mode === "replace" && there && expect && await sha256Of(target) === expect) {
    const placed = join(staging(deps.dataDir), `${randomUUID()}.placing`);
    await link(partial, placed);
    await rename(placed, target);
    await unlink(partial).catch(() => {});
    return { status: 201, body: { stored: true } };
  }
  if (there) return { status: 409, body: { conflict: true } };
  try { await link(partial, target); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return { status: 409, body: { conflict: true } };
    throw error;
  }
  await unlink(partial).catch(() => {});
  return { status: 201, body: { stored: true } };
}

/** False when the path is not this route. */
export async function moveFilesRoute(deps: MoveFilesDeps, { req, res, path, method, url, auth, json }: RouteContext): Promise<boolean> {
  if (path !== "/api/cloud-send/files") return false;
  res.setHeader("cache-control", "no-store");
  if (method === "GET" && url.searchParams.has("path")) {
    const part = partSchema.safeParse(Object.fromEntries(url.searchParams));
    const bytes = part.success && movedFilePath(part.data.path) ? await readPart(deps.dataDir, part.data) : null;
    if (!bytes) { json(res, 404, { error: "no such bot file" }); return true; }
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(bytes.length) });
    res.end(bytes);
    return true;
  }
  if (method === "GET") {
    await tidyPartials(deps.dataDir);
    json(res, 200, { v: 1, files: await listBotFiles(deps.dataDir, deps.bots().map((bot) => bot.id)), space: space(deps.dataDir) });
    return true;
  }
  if (method !== "POST") { json(res, 405, { error: "method not allowed" }); return true; }
  if (!deps.owner(auth)) { await rawBody(req, 0); json(res, 403, { error: "Only My Cloud's owner can move files into it." }); return true; }
  const query = putSchema.safeParse(Object.fromEntries(url.searchParams));
  if (!query.success) { await rawBody(req, 0); json(res, 400, { error: "send ?path, size, sha256, offset and mode" }); return true; }
  const answer = await takePart(deps, req, query.data);
  json(res, answer.status, answer.body);
  return true;
}
