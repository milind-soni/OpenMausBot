// The SSH half of the task layer: how an approved manifest reaches a worker
// and what comes back.
//
// Every remote invocation is fixed argv through the same base args and
// allow-listed environment the health probe uses (server/remote-worker.ts), so
// nothing here can widen the connection's boundary. Stage and result fetch
// carry raw bytes through a streaming runner; the remaining companion calls
// are one JSON line in and one JSON line out.
//
// Note what this file does NOT decide. It never chooses a task root — the
// worker derives its own and reports it back — and it never sends a capability
// document. It sends the instant the control plane derived one at, plus the
// digest that derivation produced, and the worker refuses anything it cannot
// reproduce from the manifest it already holds.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import type { Writable } from "node:stream";

import { z } from "zod";

import type { ResolvedWorker, WorkerPlatform } from "./computer-workers.ts";
import {
  defaultRemoteWorkerRunner,
  isExpectedWorkerChannelPath,
  remoteWorkerSshBaseArgs,
  remoteWorkerSshEnvironment,
  WORKER_COMPANION_PROTOCOL_VERSION,
  type RemoteWorkerSshRunner,
} from "./remote-worker.ts";
import { type JsonObject, type JsonValue, parseJson } from "./schema.ts";
import {
  encodeFrameHeader,
  END_FRAME,
  FRAME_HEADER_PREFIX_BYTES,
  FrameReader,
  MAX_FRAME_HEADER_BYTES,
  type FrameHeader,
} from "./worker-task-frames.ts";
import {
  readVerifiedWorkerTaskFile,
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
/** A worker's stdout is untrusted. The largest valid result stream is the
 * 200 MB artefact ceiling plus bounded framing overhead. */
export const MAX_STREAM_STDOUT_BYTES = 220 * 1024 * 1024;
/** Computer state may include a screenshot, but never a task-sized artefact. */
export const MAX_COMPUTER_STDOUT_BYTES = 24 * 1024 * 1024;
const CUA_TOOL = /^[a-z][a-z0-9_]{0,127}$/;

// ── replies ──────────────────────────────────────────────────────────────────

const digest = z.string().regex(SHA256).transform((value) => value.toLowerCase());
const protocolVersion = z.literal(WORKER_COMPANION_PROTOCOL_VERSION);

/** Discriminated on `op`, not on `ok`: every success arm shares `ok: true`, and
 * a discriminator has to be unique per arm. */
const successSchema = z.discriminatedUnion("op", [
  z.object({
    ok: z.literal(true),
    version: protocolVersion,
    op: z.literal("pause"),
    paused: z.literal(true),
  }),
  z.object({
    ok: z.literal(true),
    version: protocolVersion,
    op: z.literal("resume"),
    paused: z.literal(false),
    capabilitySha256: digest,
  }),
  z.object({
    ok: z.literal(true),
    version: protocolVersion,
    op: z.literal("stage"),
    files: z.number().int().min(0),
  }),
  z.object({
    ok: z.literal(true),
    version: protocolVersion,
    op: z.literal("validate"),
    taskRoot: z.string().min(1).max(512),
    files: z.number().int().min(0),
    commandIds: z.array(z.string().max(128)).max(128),
  }),
  z.object({
    ok: z.literal(true),
    version: protocolVersion,
    op: z.literal("activate"),
    capabilitySha256: digest,
  }),
  z.object({
    ok: z.literal(true),
    version: protocolVersion,
    op: z.literal("reset"),
    capabilitySha256: digest,
  }),
  z.object({
    ok: z.literal(true),
    version: protocolVersion,
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
  if (!parsed.success) throw new Error("the worker companion returned an unreadable reply");
  if (!parsed.data.ok) throw new Error(parsed.data.error);
  return parsed.data;
}

// ── streaming runner ─────────────────────────────────────────────────────────

export interface WorkerTaskStreamOptions {
  timeoutMs: number;
  /** A smaller operation-specific bound may narrow the general artefact cap. */
  maxStdoutBytes?: number;
  /** Consume stdout as it arrives. When captureStdout is false, this is the
   * only retained view of the stream and may throw to abort the child. */
  onStdoutChunk?: (chunk: Buffer) => void;
  /** Defaults to true for one-line replies and CUA calls. Result fetches turn
   * it off so the framed stream is never retained a second time. */
  captureStdout?: boolean;
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
    let received = 0;
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
    child.stdout.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > (options.maxStdoutBytes ?? MAX_STREAM_STDOUT_BYTES)) {
        child.kill("SIGKILL");
        finish(() => reject(new Error("the worker sent more bytes than a task stream may carry")));
        return;
      }
      try {
        options.onStdoutChunk?.(chunk);
      } catch (error) {
        child.kill("SIGKILL");
        finish(() => reject(error instanceof Error ? error : new Error(String(error))));
        return;
      }
      if (options.captureStdout !== false) chunks.push(chunk);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-64 * 1024); });
    child.on("error", () => finish(() => reject(new Error("worker SSH could not start"))));
    child.on("close", (code) => finish(() => {
      if (code === 0) resolve({
        stdout: options.captureStdout === false ? Buffer.alloc(0) : Buffer.concat(chunks),
        stderr,
      });
      else reject(new Error("worker SSH stream failed"));
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
        // Re-open under O_NOFOLLOW and copy/hash before writing any of this
        // file. A local path swap after the preflight therefore cannot turn
        // into different bytes on the worker.
        const content = readVerifiedWorkerTaskFile(localRoot, file);
        const header: FrameHeader = {
          kind: "file",
          bytes: content.length,
          path: file.path,
          sha256: file.sha256,
        };
        await write(stdin, encodeFrameHeader(header));
        await write(stdin, content);
      }
      await write(stdin, END_FRAME);
    },
  });

  const reply = parseReply(result.stdout.toString("utf8"));
  if (reply.op !== "stage") throw new Error("the worker companion did not confirm staging");
  if (reply.files !== manifest.files.length) throw new Error("the worker staged a different number of files");
  return { files: reply.files };
}

