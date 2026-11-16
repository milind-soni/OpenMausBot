import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
  watch,
  type FSWatcher,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";

export type PreviewFileKind = "html" | "pdf" | "markdown" | "text" | "image" | "resource";

export interface PreviewFileDescriptor {
  path: string;
  name: string;
  kind: PreviewFileKind;
  mimeType: string;
  size: number;
}

export interface RegisteredProjectLike {
  id: string;
  name: string;
  path: string;
  missing?: boolean;
}

const EXTENSION_MAP: Record<string, { kind: PreviewFileKind; mimeType: string }> = {
  ".css": { kind: "resource", mimeType: "text/css; charset=utf-8" },
  ".js": { kind: "resource", mimeType: "text/javascript; charset=utf-8" },
  ".mjs": { kind: "resource", mimeType: "text/javascript; charset=utf-8" },
  ".woff": { kind: "resource", mimeType: "font/woff" },
  ".woff2": { kind: "resource", mimeType: "font/woff2" },
  ".ttf": { kind: "resource", mimeType: "font/ttf" },
  ".otf": { kind: "resource", mimeType: "font/otf" },
  ".ico": { kind: "image", mimeType: "image/x-icon" },
  ".avif": { kind: "image", mimeType: "image/avif" },
  ".html": { kind: "html", mimeType: "text/html; charset=utf-8" },
  ".htm": { kind: "html", mimeType: "text/html; charset=utf-8" },
  ".pdf": { kind: "pdf", mimeType: "application/pdf" },
  ".md": { kind: "markdown", mimeType: "text/markdown; charset=utf-8" },
  ".markdown": { kind: "markdown", mimeType: "text/markdown; charset=utf-8" },
  ".txt": { kind: "text", mimeType: "text/plain; charset=utf-8" },
  ".png": { kind: "image", mimeType: "image/png" },
  ".jpg": { kind: "image", mimeType: "image/jpeg" },
  ".jpeg": { kind: "image", mimeType: "image/jpeg" },
  ".webp": { kind: "image", mimeType: "image/webp" },
  ".gif": { kind: "image", mimeType: "image/gif" },
  ".svg": { kind: "image", mimeType: "image/svg+xml" },
};

export const ALLOWED_PREVIEW_EXTENSIONS = Object.freeze(Object.keys(EXTENSION_MAP));

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "dist-server",
  "build",
  "release",
  ".next",
  ".turbo",
  ".cache",
  "coverage",
]);

const MAX_PREVIEW_FILE_BYTES = 25 * 1024 * 1024; // 25 MB
const MAX_LISTED_FILES = 400;
const MAX_WALK_DEPTH = 6;

export class PreviewFileError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "PreviewFileError";
    this.status = status;
  }
}

export function classifyPreviewExtension(filePath: string): { kind: PreviewFileKind; mimeType: string } | null {
  const ext = extname(filePath).toLowerCase();
  return EXTENSION_MAP[ext] ?? null;
}

function isStrictSubpath(rootPath: string, targetPath: string): boolean {
  const rel = relative(rootPath, targetPath);
  return Boolean(rel) && !rel.startsWith("..") && !isAbsolute(rel);
}

function toPosixRelativePath(rootPath: string, targetPath: string): string {
  return relative(rootPath, targetPath).split(sep).join(posix.sep);
}

function deepestExistingRealpath(targetPath: string): string {
  let current = targetPath;
  for (;;) {
    if (existsSync(current)) {
      return realpathSync(current);
    }
    const parent = dirname(current);
    if (parent === current) {
      return current;
    }
    current = parent;
  }
}

export interface ResolvedPreviewFile {
  project: RegisteredProjectLike;
  projectRealPath: string;
  relativePath: string;
  realFilePath: string;
  kind: PreviewFileKind;
  mimeType: string;
  size: number;
  mtimeMs: number;
}

/**
 * Resolves and validates a previewable file inside a registered project.
 * Enforces:
 * 1. The project is registered and exists on disk.
 * 2. The requested path does not lexically traverse outside the project root.
 * 3. Neither the file nor any ancestor directory escapes the project root via symlinks (`realpathSync`).
 * 4. Both the requested path and the resolved real file have an allowed preview extension.
 */
