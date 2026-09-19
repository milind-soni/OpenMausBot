// Provision/start/stop/remove flow for managed VPS containers:
// per-container locks, image preparation, readiness waits, turn-start
// policy, screenshots, and the shared ComputerBackend adapter.

import { randomBytes } from "node:crypto";

import {
  BASE_IMAGE,
  BASE_IMAGE_DIGEST,
  BASE_IMAGE_LABEL,
  CUA_DRIVER_VERSION,
  IMAGE as CUA_IMAGE,
  CUA_SOCKET,
  DRIVER_LABEL,
  IMAGE_LAYER_LABEL,
  IMAGE_LAYER_VERSION,
  MANAGED_LABEL,
  cuaExecArgs,
  managedImageDockerfile,
  wholeScreenshot,
} from "../container-computer.ts";
import type { VpsComputerBackend } from "../computer-backend.ts";
import { vpsSshAlias, type AppConfig } from "../config.ts";
import {
  COMMAND_TIMEOUT_KILL_GRACE_MS,
  CONTAINER_ID,
  CONTAINER_NAME,
  FULL_CONTAINER_ID,
  IMAGE_ID,
  MANAGED_VPS_CONTAINER_NAME,
  VPS_CONTAINER_LABEL,
  VPS_ENVIRONMENT_LABEL,
  VPS_MANAGED_LABEL,
  VPS_VIEWER_LABEL,
  VIEWER_VERSION,
  defaultRunner,
  snapshotVpsConfig,
  vpsComputerMcp,
  vpsContainerName,
  vpsDockerArgs,
  vpsEnvironmentId,
  vpsLockKey,
  type VpsCommandRunner,
  type VpsLifecycleAction,
} from "./cli.ts";
import { listManagedVpsComputers, scanManagedVpsComputers, type ManagedVpsOwner } from "./inventory.ts";
import {
  STATUS_CACHE_TTL_MS,
  computeVpsComputerStatus,
  pendingScreenshots,
  statusCache,
  viewerConnections,
  vpsComputerStatus,
  type VpsComputerStatus,
  type VpsScreenshot,
} from "./status.ts";
import { closeVpsDesktopTunnel, stopDesktopTunnel, vpsComputerJoin } from "./tunnels.ts";

const PIDS_LIMIT = 512;

const SCREENSHOT_PATH = "/tmp/openmausbot-vps-preview.png";
// The Cua XFCE base includes Pillow in its existing Python environment. Keep
// this panel-only conversion in the transfer exec: no extra SSH round trip,
// image rebuild, driver settings change, or second temporary image. Older
// containers without Pillow can still return the original PNG.
const SCREENSHOT_TRANSFER = `/opt/venv/bin/python -I -c 'import base64, io, sys
from PIL import Image
with Image.open(sys.argv[1]) as image:
    image.thumbnail((1280, 1280))
    output = io.BytesIO()
    image.convert("RGB").save(output, format="JPEG", quality=70)
sys.stdout.write(base64.b64encode(output.getvalue()).decode("ascii"))' "$1" 2>/dev/null || { base64 < "$1" | tr -d "\\n"; }`;

const lifecycleLocks = new Map<string, Promise<void>>();

/** Settings uses this as the reverse side of its config-transition lock: an
 * alias cannot move while a lifecycle action that started first still owns a
 * container lock, including ownerless inventory removals. */
export function vpsLifecycleBusy(): boolean {
  return lifecycleLocks.size > 0;
}

// A held lock means a lifecycle mutation (worst case: a 10-minute image
// build) is running. Waiting it out would wedge Sleep and the screenshot
// poll behind it, so acquisition fails fast instead.
const LOCK_ACQUIRE_TIMEOUT_MS = 5_000;

const SCREENSHOT_BUDGET_MS = 45_000;

const SCREENSHOT_CLEANUP_BUDGET_MS = 10_000;

/** Whether a turn may prepare or start the VPS container rather than only
 * reuse a running one. Explicit Cloud always may; Auto only when the person
 * switched on Start VPS automatically — except for unattended runs. A
 * scheduled routine has nobody present to choose Cloud, and a container that
 * idled out between runs would otherwise leave every scheduled job without
 * its computer, which is exactly what people reported. Starting a self-hosted
 * container costs nothing that needs consent. */
