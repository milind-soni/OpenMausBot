// Boat (docs.boat.dev/openapi/boat-v1.yaml): GET /sandboxes/{id}/artifacts streams one file of up to 50 MiB, and
// PUT /sandboxes/{id}/files takes one of up to 5 MiB after decoding, as base64 in JSON; both only under /home/user or /tmp.
// Security: a copy reads or writes only inside the bot's working folder, judged after every existing link is followed,
// and never under its secret folder.
import { randomBytes } from "node:crypto";
import { constants, lstatSync, mkdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import { open } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, posix, relative, win32 } from "node:path";
import { assertBoatNotDeleting, boatAccount, boatErrorMessage, boatFetch } from "./boat.ts";
import type { AppConfig } from "./config.ts";
import { inSecretFolder, SECRET_FILE_REFUSAL } from "./secret-folder.ts";
import { isInside, resolveThroughLinks } from "./sentinel/paths.ts";

const COPY_FROM_COMPUTER_MAX_BYTES = 50 * 1024 * 1024;
const COPY_TO_COMPUTER_MAX_BYTES = 5 * 1024 * 1024;

export type CopyOutcome = { path: string; bytes: number } | { error: string };

const mib = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
const tooBigToBring = (path: string) =>
  `${path} is larger than 50 MiB, the most copy_from_computer brings back. Make it smaller on the cloud computer first (filter, compress or split it), then copy the result.`;
const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;

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

async function boatProblem(cfg: AppConfig, response: Response, what: string): Promise<string> {
  const body: unknown = await response.json().catch(() => null);
  return boatErrorMessage(response.status, what, body, boatAccount(cfg)?.included === true);
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

/** Streams the file to a temporary name beside its place and renames it there, so a failed copy never leaves half a file. */
export async function copyFromComputer(
  cfg: AppConfig,
  boxId: string,
  folder: string,
  args: { path: string; to?: string },
  signal: AbortSignal,
): Promise<CopyOutcome> {
  const wanted = args.to ?? posix.basename(args.path);
  if (!wanted) return { error: "Name the file to copy, or say where it goes with to." };
  const placed = placeInFolder(folder, wanted);
  if ("error" in placed) return placed;
  assertBoatNotDeleting(boxId);
  const response = await boatFetch(cfg, `/sandboxes/${boxId}/artifacts?path=${encodeURIComponent(args.path)}`, { signal, headers: { accept: "*/*" } });
  if (!response.ok) return { error: await boatProblem(cfg, response, `Copying ${args.path} from the cloud computer`) };
  const landed = Number(response.headers.get("content-length")) > COPY_FROM_COMPUTER_MAX_BYTES ? { error: tooBigToBring(args.path) } : land(placed, wanted);
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
        if (bytes > COPY_FROM_COMPUTER_MAX_BYTES) return { error: tooBigToBring(args.path) };
        await handle.write(chunk.value);
      }
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

export async function copyToComputer(
  cfg: AppConfig,
  boxId: string,
  folder: string,
  args: { from: string; path: string },
  signal: AbortSignal,
): Promise<CopyOutcome> {
  const placed = placeInFolder(folder, args.from);
  if ("error" in placed) return placed;
  let content: Buffer;
  try {
    const handle = await open(placed.file, constants.O_RDONLY | noFollow);
    try {
      const info = await handle.stat();
      if (!info.isFile()) return { error: `${args.from} is not a file.` };
      if (info.size > COPY_TO_COMPUTER_MAX_BYTES) {
        return { error: `${args.from} is ${mib(info.size)}; copy_to_computer sends at most 5 MiB. Split or compress it first, or have the cloud computer download it itself.` };
      }
      content = await handle.readFile();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { error: `${args.from} is not in your working folder.` };
    throw error;
  }
  if (content.length > COPY_TO_COMPUTER_MAX_BYTES) return { error: `${args.from} grew past 5 MiB while it was read; copy_to_computer sends at most 5 MiB.` };
  assertBoatNotDeleting(boxId);
  signal.throwIfAborted();
  const response = await boatFetch(cfg, `/sandboxes/${boxId}/files`, {
    method: "PUT",
    body: JSON.stringify({ path: args.path, content: content.toString("base64"), encoding: "base64" }),
    signal,
  });
  if (!response.ok) return { error: await boatProblem(cfg, response, `Copying ${args.from} to the cloud computer`) };
  const body = await response.json().catch(() => null) as { path?: unknown } | null;
  return { path: typeof body?.path === "string" ? body.path : args.path, bytes: content.length };
}
