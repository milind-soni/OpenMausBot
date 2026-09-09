import { describe, expect, it, vi } from "vitest";

import {
  BASE_IMAGE,
  BASE_IMAGE_DIGEST,
  BASE_IMAGE_LABEL,
  CUA_DRIVER_VERSION,
  DRIVER_LABEL,
  DISPLAY,
  IMAGE_LAYER_LABEL,
  IMAGE_LAYER_VERSION,
  MANAGED_LABEL,
} from "./container-computer.ts";
import type { AppConfig } from "./config.ts";
import {
  VPS_CONTAINER_LABEL,
  VPS_ENVIRONMENT_LABEL,
  VPS_IMAGE,
  VPS_MANAGED_LABEL,
  VPS_VIEWER_LABEL,
  vpsComputerAction,
  vpsComputerScreenshot,
  vpsComputerStatus,
  vpsComputerMcp,
  vpsContainerMcpArgs,
  vpsContainerName,
  vpsContainerRunArgs,
  vpsDockerArgs,
  vpsDriverError,
  vpsSshTunnelArgs,
  reuseVps,
  type VpsCommandRunner,
} from "./vps-computer.ts";

const BOT_ID = "bot-1234-abcd";
const CONFIG: AppConfig = { vps: { sshAlias: "production-vps" } };
const IMAGE_ID = `sha256:${"a".repeat(64)}`;
const CONTAINER_ID = "b".repeat(64);
const screenshot = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(600),
  Buffer.from("IEND", "ascii"),
]);

