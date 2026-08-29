// The SSH half of the task layer: how an approved manifest reaches a worker
// and what comes back.
//
// Every remote invocation is fixed argv through the same base args and
// allow-listed environment the health probe uses (server/remote-worker.ts), so
// nothing here can widen the connection's boundary. Two of the five operations
// carry raw bytes and take a streaming runner; the other three are one JSON
// line in and one JSON line out, which is all the companion's wire accepts.
//
// Note what this file does NOT decide. It never chooses a task root — the
// worker derives its own and reports it back — and it never sends a capability
// document. It sends the instant the control plane derived one at, plus the
// digest that derivation produced, and the worker refuses anything it cannot
// reproduce from the manifest it already holds.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createReadStream } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type { Writable } from "node:stream";

import { z } from "zod";

import type { ResolvedWorker, WorkerPlatform } from "./computer-workers.ts";
import {
  remoteWorkerSshBaseArgs,
  remoteWorkerSshEnvironment,
  type RemoteWorkerSshRunner,
} from "./remote-worker.ts";
import { type JsonValue, parseJson, schemaIssue } from "./schema.ts";
import { encodeFrameHeader, END_FRAME, FrameReader, type FrameHeader } from "./worker-task-frames.ts";
import {
  verifyWorkerTaskFiles,
  workerTaskManifestJson,
  WORKER_TASK_MAX_TOTAL_BYTES,
  type WorkerTaskManifest,
} from "./worker-task-manifest.ts";
import { workerCuaCapabilityDigest, workerCuaCapabilityManifest } from "./worker-cua-capability.ts";

const COMPANION = "openmausbot-worker-companion";
const OP_TIMEOUT_MS = 60_000;
const STAGE_TIMEOUT_MS = 10 * 60_000;
const FETCH_TIMEOUT_MS = 5 * 60_000;
/** Head-room over a command's own deadline, so a companion that is enforcing
 * the timeout properly always reports back before SSH gives up on it. */
const RUN_GRACE_MS = 30_000;
const SHA256 = /^[a-f0-9]{64}$/i;

// ── replies ──────────────────────────────────────────────────────────────────

const digest = z.string().regex(SHA256).transform((value) => value.toLowerCase());

/** Discriminated on `op`, not on `ok`: four of the arms share `ok: true`, and
 * a discriminator has to be unique per arm. */
const successSchema = z.discriminatedUnion("op", [
  z.object({
    ok: z.literal(true),
    version: z.number().int(),
    op: z.literal("stage"),
    files: z.number().int().min(0),
  }),
  z.object({
    ok: z.literal(true),
    version: z.number().int(),
    op: z.literal("validate"),
    taskRoot: z.string().min(1).max(512),
    files: z.number().int().min(0),
    commandIds: z.array(z.string().max(128)).max(128),
  }),
  z.object({
    ok: z.literal(true),
    version: z.number().int(),
    op: z.literal("activate"),
    capabilitySha256: digest,
  }),
  z.object({
    ok: z.literal(true),
    version: z.number().int(),
    op: z.literal("reset"),
    capabilitySha256: digest,
  }),
  z.object({
    ok: z.literal(true),
    version: z.number().int(),
    op: z.literal("run"),
    commandId: z.string().max(128),
    code: z.number().int().nullable(),
    stdout: z.string(),
    stderr: z.string(),
  }),
]);

const failureSchema = z.object({ ok: z.literal(false), error: z.string().max(4096) });

const replySchema = z.union([failureSchema, successSchema]);

/** What a caller sees: `parseReply` turns the failure arm into a thrown error,
 * so every call site works on a reply that succeeded. */
type CompanionSuccess = z.output<typeof successSchema>;

/** A companion reply is one JSON line. Anything else — a login banner, a shell
 * error, a truncated stream — is a transport failure, not a task failure. */