export function resolvePreviewFile(
  projects: RegisteredProjectLike[],
  projectId: string,
  rawRelativePath: string,
): ResolvedPreviewFile {
  const cleanProjectId = String(projectId ?? "").trim();
  const cleanPath = String(rawRelativePath ?? "").trim();

  if (!cleanProjectId) {
    throw new PreviewFileError(400, "projectId is required");
  }
  if (!cleanPath || cleanPath.includes("\0")) {
    throw new PreviewFileError(400, "A valid file path is required");
  }

  const project = projects.find((candidate) => candidate.id === cleanProjectId);
  if (!project || project.missing || !existsSync(project.path)) {
    throw new PreviewFileError(404, "Registered project not found");
  }

  let projectRealPath: string;
  try {
    projectRealPath = realpathSync(project.path);
  } catch {
    throw new PreviewFileError(404, "Registered project folder is unavailable");
  }

  if (isAbsolute(cleanPath)) {
    throw new PreviewFileError(403, "File path must be relative to the registered project");
  }

  const normalizedRel = cleanPath.replace(/^[/\\]+/, "");
  const lexicalTarget = resolve(project.path, normalizedRel);

  // 1. Lexical containment check against the project root
  if (!isStrictSubpath(resolve(project.path), lexicalTarget)) {
    throw new PreviewFileError(403, "File path is outside the registered project");
  }

  // 2. Check for symlink escape on the target or its deepest existing ancestor
  try {
    const lstat = lstatSync(lexicalTarget);
    if (lstat.isSymbolicLink()) {
      const targetReal = realpathSync(lexicalTarget);
      if (!isStrictSubpath(projectRealPath, targetReal)) {
        throw new PreviewFileError(403, "Symlink escapes the registered project");
      }
    }
  } catch (err) {
    if (err instanceof PreviewFileError) throw err;
    // Target may not exist or a parent symlink may be broken; check deepest existing ancestor
    const ancestorReal = deepestExistingRealpath(lexicalTarget);
    if (ancestorReal !== projectRealPath && !isStrictSubpath(projectRealPath, ancestorReal)) {
      throw new PreviewFileError(403, "Symlink escapes the registered project");
    }
  }

  if (!existsSync(lexicalTarget)) {
    // Before returning 404, ensure extension check still rejects unsupported types if requested
    const requestedType = classifyPreviewExtension(lexicalTarget);
    if (!requestedType) {
      throw new PreviewFileError(415, "Unsupported preview file type");
    }
    throw new PreviewFileError(404, "Preview file not found");
  }

  let realFilePath: string;
  try {
    realFilePath = realpathSync(lexicalTarget);
  } catch {
    throw new PreviewFileError(403, "Unable to resolve file realpath inside project");
  }

  // 3. Canonical realpath containment check
  if (!isStrictSubpath(projectRealPath, realFilePath)) {
    throw new PreviewFileError(403, "Symlink escapes the registered project");
  }

  // 4. Extension allowlist check on both requested path and canonical real path
  const requestedType = classifyPreviewExtension(lexicalTarget);
  const realType = classifyPreviewExtension(realFilePath);
  if (!requestedType || !realType) {
    throw new PreviewFileError(415, "Unsupported preview file type");
  }

  const stats = statSync(realFilePath);
  if (!stats.isFile()) {
    throw new PreviewFileError(400, "Preview path must point to a regular file");
  }
  if (stats.size > MAX_PREVIEW_FILE_BYTES) {
    throw new PreviewFileError(413, "Preview file exceeds the 25 MB size limit");
  }

  return {
    project,
    projectRealPath,
    relativePath: toPosixRelativePath(project.path, lexicalTarget),
    realFilePath,
    kind: realType.kind,
    mimeType: realType.mimeType,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
  };
}

export function readPreviewFileContent(resolved: ResolvedPreviewFile): Buffer {
  return readFileSync(resolved.realFilePath);
}

/**
 * Maps a path a model wrote in chat (absolute, ~/, file:// or project-relative) to a previewable
 * file in a registered project. Every candidate goes through resolvePreviewFile, so the same
 * containment, symlink and extension rules apply. Relative paths try each project in order.
 */
