// The worker's own reading of an approved task manifest.
//
// The control plane already validated and approved this document — its digest
// is what a person clicked Allow on. The companion still re-derives two things
// from it locally rather than being told them:
//
//   1. whether a command's executable is one this platform may ever run, and
//   2. the exact CUA capability the task is allowed to activate.
//
// Both duplicate rules that also live in server/worker-task-manifest.ts and
// server/worker-cua-capability.ts, for the same reason platform.ts duplicates
// the daemon paths: the companion ships to the worker as a standalone package
// with no view of the server tree. The duplication is the point as much as the
// cost — a control plane that has been tampered with cannot hand this worker a
// broader boundary than the worker itself would derive, and
// test/manifest-parity.test.ts fails if the two ends ever disagree about what
// to reject.
import { createHash } from "node:crypto";

import { z } from "zod";

import type { JsonValue } from "./wire.ts";

export const TASK_MANIFEST_VERSION = 1;
export const TASK_IDLE_TIMEOUT_MS = 20 * 60_000;
export const TASK_MAX_FILE_BYTES = 50 * 1024 * 1024;
export const TASK_MAX_TOTAL_BYTES = 200 * 1024 * 1024;
export const TASK_MAX_COMMAND_MS = 30 * 60_000;

const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/i;
const SAFE_RELATIVE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$/;
const BLOCKED_FILE =
  /(^|\/)(?:\.git(?:\/|$)|\.env(?:\.[^/]*)?$|credentials?(?:\.[^/]*)?$|secrets?(?:\.[^/]*)?$|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.[^/]*)?$|[^/]+\.(?:key|pem|p12|pfx|keystore)$)/i;

export type TaskPlatform = "windows" | "macos";

/** The same three per-platform answers server/worker-task-manifest.ts keeps:
 * which executables are never allowed, which one is the file manager, and how
 * two executable paths compare for equality. */
interface PlatformProfile {
  readonly fileManager: string;
  readonly blockedExecutable: RegExp;
  readonly normalize: (value: string) => string;
}

export const PLATFORM_PROFILES = {
  windows: {
    fileManager: "C:\\Windows\\explorer.exe",
    blockedExecutable:
      /(?:^|\\)(?:cmd|powershell|pwsh|wt|windowsterminal|reg|regedit|mmc|taskmgr|control|mshta|wscript|cscript)\.exe$/i,
    normalize: (value: string) => value.replaceAll("/", "\\").toLowerCase(),
  },
  macos: {
    fileManager: "/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder",
    blockedExecutable:
      /(?:^|\/)(?:sh|bash|zsh|dash|ksh|csh|tcsh|fish|osascript|open|sudo|su|env|xargs|launchctl|python|python3|perl|ruby|node|deno|bun|Terminal|iTerm|iTerm2|Script Editor)$/,
    normalize: (value: string) => value,
  },
} satisfies Record<TaskPlatform, PlatformProfile>;

const WINDOWS_ABSOLUTE = /^[A-Za-z]:\\/;
const POSIX_ABSOLUTE = /^\//;

export function isAbsoluteFor(platform: TaskPlatform, value: string): boolean {
  return platform === "windows" ? WINDOWS_ABSOLUTE.test(value) : POSIX_ABSOLUTE.test(value);
}

const relativePath = z.string().refine((value) => {
  if (!SAFE_RELATIVE.test(value) || value.includes("//") || value.endsWith("/")) return false;
  const parts = value.split("/");
  return !parts.some((part) => part === "." || part === "..") && !BLOCKED_FILE.test(value);
}, { message: "must be a safe, non-secret relative task path" });

const executablePath = z.string().max(512).refine(
  (value) => !/[\u0000-\u001f"|<>]/.test(value),
  { message: "must not contain control characters or shell metacharacters" },
);

const manifestSchema = z.object({
  version: z.literal(TASK_MANIFEST_VERSION),
  surface: z.enum(["browser", "desktop"]),
  platform: z.enum(["windows", "macos"]),
  workerId: z.string().regex(ID),
  taskId: z.string().regex(ID),
  threadId: z.string().regex(ID),
  createdAt: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
  idleTimeoutMs: z.literal(TASK_IDLE_TIMEOUT_MS),
  target: z.object({
    sshAlias: z.string().regex(ID),
    basePolicySha256: z.string().regex(SHA256),
    browserExecutable: executablePath,
    browserProfile: z.string().min(1).max(100),
    ideExecutable: executablePath,
  }).strict(),
  files: z.array(z.object({
    path: relativePath,
    size: z.number().int().min(0).max(TASK_MAX_FILE_BYTES),
    sha256: z.string().regex(SHA256),
  }).strict()).max(512),
  commands: z.array(z.object({
    id: z.string().regex(ID),
    executable: executablePath,
    argv: z.array(z.string().max(4096)).max(128),
    cwd: relativePath,
    timeoutMs: z.number().int().min(1_000).max(TASK_MAX_COMMAND_MS),
  }).strict()).min(1).max(128),
  origins: z.array(z.string().max(2048)).max(128),
  resultPaths: z.array(relativePath).min(2).max(256),
}).strict();

export type TaskManifest = z.output<typeof manifestSchema>;
export type TaskCommand = TaskManifest["commands"][number];

function canonical(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || !(value instanceof Object)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, canonical(child)]),
  );
}

/** Byte-for-byte the control plane's `workerTaskManifestDigest`: canonical JSON
 * of the parsed document, so key order in the staged file cannot change what a
 * person approved. */