function parseReply(raw: string): CompanionSuccess {
  const line = raw.split("\n").map((entry) => entry.trim()).filter(Boolean).at(-1) ?? "";
  if (!line) throw new Error("the worker companion returned nothing");
  let document: JsonValue;
  try {
    document = parseJson(line);
  } catch {
    // A shell error or an unexpected login banner reaches here as a raw
    // SyntaxError, which reads to the model as if the task itself was
    // malformed. Name what actually went wrong instead.
    throw new Error("the worker companion returned an unreadable reply");
  }
  const parsed = replySchema.safeParse(document);
  if (!parsed.success) throw new Error(schemaIssue(parsed.error, "the worker companion returned an unreadable reply"));
  if (!parsed.data.ok) throw new Error(parsed.data.error);
  return parsed.data;
}

// ── streaming runner ─────────────────────────────────────────────────────────

export interface WorkerTaskStreamOptions {
  timeoutMs: number;
  /** Writes the request body to the child's stdin and resolves when done. */
  write?: (stdin: Writable) => Promise<void>;
}

export type WorkerTaskStreamRunner = (
  args: string[],
  options: WorkerTaskStreamOptions,
) => Promise<{ stdout: Buffer; stderr: string }>;

/** The binary sibling of `defaultRemoteWorkerRunner`. Staged files and result
 * artefacts are bytes, and a string round trip would corrupt them. */
export function defaultWorkerTaskStreamRunner(
  args: string[],
  options: WorkerTaskStreamOptions,
): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", args, {
      shell: false,
      env: remoteWorkerSshEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let stderr = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new Error("worker task transport timed out")));
    }, options.timeoutMs);
    timer.unref?.();

    child.stdin.on("error", () => {
      // A fast remote failure may close stdin mid-write; the close handler
      // below stays the authoritative result.
    });
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-64 * 1024); });
    child.on("error", (error) => finish(() => reject(new Error(`worker SSH could not start: ${error.message}`))));
    child.on("close", (code) => finish(() => {
      if (code === 0) resolve({ stdout: Buffer.concat(chunks), stderr });
      else reject(new Error(stderr.trim().slice(-500) || `worker SSH exited ${code ?? "without a status"}`));
    }));

    const body = options.write;
    if (!body) {
      child.stdin.end();
      return;
    }
    void body(child.stdin).then(
      () => child.stdin.end(),
      (error: Error) => finish(() => {
        child.kill("SIGKILL");
        reject(error);
      }),
    );
  });
}

function companionArgs(worker: ResolvedWorker, argv: string[]): string[] {
  return [...remoteWorkerSshBaseArgs(worker.sshAlias), COMPANION, ...argv];
}

/** Backpressure-aware write. A 200 MB stage would otherwise buffer the whole
 * transfer in this process's memory. */
async function write(stream: Writable, chunk: Buffer): Promise<void> {
  if (!stream.write(chunk)) await once(stream, "drain");
}

// ── stage ────────────────────────────────────────────────────────────────────

export interface StagedTask {
  files: number;
}

/** Send the approved manifest and the exact local files it names.
 *
 * The local stage is verified first: `verifyWorkerTaskFiles` re-hashes every
 * file without following symlinks, so a path swapped between approval and
 * transfer is caught here rather than becoming trusted bytes on the worker. */