function fixture({
  image = true,
  container = true,
  running = true,
  managed = true,
  mounts = false,
  publicPorts = false,
  publishAllPorts = false,
  deviceRequests = false,
  networkMode = "default",
  containerImageId = IMAGE_ID,
  inspectedImageId = IMAGE_ID,
  rebuiltImageId,
  containerId = CONTAINER_ID,
  privileged = false,
  pidMode = "",
  ipcMode,
  capAdd = ["CAP_SETUID", "CAP_SETGID"],
  screenshotValid = true,
  screenshotCaptureFails = false,
  desktopProbeFails = false,
  securityOpt = [],
  memory = 4 * 1024 * 1024 * 1024,
  restartPolicyName = "unless-stopped",
  cgroupnsMode,
  imageLabelsMatch = true,
  environmentId = null,
}: {
  image?: boolean;
  container?: boolean;
  running?: boolean;
  managed?: boolean;
  mounts?: boolean;
  publicPorts?: boolean;
  publishAllPorts?: boolean;
  deviceRequests?: boolean;
  networkMode?: string;
  containerImageId?: string;
  inspectedImageId?: string;
  rebuiltImageId?: string;
  containerId?: string;
  privileged?: boolean;
  pidMode?: string;
  ipcMode?: string;
  capAdd?: string[];
  screenshotValid?: boolean;
  screenshotCaptureFails?: boolean;
  desktopProbeFails?: boolean;
  securityOpt?: string[];
  memory?: number;
  restartPolicyName?: string;
  cgroupnsMode?: string;
  imageLabelsMatch?: boolean;
  environmentId?: string | null;
} = {}) {
  const name = vpsContainerName(BOT_ID);
  const provisioningArgs = vpsContainerRunArgs(name);
  const argValue = (flag: string) => {
    const index = provisioningArgs.indexOf(flag);
    if (index >= 0) return provisioningArgs[index + 1] ?? "";
    return provisioningArgs.find((arg) => arg.startsWith(`${flag}=`))?.slice(flag.length + 1) ?? "";
  };
  const calls: Array<{ args: string[]; options?: { input?: string; timeoutMs?: number } }> = [];
  const state = { image, container, running, imageLabelsMatch, inspectedImageId, containerImageId };
  const runner: VpsCommandRunner = async (args, options) => {
    calls.push({ args, options });
    const command = args[2];
    if (command === "image") {
      // The real daemon phrases a clean absence this way; anything else is
      // read as a transport failure, exactly like production.
      if (!state.image) throw new Error(`Error: No such image: ${VPS_IMAGE}`);
      return {
        stdout: JSON.stringify([{
          Config: { Labels: state.imageLabelsMatch ? {
             [MANAGED_LABEL]: "1",
             [DRIVER_LABEL]: CUA_DRIVER_VERSION,
             [BASE_IMAGE_LABEL]: BASE_IMAGE_DIGEST,
             [IMAGE_LAYER_LABEL]: IMAGE_LAYER_VERSION,
          } : { [MANAGED_LABEL]: "0" } },
          Id: state.inspectedImageId,
        }]),
        stderr: "",
      };
    }
    if (command === "inspect") {
      if (!state.container) throw new Error(`Error: No such object: ${name}`);
      return {
        stdout: JSON.stringify([{
          Config: {
            Image: state.image ? VPS_IMAGE : "old-image",
            Env: [`VNC_PW=${argValue("VNC_PW") || "viewer-secret"}`],
            Labels: {
              [VPS_MANAGED_LABEL]: managed ? "1" : "0",
              [VPS_CONTAINER_LABEL]: managed ? name : "other-container",
              [MANAGED_LABEL]: "1",
              [DRIVER_LABEL]: CUA_DRIVER_VERSION,
              [BASE_IMAGE_LABEL]: BASE_IMAGE_DIGEST,
              [IMAGE_LAYER_LABEL]: IMAGE_LAYER_VERSION,
              [VPS_VIEWER_LABEL]: "1",
              ...(environmentId ? { [VPS_ENVIRONMENT_LABEL]: environmentId } : {}),
            },
          },
           Id: containerId,
          Image: state.image ? state.containerImageId : "old-image-id",
          HostConfig: {
            Binds: mounts ? ["/host:/container"] : [],
            VolumesFrom: [],
            NetworkMode: networkMode,
            PortBindings: publicPorts ? { "6901/tcp": [{ HostIp: "0.0.0.0" }] } : {},
            PublishAllPorts: publishAllPorts,
            Memory: memory,
            MemorySwap: 4 * 1024 * 1024 * 1024,
            NanoCpus: 2_000_000_000,
            PidsLimit: 512,
            CapDrop: ["ALL"],
            CapAdd: capAdd,
            Privileged: privileged,
            PidMode: pidMode,
            IpcMode: ipcMode ?? argValue("--ipc"),
            UTSMode: "",
            ShmSize: 512 * 1024 * 1024,
            Devices: [],
            DeviceRequests: deviceRequests ? [{ Driver: "nvidia" }] : [],
            SecurityOpt: securityOpt,
            UsernsMode: "",
            CgroupnsMode: cgroupnsMode ?? argValue("--cgroupns"),
            OomKillDisable: false,
            AutoRemove: false,
            RestartPolicy: { Name: restartPolicyName, MaximumRetryCount: 0 },
          },
          NetworkSettings: {
            Networks: { [networkMode === "default" ? "bridge" : networkMode]: { IPAddress: "172.17.0.5" } },
          },
          Mounts: mounts ? [{ Source: "/host", Destination: "/container" }] : [],
          State: { Running: state.running },
        }]),
        stderr: "",
      };
    }
    if (command === "exec") {
      // only the pixel-carrying screenshot call fails; the status path's
      // plain get_desktop_state readiness probe keeps answering
      if (screenshotCaptureFails && args.includes("--screenshot-out-file")) throw new Error("capture failed");
      if (args.includes("base64")) return { stdout: screenshotValid ? screenshot.toString("base64") : "not-an-image", stderr: "" };
      if (args.includes("tail")) {
        return { stdout: "X display :1 did not become ready within 45 seconds\n", stderr: "" };
      }
      if (args.at(-1) === "--version") {
        if (desktopProbeFails) throw new Error("driver unavailable");
        return { stdout: `cua-driver ${CUA_DRIVER_VERSION}\n`, stderr: "" };
      }
      if (args.includes("status")) return { stdout: "running\n", stderr: "" };
      if (args.includes("health_report")) {
        return { stdout: JSON.stringify({ schema_version: "1", overall: "ok", checks: [] }), stderr: "" };
      }
      if (args.includes("get_desktop_state")) return { stdout: "{}\n", stderr: "" };
      return { stdout: "{}\n", stderr: "" };
    }
    if (command === "pull") return { stdout: "pulled\n", stderr: "" };
    if (command === "build") {
      state.image = true;
      state.imageLabelsMatch = true;
      state.inspectedImageId = rebuiltImageId ?? state.inspectedImageId;
      expect(options?.input).toContain(`FROM ${BASE_IMAGE}`);
      return { stdout: "built\n", stderr: "" };
    }
    if (command === "run") {
      state.container = true;
      state.running = true;
      // a fresh container is created FROM the image ref in the run argv
      state.containerImageId = args.at(-1) ?? state.containerImageId;
      return { stdout: `${name}\n`, stderr: "" };
    }
    if (command === "start") {
      state.running = true;
      return { stdout: `${name}\n`, stderr: "" };
    }
    if (command === "stop") {
      state.running = false;
      return { stdout: `${name}\n`, stderr: "" };
    }
    if (command === "rm") {
      state.container = false;
      state.running = false;
      return { stdout: `${name}\n`, stderr: "" };
    }
    throw new Error(`unexpected Docker command ${command}`);
  };
  return { calls, runner, state, name };
}