export function resolveChatFileReference(projects: RegisteredProjectLike[], rawPath: string, home: string): ResolvedPreviewFile {
  let value = String(rawPath ?? "").trim();
  if (!value || value.includes("\0")) throw new PreviewFileError(400, "A file path is required");
  if (/^file:\/\//i.test(value)) {
    try { value = decodeURIComponent(new URL(value).pathname); } catch { throw new PreviewFileError(400, "Invalid file link"); }
  }
  value = value.split(/[?#]/)[0];
  if (value === "~" || value.startsWith("~/")) value = join(home, value.slice(1));
  const available = projects.filter((project) => !project.missing && existsSync(project.path));
  if (isAbsolute(value)) {
    const target = resolve(value);
    for (const project of available) {
      for (const root of new Set([resolve(project.path), realpathSync(project.path)])) {
        if (isStrictSubpath(root, target)) return resolvePreviewFile(projects, project.id, relative(root, target));
      }
    }
    throw new PreviewFileError(404, "That file isn't inside a registered project");
  }
  let lastError: unknown = new PreviewFileError(404, "That file isn't inside a registered project");
  for (const project of available) {
    try {
      return resolvePreviewFile(projects, project.id, value.replace(/^\.\//, ""));
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

/** Text documents (Markdown, plain text) are the only editable preview files. */
export function isEditablePreviewKind(kind: PreviewFileKind): boolean {
  return kind === "markdown" || kind === "text";
}

/**
 * Saves an edited text document in place. `baseMtimeMs` is the modification time the editor
 * loaded; if the file changed since (an agent or another app wrote it), the save is refused
 * with 409 so neither version is silently lost.
 */
export function writePreviewTextFile(resolved: ResolvedPreviewFile, content: string, baseMtimeMs: number | null): number {
  if (!isEditablePreviewKind(resolved.kind)) {
    throw new PreviewFileError(415, "Only Markdown and text files can be edited");
  }
  if (baseMtimeMs !== null && Math.abs(statSync(resolved.realFilePath).mtimeMs - baseMtimeMs) > 1) {
    throw new PreviewFileError(409, "The file changed on disk since it was opened");
  }
  writeFileSync(resolved.realFilePath, content, "utf8");
  return statSync(resolved.realFilePath).mtimeMs;
}

/**
 * Lists previewable files inside a registered project, skipping build/VCS folders
 * and any symlinks that escape the project's canonical root.
 */
export function listProjectPreviewFiles(
  projects: RegisteredProjectLike[],
  projectId: string,
): { project: RegisteredProjectLike; files: PreviewFileDescriptor[] } {
  const cleanProjectId = String(projectId ?? "").trim();
  const project = projects.find((candidate) => candidate.id === cleanProjectId);
  if (!project || project.missing || !existsSync(project.path)) {
    throw new PreviewFileError(404, "Registered project not found");
  }

  const projectRealPath = realpathSync(project.path);
  const files: PreviewFileDescriptor[] = [];

  const walk = (dirPath: string, depth: number) => {
    if (depth > MAX_WALK_DEPTH || files.length >= MAX_LISTED_FILES) return;
    let entries;
    try {
      entries = readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (files.length >= MAX_LISTED_FILES) break;
      if (entry.name.startsWith(".") || IGNORED_DIRS.has(entry.name)) continue;

      const fullPath = join(dirPath, entry.name);
      let realEntryPath: string;
      try {
        realEntryPath = realpathSync(fullPath);
      } catch {
        continue;
      }

      if (!isStrictSubpath(projectRealPath, realEntryPath)) {
        continue;
      }

      let stats;
      try {
        stats = statSync(realEntryPath);
      } catch {
        continue;
      }

      if (stats.isDirectory()) {
        walk(fullPath, depth + 1);
      } else if (stats.isFile()) {
        const typeInfo = classifyPreviewExtension(entry.name);
        const realTypeInfo = classifyPreviewExtension(realEntryPath);
        if (!typeInfo || !realTypeInfo || realTypeInfo.kind === "resource" || stats.size > MAX_PREVIEW_FILE_BYTES) continue;
        files.push({
          path: toPosixRelativePath(project.path, fullPath),
          name: basename(fullPath),
          kind: realTypeInfo.kind,
          mimeType: realTypeInfo.mimeType,
          size: stats.size,
        });
      }
    }
  };

  walk(project.path, 0);
  return { project, files };
}

export interface PreviewReloadPayload {
  kind: "preview.reload";
  projectId: string;
  path: string;
  at: number;
}

interface ActiveWatchEntry {
  clientId: string;
  projectId: string;
  relativePath: string;
  watchers: FSWatcher[];
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Manages active file watchers for preview auto-refresh and broadcasts
 * `preview.reload` events when watched files change on disk.
 */
export class PreviewWatchManager {
  private readonly entries = new Map<string, ActiveWatchEntry>();
  private readonly onReload: (payload: PreviewReloadPayload) => void;

  constructor(onReload: (payload: PreviewReloadPayload) => void) {
    this.onReload = onReload;
  }

  watchFile(clientId: string, resolved: ResolvedPreviewFile): void {
    const key = clientId.trim() || "default";
    this.unwatchClient(key);

    const targetName = basename(resolved.realFilePath);
    const parentDir = dirname(resolved.realFilePath);
    const watchers: FSWatcher[] = [];

    const entry: ActiveWatchEntry = {
      clientId: key,
      projectId: resolved.project.id,
      relativePath: resolved.relativePath,
      watchers,
      timer: null,
    };

    const trigger = () => {
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = setTimeout(() => {
        entry.timer = null;
        this.onReload({
          kind: "preview.reload",
          projectId: entry.projectId,
          path: entry.relativePath,
          at: Date.now(),
        });
      }, 60);
    };

    try {
      const fileWatcher = watch(resolved.realFilePath, { persistent: false }, () => {
        trigger();
      });
      fileWatcher.on("error", () => {});
      watchers.push(fileWatcher);
    } catch {
      // Fallback to directory watcher below
    }

    try {
      const dirWatcher = watch(parentDir, { persistent: false }, (_eventType, filename) => {
        if (!filename || String(filename) === targetName) {
          trigger();
        }
      });
      dirWatcher.on("error", () => {});
      watchers.push(dirWatcher);
    } catch {
      // Ignore if platform does not support watching parent dir
    }

    this.entries.set(key, entry);
  }

  unwatchClient(clientId: string): boolean {
    const key = clientId.trim() || "default";
    const existing = this.entries.get(key);
    if (!existing) return false;
    if (existing.timer) clearTimeout(existing.timer);
    for (const watcher of existing.watchers) {
      try {
        watcher.close();
      } catch {}
    }
    this.entries.delete(key);
    return true;
  }

  closeAll(): void {
    for (const key of Array.from(this.entries.keys())) {
      this.unwatchClient(key);
    }
  }

  activeCount(): number {
    return this.entries.size;
  }
}
