import { spawn, spawnSync } from "node:child_process";
import { basename, dirname, resolve } from "node:path";
import type { Writable } from "node:stream";

const MAX_WORKER_OUTPUT_BYTES = 32 * 1024;

export interface AnchoredDirectoryIdentity {
  dev: number;
  ino: number;
}

export interface AnchoredFileIdentity {
  dev: number;
  ino: number;
  nlink: number;
  size: number;
  mode: number;
  mtimeMs: number;
  ctimeMs: number;
}

export interface AnchoredFileWriteInput {
  path: string;
  parent: AnchoredDirectoryIdentity;
  mode: "create" | "replace";
  content: Buffer | string;
  maximumBytes: number;
  expectedFile?: Omit<AnchoredFileIdentity, "mode"> & { sha256: string };
}

export class AnchoredFileError extends Error {
  readonly code: string;

  constructor(message: string, code = "ERR_ANCHORED_FILE") {
    super(message);
    this.name = "AnchoredFileError";
    this.code = code;
  }
}

interface WorkerRequest {
  name: string;
  parent: AnchoredDirectoryIdentity;
  mode: "create" | "replace";
  contentBase64: string;
  contentBytes: number;
  maximumBytes: number;
  expectedFile?: Omit<AnchoredFileIdentity, "mode"> & { sha256: string };
}

interface WorkerResponse {
  ok: boolean;
  code?: string;
  reason?: string;
  identity?: AnchoredFileIdentity;
}

// A child process receives its cwd from the kernel before user code starts.
// Once started, relative path resolution remains anchored to that directory
// object even if the pathname is renamed or replaced. The first operation
// verifies that cwd object against the parent identity captured by the host;
// no untrusted content or path is placed in argv.
const ANCHORED_FILE_WORKER = String.raw`
const crypto = require("node:crypto");
const fs = require("node:fs");

function result(value, status) {
  process.stdout.write(JSON.stringify(value));
  process.exitCode = status;
}

function reject(reason, code = "ERR_ANCHORED_FILE") {
  const error = new Error(reason);
  error.safeReason = reason;
  error.code = code;
  throw error;
}

function sameParent(info, expected) {
  return info.isDirectory() && !info.isSymbolicLink() &&
    info.dev === expected.dev && info.ino === expected.ino;
}

function sameFile(left, right) {
  return left.isFile() && right.isFile() && left.nlink === 1 && right.nlink === 1 &&
    left.dev === right.dev && left.ino === right.ino;
}

function identity(info) {
  return {
    dev: info.dev,
    ino: info.ino,
    nlink: info.nlink,
    size: info.size,
    mode: info.mode,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
  };
}

let fd = null;
let opened = null;
let prior = null;
let created = false;
let mutated = false;
let succeeded = false;
try {
  const request = JSON.parse(fs.readFileSync(0, "utf8"));
  if (!request || typeof request !== "object" ||
      typeof request.name !== "string" || !request.name || request.name === "." || request.name === ".." ||
      /[\\/\0]/.test(request.name) ||
      !request.parent || !Number.isFinite(request.parent.dev) || !Number.isFinite(request.parent.ino) ||
      !Number.isSafeInteger(request.maximumBytes) || request.maximumBytes < 1 ||
      !Number.isSafeInteger(request.contentBytes) || request.contentBytes < 0 ||
      request.contentBytes > request.maximumBytes ||
      (request.mode !== "create" && request.mode !== "replace")) {
    reject("anchored file request is invalid");
  }
  const content = Buffer.from(String(request.contentBase64 || ""), "base64");
  if (content.byteLength !== request.contentBytes) reject("anchored file content encoding is invalid");
  const parentBefore = fs.lstatSync(".");
  if (!sameParent(parentBefore, request.parent)) reject("anchored file parent identity changed");

  const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  const flags = request.mode === "create"
    ? fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow
    : fs.constants.O_RDWR | noFollow;
  fd = fs.openSync(request.name, flags, 0o600);
  opened = fs.fstatSync(fd);
  created = request.mode === "create";

  if (!opened.isFile() || opened.nlink !== 1 || opened.size > request.maximumBytes) {
    reject("anchored file target is not a bounded single-link regular file");
  }
  if (request.mode === "replace") {
    const expected = request.expectedFile;
    if (!expected || opened.dev !== expected.dev || opened.ino !== expected.ino ||
        opened.nlink !== expected.nlink || opened.size !== expected.size ||
        opened.mtimeMs !== expected.mtimeMs || opened.ctimeMs !== expected.ctimeMs) {
      reject("anchored file identity changed since the approved read");
    }
    prior = fs.readFileSync(fd);
    const currentHash = "sha256:" + crypto.createHash("sha256").update(prior).digest("hex");
    if (prior.byteLength !== opened.size || currentHash !== expected.sha256) {
      reject("anchored file content changed since the approved read");
    }
  }

  const pathBefore = fs.lstatSync(request.name);
  const parentAfterOpen = fs.lstatSync(".");
  if (!sameFile(opened, pathBefore) || !sameParent(parentAfterOpen, request.parent)) {
    reject("anchored file path or parent changed before write");
  }

  fs.ftruncateSync(fd, 0);
  mutated = true;
  for (let offset = 0; offset < content.byteLength;) {
    const written = fs.writeSync(fd, content, offset, content.byteLength - offset, offset);
    if (written <= 0) reject("anchored file write made no progress");
    offset += written;
  }
  fs.ftruncateSync(fd, content.byteLength);
  fs.fsyncSync(fd);

  const after = fs.fstatSync(fd);
  const pathAfter = fs.lstatSync(request.name);
  const parentAfter = fs.lstatSync(".");
  if (!sameFile(opened, after) || !sameFile(after, pathAfter) ||
      after.size !== content.byteLength || !sameParent(parentAfter, request.parent)) {
    reject("anchored file path or parent changed during write");
  }
  succeeded = true;
  result({ ok: true, identity: identity(after) }, 0);
} catch (error) {
  if (fd !== null && mutated && prior) {
    try {
      fs.ftruncateSync(fd, 0);
      for (let offset = 0; offset < prior.byteLength;) {
        const written = fs.writeSync(fd, prior, offset, prior.byteLength - offset, offset);
        if (written <= 0) break;
        offset += written;
      }
      fs.ftruncateSync(fd, prior.byteLength);
      fs.fsyncSync(fd);
    } catch {}
  }
  const reason = typeof error.safeReason === "string" ? error.safeReason : "anchored file write rejected";
  const code = typeof error.code === "string" ? error.code : "ERR_ANCHORED_FILE";
  result({ ok: false, reason, code }, 1);
} finally {
  if (fd !== null) {
    try { fs.closeSync(fd); } catch {}
  }
  if (created && !succeeded && opened) {
    try {
      const current = fs.lstatSync(process.argv[1]);
      if (sameFile(opened, current)) fs.unlinkSync(process.argv[1]);
    } catch {}
  }
}
`;