export function vpsStartsForTurn(input: { wants: "cloud" | "vm" | "local" | "off" | undefined; autoStartVps?: boolean; automationSource?: string }): boolean {
  if (input.wants === "cloud") return true;
  if (input.wants !== undefined) return false;
  return input.autoStartVps === true || Boolean(input.automationSource);
}

export function vpsContainerRunArgs(
  containerName: string,
  imageRef = CUA_IMAGE,
  viewerSecret = randomBytes(18).toString("base64url"),
): string[] {
  if (!CONTAINER_NAME.test(containerName) || (imageRef !== CUA_IMAGE && !IMAGE_ID.test(imageRef))) {
    throw new Error("invalid managed VPS container or image reference");
  }
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(viewerSecret)) throw new Error("invalid managed VPS viewer secret");
  return [
    "run",
    "-d",
    "--name",
    containerName,
    "--label",
    `${VPS_MANAGED_LABEL}=1`,
    "--label",
    `${VPS_CONTAINER_LABEL}=${containerName}`,
    "--label",
    `${VPS_ENVIRONMENT_LABEL}=${vpsEnvironmentId()}`,
    "--label",
    `${VPS_VIEWER_LABEL}=${VIEWER_VERSION}`,
    "--label",
    `${MANAGED_LABEL}=1`,
    "--label",
    `${DRIVER_LABEL}=${CUA_DRIVER_VERSION}`,
    "--label",
    `${BASE_IMAGE_LABEL}=${BASE_IMAGE_DIGEST}`,
    "--label",
    `${IMAGE_LAYER_LABEL}=${IMAGE_LAYER_VERSION}`,
    "--memory",
    "4g",
    "--memory-swap",
    "4g",
    "--cpus",
    "2",
    "--pids-limit",
    String(PIDS_LIMIT),
    "--network",
    "bridge",
    "--ipc",
    "private",
    "--cgroupns",
    "private",
    "--cap-drop",
    "ALL",
    "--cap-add",
    "SETUID",
    "--cap-add",
    "SETGID",
    "--shm-size",
    "512m",
    // A VPS reboots with nobody watching; without a restart policy the
    // container stays down afterwards and every turn silently degrades until
    // someone opens the panel. unless-stopped survives reboots while still
    // honoring an explicit Stop. The shared hardening check accepts exactly
    // this policy for the VPS caller (and only "no"/unset for the Local VM,
    // whose desktop cannot safely resume).
    "--restart",
    "unless-stopped",
    "-e",
    `VNC_PW=${viewerSecret}`,
    imageRef,
  ];
}

function assertUsableContainer(status: VpsComputerStatus) {
  if (
    !status.image ||
    !status.imageMatches ||
    !status.managed ||
    status.network !== "private" ||
    status.mounts !== "none" ||
    status.security !== "hardened"
  ) {
    throw Object.assign(new Error(status.problem ?? "The existing VPS container is unsafe or incompatible"), {
      status: 409,
    });
  }
}

async function prepareVpsImage(alias: string, runner: VpsCommandRunner) {
  await runner(vpsDockerArgs(alias, ["pull", BASE_IMAGE]), { timeoutMs: 10 * 60_000 });
  await runner(vpsDockerArgs(alias, ["build", "-t", CUA_IMAGE, "-"]), {
    input: managedImageDockerfile(),
    timeoutMs: 10 * 60_000,
  });
}

/** Waits for the driver inside a verified, running container to come up.
 * Backoff doubles 0.5s→4s because each poll is a real SSH connection, and
 * between polls only ONE cheap exec (`cua-driver status`) asks whether the
 * driver answers yet — the full multi-invocation status runs again only when
 * that predicate flips, and once more at the deadline, so the returned state
 * is always a complete inspection. */
