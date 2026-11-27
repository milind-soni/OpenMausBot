// Boat (docs.boat.dev/openapi/boat-v1.yaml): POST /sandboxes/{id}/files/download-url and /files/upload-url answer a link
// the sandbox serves itself, bound to one path, taking no Authorization header and no size limit; a PUT replaces a file
// only once its upload completes.
// Security: the link is a secret until it expires, so no result, error or log ever carries it. A copy reads or writes
// only inside the bot's working folder, judged after every existing link is followed, and never under its secret folder.
import { randomBytes } from "node:crypto";
import { constants, lstatSync, mkdirSync, realpathSync, renameSync, rmSync, statfsSync } from "node:fs";
import { open } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, posix, relative, win32 } from "node:path";
import { assertBoatNotDeleting, boatAccount, boatErrorMessage, boatFetch } from "./boat.ts";
import type { AppConfig } from "./config.ts";
import { boatProviderApi } from "./included-services.ts";
import { inSecretFolder, SECRET_FILE_REFUSAL } from "./secret-folder.ts";
import { isInside, resolveThroughLinks } from "./sentinel/paths.ts";

const MiB = 1024 * 1024;
const COPY_MAX_BYTES = 2 * 1024 * MiB;
/** Left free on the folder's disk, so a download never fills it. */
const DISK_RESERVE_BYTES = 256 * MiB;
const LINK_TTL_SECONDS = 300;
const OLD_RELAY = "This Cloud's computer service can't hand out file transfer links yet, so files can't be copied to or from the cloud computer until it updates. Use exec in the meantime.";
const UNUSABLE_LINK = "The cloud computer answered with a transfer link that can't be used. Try the copy again in a minute.";
const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;

export type CopyOutcome = { path: string; bytes: number } | { error: string };
export interface CopyOptions {
  /** Bytes free on the disk that holds `dir`. */
  freeBytes?(dir: string): number;
}

const sized = (bytes: number) => bytes >= 1024 * MiB ? `${(bytes / 1024 / MiB).toFixed(1)} GiB` : `${(bytes / MiB).toFixed(1)} MiB`;
const diskFree = (dir: string) => { const disk = statfsSync(dir); return Number(disk.bavail) * Number(disk.bsize); };
const tooBig = (path: string, bytes: number, atLeast = false) =>
  `${path} is ${atLeast ? "over " : ""}${sized(bytes)}; a copy moves at most 2 GiB. Make it smaller on the cloud computer first (filter, compress or split it), then copy the parts.`;
const noSpace = (path: string, bytes: number, free: number, atLeast = false) =>
  `Not enough space for ${path}: it needs ${atLeast ? "more than " : ""}${sized(bytes)} with ${sized(DISK_RESERVE_BYTES)} kept free, and the working folder's disk has ${sized(free)} free.`;

/** What the sandbox's own answer means; its body is never read, since it could carry the link. */
function linkRefusal(status: number, path: string): string {
  if (status === 404) return `${path} is not on the cloud computer.`;
  if (status === 401 || status === 403 || status === 410) return "The cloud computer refused the transfer link, which may have expired. Try the copy again.";
  return `The cloud computer answered ${status} to the copy. Try again in a minute.`;
}

type Placed = { root: string; file: string } | { error: string };

function placeInFolder(folder: string, wanted: string): Placed {
  if (isAbsolute(wanted) || win32.isAbsolute(wanted) || wanted.split(/[\\/]/).includes("..")) {
    return { error: `${wanted} must be a path relative to your working folder, without "..".` };
  }
  let root: string;
  try { root = realpathSync(folder); } catch { return { error: "Your working folder is not available right now." }; }
  const file = resolveThroughLinks(join(root, wanted));
  if (file === root) return { error: "Name a file inside your working folder, not the folder itself." };
  if (!isInside(file, root)) return { error: `${wanted} leads outside your working folder.` };
  if (inSecretFolder(file)) return { error: SECRET_FILE_REFUSAL };
  return { root, file };
}

/** Checked again once the download has begun: a link made in the folder meanwhile would lead the file out. */
function land(placed: { root: string; file: string }, wanted: string): { parent: string; target: string } | { error: string } {
  let parent: string;
  try {
    mkdirSync(dirname(placed.file), { recursive: true });
    parent = realpathSync(dirname(placed.file));
  } catch {
    return { error: `${wanted} cannot be made in your working folder.` };
  }
  if (!isInside(parent, placed.root)) return { error: `${wanted} leads outside your working folder.` };
  const target = join(parent, basename(placed.file));
  if (lstatSync(target, { throwIfNoEntry: false })?.isDirectory()) return { error: `${wanted} is a folder in your working folder; name a file instead.` };
  return { parent, target };
}

/** HTTPS, or plain HTTP only from a loopback Boat (a test fixture's), never pointed anywhere else. */
function usableLink(cfg: AppConfig, link: unknown): URL | null {
  let url: URL, api: URL;
  try {
    url = new URL(String(link));
    api = new URL(boatAccount(cfg)?.api ?? boatProviderApi());
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol === "https:") return url;
  const loopback = api.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(api.hostname);
  return loopback && url.protocol === "http:" && url.hostname === api.hostname ? url : null;
}

