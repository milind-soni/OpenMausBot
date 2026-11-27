// Website sign-ins in the Local VM live in its browsers' profiles. Chrome and Chromium have always kept theirs in the durable
// workspace; Firefox, the image's own browser, kept its profile in the container (/home/cua/.mozilla) until image layer 6.
// Before such a desktop is removed, its Firefox profile is copied into the workspace, where the new image points ~/.mozilla.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, readdir, readlink, rename, rm, rmdir, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { shellQuote } from "./browser/chrome/wrapper.ts";
import type { ContainerComputerStatus, LocalVmTarget } from "./container-computer.ts";
import { augmentedPath, resolveCliSpawn } from "./env-path.ts";

const run = promisify(execFile);
const PROFILE_IN_CONTAINER = "/home/cua/.mozilla";
const APPS_IN_CONTAINER = "/home/cua/.local";
// docker: "Could not find the file … in container"; podman: "… could not be found on container …: no such file or directory".
const NOT_IN_CONTAINER = /could not (?:be )?f(?:ou|i)nd|no such file/iu;
const PERMISSION_DENIED = /EACCES|EPERM|permission denied|operation not permitted/iu;

/** A desktop made before cua took the host's ids ran as uid 1000 and may have left folders this server cannot change.
 * The update then names the one command that hands them back instead of a bare EACCES. */
function withOwnershipStep(error: unknown, workspaceDir: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (!PERMISSION_DENIED.test(message) || !process.getuid || !process.getgid) return error instanceof Error ? error : new Error(message);
  return new Error(
    `an older desktop left files this app (uid ${process.getuid()}) cannot change; run sudo chown -R ${process.getuid()}:${process.getgid()} ${shellQuote(workspaceDir)} and it retries on its own (${message.slice(0, 80)})`,
  );
}

async function isEmptyDirectory(path: string): Promise<boolean> {
  try {
    return (await readdir(path)).length === 0;
  } catch {
    return false;
  }
}

async function readChunk(file: FileHandle, buffer: Buffer): Promise<number> {
  let filled = 0;
  while (filled < buffer.length) {
    const { bytesRead } = await file.read(buffer, filled, buffer.length - filled, null);
    if (!bytesRead) break;
    filled += bytesRead;
  }
  return filled;
}

async function sameFileBytes(a: string, b: string, deadline: number): Promise<boolean> {
  const left = await open(a, "r");
  try {
    const right = await open(b, "r");
    try {
      const leftBuffer = Buffer.allocUnsafe(64 * 1024), rightBuffer = Buffer.allocUnsafe(64 * 1024);
      for (;;) {
        if (Date.now() > deadline) throw new Error("installed-app comparison timed out");
        const [leftRead, rightRead] = await Promise.all([readChunk(left, leftBuffer), readChunk(right, rightBuffer)]);
        if (leftRead !== rightRead || !leftBuffer.subarray(0, leftRead).equals(rightBuffer.subarray(0, rightRead))) return false;
        if (!leftRead) return true;
      }
    } finally { await right.close(); }
  } finally { await left.close(); }
}

async function sameAppTree(a: string, b: string): Promise<boolean> {
  const pending: [string, string][] = [[a, b]];
  const deadline = Date.now() + 5 * 60_000;
  while (pending.length) {
    if (Date.now() > deadline) throw new Error("installed-app comparison timed out");
    const [left, right] = pending.pop()!;
    const [ls, rs] = await Promise.all([lstat(left), lstat(right)]);
    if (ls.isSymbolicLink() && rs.isSymbolicLink()) {
      if (await readlink(left) !== await readlink(right)) return false;
    } else if (ls.isDirectory() && rs.isDirectory()) {
      const [leftNames, rightNames] = await Promise.all([readdir(left), readdir(right)]);
      const names = new Set(rightNames);
      if (leftNames.length !== rightNames.length || leftNames.some((name) => !names.has(name))) return false;
      for (const name of leftNames) pending.push([join(left, name), join(right, name)]);
    } else if (ls.isFile() && rs.isFile()) {
      if (ls.size !== rs.size || !await sameFileBytes(left, right, deadline)) return false;
    } else return false;
  }
  return true;
}

/** Works on a stopped container. "kept": the workspace already has a Firefox profile, which is never overwritten.
 * Any copy failure other than "no profile there" throws, so the caller keeps the old desktop rather than lose sign-ins. */
