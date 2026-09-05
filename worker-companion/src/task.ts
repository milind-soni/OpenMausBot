// The task operations and the two streaming subcommands that feed them.
//
// The division of labour with the control plane is deliberate. The control
// plane decides *whether* a task may run — it parses the manifest, binds it to
// a configured worker, and puts a digest in front of a person. This file
// decides *what actually happens on this machine*, and it re-derives every one
// of those facts from the staged document rather than trusting the wire:
//
//   stage     bytes in, path rules applied per frame, digest checked per file
//   validate  the staged manifest must hash to the approved digest, the
//             immutable baseline must still be exact, and the editable task
//             root must remain a bounded regular-file tree
//   activate  the capability is rebuilt here and must match the digest the
//             control plane says it derived — neither end can widen it alone
//   run       a command id, never a program: the argv comes from the manifest
//
// The wire (wire.ts) can therefore name only a task id, a digest, an instant
// and a command id. It still cannot name an executable, argv, path, policy or
// capability document, which is the property the companion exists to hold.
import { createHash } from "node:crypto";
import { expectedDriverDigests, matchesDriverDigests } from "./driver-digests.ts";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Buffer } from "node:buffer";

import { capabilityDigest, parkedCapability, writeActiveCapability } from "./capability.ts";
import { assertDriverVersion, restartWorkerDaemon, runFixed } from "./driver.ts";
import {
  encodeFrameHeader,
  END_FRAME,
  FrameReader,
  MAX_FRAME_PAYLOAD_BYTES,
  type FrameHeader,
} from "./frames.ts";
import {
  parseStagedManifest,
  TASK_MAX_TOTAL_BYTES,
  taskCapabilityManifest,
  type TaskManifest,
} from "./manifest.ts";
import {
  cuaSocket,
  taskBaselineRoot,
  taskRoot,
  type WorkerPlatform,
  workerPlatform,
} from "./platform.ts";
import { asDigest, type JsonValue, type Sha256Digest } from "./wire.ts";

export const MANIFEST_FILE = "manifest.json";
const READY_TIMEOUT_MS = 15_000;
const MAX_CAPTURED_OUTPUT = 64 * 1024;
/** How far the control plane's issuing clock may sit from this worker's own.
 * A capability's lifetime is relative, so a wildly skewed instant would mint a
 * longer-lived boundary than anyone approved. */
export const MAX_ISSUE_SKEW_MS = 5 * 60_000;

const SAFE_RELATIVE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$/;
const BLOCKED_FILE =
  /(^|\/)(?:\.git(?:\/|$)|\.env(?:\.[^/]*)?$|credentials?(?:\.[^/]*)?$|secrets?(?:\.[^/]*)?$|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.[^/]*)?$|[^/]+\.(?:key|pem|p12|pfx|keystore)$)/i;

/** The staging path rules, applied to a frame before the manifest that will
 * later confirm it has even been read. Staging cannot depend on the manifest:
 * the manifest arrives in the same stream. */
export function isSafeStagedPath(value: string): boolean {
  if (!SAFE_RELATIVE.test(value) || value.includes("//") || value.endsWith("/")) return false;
  const parts = value.split("/");
  if (parts.some((part) => part === "." || part === "..")) return false;
  return !BLOCKED_FILE.test(value);
}

/** Resolve a manifest-relative path under the task root, refusing anything that
 * leaves it. Checked against the real root so a symlinked ancestor cannot move
 * the destination. */
export function resolveInRoot(root: string, relativePath: string): string {
  if (!isAbsolute(root)) throw new Error("task root must be absolute");
  const candidate = resolve(root, ...relativePath.split("/"));
  const within = relative(root, candidate);
  if (!within || within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) {
    throw new Error(`task path escapes the task root: ${relativePath}`);
  }
  return candidate;
}

// ── stage ────────────────────────────────────────────────────────────────────

export interface StageResult {
  manifestBytes: number;
  files: number;
}

/** Consume a staging stream into a fresh task root.
 *
 * Like every other operation here it takes an id and derives its own root; the
 * optional platform exists so a test can drive both platforms' layouts on one
 * machine, exactly as `parkedCapability` and `activeCapabilityPath` do.
 *
 * The root is removed first: a task id is reusable, and merging new files into
 * an older stage would let a previous task's leftovers satisfy this one's
 * validation. */
