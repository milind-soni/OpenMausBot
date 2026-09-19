// Local VM lifecycle: workspace provisioning, managed image preparation,
// the pull/run/stop/remove action dispatcher, and the cheap per-target
// existence probe used by the per-bot pool.

import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BASE_IMAGE,
  IMAGE,
  SHARED_LOCAL_VM_TARGET,
  managedImageDockerfile,
  type LocalVmTarget,
} from "./image.ts";
import { containerRunArgs } from "./hardening.ts";
import { screenshotStatusCache } from "./screenshot-cache.ts";
import { containerComputerStatus, type ContainerComputerStatus } from "./status.ts";
import { sh, type CommandRunner, type LifecycleAction, type Runtime } from "./runtime.ts";

async function ensureVmWorkspace(platform: NodeJS.Platform, target: LocalVmTarget): Promise<void> {
  await mkdir(target.workspaceDir, { recursive: true, mode: 0o700 });
  if (platform !== "win32") await chmod(target.workspaceDir, 0o700);
}

async function prepareManagedImage(runtime: Runtime, runner: CommandRunner): Promise<void> {
  await runner(runtime, ["pull", BASE_IMAGE], 10 * 60_000);
  const context = await mkdtemp(join(tmpdir(), "openmausbot-cua-image-"));
  try {
    await writeFile(join(context, "Dockerfile"), managedImageDockerfile(), { mode: 0o600 });
    await runner(runtime, ["build", "-t", IMAGE, context], 10 * 60_000);
  } finally {
    await rm(context, { recursive: true, force: true });
  }
}

export async function containerComputerAction(
  action: LifecycleAction,
  runner: CommandRunner = sh,
  platform: NodeJS.Platform = process.platform,
  target: LocalVmTarget = SHARED_LOCAL_VM_TARGET,
): Promise<ContainerComputerStatus> {
  if (runner === sh && platform === process.platform) screenshotStatusCache.delete(target.key);
  const before = await containerComputerStatus(runner, platform, target);
  const runtime = before.runtime;
  if (!runtime) throw Object.assign(new Error(before.problem ?? "No container runtime is installed"), { status: 409 });
  if (!before.daemonUp) throw Object.assign(new Error(before.problem ?? `${runtime} is not running`), { status: 409 });

  if (action === "run" && before.container !== "missing") {
    throw Object.assign(new Error("A Local VM already exists; remove it before creating a replacement"), { status: 409 });
  }
  if (action === "run" && !before.image) {
    throw Object.assign(new Error("Prepare the Cua desktop image before creating the Local VM"), { status: 409 });
  }
  if (action === "run" && !before.create_supported) {
    throw Object.assign(new Error(before.problem ?? "This runtime cannot create a per-bot Local VM"), { status: 409 });
  }
  if (action === "start") {
    throw Object.assign(new Error("This desktop image cannot safely resume; remove and recreate the Local VM"), {
      status: 409,
    });
  }
  if (action === "stop" && before.container !== "running") {
    throw Object.assign(new Error("The Local VM is not running"), { status: 409 });
  }
  if (action === "remove" && before.container === "missing") return before;
  if (action === "remove" && !before.managed) {
    throw Object.assign(
      new Error(
        `The existing container named ${target.containerName} was not created by OpenMausBot; remove it manually in ${runtime}`,
      ),
      { status: 409 },
    );
  }

  if (action === "pull") {
    await prepareManagedImage(runtime, runner);
  } else {
    if (action === "run") await ensureVmWorkspace(platform, target);
    const args =
      action === "run"
        ? containerRunArgs(runtime, randomBytes(6).toString("base64url"), target)
        : action === "remove"
          ? ["rm", runtime === "container" ? "--force" : "-f", target.containerName]
          : [action, target.containerName];
    await runner(runtime, args, 2 * 60_000);
  }
  return containerComputerStatus(runner, platform, target);
}

/** Cheap capacity probe used by the per-bot pool. It deliberately checks an
 * exact derived container name rather than parsing a broad daemon listing. */
export async function containerComputerExists(
  runtime: Runtime,
  target: LocalVmTarget,
  runner: CommandRunner = sh,
): Promise<boolean> {
  try {
    await runner(runtime, ["inspect", target.containerName], 8_000);
    return true;
  } catch {
    return false;
  }
}
