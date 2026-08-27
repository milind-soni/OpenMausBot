// Named remote CUA workers.
//
// A worker is one operator-owned interactive machine — a Windows PC or a
// macOS guest — reached through the operator's own SSH config. OpenMausBot
// never provisions a worker, never stores a key, a password or a bearer
// value, and never opens a listener on it: it persists only the SSH alias
// plus public configuration digests, and authentication stays entirely with
// SSH.
//
// This registry exists because the single app-level `vps.sshAlias` shape
// cannot express two targets at once. Bots address a worker by id, and the
// per-alias lease in ./remote-worker.ts keeps two workers independent, so a
// bot on Windows and a bot on macOS can hold their desktops at the same time.
import { z } from "zod";
import type { JsonValue } from "./schema.ts";

/** Pinned across every worker platform; the driver's wire protocol and its
 * policy/capability digests are only comparable within one exact version. */
export const WORKER_DRIVER_VERSION = "0.20.0";

export const MAX_WORKERS = 8;

const WORKER_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SSH_ALIAS = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/i;
const WINDOWS_ABSOLUTE = /^[A-Za-z]:\\/;
const POSIX_ABSOLUTE = /^\//;

export type WorkerPlatform = "windows" | "macos";

export const WORKER_PLATFORMS: readonly WorkerPlatform[] = ["windows", "macos"];

/** Per-platform defaults. A fresh worker only needs an alias and a base-policy
 * digest; everything else has a conventional value the operator can override
 * when their install differs. */
export const WORKER_DEFAULTS = {
  windows: {
    browserExecutable: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    browserProfile: "OpenMaus Windows Worker",
    ideExecutable: "C:\\Program Files\\Microsoft VS Code\\Code.exe",
  },
  macos: {
    browserExecutable: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    browserProfile: "OpenMaus macOS Worker",
    ideExecutable: "/Applications/Visual Studio Code.app/Contents/MacOS/Electron",
  },
} satisfies Record<WorkerPlatform, { browserExecutable: string; browserProfile: string; ideExecutable: string }>;

export function isValidWorkerId(value: string): boolean {
  return WORKER_ID.test(value);
}

export function isValidWorkerSshAlias(value: string): boolean {
  return SSH_ALIAS.test(value);
}

export function isWorkerPlatform(value: JsonValue): value is WorkerPlatform {
  return value === "windows" || value === "macos";
}

/** The id as it arrives from config, a bot record, or an HTTP body. */
const workerIdSchema = z.string().regex(WORKER_ID);

/** Executable paths reach a shell-free spawn and the CUA capability YAML, but
 * they are still operator input echoed into a manifest the daemon enforces.
 * Reject control characters and the shell metacharacters that would make a
 * quoted YAML scalar ambiguous, and require the platform's absolute form so a
 * relative path can never resolve against an unexpected working directory. */