async function waitForVpsReady(
  cfg: AppConfig,
  botId: string,
  runner: VpsCommandRunner,
  budgetMs = 60_000,
): Promise<VpsComputerStatus> {
  const alias = vpsSshAlias(cfg);
  const deadline = Date.now() + budgetMs;
  let status = await computeVpsComputerStatus(cfg, botId, runner);
  let delayMs = 500;
  while (!status.ready && alias && Date.now() < deadline) {
    if (
      !status.daemonUp ||
      !status.image ||
      !status.imageMatches ||
      !status.managed ||
      status.container !== "running" ||
      status.network !== "private" ||
      status.mounts !== "none" ||
      status.security !== "hardened"
    ) {
      return status;
    }
    await new Promise((resolve) => {
      const sleep = setTimeout(resolve, Math.min(delayMs, Math.max(0, deadline - Date.now())));
      sleep.unref?.();
    });
    delayMs = Math.min(delayMs * 2, 4_000);
    const container = status.container_id ?? status.container_name;
    const driverAnswers = await runner(
      vpsDockerArgs(alias, cuaExecArgs(["status", "--socket", CUA_SOCKET], { container })),
      { timeoutMs: 10_000 },
    ).then(
      () => true,
      () => false,
    );
    if (!driverAnswers && Date.now() < deadline) continue;
    status = await computeVpsComputerStatus(cfg, botId, runner);
  }
  return status;
}

async function withVpsLifecycleLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = lifecycleLocks.get(key);
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  lifecycleLocks.set(key, current);
  if (previous) {
    let acquireTimer: ReturnType<typeof setTimeout> | undefined;
    const acquired = await Promise.race([
      previous.then(() => true),
      new Promise<boolean>((resolve) => {
        acquireTimer = setTimeout(() => resolve(false), LOCK_ACQUIRE_TIMEOUT_MS);
        acquireTimer.unref?.();
      }),
    ]);
    if (acquireTimer) clearTimeout(acquireTimer);
    if (!acquired) {
      // Keep the queue serialized: this slot opens only when the holder's
      // does, so a later caller can never run beside the long operation the
      // timed-out one refused to wait for.
      void previous.then(() => {
        release();
        if (lifecycleLocks.get(key) === current) lifecycleLocks.delete(key);
      });
      throw Object.assign(new Error("the VPS is being prepared — try again shortly"), { status: 409 });
    }
  }
  try {
    return await operation();
  } finally {
    release();
    if (lifecycleLocks.get(key) === current) lifecycleLocks.delete(key);
  }
}

/** Permanently remove one inventory row. The fresh inventory read happens
 * while holding the same per-container lock as provision/start/stop, so a
 * stale Settings tab can never delete a replacement container. */
export async function removeManagedVpsComputer(
  cfg: AppConfig,
  owners: ManagedVpsOwner[],
  containerName: string,
  confirmName: string,
  runner: VpsCommandRunner = defaultRunner,
): Promise<{ removed: true; name: string }> {
  cfg = snapshotVpsConfig(cfg);
  const alias = vpsSshAlias(cfg);
  if (!alias) {
    throw Object.assign(new Error("VPS is not configured — add an SSH config alias in Connections"), { status: 409 });
  }
  if (!MANAGED_VPS_CONTAINER_NAME.test(containerName)) {
    throw Object.assign(new Error("invalid managed VPS computer name"), { status: 400 });
  }
  const key = `${alias}:${containerName}`;
  return withVpsLifecycleLock(key, async () => {
    const scan = await scanManagedVpsComputers(cfg, owners, runner);
    const inventory = scan.inventory;
    if (!inventory.available) {
      throw Object.assign(new Error(inventory.problem ?? "VPS computer inventory is unavailable"), { status: 503 });
    }
    const instance = inventory.instances.find((candidate) => candidate.name === containerName);
    if (!instance) throw Object.assign(new Error("managed VPS computer not found"), { status: 404 });
    if (instance.inUse) {
      throw Object.assign(new Error("this VPS computer is in use — stop its bot's work first"), { status: 409 });
    }
    if (confirmName !== instance.name) {
      throw Object.assign(new Error("confirmation no longer matches this VPS computer — refresh and try again"), { status: 400 });
    }

    const containerId = scan.containerIds.get(instance.name);
    if (!containerId || !FULL_CONTAINER_ID.test(containerId)) {
      throw Object.assign(new Error("the VPS computer identity could not be revalidated"), { status: 409 });
    }
    try {
      // Use the immutable ID from the same inspect, not the mutable name. A
      // VPS administrator replacing a same-name container between inspect
      // and rm must not redirect this explicit removal to the replacement.
      await runner(vpsDockerArgs(alias, ["rm", "-f", containerId]), { timeoutMs: 2 * 60_000 });
    } catch (error) {
      const detail = (error instanceof Error ? error.message : String(error))
        .replace(/[\r\n\t]+/g, " ")
        .trim()
        .slice(0, 200);
      throw Object.assign(
        new Error(`The VPS refused to remove this computer${detail ? `: ${detail}` : ""}`),
        { status: 502 },
      );
    }
    statusCache.delete(key);
    viewerConnections.delete(key);
    if (instance.ownerBotId) stopDesktopTunnel(instance.ownerBotId);
    return { removed: true, name: instance.name };
  });
}