export function stageTask(
  taskId: string,
  input: NodeJS.ReadableStream,
  platform: WorkerPlatform = workerPlatform(),
): Promise<StageResult> {
  const root = taskRoot(taskId, platform);
  const baseline = taskBaselineRoot(taskId, platform);
  return new Promise((resolveResult, reject) => {
    rmSync(root, { recursive: true, force: true });
    rmSync(baseline, { recursive: true, force: true });
    mkdirSync(root, { recursive: true, mode: 0o700 });
    mkdirSync(baseline, { recursive: true, mode: 0o700 });

    let manifestBytes = -1;
    let files = 0;
    let total = 0;
    let fd: number | null = null;
    let baselineFd: number | null = null;
    let hash = createHash("sha256");
    let written = 0;
    let settled = false;

    const closeFds = () => {
      if (fd !== null) {
        closeSync(fd);
        fd = null;
      }
      if (baselineFd !== null) {
        closeSync(baselineFd);
        baselineFd = null;
      }
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      closeFds();
      rmSync(root, { recursive: true, force: true });
      rmSync(baseline, { recursive: true, force: true });
      reject(error);
    };

    const reader = new FrameReader({
      onHeader(header: FrameHeader) {
        if (header.kind === "end") return;
        const path = header.kind === "manifest" ? MANIFEST_FILE : (header.path ?? "");
        if (header.kind === "manifest" && manifestBytes >= 0) throw new Error("duplicate manifest frame");
        if (header.kind === "file") {
          if (!isSafeStagedPath(path)) throw new Error(`unsafe staged path: ${path}`);
          if (path === MANIFEST_FILE) throw new Error("a staged file cannot shadow the manifest");
        }
        total += header.bytes;
        if (total > TASK_MAX_TOTAL_BYTES) throw new Error("staged task files exceed 200 MB");
        const target = resolveInRoot(root, path);
        const baselineTarget = resolveInRoot(baseline, path);
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
        mkdirSync(dirname(baselineTarget), { recursive: true, mode: 0o700 });
        if (existsSync(target) || existsSync(baselineTarget)) throw new Error(`duplicate staged path: ${path}`);
        // wx: never follow an existing entry, so a symlink planted between the
        // check above and this open cannot redirect the write.
        fd = openSync(target, "wx", 0o600);
        baselineFd = openSync(baselineTarget, "wx", 0o600);
        hash = createHash("sha256");
        written = 0;
      },
      onPayload(chunk: Buffer) {
        if (fd === null || baselineFd === null) throw new Error("payload arrived outside a frame");
        writeSync(fd, chunk);
        writeSync(baselineFd, chunk);
        hash.update(chunk);
        written += chunk.length;
      },
      onFrameEnd(header: FrameHeader) {
        if (header.kind === "end") return;
        closeFds();
        if (written !== header.bytes) throw new Error("staged file is shorter than its frame declared");
        if (header.kind === "manifest") {
          manifestBytes = written;
          return;
        }
        const digest = hash.digest("hex");
        if (digest !== (header.sha256 ?? "").toLowerCase()) {
          throw new Error(`staged file hash does not match: ${header.path ?? "?"}`);
        }
        files += 1;
      },
    });

    input.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      try {
        reader.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    input.on("error", (error: Error) => fail(error));
    input.on("end", () => {
      if (settled) return;
      try {
        reader.end();
        if (manifestBytes < 0) throw new Error("staging stream carried no manifest");
        settled = true;
        resolveResult({ manifestBytes, files });
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

// ── validate ─────────────────────────────────────────────────────────────────

function readStagedDocument(root: string): JsonValue {
  const path = join(root, MANIFEST_FILE);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("staged manifest is not a regular file");
  const raw = readFileSync(path, "utf8");
  // SAFETY: JSON.parse without a reviver can only produce JSON-compatible
  // values, which is exactly what JsonValue describes.
  return JSON.parse(raw) as JsonValue;
}

/** Inspect the whole tree without following links. A task command is not an OS
 * sandbox, but it must not inherit a path planted outside the task root or an
 * unbounded working set that CUA created after approval. */
function inspectTaskTree(root: string, label: "baseline" | "working tree"): Set<string> {
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`task ${label} is not a regular directory`);
  }

  const present = new Set<string>();
  let total = 0;
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const path = relative(root, absolute).split(sep).join("/");
      if (path !== MANIFEST_FILE && !isSafeStagedPath(path)) {
        throw new Error(`task ${label} contains an unsafe path: ${path}`);
      }
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error(`task ${label} contains a symbolic link: ${path}`);
      if (stat.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (!stat.isFile()) throw new Error(`task ${label} contains a special file: ${path}`);
      if (stat.size > MAX_FRAME_PAYLOAD_BYTES) throw new Error(`task ${label} file is too large: ${path}`);
      total += stat.size;
      if (total > TASK_MAX_TOTAL_BYTES) throw new Error(`task ${label} exceeds 200 MB`);
      present.add(path);
    }
  };
  visit(root);
  return present;
}

export interface ValidatedTask {
  manifest: TaskManifest;
  root: string;
}

/** Re-establish, from disk alone, that this worker holds exactly the task the
 * operator approved. Called before every activate and every run: an approval is
 * not a fact about the past, it is a claim about what is on this machine now. */
export function validateTask(
  taskId: string,
  manifestSha256: string,
  platform: WorkerPlatform = workerPlatform(),
): ValidatedTask {
  const root = taskRoot(taskId, platform);
  const baseline = taskBaselineRoot(taskId, platform);
  if (!existsSync(join(root, MANIFEST_FILE)) || !existsSync(join(baseline, MANIFEST_FILE))) {
    throw new Error("no task is staged under that id");
  }
  // The editable copy of the manifest remains exact, while the baseline copy
  // is the authority for inputs after VS Code edits the working copies.
  parseStagedManifest(readStagedDocument(root), manifestSha256);
  const manifest = parseStagedManifest(readStagedDocument(baseline), manifestSha256);
  if (manifest.taskId !== taskId) throw new Error("staged manifest names a different task");
  const expectedPlatform = platform === "darwin" ? "macos" : "windows";
  if (manifest.platform !== expectedPlatform) throw new Error("staged manifest targets a different platform");
  const now = Date.now();
  if (manifest.createdAt > now + MAX_ISSUE_SKEW_MS || manifest.expiresAt <= now) {
    throw new Error("staged task manifest is not currently valid");
  }

  const baselineFiles = inspectTaskTree(baseline, "baseline");
  const expectedBaseline = new Set([MANIFEST_FILE, ...manifest.files.map((file) => file.path)]);
  if (baselineFiles.size !== expectedBaseline.size) throw new Error("task baseline contains undeclared files");
  for (const path of expectedBaseline) {
    if (!baselineFiles.has(path)) throw new Error(`task baseline is missing an approved file: ${path}`);
  }

  // The baseline, not the CUA-editable copy, must remain exactly what the
  // person approved. The working source may be edited or deleted.
  for (const file of manifest.files) {
    const target = resolveInRoot(baseline, file.path);
    const stat = lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`baseline file is not regular: ${file.path}`);
    if (stat.size !== file.size) throw new Error(`baseline file size changed: ${file.path}`);
    const digest = createHash("sha256").update(readFileSync(target)).digest("hex");
    if (digest !== file.sha256.toLowerCase()) throw new Error(`baseline file hash changed: ${file.path}`);
  }
  inspectTaskTree(root, "working tree");
  return { manifest, root };
}

// ── activate ─────────────────────────────────────────────────────────────────

/** Poll the daemon until it reports the exact boundary it was asked to hold.
 * A driver that quietly loaded some other capability never satisfies this. */
async function awaitActiveCapability(
  capability: Sha256Digest,
  basePolicy: string,
  platform: WorkerPlatform,
): Promise<void> {
  const socket = cuaSocket(platform);
  const expected = expectedDriverDigests(capability, basePolicy, platform);
  await restartWorkerDaemon(platform);
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let diagnostic = "";
  for (;;) {
    const status = await runFixed("cua-driver", ["status", "--socket", socket], 5_000, true, { platform });
    diagnostic = `${status.stdout}\n${status.stderr}`.toLowerCase();
    if (
      status.code === 0 &&
      matchesDriverDigests(diagnostic, expected)
    ) return;
    if (Date.now() >= deadline) break;
    await new Promise((wait) => setTimeout(wait, 250));
  }
  throw new Error(`approved CUA capability did not become active: ${diagnostic.trim().slice(-300) || "no status"}`);
}

export async function activateTask(
  taskId: string,
  manifestSha256: string,
  issuedAt: number,
  expectedCapabilitySha256: Sha256Digest,
  now = Date.now(),
  platform: WorkerPlatform = workerPlatform(),
): Promise<Sha256Digest> {
  const { manifest, root } = validateTask(taskId, manifestSha256, platform);
  // Also enforce the Windows desktop hold on the worker, so an older control
  // plane cannot activate the driver that failed live application denial.
  if (manifest.platform === "windows" && manifest.surface === "desktop") {
    throw new Error("Windows desktop tasks are unavailable: CUA 0.20.0 failed application-boundary acceptance");
  }
  if (Math.abs(now - issuedAt) > MAX_ISSUE_SKEW_MS) {
    throw new Error("task capability was issued too far from this worker's clock");
  }
  // Every deterministic check runs before the daemon is touched: a request
  // that cannot succeed should not disturb a running driver, and it makes the
  // refusals testable without one.
  const content = taskCapabilityManifest(manifest, root, issuedAt);
  const digest = asDigest(capabilityDigest(content));
  if (digest !== expectedCapabilitySha256.toLowerCase()) {
    throw new Error("derived CUA capability does not match the approved digest");
  }
  await assertDriverVersion(platform);
  writeActiveCapability(content, platform);
  await awaitActiveCapability(digest, manifest.target.basePolicySha256, platform);
  return digest;
}

// ── run ──────────────────────────────────────────────────────────────────────

export interface CommandResult {
  commandId: string;
  code: number | null;
  stdout: string;
  stderr: string;
}

export async function runTaskCommand(
  taskId: string,
  manifestSha256: string,
  commandId: string,
  platform: WorkerPlatform = workerPlatform(),
): Promise<CommandResult> {
  const { manifest, root } = validateTask(taskId, manifestSha256, platform);
  const command = manifest.commands.find((entry) => entry.id === commandId);
  if (!command) throw new Error("the approved manifest has no command with that id");

  const cwd = resolveInRoot(root, command.cwd);
  if (!statSync(cwd).isDirectory()) throw new Error(`command working directory is not a directory: ${command.cwd}`);

  const result = await runFixed(command.executable, command.argv, command.timeoutMs, true, { cwd, platform });
  return {
    commandId,
    code: result.code,
    stdout: result.stdout.slice(-MAX_CAPTURED_OUTPUT),
    stderr: result.stderr.slice(-MAX_CAPTURED_OUTPUT),
  };
}

// ── reset ────────────────────────────────────────────────────────────────────

/** Drop the task's files and put the worker back on the non-action capability.
 * Reset is the operation that must work even when everything else has failed,
 * so it removes the root before it touches the daemon. */
export async function resetTask(
  taskId: string,
  expectedBasePolicySha256: Sha256Digest,
  platform: WorkerPlatform = workerPlatform(),
): Promise<Sha256Digest> {
  rmSync(taskRoot(taskId, platform), { recursive: true, force: true });
  rmSync(taskBaselineRoot(taskId, platform), { recursive: true, force: true });
  await assertDriverVersion(platform);
  const content = parkedCapability(platform);
  writeActiveCapability(content, platform);
  const digest = asDigest(capabilityDigest(content));
  await awaitActiveCapability(digest, expectedBasePolicySha256, platform);
  return digest;
}

// ── fetch ────────────────────────────────────────────────────────────────────

/** Stream the task's declared result artefacts back as frames. Only paths the
 * approved manifest names are readable, and a result the task never produced is
 * simply absent rather than an error. */
export function fetchResults(
  taskId: string,
  manifestSha256: string,
  output: NodeJS.WritableStream,
  platform: WorkerPlatform = workerPlatform(),
): void {
  const { manifest, root } = validateTask(taskId, manifestSha256, platform);
  const rootReal = realpathSync(root);
  const escapes = (within: string) =>
    !within || within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within);
  for (const path of manifest.resultPaths) {
    const target = resolveInRoot(root, path);
    if (!existsSync(target)) continue;
    let descriptor: number;
    try {
      const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
      descriptor = openSync(target, constants.O_RDONLY | noFollow);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (code === "ENOENT" || code === "ELOOP") continue;
      throw error;
    }
    try {
      // On POSIX O_NOFOLLOW rejects the final symlink. Windows has no exposed
      // equivalent flag, so the descriptor/path identity and realpath checks
      // below are the reparse-point guard there (and a second guard on POSIX).
      const opened = fstatSync(descriptor);
      const linked = lstatSync(target);
      if (
        !opened.isFile()
        || opened.nlink !== 1
        || linked.isSymbolicLink()
        || !linked.isFile()
        || opened.dev !== linked.dev
        || opened.ino !== linked.ino
        || escapes(relative(rootReal, realpathSync(target)))
      ) continue;
      if (opened.size > MAX_FRAME_PAYLOAD_BYTES) throw new Error(`result artefact is too large: ${path}`);
      // Read no more than the size proved on this descriptor, then require EOF.
      // A task growing the file concurrently cannot turn the bounded check into
      // an unbounded allocation or a mixed-size frame.
      const payload = Buffer.alloc(opened.size);
      let offset = 0;
      while (offset < payload.length) {
        const count = readSync(descriptor, payload, offset, payload.length - offset, offset);
        if (count === 0) break;
        offset += count;
      }
      const extra = Buffer.alloc(1);
      const extraBytes = readSync(descriptor, extra, 0, 1, offset);
      if (offset !== payload.length || extraBytes !== 0) {
        throw new Error(`result artefact changed while being read: ${path}`);
      }
      const sha256 = createHash("sha256").update(payload).digest("hex");
      output.write(encodeFrameHeader({ kind: "file", bytes: payload.length, path, sha256 }));
      output.write(payload);
    } finally {
      closeSync(descriptor);
    }
  }
  output.write(END_FRAME);
}

/** Exported for the frame-parity test, which needs to build a header without
 * writing one to a stream. */
export { encodeFrameHeader };
