// The task manifest: the third fence.
//
// The base policy is the stable ceiling and the CUA capability is the
// short-lived per-task boundary that intersects it. This is the document that
// says what one approved task may actually do — every mutable execution field
// lives inside it, it is hashed, and the hash is what an operator approves.
//
// Derived from the Windows-only manifest and generalised: everything that was
// OS-specific reduces to the small profile table below, so the validation rules
// themselves are shared and there is exactly one place where "which shells are
// forbidden" is answered per platform.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { z } from "zod";

import { isSafeWorkerExecutable, type ResolvedWorker, type WorkerPlatform } from "./computer-workers.ts";
import { parseJson, type JsonValue } from "./schema.ts";

export const WORKER_TASK_MANIFEST_VERSION = 1 as const;
export const WORKER_TASK_MAX_LIFETIME_MS = 2 * 60 * 60_000;
export const WORKER_TASK_IDLE_TIMEOUT_MS = 20 * 60_000;
export const WORKER_TASK_MAX_FILE_BYTES = 50 * 1024 * 1024;
export const WORKER_TASK_MAX_TOTAL_BYTES = 200 * 1024 * 1024;
export const WORKER_TASK_MAX_COMMAND_MS = 30 * 60_000;

const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/i;
const SAFE_RELATIVE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$/;
const BLOCKED_FILE =
  /(^|\/)(?:\.git(?:\/|$)|\.env(?:\.[^/]*)?$|credentials?(?:\.[^/]*)?$|secrets?(?:\.[^/]*)?$|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.[^/]*)?$|[^/]+\.(?:key|pem|p12|pfx|keystore)$)/i;

/** Per-platform answers to the three questions the shared rules ask: which
 * executables are never allowed, which one is the file manager, and how two
 * executable paths are compared for equality. */
interface PlatformProfile {
  /** The file manager, which the CUA desktop capability may launch. */
  readonly fileManager: string;
  /** Shells, terminals, script hosts and administrative surfaces. Matched on
   * the basename so a bundle path like
   * /Applications/Utilities/Terminal.app/Contents/MacOS/Terminal is caught. */
  readonly blockedExecutable: RegExp;
  /** Windows paths are case-insensitive and separator-agnostic; POSIX paths
   * are neither, and folding them would let two different binaries compare
   * equal. */
  readonly normalize: (value: string) => string;
}

const PLATFORM_PROFILES = {
  windows: {
    fileManager: "C:\\Windows\\explorer.exe",
    blockedExecutable:
      /(?:^|\\)(?:cmd|powershell|pwsh|wt|windowsterminal|reg|regedit|mmc|taskmgr|control|mshta|wscript|cscript)\.exe$/i,
    normalize: (value: string) => value.replaceAll("/", "\\").toLowerCase(),
  },
  macos: {
    fileManager: "/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder",
    // No extension to key off on POSIX, so this is a basename list. `open` and
    // `osascript` matter as much as the shells: either one turns a bounded
    // command into arbitrary execution.
    blockedExecutable:
      /(?:^|\/)(?:sh|bash|zsh|dash|ksh|csh|tcsh|fish|osascript|open|sudo|su|env|xargs|launchctl|python|python3|perl|ruby|node|deno|bun|Terminal|iTerm|iTerm2|Script Editor)$/,
    normalize: (value: string) => value,
  },
} satisfies Record<WorkerPlatform, PlatformProfile>;

export interface WorkerTaskFile {
  path: string;
  size: number;
  sha256: string;
}

export interface WorkerTaskCommand {
  id: string;
  executable: string;
  argv: string[];
  cwd: string;
  timeoutMs: number;
}

export interface WorkerTaskManifest {
  version: typeof WORKER_TASK_MANIFEST_VERSION;
  /** CUA rejects browser-origin scope combined with generic desktop input, so
   * each task selects exactly one native capability surface. */
  surface: "browser" | "desktop";
  platform: WorkerPlatform;
  workerId: string;
  taskId: string;
  threadId: string;
  createdAt: number;
  expiresAt: number;
  idleTimeoutMs: typeof WORKER_TASK_IDLE_TIMEOUT_MS;
  target: {
    sshAlias: string;
    basePolicySha256: string;
    browserExecutable: string;
    browserProfile: string;
    ideExecutable: string;
  };
  files: WorkerTaskFile[];
  commands: WorkerTaskCommand[];
  origins: string[];
  resultPaths: string[];
}