export function isSafeWorkerExecutable(platform: WorkerPlatform, value: string): boolean {
  if (value.length === 0 || value.length > 512) return false;
  if (/[\u0000-\u001f"|<>]/.test(value)) return false;
  return platform === "windows" ? WINDOWS_ABSOLUTE.test(value) : POSIX_ABSOLUTE.test(value);
}

const workerConfigSchema = z.object({
  platform: z.enum(["windows", "macos"]),
  sshAlias: z.string().refine(isValidWorkerSshAlias, {
    message: "must be a simple SSH config alias",
  }),
  displayName: z.string().max(100).refine((value) => !/[\u0000-\u001f]/.test(value), {
    message: "must not contain control characters",
  }).optional(),
  expectedDriverVersion: z.string().max(32).refine((value) => value === "" || /^\d+\.\d+\.\d+$/.test(value), {
    message: "must be an exact CUA Driver version",
  }).optional(),
  expectedBasePolicySha256: z.string().refine((value) => value === "" || SHA256.test(value), {
    message: "must be a SHA-256 digest",
  }).optional(),
  browserExecutable: z.string().max(512).optional(),
  browserProfile: z.string().max(100).refine((value) => !/[\u0000-\u001f]/.test(value), {
    message: "must not contain control characters",
  }).optional(),
  ideExecutable: z.string().max(512).optional(),
  paused: z.boolean().optional(),
}).strict().superRefine((worker, ctx) => {
  // Path grammar depends on the sibling `platform` field, so it cannot be
  // expressed on the individual string schemas above.
  for (const key of ["browserExecutable", "ideExecutable"] as const) {
    const value = worker[key];
    if (value === undefined || value === "") continue;
    if (!isSafeWorkerExecutable(worker.platform, value)) {
      ctx.addIssue({
        code: "custom",
        path: [key],
        message: worker.platform === "windows"
          ? "must be an absolute Windows executable path without control or shell characters"
          : "must be an absolute POSIX executable path without control or shell characters",
      });
    }
  }
});

export const workerConfigMapSchema = z
  .record(z.string().regex(WORKER_ID, "must be a lowercase worker id"), workerConfigSchema)
  .refine((workers) => Object.keys(workers).length <= MAX_WORKERS, {
    message: `at most ${MAX_WORKERS} workers may be configured`,
  })
  .refine(
    (workers) => {
      const aliases = Object.values(workers).map((worker) => worker.sshAlias);
      return new Set(aliases).size === aliases.length;
    },
    // Two ids sharing one alias would take two independent leases against one
    // real machine, and each would believe it held the desktop exclusively.
    { message: "each worker must use a distinct SSH alias" },
  );

export type WorkerConfig = z.output<typeof workerConfigSchema>;
export type WorkerConfigMap = Record<string, WorkerConfig>;

export interface ResolvedWorker {
  id: string;
  platform: WorkerPlatform;
  displayName: string;
  sshAlias: string;
  expectedDriverVersion: string;
  expectedBasePolicySha256: string | null;
  browserExecutable: string;
  browserProfile: string;
  ideExecutable: string;
  paused: boolean;
  /** False until the operator supplies the base-policy digest. An unpinned
   * policy means the driver's tool ceiling is whatever happens to be on the
   * worker's disk, so an unconfigured worker is never treated as usable. */
  configured: boolean;
}

export function resolveWorker(id: string, raw: WorkerConfig): ResolvedWorker {
  const defaults = WORKER_DEFAULTS[raw.platform];
  const digest = raw.expectedBasePolicySha256 && SHA256.test(raw.expectedBasePolicySha256)
    ? raw.expectedBasePolicySha256.toLowerCase()
    : null;
  return {
    id,
    platform: raw.platform,
    displayName: raw.displayName || id,
    sshAlias: raw.sshAlias,
    expectedDriverVersion: raw.expectedDriverVersion || WORKER_DRIVER_VERSION,
    expectedBasePolicySha256: digest,
    browserExecutable: raw.browserExecutable || defaults.browserExecutable,
    browserProfile: raw.browserProfile || defaults.browserProfile,
    ideExecutable: raw.ideExecutable || defaults.ideExecutable,
    paused: raw.paused === true,
    configured: digest !== null,
  };
}

export function listWorkers(workers: WorkerConfigMap | undefined): ResolvedWorker[] {
  if (!workers) return [];
  return Object.keys(workers)
    .filter(isValidWorkerId)
    .sort()
    .map((id) => resolveWorker(id, workers[id]));
}

export function findWorker(workers: WorkerConfigMap | undefined, id: JsonValue): ResolvedWorker | null {
  const parsed = workerIdSchema.safeParse(id);
  if (!workers || !parsed.success) return null;
  const raw = workers[parsed.data];
  return raw ? resolveWorker(parsed.data, raw) : null;
}

/** Redacts the transport identity before a worker is described to a bot, a
 * device client, or a task event. The alias names a host in the operator's
 * own SSH config; nothing downstream of the control plane needs it, and #508
 * requires it stay out of snapshots, events, logs and exports. */
export function publicWorker(worker: ResolvedWorker): Omit<ResolvedWorker, "sshAlias"> {
  const { sshAlias: _sshAlias, ...rest } = worker;
  return rest;
}