export async function vpsComputerAction(
  action: VpsLifecycleAction,
  cfg: AppConfig,
  botId: string,
  runner: VpsCommandRunner = defaultRunner,
): Promise<VpsComputerStatus> {
  cfg = snapshotVpsConfig(cfg);
  const alias = vpsSshAlias(cfg);
  if (!alias) throw Object.assign(new Error("VPS is not configured — add an SSH config alias in App Settings → Connections"), { status: 409 });
  const key = `${alias}:${vpsContainerName(botId)}`;
  const operation = async () => {
    // A mutation invalidates every cached poll answer, before and after: the
    // panel must never keep showing the pre-action world for a TTL.
    statusCache.delete(key);
    try {
      const before = await computeVpsComputerStatus(cfg, botId, runner);
      if (!before.daemonUp) throw Object.assign(new Error(before.problem ?? "Docker over SSH is not reachable"), { status: 409 });
      // A real lifecycle change invalidates the remote endpoint. Provision
      // is also the turn-start idempotency path, so leave an already-running
      // viewer alone when no start/replacement will occur.
      if (action !== "provision" || before.container !== "running") stopDesktopTunnel(botId);
      const run = (args: string[], timeoutMs = 2 * 60_000) => runner(vpsDockerArgs(alias, args), { timeoutMs });

      const containerRef = before.container_id ?? before.container_name;
      if (action === "provision") {
        if (before.container === "missing") {
          let imageRef = before.image ? before.image_id : null;
          if (!before.image) {
            await prepareVpsImage(alias, runner);
            imageRef = (await computeVpsComputerStatus(cfg, botId, runner)).image_id;
          }
          if (!imageRef) throw Object.assign(new Error("The prepared VPS image could not be identified"), { status: 409 });
          await run(vpsContainerRunArgs(before.container_name, imageRef));
        } else {
          assertUsableContainer(before);
          if (before.container === "stopped") await run(["start", containerRef]);
        }
      } else if (action === "start") {
        if (before.container === "missing") throw Object.assign(new Error("No VPS container exists for this bot"), { status: 409 });
        if (before.container === "running") throw Object.assign(new Error("The VPS container is already running"), { status: 409 });
        assertUsableContainer(before);
        await run(["start", containerRef]);
      } else if (action === "remove") {
        // remove exists to escape an incompatible or unsafe container (an
        // IMAGE_LAYER_VERSION bump otherwise bricks the bot: provision 409s
        // on assertUsableContainer forever), so it deliberately skips that
        // check. The ownership labels from the inspect are the only gate:
        // never docker-rm a container OpenMausBot did not create, even one
        // squatting on our name.
        if (before.container === "missing") return before;
        if (!before.managed) {
          throw Object.assign(
            new Error("The VPS container name is occupied by a container OpenMausBot did not create — remove it on the VPS yourself"),
            { status: 409 },
          );
        }
        await run(["rm", "-f", containerRef]);
        return computeVpsComputerStatus(cfg, botId, runner);
      } else {
        if (before.container !== "running") throw Object.assign(new Error("The VPS container is not running"), { status: 409 });
        assertUsableContainer(before);
        await run(["stop", containerRef]);
      }
      return action === "stop" ? computeVpsComputerStatus(cfg, botId, runner) : waitForVpsReady(cfg, botId, runner);
    } finally {
      statusCache.delete(key);
    }
  };
  return withVpsLifecycleLock(key, operation);
}