const relativePath = z.string().refine((value) => {
  if (!SAFE_RELATIVE.test(value) || value.includes("//") || value.endsWith("/")) return false;
  const parts = value.split("/");
  return !parts.some((part) => part === "." || part === "..") && !BLOCKED_FILE.test(value);
}, { message: "must be a safe, non-secret relative task path" });

// The executable grammar depends on the sibling `platform` field, so it is
// checked in the superRefine below rather than here.
const executablePath = z.string().max(512).refine(
  (value) => !/[\u0000-\u001f"|<>]/.test(value),
  { message: "must not contain control characters or shell metacharacters" },
);

const fileSchema = z.object({
  path: relativePath,
  size: z.number().int().min(0).max(WORKER_TASK_MAX_FILE_BYTES),
  sha256: z.string().regex(SHA256).transform((value) => value.toLowerCase()),
}).strict();

const commandSchema = z.object({
  id: z.string().regex(ID),
  executable: executablePath,
  argv: z.array(z.string().max(4096).refine((value) => !/[\u0000\r\n]/.test(value))).max(128),
  cwd: relativePath,
  timeoutMs: z.number().int().min(1_000).max(WORKER_TASK_MAX_COMMAND_MS),
}).strict();

const manifestSchema = z.object({
  version: z.literal(WORKER_TASK_MANIFEST_VERSION),
  surface: z.enum(["browser", "desktop"]).optional(),
  platform: z.enum(["windows", "macos"]),
  workerId: z.string().regex(ID),
  taskId: z.string().regex(ID),
  threadId: z.string().regex(ID),
  createdAt: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
  idleTimeoutMs: z.literal(WORKER_TASK_IDLE_TIMEOUT_MS),
  target: z.object({
    sshAlias: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/),
    basePolicySha256: z.string().regex(SHA256).transform((value) => value.toLowerCase()),
    browserExecutable: executablePath.optional(),
    browserProfile: z.string().min(1).max(100).refine((value) => !/[\u0000-\u001f]/.test(value)).optional(),
    ideExecutable: executablePath.optional(),
  }).strict(),
  files: z.array(fileSchema).max(512),
  commands: z.array(commandSchema).min(1).max(128),
  origins: z.array(z.string().max(2048)).max(128),
  resultPaths: z.array(relativePath).min(2).max(256),
}).strict();

/** An origin the browser capability may reach. Exact only: a wildcard, a path,
 * a query, or embedded credentials would make the origin list decorative. */
