// Screenshot and frame capture over the running Local VM, the spawned MCP
// bridge contract, the transparent setup commands, and the shared
// ComputerBackend adapter for the container arm.

import type { ContainerComputerBackend } from "../computer-backend.ts";
import { SPAWNED_PROXIES } from "../proxy-paths.ts";
import { BASE_IMAGE, CUA_SOCKET, SHARED_LOCAL_VM_TARGET, type LocalVmTarget } from "./image.ts";
import { containerRunArgs } from "./hardening.ts";
import { containerComputerAction } from "./lifecycle.ts";
import { sh, type CommandRunner, type Runtime } from "./runtime.ts";
import { SCREENSHOT_STATUS_TTL_MS, screenshotStatusCache } from "./screenshot-cache.ts";
import { cuaExecArgs, containerComputerStatus, wholeScreenshot } from "./status.ts";

/** The raw frame, in the shape the live screen poller broadcasts to every
 * client (server/index.ts). The web panel wants a data URL instead, so
 * containerComputerScreenshot below wraps this one. */
export async function containerComputerFrame(
  runner: CommandRunner = sh,
  platform: NodeJS.Platform = process.platform,
  target: LocalVmTarget = SHARED_LOCAL_VM_TARGET,
): Promise<{ png: string; format: "png" | "jpeg" }> {
  const cacheable = runner === sh && platform === process.platform;
  const now = Date.now();
  const cached = screenshotStatusCache.get(target.key);
  const status =
    cacheable && cached && cached.expiresAt > now
      ? cached.status
      : await containerComputerStatus(runner, platform, target);
  if (!status.ready || !status.runtime) {
    if (cacheable) screenshotStatusCache.delete(target.key);
    throw Object.assign(new Error(status.problem ?? "The Local VM is not ready"), { status: 409 });
  }
  if (cacheable) screenshotStatusCache.set(target.key, { status, expiresAt: now + SCREENSHOT_STATUS_TTL_MS });
  try {
    const screenshot = "/tmp/openmausbot-preview.png";
    await runner(
      status.runtime,
      cuaExecArgs([
        "call",
        "get_desktop_state",
        "{}",
        "--socket",
        CUA_SOCKET,
        "--screenshot-out-file",
        screenshot,
      ], { container: target.containerName }),
      30_000,
    );
    const { stdout } = await runner(
      status.runtime,
      ["exec", target.containerName, "base64", "-w0", screenshot],
      30_000,
    );
    const data = stdout.trim();
    const checked = wholeScreenshot(Buffer.from(data, "base64"));
    if (!checked.ok) {
      throw Object.assign(new Error("Cua Driver returned an incomplete screenshot"), { status: 502 });
    }
    return { png: data, format: checked.mime === "image/jpeg" ? "jpeg" : "png" };
  } catch (error) {
    if (cacheable) screenshotStatusCache.delete(target.key);
    throw error;
  }
}

export async function containerComputerScreenshot(
  runner: CommandRunner = sh,
  platform: NodeJS.Platform = process.platform,
  target: LocalVmTarget = SHARED_LOCAL_VM_TARGET,
): Promise<string> {
  const { png, format } = await containerComputerFrame(runner, platform, target);
  return `data:image/${format};base64,${png}`;
}

const containerMcpPath = SPAWNED_PROXIES.containerMcp;

/** Spawn contract handed directly to agent runtimes. The tiny host wrapper
 * only preserves stdio through the container CLI; Cua Driver owns the MCP
 * protocol and every computer tool. */
type ContainerMcpLaunch = {
  command: string;
  args: string[];
  env: Record<string, string>;
};

export function containerComputerMcp(
  runtime: Runtime,
  control?: { url: string; token: string },
  target: LocalVmTarget = SHARED_LOCAL_VM_TARGET,
): ContainerMcpLaunch {
  return {
    command: process.execPath,
    args: [containerMcpPath, runtime, target.containerName, CUA_SOCKET],
    // The control pair rides in env, not argv — argv is world-readable
    // through `ps` for the life of the bridge.
    env: {
      ELECTRON_RUN_AS_NODE: "1",
      ...(control ? { OMB_CONTROL_URL: control.url, OMB_CONTROL_TOKEN: control.token } : {}),
    },
  };
}

/** Commands shown as a transparent fallback. Normal setup builds the pinned
 * derivative through the API, so users do not need to author a Dockerfile. */
export function setupCommands(
  runtime: Runtime | null,
  platform: NodeJS.Platform = process.platform,
  target: LocalVmTarget = SHARED_LOCAL_VM_TARGET,
) {
  const install =
    platform === "darwin"
      ? "brew install podman; podman machine init; podman machine start"
      : platform === "win32"
        ? "winget install -e --id RedHat.Podman-Desktop"
        : null;
  const runtimeStart =
    runtime === "container"
      ? "container system start"
      : runtime === "podman" && platform !== "linux"
        ? "podman machine init; podman machine start"
        : runtime === "docker" && platform === "darwin"
          ? "colima start || open -a Docker"
          : runtime === "docker" && platform === "linux"
            ? "sudo systemctl start docker"
            : null;

  if (!runtime) {
    return {
      install,
      runtimeStart: null,
      pull: null,
      run: null,
      start: null,
      stop: null,
      remove: null,
      view: target.viewerPort ? `http://127.0.0.1:${target.viewerPort}/vnc.html` : "",
    };
  }
  const command = (args: string[]) => [runtime, ...args].join(" ");
  return {
    install,
    runtimeStart,
    // This is the inspectable base download. The normal Prepare button also
    // builds the checksum-pinned 0.20.0 derivative automatically.
    pull: command(["pull", BASE_IMAGE]),
    run:
      runtime === "container" && target.key !== SHARED_LOCAL_VM_TARGET.key
        ? null
        : command(containerRunArgs(runtime, "CHANGE_ME", target)),
    start: null,
    stop: command(["stop", target.containerName]),
    remove: command(["rm", runtime === "container" ? "--force" : "-f", target.containerName]),
    view: target.viewerPort ? `http://127.0.0.1:${target.viewerPort}/vnc.html` : "",
  };
}

/** The Local VM arm of the shared ComputerBackend dispatch
 * (computer-backend.ts). The module's functions already carry the target-
 * scoped signatures callers need, so this is an identity adapter. */
export const containerComputerBackend: ContainerComputerBackend = {
  kind: "container",
  status: containerComputerStatus,
  action: containerComputerAction,
  screenshot: containerComputerScreenshot,
  mcp: containerComputerMcp,
};