/** Auto is intentionally read-only: it can attach only to an existing ready
 * container. It recomputes rather than reading the poll cache — routing a
 * turn onto a container that stopped seconds ago is worse than one extra
 * inspection at turn start. */
export async function reuseVps(
  cfg: AppConfig,
  botId: string,
  runner: VpsCommandRunner = defaultRunner,
): Promise<VpsComputerStatus | null> {
  const status = await inspectVpsForAuto(cfg, botId, runner);
  return status.ready ? status : null;
}

/** Auto needs the complete fresh status to explain a failed attach, while
 * retaining reuseVps's no-cache/no-mutation routing guarantee. */
export async function inspectVpsForAuto(
  cfg: AppConfig,
  botId: string,
  runner: VpsCommandRunner = defaultRunner,
): Promise<VpsComputerStatus> {
  cfg = snapshotVpsConfig(cfg);
  const key = vpsLockKey(cfg, botId);
  return key
    ? withVpsLifecycleLock(key, () => computeVpsComputerStatus(cfg, botId, runner))
    : computeVpsComputerStatus(cfg, botId, runner);
}

export function vpsDriverError(driverKind: string, computerMcp: boolean): string | null {
  if (driverKind === "boxAgent") {
    return "The Computer engine runs its agent on Box and cannot use a self-hosted VPS — choose Claude or an ACP engine";
  }
  if (!computerMcp) {
    return "This model engine cannot mount a self-hosted VPS computer — choose Claude or an ACP engine";
  }
  return null;
}