export async function rescueFirefoxProfile(runtime: string, target: LocalVmTarget): Promise<"rescued" | "kept" | "none"> {
  const profiles = join(target.workspaceDir, ".browser-profiles");
  const durable = join(profiles, "mozilla");
  await mkdir(profiles, { recursive: true, mode: 0o700 });
  const existing = await lstat(durable).catch(() => null);
  if (existing && !(existing.isDirectory() && await isEmptyDirectory(durable))) return "kept";
  // Staged in the workspace root, which this server made: an older desktop may own .browser-profiles, and a desktop whose
  // ~/.mozilla is already a link into the workspace must update without writing there.
  const staging = join(target.workspaceDir, `.mozilla-rescue-${randomBytes(6).toString("hex")}`);
  try {
    const { command, args } = resolveCliSpawn(runtime, ["cp", `${target.containerName}:${PROFILE_IN_CONTAINER}`, staging]);
    try {
      await run(command, args, { timeout: 5 * 60_000, maxBuffer: 1024 * 1024, env: { ...process.env, PATH: augmentedPath() }, windowsHide: true });
    } catch (error) {
      const failure = error as { stderr?: string; message?: string };
      if (NOT_IN_CONTAINER.test(`${failure.stderr ?? ""} ${failure.message ?? ""}`)) return "none";
      throw new Error(`could not copy the desktop's Firefox profile: ${(failure.stderr || failure.message || String(error)).trim().slice(0, 300)}`);
    }
    // A newer desktop's ~/.mozilla is already a link into the workspace: there is nothing to move.
    const copied = await lstat(staging);
    if (!copied.isDirectory()) return "none";
    if (existing) await rmdir(durable);
    await rename(staging, durable);
    return "rescued";
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** Before a desktop this server made is removed. One on the current image already keeps Firefox in the workspace; an older
 * one is stopped first, so Firefox writes its profile out and the copy is consistent. */
export async function keepFirefoxProfileBeforeRemove(
  target: LocalVmTarget,
  status: Pick<ContainerComputerStatus, "runtime" | "container" | "managed" | "imageMatches">,
  stop: () => Promise<unknown>,
): Promise<"rescued" | "kept" | "none"> {
  if (!status.runtime || status.container === "missing" || !status.managed || status.imageMatches) return "none";
  if (status.container === "running") await stop();
  return rescueFirefoxProfile(status.runtime, target).catch((error: unknown) => { throw withOwnershipStep(error, target.workspaceDir); });
}

/** User-installed desktop applications conventionally live in ~/.local. Rescue that directory before replacing a legacy
 * Local VM, but never overwrite an application area the durable folder already owns. */
export async function rescueInstalledApps(runtime: string, target: LocalVmTarget): Promise<"rescued" | "kept" | "none"> {
  const apps = join(target.workspaceDir, ".desktop-apps");
  const durable = join(apps, "local");
  await mkdir(apps, { recursive: true, mode: 0o700 });
  const existing = await lstat(durable).catch(() => null);
  const staging = join(target.workspaceDir, `.local-rescue-${randomBytes(6).toString("hex")}`); // the root, as for Firefox
  try {
    const { command, args } = resolveCliSpawn(runtime, ["cp", `${target.containerName}:${APPS_IN_CONTAINER}`, staging]);
    try {
      await run(command, args, { timeout: 5 * 60_000, maxBuffer: 1024 * 1024, env: { ...process.env, PATH: augmentedPath() }, windowsHide: true });
    } catch (error) {
      const failure = error as { stderr?: string; message?: string };
      if (NOT_IN_CONTAINER.test(`${failure.stderr ?? ""} ${failure.message ?? ""}`)) return "none";
      throw new Error(`could not copy installed desktop apps: ${(failure.stderr || failure.message || String(error)).trim().slice(0, 300)}`);
    }
    const copied = await lstat(staging);
    if (!copied.isDirectory()) return "none";
    if (existing && !(existing.isDirectory() && await isEmptyDirectory(durable))) {
      try {
        if (!await sameAppTree(staging, durable)) throw new Error("different app trees");
      } catch {
        throw new Error("could not preserve installed desktop apps because the durable app area differs from the old desktop");
      }
      return "kept";
    }
    if (existing) await rmdir(durable);
    await rename(staging, durable);
    return "rescued";
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function keepInstalledAppsBeforeRemove(
  target: LocalVmTarget,
  status: Pick<ContainerComputerStatus, "runtime" | "container" | "managed" | "imageMatches">,
  stop: () => Promise<unknown>,
): Promise<"rescued" | "kept" | "none"> {
  if (!status.runtime || status.container === "missing" || !status.managed || status.imageMatches) return "none";
  if (status.container === "running") await stop();
  return rescueInstalledApps(status.runtime, target).catch((error: unknown) => { throw withOwnershipStep(error, target.workspaceDir); });
}