function exactOrigin(value: string): string | null {
  if (value.includes("*")) return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    if (url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Parse an untrusted manifest and bind it to one configured worker. */
export function parseWorkerTaskManifest(
  value: JsonValue,
  worker: ResolvedWorker,
  now = Date.now(),
): WorkerTaskManifest {
  const parsed = manifestSchema.safeParse(value);
  if (!parsed.success) throw new Error(`Invalid worker task manifest: ${z.prettifyError(parsed.error)}`);

  if (parsed.data.platform !== worker.platform) {
    throw new Error("Worker task platform does not match the configured worker");
  }
  if (parsed.data.workerId !== worker.id) {
    throw new Error("Worker task manifest names a different worker");
  }
  const profile = PLATFORM_PROFILES[worker.platform];

  const manifest: WorkerTaskManifest = {
    ...parsed.data,
    surface: parsed.data.surface ?? (parsed.data.origins.length > 0 ? "browser" : "desktop"),
    target: {
      ...parsed.data.target,
      browserExecutable: parsed.data.target.browserExecutable ?? worker.browserExecutable,
      browserProfile: parsed.data.target.browserProfile ?? worker.browserProfile,
      ideExecutable: parsed.data.target.ideExecutable ?? worker.ideExecutable,
    },
  };

  if (!worker.configured || !worker.expectedBasePolicySha256) {
    throw new Error("Worker task target has no pinned base policy");
  }
  if (manifest.target.sshAlias !== worker.sshAlias) {
    throw new Error("Worker task target does not match the configured SSH alias");
  }
  if (manifest.target.basePolicySha256 !== worker.expectedBasePolicySha256) {
    throw new Error("Worker task policy digest does not match the configured base policy");
  }

  const sameExecutable = (a: string, b: string) => profile.normalize(a) === profile.normalize(b);
  if (
    !sameExecutable(manifest.target.browserExecutable, worker.browserExecutable) ||
    manifest.target.browserProfile !== worker.browserProfile ||
    !sameExecutable(manifest.target.ideExecutable, worker.ideExecutable)
  ) {
    throw new Error("Worker task application target does not match the configured worker");
  }

  if (manifest.createdAt > now + 60_000 || manifest.expiresAt <= now) {
    throw new Error("Worker task manifest is not currently valid");
  }
  if (manifest.expiresAt - manifest.createdAt > WORKER_TASK_MAX_LIFETIME_MS) {
    throw new Error("Worker task manifest lifetime exceeds two hours");
  }

  const total = manifest.files.reduce((sum, file) => sum + file.size, 0);
  if (total > WORKER_TASK_MAX_TOTAL_BYTES) throw new Error("Worker task staged files exceed 200 MB");

  const unique = (values: string[], label: string) => {
    if (new Set(values.map((entry) => entry.toLowerCase())).size !== values.length) {
      throw new Error(`Worker task ${label} must be unique`);
    }
  };
  unique(manifest.files.map((file) => file.path), "file paths");
  unique(manifest.commands.map((command) => command.id), "command ids");
  unique(manifest.resultPaths, "result paths");
  if (!manifest.resultPaths.includes("result.json") || !manifest.resultPaths.includes("changes.patch")) {
    throw new Error("Worker task results must include result.json and changes.patch");
  }

  manifest.origins = manifest.origins.map((origin) => {
    const normalized = exactOrigin(origin);
    if (!normalized || normalized !== origin) throw new Error(`Worker task origin must be exact: ${origin}`);
    return normalized;
  });
  unique(manifest.origins, "origins");
  if (manifest.surface === "browser" && manifest.origins.length === 0) {
    throw new Error("A browser worker task requires at least one exact origin");
  }
  if (manifest.surface === "desktop" && manifest.origins.length > 0) {
    throw new Error("A desktop worker task cannot declare browser origins; use a separate browser task");
  }

  // The CUA policy is limited to browser / IDE / file manager. The companion's
  // structured runner may additionally launch an exact build or test binary
  // named in this approved manifest — but never a shell, terminal, script host,
  // registry or administrative surface, and never a GUI app that belongs to
  // CUA, because a GUI launched behind SSH would sit outside the capability.
  const guiApps = new Set(
    [manifest.target.browserExecutable, manifest.target.ideExecutable, profile.fileManager]
      .map(profile.normalize),
  );
  for (const command of manifest.commands) {
    if (!isSafeWorkerExecutable(worker.platform, command.executable)) {
      throw new Error(`Worker task executable must be an absolute path: ${command.executable}`);
    }
    const normalized = profile.normalize(command.executable);
    if (profile.blockedExecutable.test(command.executable)) {
      throw new Error(`Worker task executable is forbidden: ${command.executable}`);
    }
    if (worker.platform === "windows" && !normalized.endsWith(".exe")) {
      throw new Error(`Worker task executable must be a .exe: ${command.executable}`);
    }
    if (guiApps.has(normalized)) {
      throw new Error(`GUI executable must be driven through CUA, not the command runner: ${command.executable}`);
    }
  }
  return manifest;
}

function canonical(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || !(value instanceof Object)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, canonical(child)]),
  );
}

/** Canonical JSON: key order must not change the digest an operator approved. */
export function workerTaskManifestJson(manifest: WorkerTaskManifest): string {
  return JSON.stringify(canonical(parseJson(JSON.stringify(manifest))));
}

export function workerTaskManifestDigest(manifest: WorkerTaskManifest): string {
  return createHash("sha256").update(workerTaskManifestJson(manifest)).digest("hex");
}

/** Verify the exact local stage without following symlinks or reading a blocked
 * credential path. The manifest path filter runs before any filesystem access,
 * and every resolved file must stay below the task root — checked both before
 * and after realpath, because a symlink swapped in between would otherwise
 * escape. */
