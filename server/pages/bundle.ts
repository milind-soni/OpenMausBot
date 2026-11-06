// A page's files, read from inside the bot's own folders only: the path is resolved and every file re-checked with
// realpath containment, symlinks out of the folder are skipped, and hidden files and folders (.git, .env) never go.
// Everything left out is named to the bot, except the secret folder, which a page never mentions.
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { PAGE_FILE_EXTENSIONS, PAGE_MAX_BYTES, PAGE_MAX_FILES } from "../../shared/published-page.ts";
import { guestWorkspaceToHost } from "../bot-attachment.ts";
import { VM_WORKSPACE_GUEST } from "../container-computer.ts";
import { inSecretFolder, SECRET_FILE_REFUSAL } from "../secret-folder.ts";

export interface PageFile {
  path: string;
  data: Buffer;
}
/** A video beside a chat page's index.html, kept where it is on disk: never read into memory or copied. The identity
 * is what lets the page's files route refuse a file that was replaced after the page was shown. BigInt stat fields as text,
 * since inode numbers can pass 2^53. */
export interface PageVideo {
  file: string;
  bytes: number;
  dev: string;
  ino: string;
  mtimeNs: string;
}
/** Why a page left a file out, in the order the bot is told them. */
const SKIP_REASONS = ["type", "video", "name", "link", "deep", "packages", "hidden"] as const;
/** A file or folder (its path ends in "/") a page left out. */
export interface SkippedFile {
  path: string;
  why: (typeof SKIP_REASONS)[number];
}
export interface PageBundle {
  /** The file or folder published, canonical: the same source publishes to the same link again. */
  source: string;
  files: PageFile[];
  bytes: number;
  skipped: SkippedFile[];
  /** Only when asked for, by path in the folder: the pages Worker refuses video, so a published page leaves it out. */
  videos?: Record<string, PageVideo>;
}

const SKIPPED_FOLDERS = new Set(["node_modules", "__pycache__"]);
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._ ()+@-]{0,99}$/;

export class PageBundleError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

const containedBy = (root: string, candidate: string) => {
  const suffix = relative(root, candidate);
  return suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
};
const servable = (name: string) => PAGE_FILE_EXTENSIONS.has(extname(name).slice(1).toLowerCase());
const isHtml = (name: string) => /^\.html?$/i.test(extname(name));
const isVideo = (name: string) => /^\.(?:mp4|webm|mov)$/i.test(extname(name));

async function canonicalRoots(roots: readonly string[]): Promise<string[]> {
  const found = await Promise.all(roots.map(async (root) => {
    try {
      const canonical = await realpath(root);
      return (await stat(canonical)).isDirectory() ? canonical : null;
    } catch {
      return null;
    }
  }));
  return found.filter((root): root is string => root !== null);
}

/** The file or folder at `requested` (absolute, or relative to one of `roots`) and the root holding it. */
async function locate(requested: string, roots: readonly string[]): Promise<{ target: string; root: string }> {
  const trimmed = requested.trim();
  if (!trimmed) throw new PageBundleError("path is required: the .html file or the folder to publish.");
  const allowed = await canonicalRoots(roots);
  const candidates = isAbsolute(trimmed) ? [resolve(trimmed)] : allowed.map((root) => resolve(root, trimmed));
  let outside = false;
  for (const candidate of candidates) {
    let target: string;
    try {
      target = await realpath(candidate);
    } catch {
      continue;
    }
    const root = allowed.find((each) => containedBy(each, target));
    if (root && inSecretFolder(target)) throw new PageBundleError(SECRET_FILE_REFUSAL, 403);
    if (root) return { target, root };
    outside = true;
  }
  if (outside) throw new PageBundleError("Only files in your working folder can be published. Save the page there first.", 403);
  throw new PageBundleError(`Nothing was found at ${trimmed}. Save the page in your working folder and pass its exact path.`, 404);
}

/** The canonical file or folder `requested` names inside `roots`: the key a page is remembered by. */
export async function pageSource(requested: string, roots: readonly string[]): Promise<string> {
  return (await locate(requested, roots)).target;
}