async function transferLink(cfg: AppConfig, boxId: string, kind: "download-url" | "upload-url", path: string, signal: AbortSignal): Promise<{ url: URL; path: string } | { error: string }> {
  assertBoatNotDeleting(boxId);
  const response = await boatFetch(cfg, `/sandboxes/${boxId}/files/${kind}`, { method: "POST", body: JSON.stringify({ path, ttlSeconds: LINK_TTL_SECONDS }), signal });
  const body = await response.json().catch(() => null) as { ok?: unknown; code?: unknown; error?: { code?: unknown }; url?: unknown; method?: unknown; path?: unknown } | null;
  if (!response.ok || body?.ok === false) {
    if ((body?.error?.code ?? body?.code) === "not_available") return { error: OLD_RELAY };
    return { error: boatErrorMessage(response.status, `Copying ${path} ${kind === "download-url" ? "from" : "to"} the cloud computer`, body, boatAccount(cfg)?.included === true) };
  }
  const url = usableLink(cfg, body?.url);
  if (!url || body?.method !== (kind === "download-url" ? "GET" : "PUT")) return { error: UNUSABLE_LINK };
  return { url, path: typeof body.path === "string" ? body.path : path };
}

/** Streams the file to a temporary name beside its place and renames it there, so a failed copy never leaves half a file. */
export async function copyFromComputer(
  cfg: AppConfig,
  boxId: string,
  folder: string,
  args: { path: string; to?: string },
  signal: AbortSignal,
  options: CopyOptions = {},
): Promise<CopyOutcome> {
  const wanted = args.to ?? posix.basename(args.path);
  if (!wanted) return { error: "Name the file to copy, or say where it goes with to." };
  const placed = placeInFolder(folder, wanted);
  if ("error" in placed) return placed;
  const link = await transferLink(cfg, boxId, "download-url", args.path, signal);
  if ("error" in link) return link;
  let response: Response;
  try {
    response = await fetch(link.url, { signal, redirect: "error" });
  } catch {
    signal.throwIfAborted();
    return { error: "The cloud computer could not be reached to copy the file. Try again in a minute." };
  }
  const free = (options.freeBytes ?? diskFree)(placed.root);
  const declared = Number(response.headers.get("content-length") ?? Number.NaN);
  const landed = !response.ok ? { error: linkRefusal(response.status, args.path) }
    : declared > COPY_MAX_BYTES ? { error: tooBig(args.path, declared) }
    : declared + DISK_RESERVE_BYTES > free ? { error: noSpace(args.path, declared, free) }
    : land(placed, wanted);
  if ("error" in landed) {
    await response.body?.cancel().catch(() => {});
    return landed;
  }
  const { parent, target } = landed;
  const temporary = join(parent, `.${basename(target)}.${randomBytes(6).toString("hex")}.part`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o644);
  let bytes = 0;
  let written = false;
  try {
    const reader = response.body?.getReader();
    try {
      for (;;) {
        const chunk = await reader?.read();
        if (!chunk || chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > COPY_MAX_BYTES) return { error: tooBig(args.path, COPY_MAX_BYTES, true) };
        if (bytes + DISK_RESERVE_BYTES > free) return { error: noSpace(args.path, bytes, free, true) };
        try {
          await handle.write(chunk.value);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOSPC") return { error: noSpace(args.path, bytes, free, true) };
          throw error;
        }
      }
    } catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof Error) || "code" in error) throw error;
      return { error: "The download from the cloud computer was interrupted; nothing was saved. Try again." };
    } finally {
      await reader?.cancel().catch(() => {});
    }
    await handle.close();
    signal.throwIfAborted();
    renameSync(temporary, target);
    written = true;
  } finally {
    await handle.close().catch(() => {});
    if (!written) rmSync(temporary, { force: true });
  }
  return { path: relative(placed.root, target), bytes };
}

/** Streams the file from disk as the upload's body; the computer keeps its old file unless the whole upload lands. */
export async function copyToComputer(
  cfg: AppConfig,
  boxId: string,
  folder: string,
  args: { from: string; path: string },
  signal: AbortSignal,
): Promise<CopyOutcome> {
  const placed = placeInFolder(folder, args.from);
  if ("error" in placed) return placed;
  let handle;
  try {
    handle = await open(placed.file, constants.O_RDONLY | noFollow);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { error: `${args.from} is not in your working folder.` };
    if (code === "ELOOP") return { error: `${args.from} leads outside your working folder.` };
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { error: `${args.from} is not a file.` };
    if (info.size > COPY_MAX_BYTES) return { error: tooBig(args.from, info.size) };
    const link = await transferLink(cfg, boxId, "upload-url", args.path, signal);
    if ("error" in link) return link;
    // Never more than the length declared, whatever is appended meanwhile; a file that shrinks fails the upload.
    const body = info.size === 0 ? new Uint8Array() : handle.createReadStream({ start: 0, end: info.size - 1, autoClose: false });
    let response: Response;
    try {
      response = await fetch(link.url, {
        method: "PUT", body: body as unknown as RequestInit["body"], signal, redirect: "error", duplex: "half",
        headers: { "content-type": "application/octet-stream", "content-length": String(info.size) },
      } as RequestInit);
    } catch {
      signal.throwIfAborted();
      return { error: `The upload of ${args.from} was interrupted; the cloud computer still has its old file, if any. Try again.` };
    }
    await response.body?.cancel().catch(() => {});
    if (!response.ok) return { error: linkRefusal(response.status, args.path) };
    return { path: link.path, bytes: info.size };
  } finally {
    await handle.close().catch(() => {});
  }
}