function workerEnvironment(): NodeJS.ProcessEnv {
  const names = ["SystemRoot", "WINDIR", "ComSpec", "COMSPEC", "PATH", "HOME", "USERPROFILE", "TMP", "TEMP", "TMPDIR"];
  return Object.fromEntries([
    ...names.flatMap((name) => process.env[name] ? [[name, process.env[name]!]] : []),
    ["ELECTRON_RUN_AS_NODE", "1"],
  ]);
}

function requestFor(input: AnchoredFileWriteInput): { cwd: string; serialized: string } {
  const path = resolve(input.path);
  const name = basename(path);
  const cwd = dirname(path);
  const content = Buffer.isBuffer(input.content) ? input.content : Buffer.from(input.content, "utf8");
  if (!name || name === "." || name === ".." || /[\\/\0]/.test(name) ||
      !Number.isSafeInteger(input.maximumBytes) || input.maximumBytes < 1 ||
      content.byteLength > input.maximumBytes ||
      !Number.isFinite(input.parent.dev) || !Number.isFinite(input.parent.ino) ||
      (input.mode === "replace" && !input.expectedFile)) {
    throw new AnchoredFileError("anchored file request is invalid");
  }
  const request: WorkerRequest = {
    name,
    parent: input.parent,
    mode: input.mode,
    contentBase64: content.toString("base64"),
    contentBytes: content.byteLength,
    maximumBytes: input.maximumBytes,
    ...(input.expectedFile ? { expectedFile: input.expectedFile } : {}),
  };
  return { cwd, serialized: JSON.stringify(request) };
}

function parseResponse(stdout: string, success: boolean): AnchoredFileIdentity {
  let response: WorkerResponse | null = null;
  try { response = JSON.parse(stdout) as WorkerResponse; } catch {}
  if (!success || !response?.ok || !response.identity) {
    throw new AnchoredFileError(
      response?.reason ?? "anchored file worker failed closed",
      response?.code ?? "ERR_ANCHORED_FILE",
    );
  }
  return response.identity;
}

export function writeAnchoredFileSync(
  input: AnchoredFileWriteInput,
  hooks: { beforeSpawn?: () => void } = {},
): AnchoredFileIdentity {
  const request = requestFor(input);
  hooks.beforeSpawn?.();
  const child = spawnSync(process.execPath, ["-e", ANCHORED_FILE_WORKER, basename(resolve(input.path))], {
    cwd: request.cwd,
    env: workerEnvironment(),
    input: request.serialized,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: MAX_WORKER_OUTPUT_BYTES,
    stdio: ["pipe", "pipe", "ignore"],
  });
  if (child.error) throw new AnchoredFileError("anchored file worker could not start");
  return parseResponse(String(child.stdout ?? ""), child.status === 0);
}

export async function writeAnchoredFile(
  input: AnchoredFileWriteInput,
  hooks: {
    beforeSpawn?: () => void | Promise<void>;
    beforeStdinWrite?: (stdin: Writable) => void;
  } = {},
): Promise<AnchoredFileIdentity> {
  const request = requestFor(input);
  await hooks.beforeSpawn?.();
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, ["-e", ANCHORED_FILE_WORKER, basename(resolve(input.path))], {
      cwd: request.cwd,
      env: workerEnvironment(),
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
    let stdout = "";
    let settled = false;
    let stdinFailure: AnchoredFileError | null = null;
    const finish = (error?: Error, identity?: AnchoredFileIdentity) => {
      if (settled) return;
      settled = true;
      if (error) rejectPromise(error);
      else resolvePromise(identity!);
    };
    // The worker performs only bounded local I/O. Do not externally kill it:
    // termination between truncate and rollback could turn a rejected write
    // into persistent partial content.
    child.once("error", () => finish(new AnchoredFileError("anchored file worker could not start")));
    child.stdin.once("error", () => {
      stdinFailure ??= new AnchoredFileError("anchored file worker stdin failed closed");
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.once("close", (code) => {
      if (stdinFailure) return finish(stdinFailure);
      try { finish(undefined, parseResponse(stdout, code === 0)); }
      catch (error) { finish(error as Error); }
    });
    try {
      hooks.beforeStdinWrite?.(child.stdin);
      child.stdin.end(request.serialized);
    } catch {
      stdinFailure ??= new AnchoredFileError("anchored file worker stdin failed closed");
      child.stdin.destroy();
    }
  });
}