/** The page at `requested`: one .html file (published as index.html), or a folder with index.html at its top. */
export async function readPageBundle(requested: string, roots: readonly string[], limits = { bytes: PAGE_MAX_BYTES, files: PAGE_MAX_FILES }, options: { videos?: boolean } = {}): Promise<PageBundle> {
  const { target, root } = await locate(requested, roots);
  const info = await stat(target);
  if (info.isFile()) {
    if (!isHtml(target)) throw new PageBundleError("A single file must be an .html page. For anything else, publish a folder with an index.html.");
    if (info.size > limits.bytes) throw new PageBundleError(`The page is ${info.size} bytes; a page can be at most ${limits.bytes}.`, 413);
    const data = await readFile(target);
    return { source: target, files: [{ path: "index.html", data }], bytes: data.byteLength, skipped: [] };
  }
  if (!info.isDirectory()) throw new PageBundleError("Publish an .html file or a folder.");
  const files: PageFile[] = [], skipped: SkippedFile[] = [], videos: Record<string, PageVideo> = {};
  let bytes = 0;
  const walk = async (folder: string, depth: number): Promise<void> => {
    for (const name of (await readdir(folder)).sort()) {
      const full = join(folder, name);
      if (inSecretFolder(full)) continue;
      const own = await lstat(full), path = relative(target, full).split(sep).join("/");
      if (name.startsWith(".")) { skipped.push({ path: own.isDirectory() ? `${path}/` : path, why: "hidden" }); continue; }
      const real = own.isSymbolicLink() ? await realpath(full).catch(() => null) : full;
      if (!real || !containedBy(root, real) || inSecretFolder(real)) { skipped.push({ path, why: "link" }); continue; }
      const entry = own.isSymbolicLink() ? await stat(real) : own;
      if (entry.isDirectory()) {
        const why = SKIPPED_FOLDERS.has(name) ? "packages" : depth >= 9 ? "deep" : !SEGMENT.test(name) || name.endsWith(".") ? "name" : null;
        if (why) { skipped.push({ path: `${path}/`, why }); continue; }
        await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!servable(name) && !(options.videos && isVideo(name))) { skipped.push({ path, why: isVideo(name) ? "video" : "type" }); continue; }
      if (!SEGMENT.test(name) || name.endsWith(".")) { skipped.push({ path, why: "name" }); continue; }
      if (isVideo(name)) {
        if (files.length + Object.keys(videos).length >= limits.files) throw new PageBundleError(`The folder has more than ${limits.files} files a page can hold. Publish a smaller folder.`, 413);
        const identity = await stat(real, { bigint: true });
        videos[path] = { file: real, bytes: Number(identity.size), dev: String(identity.dev), ino: String(identity.ino), mtimeNs: String(identity.mtimeNs) };
        continue;
      }
      if (files.length >= limits.files) throw new PageBundleError(`The folder has more than ${limits.files} files a page can hold. Publish a smaller folder.`, 413);
      bytes += entry.size;
      if (bytes > limits.bytes) throw new PageBundleError(`The folder's files come to more than ${limits.bytes} bytes, a page's limit. Make the images smaller or leave some out.`, 413);
      files.push({ path, data: await readFile(real) });
    }
  };
  await walk(target, 0);
  if (!files.some((file) => file.path === "index.html")) {
    throw new PageBundleError(`${basename(target)} has no index.html at its top. Name the main page index.html, then publish again.`);
  }
  return { source: target, files, bytes, skipped, ...(options.videos ? { videos } : {}) };
}

const NOTE_GROUPS = 4, NOTE_PATHS = 3;

function reason(file: SkippedFile): string {
  switch (file.why) {
    case "type": {
      const extension = extname(file.path).slice(1).toLowerCase();
      return extension ? `pages can't carry .${extension} files` : "pages can't carry files without an extension";
    }
    case "video": return "published pages can't carry video";
    case "name": return "names with characters a page can't hold";
    case "link": return "links a page can't follow";
    case "deep": return "nested too deep";
    case "packages": return "package and cache folders";
    case "hidden": return "hidden";
  }
}

const inWords = (parts: readonly string[]) => parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0] ?? "";

/** One sentence for the bot naming what a page left out and why, grouped by reason; "" when nothing was. */
export function skippedNote(skipped: readonly SkippedFile[]): string {
  const groups = new Map<string, string[]>();
  for (const file of [...skipped].sort((a, b) => SKIP_REASONS.indexOf(a.why) - SKIP_REASONS.indexOf(b.why))) {
    const why = reason(file);
    groups.set(why, [...(groups.get(why) ?? []), file.path]);
  }
  const shown = [...groups].slice(0, NOTE_GROUPS);
  const parts = shown.map(([why, paths]) =>
    `${paths.slice(0, NOTE_PATHS).join(", ")}${paths.length > NOTE_PATHS ? ` and ${paths.length - NOTE_PATHS} more` : ""} (${why})`);
  const rest = skipped.length - shown.reduce((sum, [, paths]) => sum + paths.length, 0);
  if (rest) parts.push(`${rest} more`);
  return parts.length ? `Left out ${inWords(parts)}.` : "";
}

/** The bot's own folders for a turn, and its Local VM's workspace on this computer when it has one. */
export type BotFolders = () => Promise<{ roots: readonly string[]; vmWorkspace: string | null }>;

/** A chat page's bundle, videos included: readPageBundle within a bot's own folders; a path inside its Local VM's workspace means the same file here. */
export async function readBotPageBundle(requested: string, folders: BotFolders): Promise<PageBundle> {
  const { roots, vmWorkspace } = await folders();
  const path = vmWorkspace ? guestWorkspaceToHost(requested, VM_WORKSPACE_GUEST, vmWorkspace) ?? requested : requested;
  return readPageBundle(path, vmWorkspace ? [vmWorkspace, ...roots] : roots, undefined, { videos: true });
}

/** A file inside a bot's own folders (or its Local VM's workspace), by the same rules as a page: the `extract` tool's. */
export async function botFileSource(requested: string, folders: BotFolders): Promise<string> {
  const { roots, vmWorkspace } = await folders();
  const path = vmWorkspace ? guestWorkspaceToHost(requested, VM_WORKSPACE_GUEST, vmWorkspace) ?? requested : requested;
  return pageSource(path, vmWorkspace ? [vmWorkspace, ...roots] : roots);
}