// ── fixed JSON operations ───────────────────────────────────────────────────

async function companionOp(
  worker: ResolvedWorker,
  request: Record<string, string | number>,
  runner: RemoteWorkerSshRunner,
  timeoutMs: number,
): Promise<CompanionSuccess> {
  const result = await runner(companionArgs(worker, ["stdio"]), timeoutMs, `${JSON.stringify(request)}\n`);
  return parseReply(result.stdout);
}

/** Restart an expired parked daemon through the companion's fixed launch
 * identity. The control plane supplies only its pinned policy digest and
 * requires the exact configured parked capability back. */
export async function refreshParkedWorker(
  worker: ResolvedWorker,
  runner: RemoteWorkerSshRunner = defaultRemoteWorkerRunner,
): Promise<string> {
  if (!worker.expectedBasePolicySha256 || !worker.expectedParkedCapabilitySha256) {
    throw new Error("worker has no pinned parked policy configuration");
  }
  const reply = await companionOp(
    worker,
    { op: "resume", expectedBasePolicySha256: worker.expectedBasePolicySha256 },
    runner,
    OP_TIMEOUT_MS,
  );
  if (reply.op !== "resume") throw new Error("the worker companion did not refresh the parked capability");
  if (reply.capabilitySha256 !== worker.expectedParkedCapabilitySha256) {
    throw new Error("the worker refreshed a different parked capability");
  }
  return reply.capabilitySha256;
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
  if (/[\u0000\r\n]/.test(value) || value.includes("..")) return false;
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
  const expectedCommandIds = manifest.commands.map((command) => command.id);
  if (
    reply.commandIds.length !== expectedCommandIds.length ||
    reply.commandIds.some((commandId, index) => commandId !== expectedCommandIds[index])
  ) {
    throw new Error("the worker holds a different set of task commands");
  }
  return { taskRoot: reply.taskRoot, files: reply.files, commandIds: expectedCommandIds };
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

// ── approved CUA calls ─────────────────────────────────────────────────────

/** Describe one driver tool without starting the long-lived MCP proxy. Tool
 * names are selected from the approved surface by WorkerTaskService; this
 * second grammar check keeps the SSH command fixed even if a caller regresses. */
export async function describeWorkerComputerTool(
  worker: ResolvedWorker,
  tool: string,
  runner: RemoteWorkerSshRunner = defaultRemoteWorkerRunner,
): Promise<string> {
  if (!CUA_TOOL.test(tool)) throw new Error("invalid worker computer tool name");
  const result = await runner(
    [...remoteWorkerSshBaseArgs(worker.sshAlias), "cua-driver", "describe", tool],
    OP_TIMEOUT_MS,
  );
  const description = result.stdout.trim();
  if (!description) throw new Error("CUA Driver returned no tool description");
  return description;
}

export interface WorkerComputerCallResult {
  stdout: Buffer;
  stderr: string;
}

/** Invoke one approved CUA tool through the worker's fixed daemon channel.
 * Arguments travel on stdin, never in ssh argv, so model text cannot become a
 * remote shell fragment. The daemon's active native capability is still the
 * final tool/application/origin authority. */
export async function callWorkerComputerTool(
  worker: ResolvedWorker,
  channelPath: string,
  tool: string,
  args: JsonObject,
  runner: WorkerTaskStreamRunner = defaultWorkerTaskStreamRunner,
): Promise<WorkerComputerCallResult> {
  if (!CUA_TOOL.test(tool)) throw new Error("invalid worker computer tool name");
  if (!isExpectedWorkerChannelPath(worker.platform, channelPath)) {
    throw new Error("invalid worker CUA control channel path");
  }
  const result = await runner(
    [
      ...remoteWorkerSshBaseArgs(worker.sshAlias),
      "cua-driver",
      "call",
      tool,
      "--socket",
      channelPath,
    ],
    {
      timeoutMs: FETCH_TIMEOUT_MS,
      maxStdoutBytes: MAX_COMPUTER_STDOUT_BYTES,
      async write(stdin) {
        await write(stdin, Buffer.from(`${JSON.stringify(args)}\n`, "utf8"));
      },
    },
  );
  return { stdout: result.stdout, stderr: result.stderr };
}

/** Drop the task's files and put the worker back on its non-action capability.
 * The one operation that must still work when everything else has failed. */
export async function resetWorkerTask(
  worker: ResolvedWorker,
  taskId: string,
  runner: RemoteWorkerSshRunner,
): Promise<string> {
  if (!worker.expectedBasePolicySha256) throw new Error("worker has no pinned base policy");
  if (!worker.expectedParkedCapabilitySha256) throw new Error("worker has no pinned parked capability");
  const reply = await companionOp(
    worker,
    { op: "reset", taskId, expectedBasePolicySha256: worker.expectedBasePolicySha256 },
    runner,
    OP_TIMEOUT_MS,
  );
  if (reply.op !== "reset") throw new Error("the worker companion did not reset the task");
  if (reply.capabilitySha256 !== worker.expectedParkedCapabilitySha256) {
    throw new Error("the worker reset to a different parked capability");
  }
  return reply.capabilitySha256;
}

// ── fetch ────────────────────────────────────────────────────────────────────

export interface WorkerResultArtefact {
  path: string;
  sha256: string;
  /** Exact remote size, even when content is only a bounded preview. */
  bytes: number;
  content: Buffer;
  truncated: boolean;
}

/** The model-facing service shows at most this much of any one result. Keep
 * only that prefix while hashing the complete stream. */
export const MAX_RESULT_PREVIEW_BYTES = 64 * 1024;

/** Read back only the artefacts the approved manifest declares. A worker that
 * offers anything else — a path not in `resultPaths`, a digest that does not
 * match its own bytes — is refused whole rather than partially trusted. */
export async function fetchWorkerResults(
  worker: ResolvedWorker,
  manifest: WorkerTaskManifest,
  manifestSha256: string,
  runner: WorkerTaskStreamRunner = defaultWorkerTaskStreamRunner,
): Promise<WorkerResultArtefact[]> {
  const declared = new Set(manifest.resultPaths);
  const seen = new Set<string>();
  const artefacts: WorkerResultArtefact[] = [];
  let parts: Buffer[] = [];
  let retained = 0;
  let received = 0;
  let frameHash = createHash("sha256");
  let streamed = false;

  const reader = new FrameReader({
    onHeader(header: FrameHeader) {
      if (header.kind === "manifest") throw new Error("a result stream cannot carry a manifest");
      if (header.kind === "file") {
        const path = header.path ?? "";
        if (!declared.has(path)) throw new Error(`the worker returned an artefact the task never declared: ${path}`);
        if (seen.has(path)) throw new Error(`the worker returned ${path} twice`);
        seen.add(path);
      }
      parts = [];
      retained = 0;
      received = 0;
      frameHash = createHash("sha256");
    },
    onPayload(chunk: Buffer) {
      received += chunk.length;
      frameHash.update(chunk);
      if (retained < MAX_RESULT_PREVIEW_BYTES) {
        const take = Math.min(chunk.length, MAX_RESULT_PREVIEW_BYTES - retained);
        parts.push(Buffer.from(chunk.subarray(0, take)));
        retained += take;
      }
    },
    onFrameEnd(header: FrameHeader) {
      if (header.kind !== "file") return;
      const path = header.path ?? "";
      const sha256 = (header.sha256 ?? "").toLowerCase();
      const actual = frameHash.digest("hex");
      if (actual !== sha256) throw new Error(`result artefact hash does not match: ${path}`);
      artefacts.push({
        path,
        sha256,
        bytes: received,
        content: Buffer.concat(parts),
        truncated: received > retained,
      });
      parts = [];
    },
  });
  const maxStdoutBytes = WORKER_TASK_MAX_TOTAL_BYTES
    + (manifest.resultPaths.length + 1) * (FRAME_HEADER_PREFIX_BYTES + MAX_FRAME_HEADER_BYTES);
  const result = await runner(companionArgs(worker, ["fetch", manifest.taskId, manifestSha256]), {
    timeoutMs: FETCH_TIMEOUT_MS,
    maxStdoutBytes,
    captureStdout: false,
    onStdoutChunk(chunk) {
      streamed = true;
      reader.push(chunk);
    },
  });
  // Injectable runners predating the incremental callback may still return a
  // bounded buffer. Accept that test/adapter contract without double-reading
  // production runners that invoked onStdoutChunk.
  if (!streamed && result.stdout.length > 0) reader.push(result.stdout);
  reader.end();
  return artefacts;
}