export function taskManifestDigest(document: JsonValue): string {
  return createHash("sha256").update(JSON.stringify(canonical(document))).digest("hex");
}

/** Parse a staged manifest and re-apply the executable rules locally.
 *
 * `expectedSha256` is the digest the operator approved. It is checked against
 * the document as staged, so nothing that reached this worker after approval
 * can change what runs. */
export function parseStagedManifest(document: JsonValue, expectedSha256: string): TaskManifest {
  if (taskManifestDigest(document).toLowerCase() !== expectedSha256.toLowerCase()) {
    throw new Error("staged task manifest does not match the approved digest");
  }
  const parsed = manifestSchema.safeParse(document);
  if (!parsed.success) {
    throw new Error(`invalid staged task manifest: ${parsed.error.issues[0]?.message ?? "unparseable"}`);
  }
  const manifest = parsed.data;
  const profile = PLATFORM_PROFILES[manifest.platform];

  if (manifest.files.reduce((sum, file) => sum + file.size, 0) > TASK_MAX_TOTAL_BYTES) {
    throw new Error("staged task files exceed 200 MB");
  }
  if (manifest.surface === "browser" && manifest.origins.length === 0) {
    throw new Error("a browser task requires at least one exact origin");
  }
  if (manifest.surface === "desktop" && manifest.origins.length > 0) {
    throw new Error("a desktop task cannot declare browser origins");
  }

  const guiApps = new Set(
    [manifest.target.browserExecutable, manifest.target.ideExecutable, profile.fileManager]
      .map(profile.normalize),
  );
  for (const command of manifest.commands) {
    if (!isAbsoluteFor(manifest.platform, command.executable)) {
      throw new Error(`task executable must be an absolute path: ${command.executable}`);
    }
    if (profile.blockedExecutable.test(command.executable)) {
      throw new Error(`task executable is forbidden: ${command.executable}`);
    }
    const normalized = profile.normalize(command.executable);
    if (manifest.platform === "windows" && !normalized.endsWith(".exe")) {
      throw new Error(`task executable must be a .exe: ${command.executable}`);
    }
    if (guiApps.has(normalized)) {
      throw new Error(`GUI executable must be driven through CUA, not the command runner: ${command.executable}`);
    }
  }
  return manifest;
}

// ── the derived CUA capability ───────────────────────────────────────────────

/** JSON double-quoted strings are valid YAML scalars, which avoids hand-rolling
 * quoting rules for Windows paths, profile names, and origins. */
const yamlString = (value: string): string => JSON.stringify(value);

const BROWSER_TOOLS = [
  "start_session",
  "end_session",
  "list_windows",
  "browser_prepare",
  "get_browser_state",
  "browser_navigate",
  "browser_click",
  "browser_type",
];

const DESKTOP_TOOLS = [
  "start_session",
  "end_session",
  "launch_app",
  "list_windows",
  "get_window_state",
  "click",
  "double_click",
  "right_click",
  "drag",
  "scroll",
  "type_text",
  "press_key",
  "hotkey",
  "set_value",
  "wait",
  "bring_to_front",
];

const app = (executable: string): string[] => [
  `    - executable: ${yamlString(executable)}`,
  "      launch: true",
  "      windows: all",
  "      terminate: driver_launched",
];

/** Rebuild the exact capability the control plane derived. `issuedAt` is the
 * instant the control plane used; the lifetimes in a CUA manifest are relative,
 * so without it the two ends could never agree on a digest. The caller bounds
 * how far that instant may be from this worker's own clock. */
export function taskCapabilityManifest(manifest: TaskManifest, root: string, issuedAt: number): string {
  if (!isAbsoluteFor(manifest.platform, root) || /[\u0000\r\n]/.test(root)) {
    throw new Error(`task root must be an absolute ${manifest.platform} path`);
  }
  const expiresSeconds = Math.floor((manifest.expiresAt - issuedAt) / 1_000);
  if (expiresSeconds < 1) throw new Error("task capability manifest is expired");
  const idleSeconds = Math.max(1, Math.min(expiresSeconds, Math.floor(manifest.idleTimeoutMs / 1_000)));

  const head = [
    "version: 3",
    `expires_after: ${expiresSeconds}s`,
    `idle_timeout: ${idleSeconds}s`,
    "",
    "allow:",
    "  tools:",
  ];

  if (manifest.surface === "browser") {
    return [
      ...head,
      ...BROWSER_TOOLS.map((tool) => `    - ${tool}`),
      "",
      "resources:",
      "  apps:",
      ...app(manifest.target.browserExecutable),
      "  browser:",
      "    profiles:",
      "      - kind: existing_profile",
      "    origins:",
      ...manifest.origins.map((origin) => `      - ${yamlString(origin)}`),
      "  desktop:",
      "    display: false",
      "",
    ].join("\n");
  }

  return [
    ...head,
    ...DESKTOP_TOOLS.map((tool) => `    - ${tool}`),
    "",
    "resources:",
    "  apps:",
    ...app(manifest.target.ideExecutable),
    ...app(PLATFORM_PROFILES[manifest.platform].fileManager),
    "  files:",
    "    read:",
    `      - dir: ${yamlString(root)}`,
    "        recursive: true",
    "    write:",
    `      - dir: ${yamlString(root)}`,
    "        recursive: true",
    "  desktop:",
    "    display: false",
    "",
  ].join("\n");
}
