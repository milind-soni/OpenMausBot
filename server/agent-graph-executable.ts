import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { findCliCandidates } from "./env-path.ts";
import { agentGraphNoFollowFlag } from "./agent-graph-evidence.ts";
import { resolveCli } from "./procs.ts";

const MAX_EXECUTABLE_BYTES = 512 * 1024 * 1024;
const HASH_CHUNK_BYTES = 1024 * 1024;

interface FileIdentity {
  path: string;
  realPath: string;
  linkDev: string;
  linkIno: string;
  targetDev: string;
  targetIno: string;
  size: number;
  mode: number;
  sha256: string;
  shebang: string | null;
}

const identityCache = new Map<string, FileIdentity>();

function assertExecutableFile(info: Stats): void {
  if (!info.isFile()) throw new Error("graph provider executable target must be a regular file");
  if (info.size < 1 || info.size > MAX_EXECUTABLE_BYTES) {
    throw new Error("graph provider executable is outside the bounded size limit");
  }
  if (process.platform !== "win32" && (info.mode & 0o111) === 0) {
    throw new Error("graph provider executable is not executable");
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function fileIdentity(path: string): FileIdentity {
  const absolute = resolve(path);
  const link = lstatSync(absolute);
  const realPath = realpathSync(absolute);
  const targetLink = lstatSync(realPath);
  if (targetLink.isSymbolicLink()) throw new Error("graph provider executable target must be a regular file");
  assertExecutableFile(targetLink);
  const signature = [
    absolute, realPath, link.dev, link.ino, link.size, link.mtimeMs, link.ctimeMs,
    targetLink.dev, targetLink.ino, targetLink.size, targetLink.mode, targetLink.mtimeMs, targetLink.ctimeMs,
  ].join("\0");
  const cached = targetLink.size > 16 * 1024 * 1024 ? identityCache.get(signature) : undefined;
  if (cached) return cached;
  const fd = openSync(realPath, fsConstants.O_RDONLY | agentGraphNoFollowFlag());
  try {
    const before = fstatSync(fd);
    assertExecutableFile(before);
    if (
      before.dev !== targetLink.dev || before.ino !== targetLink.ino || before.size !== targetLink.size ||
      before.mode !== targetLink.mode || before.mtimeMs !== targetLink.mtimeMs || before.ctimeMs !== targetLink.ctimeMs
    ) throw new Error("graph provider executable changed before its identity was captured");
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
    let total = 0;
    let head = Buffer.alloc(0);
    while (total < before.size) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, before.size - total), null);
      if (!count) break;
      const chunk = buffer.subarray(0, count);
      digest.update(chunk);
      if (head.length < 512) head = Buffer.concat([head, chunk.subarray(0, 512 - head.length)]);
      total += count;
    }
    const after = fstatSync(fd);
    if (
      before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || total !== after.size
    ) throw new Error("graph provider executable changed while its identity was captured");
    const firstLine = head.toString("utf8").split("\n", 1)[0] ?? "";
    const identity = {
      path: absolute,
      realPath,
      linkDev: String(link.dev),
      linkIno: String(link.ino),
      targetDev: String(after.dev),
      targetIno: String(after.ino),
      size: after.size,
      mode: after.mode,
      sha256: `sha256:${digest.digest("hex")}`,
      shebang: firstLine.startsWith("#!") ? firstLine : null,
    };
    if (targetLink.size > 16 * 1024 * 1024) {
      identityCache.set(signature, identity);
      if (identityCache.size > 32) identityCache.delete(identityCache.keys().next().value!);
    }
    return identity;
  } finally {
    closeSync(fd);
  }
}

function absoluteCommand(command: string): string {
  if (isAbsolute(command) || /[/\\]/.test(command)) return resolve(command);
  const candidate = findCliCandidates(command)[0];
  if (!candidate) throw new Error("graph provider executable is not resolvable on the app path");
  return resolve(candidate);
}

function shebangInterpreter(executable: FileIdentity): FileIdentity | null {
  const firstLine = executable.shebang ?? "";
  if (!firstLine.startsWith("#!")) return null;
  const words = firstLine.slice(2).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  let command = words[0]!;
  if (/(?:^|[/\\])env(?:\.exe)?$/i.test(command)) {
    const payload = words.slice(1).filter((word) => word !== "-S" && !word.startsWith("-"));
    if (!payload.length) return null;
    command = payload[0]!;
  }
  try {
    return fileIdentity(absoluteCommand(command));
  } catch {
    return null;
  }
}

/** Bind an approved route to the exact executable, wrapper/script files, and
 * fixed leading arguments that spawnCli will use. Replacing a same-version
 * binary or changing PATH therefore invalidates the approved graph hash. */
export function graphExecutableIdentity(cli: string): string {
  const resolved = resolveCli(cli, []);
  const command = fileIdentity(absoluteCommand(resolved.command));
  const interpreter = shebangInterpreter(command);
  const argumentFiles = resolved.args.flatMap((argument) => {
    if (!isAbsolute(argument) || !existsSync(argument)) return [];
    try {
      return [fileIdentity(argument)];
    } catch {
      return [];
    }
  });
  const payload = {
    schema: "openmaus.agent-graph-executable.v1",
    command,
    interpreter,
    fixedArgs: resolved.args,
    argumentFiles,
  };
  return `sha256:${createHash("sha256").update(canonical(payload)).digest("hex")}`;
}

export function graphExecutableReady(cli: string): boolean {
  try {
    graphExecutableIdentity(cli);
    return true;
  } catch {
    return false;
  }
}
