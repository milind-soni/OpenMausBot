// A page's files, read from inside the bot's own folders only: the path is resolved and every file re-checked with
// realpath containment, symlinks out of the folder are skipped, and hidden files and folders (.git, .env) never go.
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { PAGE_FILE_EXTENSIONS, PAGE_MAX_BYTES, PAGE_MAX_FILES } from "../../shared/published-page.ts";
import { guestWorkspaceToHost } from "../bot-attachment.ts";
import { VM_WORKSPACE_GUEST } from "../container-computer.ts";

export interface PageFile {
  path: string;
  data: Buffer;
}
export interface PageBundle {
  /** The file or folder published, canonical: the same source publishes to the same link again. */
  source: string;
  files: PageFile[];
  bytes: number;
  /** Files left out because a page can't serve them. */
  skipped: string[];
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
export async function readPageBundle(requested: string, roots: readonly string[], limits = { bytes: PAGE_MAX_BYTES, files: PAGE_MAX_FILES }): Promise<PageBundle> {
  const { target, root } = await locate(requested, roots);
  const info = await stat(target);
  if (info.isFile()) {
    if (!isHtml(target)) throw new PageBundleError("A single file must be an .html page. For anything else, publish a folder with an index.html.");
    if (info.size > limits.bytes) throw new PageBundleError(`The page is ${info.size} bytes; a page can be at most ${limits.bytes}.`, 413);
    const data = await readFile(target);
    return { source: target, files: [{ path: "index.html", data }], bytes: data.byteLength, skipped: [] };
  }
  if (!info.isDirectory()) throw new PageBundleError("Publish an .html file or a folder.");
  const files: PageFile[] = [], skipped: string[] = [];
  let bytes = 0;
  const walk = async (folder: string, depth: number): Promise<void> => {
    for (const name of (await readdir(folder)).sort()) {
      if (name.startsWith(".")) continue;
      const full = join(folder, name), own = await lstat(full);
      const real = own.isSymbolicLink() ? await realpath(full).catch(() => null) : full;
      if (!real || !containedBy(root, real)) continue;
      const entry = own.isSymbolicLink() ? await stat(real) : own;
      const path = relative(target, full).split(sep).join("/");
      if (entry.isDirectory()) {
        if (SKIPPED_FOLDERS.has(name) || depth >= 9 || !SEGMENT.test(name) || name.endsWith(".")) { skipped.push(`${path}/`); continue; }
        await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!servable(name) || !SEGMENT.test(name) || name.endsWith(".")) { skipped.push(path); continue; }
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
  return { source: target, files, bytes, skipped };
}

/** The bot's own folders for a turn, and its Local VM's workspace on this computer when it has one. */
export type BotFolders = () => Promise<{ roots: readonly string[]; vmWorkspace: string | null }>;

/** readPageBundle within a bot's own folders; a path inside its Local VM's workspace means the same file here. */
export async function readBotPageBundle(requested: string, folders: BotFolders): Promise<PageBundle> {
  const { roots, vmWorkspace } = await folders();
  const path = vmWorkspace ? guestWorkspaceToHost(requested, VM_WORKSPACE_GUEST, vmWorkspace) ?? requested : requested;
  return readPageBundle(path, vmWorkspace ? [vmWorkspace, ...roots] : roots);
}
