// Website sign-ins in the Local VM live in its browsers' profiles. Chrome and Chromium have always kept theirs in the durable
// workspace; Firefox, the image's own browser, kept its profile in the container (/home/cua/.mozilla) until image layer 6.
// Before such a desktop is removed, its Firefox profile is copied into the workspace, where the new image points ~/.mozilla.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, rename, rm, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import type { ContainerComputerStatus, LocalVmTarget } from "./container-computer.ts";
import { augmentedPath, resolveCliSpawn } from "./env-path.ts";

const run = promisify(execFile);
const PROFILE_IN_CONTAINER = "/home/cua/.mozilla";
const APPS_IN_CONTAINER = "/home/cua/.local";
// docker: "Could not find the file … in container"; podman: "… could not be found on container …: no such file or directory".
const NOT_IN_CONTAINER = /could not (?:be )?f(?:ou|i)nd|no such file/iu;

async function isEmptyDirectory(path: string): Promise<boolean> {
  try {
    return (await readdir(path)).length === 0;
  } catch {
    return false;
  }
}

/** Works on a stopped container. "kept": the workspace already has a Firefox profile, which is never overwritten.
 * Any copy failure other than "no profile there" throws, so the caller keeps the old desktop rather than lose sign-ins. */
export async function rescueFirefoxProfile(runtime: string, target: LocalVmTarget): Promise<"rescued" | "kept" | "none"> {
  const profiles = join(target.workspaceDir, ".browser-profiles");
  const durable = join(profiles, "mozilla");
  await mkdir(profiles, { recursive: true, mode: 0o700 });
  const existing = await lstat(durable).catch(() => null);
  if (existing && !(existing.isDirectory() && await isEmptyDirectory(durable))) return "kept";
  const staging = join(profiles, `.mozilla-rescue-${randomBytes(6).toString("hex")}`);
  try {
    const { command, args } = resolveCliSpawn(runtime, ["cp", `${target.containerName}:${PROFILE_IN_CONTAINER}`, staging]);
    try {
      await run(command, args, { timeout: 5 * 60_000, maxBuffer: 1024 * 1024, env: { ...process.env, PATH: augmentedPath() } });
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
  return rescueFirefoxProfile(status.runtime, target);
}

/** User-installed desktop applications conventionally live in ~/.local. Rescue that directory before replacing a legacy
 * Local VM, but never overwrite an application area the durable folder already owns. */
export async function rescueInstalledApps(runtime: string, target: LocalVmTarget): Promise<"rescued" | "kept" | "none"> {
  const apps = join(target.workspaceDir, ".desktop-apps");
  const durable = join(apps, "local");
  await mkdir(apps, { recursive: true, mode: 0o700 });
  const existing = await lstat(durable).catch(() => null);
  const staging = join(apps, `.local-rescue-${randomBytes(6).toString("hex")}`);
  try {
    const { command, args } = resolveCliSpawn(runtime, ["cp", `${target.containerName}:${APPS_IN_CONTAINER}`, staging]);
    try {
      await run(command, args, { timeout: 5 * 60_000, maxBuffer: 1024 * 1024, env: { ...process.env, PATH: augmentedPath() } });
    } catch (error) {
      const failure = error as { stderr?: string; message?: string };
      if (NOT_IN_CONTAINER.test(`${failure.stderr ?? ""} ${failure.message ?? ""}`)) return "none";
      throw new Error(`could not copy installed desktop apps: ${(failure.stderr || failure.message || String(error)).trim().slice(0, 300)}`);
    }
    const copied = await lstat(staging);
    if (!copied.isDirectory()) return "none";
    if (existing && !(existing.isDirectory() && await isEmptyDirectory(durable))) {
      try {
        await run("/usr/bin/diff", ["-qr", staging, durable], { timeout: 5 * 60_000, maxBuffer: 1024 * 1024 });
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
  return rescueInstalledApps(status.runtime, target);
}