export function verifyWorkerTaskFiles(root: string, manifest: WorkerTaskManifest): void {
  if (!isAbsolute(root)) throw new Error("Worker task staging root must be absolute");
  const rootReal = realpathSync(root);
  const escapes = (within: string) =>
    !within || within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within);

  for (const file of manifest.files) {
    if (BLOCKED_FILE.test(file.path)) throw new Error(`Worker task file is blocked: ${file.path}`);
    const candidate = resolve(rootReal, ...file.path.split("/"));
    if (escapes(relative(rootReal, candidate))) {
      throw new Error(`Worker task file escapes the staging root: ${file.path}`);
    }
    const stat = lstatSync(candidate);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`Worker task file is not a regular file: ${file.path}`);
    }
    if (escapes(relative(rootReal, realpathSync(candidate)))) {
      throw new Error(`Worker task file resolves outside the staging root: ${file.path}`);
    }
    if (stat.size !== file.size) throw new Error(`Worker task file size changed: ${file.path}`);
    const digest = createHash("sha256").update(readFileSync(candidate)).digest("hex");
    if (digest !== file.sha256) throw new Error(`Worker task file hash changed: ${file.path}`);
  }
}

export interface WorkerTaskRecord {
  manifest: WorkerTaskManifest;
  digest: string;
  approvedAt: number | null;
  lastUsedAt: number | null;
}

/** In-memory approval and idle fence. A restart intentionally forgets approval:
 * the manifest stays data, but remote execution needs a fresh card. */
export class WorkerTaskRegistry {
  private readonly records = new Map<string, WorkerTaskRecord>();

  register(manifest: WorkerTaskManifest): WorkerTaskRecord {
    const digest = workerTaskManifestDigest(manifest);
    const current = this.records.get(manifest.taskId);
    // Re-registering the identical document keeps any approval it already has;
    // a changed document silently drops it, which is the point of the digest.
    const record: WorkerTaskRecord = current?.digest === digest
      ? current
      : { manifest, digest, approvedAt: null, lastUsedAt: null };
    this.records.set(manifest.taskId, record);
    return structuredClone(record);
  }

  approve(taskId: string, digest: string, now = Date.now()): boolean {
    const record = this.records.get(taskId);
    if (!record || record.digest !== digest || record.manifest.expiresAt <= now) return false;
    record.approvedAt = now;
    record.lastUsedAt = now;
    return true;
  }

  approved(taskId: string, digest: string, now = Date.now()): WorkerTaskRecord | null {
    const record = this.records.get(taskId);
    if (!record || record.digest !== digest || record.approvedAt === null || record.lastUsedAt === null) return null;
    if (record.manifest.expiresAt <= now || now - record.lastUsedAt >= record.manifest.idleTimeoutMs) {
      record.approvedAt = null;
      record.lastUsedAt = null;
      return null;
    }
    record.lastUsedAt = now;
    return structuredClone(record);
  }

  get(taskId: string): WorkerTaskRecord | null {
    const record = this.records.get(taskId);
    return record ? structuredClone(record) : null;
  }

  forThread(threadId: string): WorkerTaskRecord | null {
    const records = [...this.records.values()].filter((record) => record.manifest.threadId === threadId);
    const record = records.sort((a, b) => b.manifest.createdAt - a.manifest.createdAt)[0];
    return record ? structuredClone(record) : null;
  }

  /** Every task on one worker, newest first — used to revoke a worker's whole
   * surface when it goes offline without touching the other worker's tasks. */
  forWorker(workerId: string): WorkerTaskRecord[] {
    return [...this.records.values()]
      .filter((record) => record.manifest.workerId === workerId)
      .sort((a, b) => b.manifest.createdAt - a.manifest.createdAt)
      .map((record) => structuredClone(record));
  }

  revoke(taskId: string): void {
    const record = this.records.get(taskId);
    if (record) {
      record.approvedAt = null;
      record.lastUsedAt = null;
    }
  }

  revokeWorker(workerId: string): void {
    for (const record of this.records.values()) {
      if (record.manifest.workerId !== workerId) continue;
      record.approvedAt = null;
      record.lastUsedAt = null;
    }
  }

  revokeAll(): void {
    for (const record of this.records.values()) {
      record.approvedAt = null;
      record.lastUsedAt = null;
    }
  }
}