export async function vpsComputerScreenshot(
  cfg: AppConfig,
  botId: string,
  runner: VpsCommandRunner = defaultRunner,
): Promise<VpsScreenshot> {
  cfg = snapshotVpsConfig(cfg);
  const alias = vpsSshAlias(cfg);
  if (!alias) throw Object.assign(new Error("VPS is not configured"), { status: 409 });
  const key = `${alias}:${vpsContainerName(botId)}`;
  const pending = pendingScreenshots.get(key);
  if (pending) return pending;
  const cacheable = runner === defaultRunner;
  const deadline = Date.now() + SCREENSHOT_BUDGET_MS;
  const workDeadline = deadline - SCREENSHOT_CLEANUP_BUDGET_MS;
  let budgetExpired = false;
  const timeoutError = () => Object.assign(new Error("The VPS screen preview timed out. Retry the preview when the connection recovers."), { status: 504 });
  // Clamp each command and wait through the runner's termination grace,
  // rather than racing its promise and releasing the lock before cleanup.
  const boundedRunner: VpsCommandRunner = async (args, options = {}) => {
    const remaining = workDeadline - Date.now() - COMMAND_TIMEOUT_KILL_GRACE_MS;
    if (remaining <= 0) { budgetExpired = true; throw timeoutError(); }
    try {
      const result = await runner(args, { ...options, timeoutMs: Math.min(options.timeoutMs ?? 120_000, remaining) });
      if (Date.now() >= workDeadline) { budgetExpired = true; throw timeoutError(); }
      return result;
    } catch (error) {
      if (Date.now() >= workDeadline - COMMAND_TIMEOUT_KILL_GRACE_MS) budgetExpired = true;
      throw budgetExpired ? timeoutError() : error;
    }
  };
  const capture = withVpsLifecycleLock(key, async () => {
    // Same shape as containerComputerScreenshot's screenshotStatusCache: the
    // poller runs every few seconds, and re-verifying the whole container
    // between frames multiplied every frame's SSH cost.
    const cached = cacheable ? statusCache.get(key) : undefined;
    const status =
      cached && cached.expiresAt > Date.now()
        ? cached.status
        : await computeVpsComputerStatus(cfg, botId, boundedRunner);
    // Status converts transport errors into displayable state. A deadline is
    // still a timeout, not evidence that this container became incompatible.
    if (budgetExpired) {
      if (cacheable) statusCache.delete(key);
      throw timeoutError();
    }
    if (!status.ready) {
      if (cacheable) statusCache.delete(key);
      throw Object.assign(new Error(status.problem ?? "The VPS computer is not ready"), { status: 409 });
    }
    const containerRef = status.container_id ?? status.container_name;
    // The ref goes straight into docker argv, and a cached status is one
    // more step removed from the inspect that produced it — revalidate the
    // exact shapes before spending an exec on it.
    if (!CONTAINER_ID.test(containerRef) && !CONTAINER_NAME.test(containerRef)) {
      throw Object.assign(new Error("the VPS container reference is malformed"), { status: 409 });
    }
    let frame: VpsScreenshot;
    try {
      await boundedRunner(
        vpsDockerArgs(
          alias,
          cuaExecArgs(
            ["call", "get_desktop_state", "{}", "--socket", CUA_SOCKET, "--screenshot-out-file", SCREENSHOT_PATH],
            { container: containerRef },
          ),
        ),
        { timeoutMs: 30_000 },
      );
      const encoded = (await boundedRunner(vpsDockerArgs(alias, [
        "exec",
        "-u",
        "cua",
        "-e",
        "HOME=/home/cua",
        containerRef,
        "sh",
        "-c",
        SCREENSHOT_TRANSFER,
        "openmausbot-preview",
        SCREENSHOT_PATH,
      ]), { timeoutMs: 30_000 })).stdout.trim();
      const checked = wholeScreenshot(Buffer.from(encoded, "base64"));
      if (!checked.ok) throw Object.assign(new Error("Cua Driver returned an incomplete VPS screenshot"), { status: 502 });
      frame = { png: encoded, format: checked.mime === "image/jpeg" ? "jpeg" : "png" };
    } catch (error) {
      // The failure may mean the world changed (container stopped, link
      // dropped); a cached "ready" would keep the poller failing for a TTL.
      if (cacheable) statusCache.delete(key);
      throw error;
    } finally {
      const cleanupMs = Math.min(5_000, deadline - Date.now() - COMMAND_TIMEOUT_KILL_GRACE_MS);
      if (cleanupMs > 0) await runner(vpsDockerArgs(alias, ["exec", "-u", "cua", containerRef, "rm", "-f", SCREENSHOT_PATH]), {
        timeoutMs: cleanupMs,
      }).catch(() => {});
    }
    // Start the TTL after transfer and cleanup; a slow but healthy frame must
    // not return with its own readiness cache already expired.
    if (cacheable) statusCache.set(key, { status, expiresAt: Date.now() + STATUS_CACHE_TTL_MS });
    return frame;
  });
  pendingScreenshots.set(key, capture);
  try { return await capture; }
  finally { if (pendingScreenshots.get(key) === capture) pendingScreenshots.delete(key); }
}

/** The VPS arm of the shared ComputerBackend dispatch (computer-backend.ts).
 * Thin adapters over the module's own functions; the underlying signatures
 * stay available for the VPS-specific policy that still lives in index.ts. */
export const vpsComputerBackend: VpsComputerBackend = {
  kind: "vps",
  status: (cfg, botId) => vpsComputerStatus(cfg, botId),
  action: (cfg, botId, action) => vpsComputerAction(action, cfg, botId),
  screenshot: (cfg, botId) => vpsComputerScreenshot(cfg, botId),
  join: (cfg, botId) => vpsComputerJoin(cfg, botId),
  closeViewer: (botId) => closeVpsDesktopTunnel(botId),
  inventory: (cfg, owners) => listManagedVpsComputers(cfg, owners),
  removeManaged: (cfg, owners, containerName, confirmName) =>
    removeManagedVpsComputer(cfg, owners, containerName, confirmName),
  mcp: (cfg, botId, containerRef) => vpsComputerMcp(cfg, botId, containerRef),
  inspectForAuto: (cfg, botId) => inspectVpsForAuto(cfg, botId),
};