export async function stageWorkerTask(
  worker: ResolvedWorker,
  localRoot: string,
  manifest: WorkerTaskManifest,
  runner: WorkerTaskStreamRunner = defaultWorkerTaskStreamRunner,
): Promise<StagedTask> {
  verifyWorkerTaskFiles(localRoot, manifest);
  const total = manifest.files.reduce((sum, file) => sum + file.size, 0);
  if (total > WORKER_TASK_MAX_TOTAL_BYTES) throw new Error("Worker task staged files exceed 200 MB");

  const document = Buffer.from(workerTaskManifestJson(manifest), "utf8");
  const result = await runner(companionArgs(worker, ["stage", manifest.taskId]), {
    timeoutMs: STAGE_TIMEOUT_MS,
    async write(stdin) {
      await write(stdin, encodeFrameHeader({ kind: "manifest", bytes: document.length }));
      await write(stdin, document);
      for (const file of manifest.files) {
        const header: FrameHeader = {
          kind: "file",
          bytes: file.size,
          path: file.path,
          sha256: file.sha256,
        };
        await write(stdin, encodeFrameHeader(header));
        const source = createReadStream(resolvePath(localRoot, ...file.path.split("/")));
        for await (const chunk of source) {
          await write(stdin, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
      }
      await write(stdin, END_FRAME);
    },
  });

  const reply = parseReply(result.stdout.toString("utf8"));
  if (reply.op !== "stage") throw new Error("the worker companion did not confirm staging");
  if (reply.files !== manifest.files.length) throw new Error("the worker staged a different number of files");
  return { files: reply.files };
}

// ── the three JSON operations ────────────────────────────────────────────────

async function companionOp(
  worker: ResolvedWorker,
  request: Record<string, string | number>,
  runner: RemoteWorkerSshRunner,
  timeoutMs: number,
): Promise<CompanionSuccess> {
  const result = await runner(companionArgs(worker, ["stdio"]), timeoutMs, `${JSON.stringify(request)}\n`);
  return parseReply(result.stdout);
}

export interface ValidatedWorkerTask {
  taskRoot: string;
  files: number;
  commandIds: string[];
}

/** A worker-derived task root is only a hint, but it becomes part of the
 * capability document, so refuse any shape that is not the one this platform's
 * companion can produce before building a capability around it. */
export function isPlausibleTaskRoot(platform: WorkerPlatform, taskId: string, value: string): boolean {
  if (/[ \r\n]/.test(value) || value.includes("..")) return false;
  return platform === "windows"
    ? /^[A-Za-z]:\\/.test(value) && value.endsWith(`\\tasks\\${taskId}`)
    : value.startsWith("/") && value.endsWith(`/tasks/${taskId}`);
}

export async function validateWorkerTask(
  worker: ResolvedWorker,
  manifest: WorkerTaskManifest,
  manifestSha256: string,
  runner: RemoteWorkerSshRunner,
): Promise<ValidatedWorkerTask> {
  const reply = await companionOp(
    worker,
    { op: "validate", taskId: manifest.taskId, manifestSha256 },
    runner,
    OP_TIMEOUT_MS,
  );
  if (reply.op !== "validate") throw new Error("the worker companion did not validate the task");
  if (!isPlausibleTaskRoot(manifest.platform, manifest.taskId, reply.taskRoot)) {
    throw new Error("the worker reported an implausible task root");
  }
  if (reply.files !== manifest.files.length) throw new Error("the worker holds a different set of task files");
  return { taskRoot: reply.taskRoot, files: reply.files, commandIds: [...reply.commandIds] };
}

export interface ActivatedWorkerTask {
  capabilitySha256: string;
  issuedAt: number;
}

/** Derive the capability here, then require the worker to reproduce it.
 * Neither end can widen the boundary alone: the control plane cannot send a
 * document, and the worker cannot activate one whose digest the control plane
 * did not name. */
export async function activateWorkerTask(
  worker: ResolvedWorker,
  manifest: WorkerTaskManifest,
  manifestSha256: string,
  taskRoot: string,
  runner: RemoteWorkerSshRunner,
  issuedAt = Date.now(),
): Promise<ActivatedWorkerTask> {
  if (!isPlausibleTaskRoot(manifest.platform, manifest.taskId, taskRoot)) {
    throw new Error("refusing to derive a capability for an implausible task root");
  }
  const expected = workerCuaCapabilityDigest(workerCuaCapabilityManifest(manifest, taskRoot, issuedAt));
  const reply = await companionOp(
    worker,
    {
      op: "activate",
      taskId: manifest.taskId,
      manifestSha256,
      issuedAt,
      expectedCapabilitySha256: expected,
    },
    runner,
    OP_TIMEOUT_MS,
  );
  if (reply.op !== "activate") throw new Error("the worker companion did not activate the task");
  if (reply.capabilitySha256 !== expected) throw new Error("the worker activated a different capability");
  return { capabilitySha256: expected, issuedAt };
}

export interface WorkerCommandResult {
  commandId: string;
  code: number | null;
  stdout: string;
  stderr: string;
}

export async function runWorkerCommand(
  worker: ResolvedWorker,
  manifest: WorkerTaskManifest,
  manifestSha256: string,
  commandId: string,
  runner: RemoteWorkerSshRunner,
): Promise<WorkerCommandResult> {
  const command = manifest.commands.find((entry) => entry.id === commandId);
  if (!command) throw new Error("the approved task has no command with that id");
  const reply = await companionOp(
    worker,
    { op: "run", taskId: manifest.taskId, manifestSha256, commandId },
    runner,
    command.timeoutMs + RUN_GRACE_MS,
  );
  if (reply.op !== "run") throw new Error("the worker companion did not run the command");
  if (reply.commandId !== commandId) throw new Error("the worker ran a different command");
  return { commandId, code: reply.code, stdout: reply.stdout, stderr: reply.stderr };
}

/** Drop the task's files and put the worker back on its deny-all capability.
 * The one operation that must still work when everything else has failed. */
export async function resetWorkerTask(
  worker: ResolvedWorker,
  taskId: string,
  runner: RemoteWorkerSshRunner,
): Promise<string> {
  if (!worker.expectedBasePolicySha256) throw new Error("worker has no pinned base policy");
  const reply = await companionOp(
    worker,
    { op: "reset", taskId, expectedBasePolicySha256: worker.expectedBasePolicySha256 },
    runner,
    OP_TIMEOUT_MS,
  );
  if (reply.op !== "reset") throw new Error("the worker companion did not reset the task");
  return reply.capabilitySha256;
}

// ── fetch ────────────────────────────────────────────────────────────────────

export interface WorkerResultArtefact {
  path: string;
  sha256: string;
  content: Buffer;
}

/** Read back only the artefacts the approved manifest declares. A worker that
 * offers anything else — a path not in `resultPaths`, a digest that does not
 * match its own bytes — is refused whole rather than partially trusted. */
export async function fetchWorkerResults(
  worker: ResolvedWorker,
  manifest: WorkerTaskManifest,
  manifestSha256: string,
  runner: WorkerTaskStreamRunner = defaultWorkerTaskStreamRunner,
): Promise<WorkerResultArtefact[]> {
  const result = await runner(companionArgs(worker, ["fetch", manifest.taskId, manifestSha256]), {
    timeoutMs: FETCH_TIMEOUT_MS,
  });

  const declared = new Set(manifest.resultPaths);
  const artefacts: WorkerResultArtefact[] = [];
  let parts: Buffer[] = [];

  const reader = new FrameReader({
    onHeader(header: FrameHeader) {
      if (header.kind === "manifest") throw new Error("a result stream cannot carry a manifest");
      parts = [];
    },
    onPayload(chunk: Buffer) {
      parts.push(chunk);
    },
    onFrameEnd(header: FrameHeader) {
      if (header.kind !== "file") return;
      const path = header.path ?? "";
      if (!declared.has(path)) throw new Error(`the worker returned an artefact the task never declared: ${path}`);
      if (artefacts.some((artefact) => artefact.path === path)) {
        throw new Error(`the worker returned ${path} twice`);
      }
      artefacts.push({ path, sha256: (header.sha256 ?? "").toLowerCase(), content: Buffer.concat(parts) });
      parts = [];
    },
  });
  reader.push(result.stdout);
  reader.end();

  for (const artefact of artefacts) {
    const actual = createHash("sha256").update(artefact.content).digest("hex");
    if (actual !== artefact.sha256) throw new Error(`result artefact hash does not match: ${artefact.path}`);
  }
  return artefacts;
}