describe("VPS computer", () => {
  it("uses a deterministic, bot-id-derived managed container name", () => {
    expect(vpsContainerName(BOT_ID)).toBe(vpsContainerName(BOT_ID));
    expect(vpsContainerName(BOT_ID)).not.toBe(vpsContainerName("another-bot"));
    expect(vpsContainerName(BOT_ID)).toMatch(/^openmausbot-vps-[a-z0-9-]+$/);
  });

  it("passes the SSH target as one validated Docker argv value", () => {
    expect(vpsDockerArgs("production-vps", ["info"])).toEqual(["-H", "ssh://production-vps", "info"]);
    for (const alias of ["production-vps;touch", "ssh://production-vps", "-H", "--host=evil", "prod vps", "prod\n-v"] ) {
      expect(() => vpsDockerArgs(alias, ["info"])).toThrow(/alias/);
    }
    expect(() => vpsContainerMcpArgs("production-vps", "not a container")).toThrow(/connection/);
  });

  it("keeps the live desktop behind a validated loopback SSH forward", () => {
    const args = vpsSshTunnelArgs("production-vps", 45678, "172.17.0.5");
    expect(args).toContain("127.0.0.1:45678:172.17.0.5:6901");
    expect(args.at(-1)).toBe("production-vps");
    expect(args).toContain("ExitOnForwardFailure=yes");
    expect(() => vpsSshTunnelArgs("production-vps", 80, "172.17.0.5")).toThrow(/port/);
    expect(() => vpsSshTunnelArgs("production-vps", 45678, "203.0.113.8")).toThrow(/private/);
  });

  it("reports a ready container only when image, labels, limits, mounts, network, and Cua pass", async () => {
    const fake = fixture();
    const status = await vpsComputerStatus(CONFIG, BOT_ID, fake.runner);
    expect(status).toMatchObject({
      configured: true,
      daemonUp: true,
      image: true,
      imageMatches: true,
      managed: true,
      network: "private",
      mounts: "none",
      security: "hardened",
      desktopReady: true,
      ready: true,
      problem: null,
    });
    // No standalone `docker info` round-trip: the image inspect doubles as
    // the daemon probe, so a healthy status costs 2 docker calls + 4 execs.
    expect(fake.calls[0]?.args).toEqual(["-H", "ssh://production-vps", "image", "inspect", VPS_IMAGE]);
    expect(fake.calls.some(({ args }) => args[2] === "info")).toBe(false);
    const probes = fake.calls.filter(
      ({ args }) =>
        args[2] === "exec" &&
        (args.at(-1) === "--version" || args.includes("status") || args.includes("health_report") || args.includes("get_desktop_state")),
    );
    expect(probes).toHaveLength(4);
    expect(probes.every(({ args }) => args.includes(CONTAINER_ID))).toBe(true);
    expect(probes.every(({ args }) => !args.includes(fake.name))).toBe(true);
    expect(probes.every(({ args }) => args.includes(`DISPLAY=${DISPLAY}`))).toBe(true);
    expect(probes.every(({ args }) => args.includes("CUA_DRIVER_RS_TELEMETRY_ENABLED=0"))).toBe(true);
    // The status poll must never transfer pixels: readiness is the driver
    // answering get_desktop_state, and pixel validation belongs to the
    // screenshot path alone.
    expect(fake.calls.some(({ args }) => args.includes("base64"))).toBe(false);
    expect(fake.calls.some(({ args }) => args.includes("--screenshot-out-file"))).toBe(false);
  });

  it("refuses host mounts, public ports, and unowned containers", async () => {
    const mounted = await vpsComputerStatus(CONFIG, BOT_ID, fixture({ mounts: true }).runner);
    expect(mounted.ready).toBe(false);
    expect(mounted.mounts).toBe("unsafe");

    const publicPorts = await vpsComputerStatus(CONFIG, BOT_ID, fixture({ publicPorts: true }).runner);
    expect(publicPorts.ready).toBe(false);
    expect(publicPorts.network).toBe("unsafe");

    const publishedAll = await vpsComputerStatus(CONFIG, BOT_ID, fixture({ publishAllPorts: true }).runner);
    expect(publishedAll.ready).toBe(false);
    expect(publishedAll.network).toBe("unsafe");

    const devices = await vpsComputerStatus(CONFIG, BOT_ID, fixture({ deviceRequests: true }).runner);
    expect(devices.ready).toBe(false);
    expect(devices.security).toBe("unsafe");

    const sharedNetwork = await vpsComputerStatus(CONFIG, BOT_ID, fixture({ networkMode: "shared-net" }).runner);
    expect(sharedNetwork.ready).toBe(false);
    expect(sharedNetwork.network).toBe("unsafe");

    const hostNetwork = await vpsComputerStatus(CONFIG, BOT_ID, fixture({ networkMode: "host" }).runner);
    expect(hostNetwork.ready).toBe(false);
    expect(hostNetwork.network).toBe("unsafe");

    const privileged = await vpsComputerStatus(CONFIG, BOT_ID, fixture({ privileged: true }).runner);
    expect(privileged.ready).toBe(false);
    expect(privileged.security).toBe("unsafe");

    const hostNamespaces = await vpsComputerStatus(
      CONFIG,
      BOT_ID,
      fixture({ pidMode: "host", ipcMode: "host" }).runner,
    );
    expect(hostNamespaces.ready).toBe(false);
    expect(hostNamespaces.security).toBe("unsafe");

    const extraCapability = await vpsComputerStatus(
      CONFIG,
      BOT_ID,
      fixture({ capAdd: ["CAP_SETUID", "CAP_SETGID", "CAP_SYS_ADMIN"] }).runner,
    );
    expect(extraCapability.ready).toBe(false);
    expect(extraCapability.security).toBe("unsafe");

    const unsafeProfile = await vpsComputerStatus(
      CONFIG,
      BOT_ID,
      fixture({ securityOpt: ["seccomp=unconfined"], memory: 1024, restartPolicyName: "always", cgroupnsMode: "host" }).runner,
    );
    expect(unsafeProfile.ready).toBe(false);
    expect(unsafeProfile.security).toBe("unsafe");

    // the VPS container must survive an unwatched reboot: exactly
    // unless-stopped, so a policy-less container is flagged for recreation
    const noRestart = await vpsComputerStatus(CONFIG, BOT_ID, fixture({ restartPolicyName: "no" }).runner);
    expect(noRestart.ready).toBe(false);
    expect(noRestart.security).toBe("unsafe");

    const wrongImage = await vpsComputerStatus(CONFIG, BOT_ID, fixture({ containerImageId: "c".repeat(64) }).runner);
    expect(wrongImage.ready).toBe(false);
    expect(wrongImage.imageMatches).toBe(false);

    const malformedImageId = await vpsComputerStatus(CONFIG, BOT_ID, fixture({ inspectedImageId: "--help" }).runner);
    expect(malformedImageId.ready).toBe(false);
    expect(malformedImageId.image).toBe(false);

    const malformedContainerId = await vpsComputerStatus(CONFIG, BOT_ID, fixture({ containerId: "--help" }).runner);
    expect(malformedContainerId.ready).toBe(false);
    expect(malformedContainerId.container_id).toBeNull();

    const unowned = await vpsComputerStatus(CONFIG, BOT_ID, fixture({ managed: false }).runner);
    expect(unowned.ready).toBe(false);
    expect(unowned.managed).toBe(false);
  });

  it("lets explicit provisioning build and run the pinned container, but Auto only reuses", async () => {
    const auto = fixture({ image: false, container: false });
    expect(await reuseVps(CONFIG, BOT_ID, auto.runner)).toBeNull();
    expect(auto.calls.some(({ args }) => ["run", "start", "build", "pull"].includes(args[2]!))).toBe(false);

    const provision = fixture({ image: false, container: false });
    const status = await vpsComputerAction("provision", CONFIG, BOT_ID, provision.runner);
    expect(status.ready).toBe(true);
    const run = provision.calls.find(({ args }) => args[2] === "run")?.args ?? [];
    expect(run).toContain("--memory");
    expect(run).toContain("--pids-limit");
    expect(run).toContain("--ipc");
    expect(run[run.indexOf("--ipc") + 1]).toBe("private");
    expect(run).toContain("--cgroupns");
    expect(run[run.indexOf("--cgroupns") + 1]).toBe("private");
    expect(run.at(-1)).toBe(IMAGE_ID);
    expect(run.join(" ")).toContain(`--label ${VPS_MANAGED_LABEL}=1`);
    expect(run.find((arg) => arg.startsWith(`${VPS_ENVIRONMENT_LABEL}=`)))
      .toMatch(/^com\.openmausbot\.environment=[0-9a-f-]{36}$/i);
    expect(run.join(" ")).toContain(`--label ${IMAGE_LAYER_LABEL}=${IMAGE_LAYER_VERSION}`);
    expect(run.join(" ")).toContain(`--label ${VPS_VIEWER_LABEL}=1`);
    expect(run.join(" ")).toContain("--restart unless-stopped");
    expect(run).toContain("-e");
    expect(run.some((arg) => /^VNC_PW=[A-Za-z0-9_-]{8,}$/.test(arg))).toBe(true);
    expect(run).not.toContain("--mount");
    expect(run).not.toContain("-p");
    expect(provision.calls.some(({ args }) => args[2] === "build")).toBe(true);
  });

  it("uses the image id produced by a rebuild", async () => {
    const staleImageId = `sha256:${"b".repeat(64)}`;
    const provision = fixture({
      image: true,
      imageLabelsMatch: false,
      container: false,
      inspectedImageId: staleImageId,
      rebuiltImageId: IMAGE_ID,
    });

    const status = await vpsComputerAction("provision", CONFIG, BOT_ID, provision.runner);
    expect(status.ready).toBe(true);
    const run = provision.calls.find(({ args }) => args[2] === "run")?.args ?? [];
    expect(run.at(-1)).toBe(IMAGE_ID);
    expect(run.at(-1)).not.toBe(staleImageId);
  });

  it("starts and sleeps only the managed container, never the VPS", async () => {
    const start = fixture({ running: false });
    const started = await vpsComputerAction("start", CONFIG, BOT_ID, start.runner);
    expect(started.container).toBe("running");
    expect(start.calls.some(({ args }) => args[2] === "start")).toBe(true);
    expect(start.calls.some(({ args }) => ["rm", "system", "reboot", "shutdown"].includes(args[2]!))).toBe(false);

    const stop = fixture();
    const stopped = await vpsComputerAction("stop", CONFIG, BOT_ID, stop.runner);
    expect(stopped.container).toBe("stopped");
    expect(stop.calls.some(({ args }) => args[2] === "stop" && args[3] === CONTAINER_ID)).toBe(true);
    expect(stop.calls.some(({ args }) => ["rm", "system", "reboot", "shutdown"].includes(args[2]!))).toBe(false);
  });

  it("serializes concurrent provisioning for the same bot", async () => {
    const fake = fixture({ image: false, container: false });
    const results = await Promise.all([
      vpsComputerAction("provision", CONFIG, BOT_ID, fake.runner),
      vpsComputerAction("provision", CONFIG, BOT_ID, fake.runner),
    ]);
    expect(results.every((status) => status.ready)).toBe(true);
    expect(fake.calls.filter(({ args }) => args[2] === "run")).toHaveLength(1);
  });

  it("keeps provisioning and readiness checks on the alias captured at operation start", async () => {
    const fake = fixture({ container: false });
    const config: AppConfig = { vps: { sshAlias: "original-vps" } };
    const runner: VpsCommandRunner = async (args, options) => {
      const result = await fake.runner(args, options);
      if (args[2] === "run") config.vps!.sshAlias = "replacement-vps";
      return result;
    };

    expect((await vpsComputerAction("provision", config, BOT_ID, runner)).ready).toBe(true);
    expect(fake.calls.some(({ args }) => args[2] === "run")).toBe(true);
    expect(fake.calls.every(({ args }) => args[1] === "ssh://original-vps")).toBe(true);
  });

  it("mounts the official Cua MCP server through the tiny remote exec bridge", () => {
    const connection = vpsComputerMcp(CONFIG, BOT_ID);
    expect(connection.command).toBe(process.execPath);
    expect(connection.args.slice(-2)).toEqual(["production-vps", vpsContainerName(BOT_ID)]);
    expect(connection.env).toEqual({ ELECTRON_RUN_AS_NODE: "1" });
    expect(vpsComputerMcp(CONFIG, BOT_ID, CONTAINER_ID).args.slice(-2)).toEqual(["production-vps", CONTAINER_ID]);
    expect(vpsContainerMcpArgs("production-vps", vpsContainerName(BOT_ID))).toEqual([
      "-H",
      "ssh://production-vps",
      "exec",
      "-i",
      "-u",
      "cua",
      "-e",
      "HOME=/home/cua",
      "-e",
      "DISPLAY=:1",
      "-e",
      "CUA_DRIVER_INSTALL_CHANNEL=python_package",
      "-e",
      "CUA_DRIVER_RS_TELEMETRY_ENABLED=0",
      vpsContainerName(BOT_ID),
      "/usr/local/libexec/openmausbot/cua-driver",
      "mcp",
      "--socket",
      "/run/user/1000/openmausbot-cua.sock",
    ]);
  });

  it("captures screenshots through Cua Driver and validates the returned image", async () => {
    const fake = fixture();
    const frame = await vpsComputerScreenshot(CONFIG, BOT_ID, fake.runner);
    expect(frame).toEqual({ png: screenshot.toString("base64"), format: "png" });
    expect(fake.calls.some(({ args }) => args.includes("get_desktop_state"))).toBe(true);
    expect(fake.calls.some(({ args }) => args.includes("base64") && args.includes("-u") && args.includes("cua"))).toBe(true);
    expect(fake.calls.some(({ args }) => args.includes("rm") && args.includes("-f"))).toBe(true);

    await expect(vpsComputerScreenshot(CONFIG, BOT_ID, fixture({ screenshotValid: false }).runner)).rejects.toThrow(/incomplete/);

    const failedCapture = fixture({ screenshotCaptureFails: true });
    await expect(vpsComputerScreenshot(CONFIG, BOT_ID, failedCapture.runner)).rejects.toThrow(/capture failed/);
    expect(failedCapture.calls.some(({ args }) => args.includes("rm") && args.includes("-f"))).toBe(true);
  });

  it("fails clearly for BoxAgent and engines without computer MCP", () => {
    expect(vpsDriverError("boxAgent", true)).toMatch(/cannot use a self-hosted VPS/);
    expect(vpsDriverError("codex", false)).toMatch(/cannot mount/);
    expect(vpsDriverError("claudeAgent", true)).toBeNull();
  });

  it("fails cleanly when no VPS alias is configured", async () => {
    await expect(vpsComputerAction("provision", {}, BOT_ID, fixture().runner)).rejects.toThrow(/not configured/);
  });

  it("attributes a transport failure to the link, never to a missing container", async () => {
    const fake = fixture();
    const flaky: VpsCommandRunner = async (args, options) => {
      if (args[2] === "inspect") throw new Error("ssh: connect to host production-vps port 22: Connection timed out");
      return fake.runner(args, options);
    };
    const status = await vpsComputerStatus(CONFIG, BOT_ID, flaky);
    expect(status.daemonUp).toBe(false);
    expect(status.ready).toBe(false);
    expect(status.problem).toMatch(/Docker over SSH failed while checking the VPS/);

    // and provision must refuse to `docker run --name <existing>` into the fog
    await expect(vpsComputerAction("provision", CONFIG, BOT_ID, flaky)).rejects.toThrow(/Docker over SSH failed/);
    expect(fake.calls.some(({ args }) => args[2] === "run")).toBe(false);

    const imageFlaky: VpsCommandRunner = async (args, options) => {
      if (args[2] === "image") throw new Error("kex_exchange_identification: read: Connection reset by peer");
      return fake.runner(args, options);
    };
    const imageStatus = await vpsComputerStatus(CONFIG, BOT_ID, imageFlaky);
    expect(imageStatus.daemonUp).toBe(false);
    expect(imageStatus.problem).toMatch(/Docker over SSH failed while checking the VPS/);
  });

  it("removes a managed container even when its image is incompatible, then provisions fresh", async () => {
    // an IMAGE_LAYER_VERSION bump leaves a running container that provision
    // refuses to touch — remove is the in-app escape hatch
    const stale = fixture({ containerImageId: `sha256:${"c".repeat(64)}` });
    expect((await vpsComputerStatus(CONFIG, BOT_ID, stale.runner)).imageMatches).toBe(false);
    await expect(vpsComputerAction("provision", CONFIG, BOT_ID, stale.runner)).rejects.toThrow(/incompatible|unsafe/);

    const removed = await vpsComputerAction("remove", CONFIG, BOT_ID, stale.runner);
    expect(removed.container).toBe("missing");
    expect(stale.calls.some(({ args }) => args[2] === "rm" && args[3] === "-f" && args[4] === CONTAINER_ID)).toBe(true);

    const rebuilt = await vpsComputerAction("provision", CONFIG, BOT_ID, stale.runner);
    expect(rebuilt.ready).toBe(true);
  });

  it("never removes a container OpenMausBot did not create", async () => {
    const unowned = fixture({ managed: false });
    await expect(vpsComputerAction("remove", CONFIG, BOT_ID, unowned.runner)).rejects.toThrow(/did not create/);
    expect(unowned.calls.some(({ args }) => args[2] === "rm")).toBe(false);

    const foreign = fixture({ environmentId: "11111111-2222-4333-8444-555555555555" });
    expect((await vpsComputerStatus(CONFIG, BOT_ID, foreign.runner)).managed).toBe(false);
    await expect(vpsComputerAction("remove", CONFIG, BOT_ID, foreign.runner)).rejects.toThrow(/did not create/);
    expect(foreign.calls.some(({ args }) => args[2] === "rm")).toBe(false);

    const absent = fixture({ container: false });
    const afterMissing = await vpsComputerAction("remove", CONFIG, BOT_ID, absent.runner);
    expect(afterMissing.container).toBe("missing");
    expect(absent.calls.some(({ args }) => args[2] === "rm")).toBe(false);
  });

  it("surfaces the supervisor error log when the desktop probe fails", async () => {
    const fake = fixture({ desktopProbeFails: true });
    const status = await vpsComputerStatus(CONFIG, BOT_ID, fake.runner);
    expect(status.desktopReady).toBe(false);
    expect(status.desktop_error).toContain("did not become ready");
    expect(status.problem).toContain("desktop failed to start");
    expect(fake.calls.some(({ args }) => args[2] === "exec" && args.includes("tail"))).toBe(true);
  });

  it("waits for readiness with a cheap driver probe and backoff, not full re-inspections", async () => {
    vi.useFakeTimers();
    try {
      const fake = fixture({ container: false });
      let driverProbes = 0;
      const runner: VpsCommandRunner = async (args, options) => {
        if (args[2] === "exec" && args.includes("status")) {
          driverProbes += 1;
          if (driverProbes < 4) throw new Error("driver not up yet");
        }
        return fake.runner(args, options);
      };
      const pending = vpsComputerAction("provision", CONFIG, BOT_ID, runner);
      await vi.advanceTimersByTimeAsync(10_000);
      const status = await pending;
      expect(status.ready).toBe(true);
      // the expensive end of the pipeline ran exactly once — every retry in
      // between was the single `cua-driver status` predicate
      const desktopCalls = fake.calls.filter(({ args }) => args.includes("get_desktop_state"));
      expect(desktopCalls).toHaveLength(1);
      const healthCalls = fake.calls.filter(({ args }) => args.includes("health_report"));
      expect(healthCalls).toHaveLength(1);
      expect(driverProbes).toBeGreaterThanOrEqual(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails lifecycle calls fast instead of queueing behind a long provision", async () => {
    vi.useFakeTimers();
    try {
      let releaseBuild!: () => void;
      const buildGate = new Promise<void>((resolve) => {
        releaseBuild = resolve;
      });
      const fake = fixture({ image: false, container: false });
      const slowRunner: VpsCommandRunner = async (args, options) => {
        if (args[2] === "build") await buildGate;
        return fake.runner(args, options);
      };
      const first = vpsComputerAction("provision", CONFIG, BOT_ID, slowRunner);
      // let the first action reach its (gated) docker build
      await vi.advanceTimersByTimeAsync(0);
      const second = vpsComputerAction("stop", CONFIG, BOT_ID, slowRunner);
      const rejection = expect(second).rejects.toThrow(/being prepared/);
      await vi.advanceTimersByTimeAsync(5_000);
      await rejection;

      releaseBuild();
      await vi.advanceTimersByTimeAsync(10_000);
      const status = await first;
      expect(status.ready).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
