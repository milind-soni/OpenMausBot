import { describe, expect, it } from "vitest";

import {
  BASE_IMAGE,
  BASE_IMAGE_DIGEST,
  BASE_IMAGE_LABEL,
  CONTAINER,
  CUA_DRIVER_VERSION,
  CUA_EXECUTABLE,
  CUA_SOCKET,
  DRIVER_LABEL,
  IMAGE,
  IMAGE_LAYER_LABEL,
  IMAGE_LAYER_VERSION,
  MANAGED_LABEL,
  TARGET_LABEL,
  VM_WORKSPACE_DIR,
  VM_WORKSPACE_GUEST,
  WORKSPACE_LABEL,
  computerProxyEnv,
  containerComputerAction,
  containerComputerFrame,
  containerComputerMcp,
  containerComputerScreenshot,
  containerComputerStatus,
  containerRuntimeStatus,
  containerRunArgs,
  localVmRecreatableOnDemand,
  managedImageDockerfile,
  perBotLocalVmTarget,
  podmanSecurityIsHardened,
  SHARED_LOCAL_VM_TARGET,
  setupCommands,
  type CommandRunner,
  type LocalVmTarget,
} from "./container-computer.ts";

function runner(responses: Record<string, string | Error>) {
  const calls: string[] = [];
  const run: CommandRunner = async (command, args) => {
    const key = [command, ...args].join(" ");
    calls.push(key);
    const response = responses[key];
    if (response instanceof Error || response === undefined) {
      throw response ?? new Error(`unexpected command: ${key}`);
    }
    return { stdout: response };
  };
  return { calls, run };
}

const driverExec =
  `docker exec -u cua -e HOME=/home/cua -e DISPLAY=:1 -e CUA_DRIVER_INSTALL_CHANNEL=python_package ` +
  `-e CUA_DRIVER_RS_TELEMETRY_ENABLED=0 ${CONTAINER} ${CUA_EXECUTABLE}`;
const versionProbe = `${driverExec} --version`;
const statusProbe = `${driverExec} status --socket ${CUA_SOCKET}`;
const healthProbe = `${driverExec} call health_report {} --socket ${CUA_SOCKET}`;
const readinessProbe =
  `${driverExec} call get_desktop_state {} --socket ${CUA_SOCKET} ` +
  "--screenshot-out-file /tmp/openmausbot-readiness.png";
const readinessRead = `docker exec ${CONTAINER} base64 -w0 /tmp/openmausbot-readiness.png`;
const validPng = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(600),
  Buffer.from("IEND", "ascii"),
]);

function preparedImageInspect() {
  return JSON.stringify([
    {
      Id: "sha256:managed-image-id",
      Config: {
        Labels: {
          [MANAGED_LABEL]: "1",
          [DRIVER_LABEL]: CUA_DRIVER_VERSION,
          [BASE_IMAGE_LABEL]: BASE_IMAGE_DIGEST,
          [IMAGE_LAYER_LABEL]: IMAGE_LAYER_VERSION,
        },
      },
    },
  ]);
}

function readyInspect(overrides: Record<string, unknown> = {}) {
  return JSON.stringify([
    {
      Config: {
        Image: IMAGE,
        Labels: {
          [MANAGED_LABEL]: "1",
          [DRIVER_LABEL]: CUA_DRIVER_VERSION,
          [BASE_IMAGE_LABEL]: BASE_IMAGE_DIGEST,
          [IMAGE_LAYER_LABEL]: IMAGE_LAYER_VERSION,
          [WORKSPACE_LABEL]: "1",
        },
        Env: ["VNC_PW=secret123"],
      },
      State: { Running: true },
      Image: "sha256:managed-image-id",
      // the full hardened HostConfig the stricter shared check now demands:
      // unprivileged, private IPC/cgroup namespaces, pinned shm, no devices
      HostConfig: {
        Memory: 4 * 1024 * 1024 * 1024,
        MemorySwap: 4 * 1024 * 1024 * 1024,
        NanoCpus: 2_000_000_000,
        PidsLimit: 512,
        CapDrop: ["ALL"],
        CapAdd: ["CAP_SETUID", "CAP_SETGID"],
        Privileged: false,
        IpcMode: "private",
        CgroupnsMode: "private",
        ShmSize: 512 * 1024 * 1024,
        RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
        PortBindings: { "6901/tcp": [{ HostIp: "127.0.0.1" }] },
      },
      Mounts: [
        {
          Type: "bind",
          Source: VM_WORKSPACE_DIR,
          Destination: VM_WORKSPACE_GUEST,
          RW: true,
        },
      ],
      ...overrides,
    },
  ]);
}

function perBotReadyInspect(botId: string, viewerPort: number, targetLabel?: string) {
  const target = perBotLocalVmTarget(botId);
  const detail = JSON.parse(readyInspect())[0];
  detail.Config.Labels[TARGET_LABEL] = targetLabel ?? target.label;
  detail.Mounts[0].Source = target.workspaceDir;
  detail.HostConfig.PortBindings["6901/tcp"][0].HostPort = String(viewerPort);
  detail.NetworkSettings = {
    Ports: { "6901/tcp": [{ HostIp: "127.0.0.1", HostPort: String(viewerPort) }] },
  };
  return JSON.stringify([detail]);
}

describe("containerComputerStatus", () => {
  it("prefers the supported Podman image store when Docker is also healthy on Windows", async () => {
    const fake = runner({
      "where.exe podman": "C:\\Program Files\\RedHat\\Podman\\podman.exe\n",
      "where.exe docker": "C:\\Program Files\\Docker\\docker.exe\n",
      "podman info --format json": '{"host":{"arch":"amd64"}}\n',
      "docker info --format {{.ServerVersion}}": "29.0.0\n",
    });

    const status = await containerRuntimeStatus(fake.run, "win32");

    expect(status).toEqual({
      runtime: "podman",
      available: ["podman", "docker"],
      daemonUp: true,
    });
  });

  it("accepts exact Podman-on-Windows hardening and its WSL-translated durable mount", async () => {
    const derived = perBotLocalVmTarget("bot-win");
    const target: LocalVmTarget = {
      ...derived,
      workspaceDir: "C:\\Users\\light\\.openmausbot\\vm-homes\\win-target",
    };
    const detail = JSON.parse(perBotReadyInspect("bot-win", 41629))[0];
    detail.Mounts[0].Source = "/mnt/c/Users/light/.openmausbot/vm-homes/win-target";
    detail.HostConfig = {
      ...detail.HostConfig,
      CapDrop: ["CAP_CHOWN", "CAP_DAC_OVERRIDE"],
      CapAdd: [],
      PidMode: "private",
      UTSMode: "private",
      CgroupnsMode: null,
    };
    detail.EffectiveCaps = ["CAP_SETGID", "CAP_SETUID"];
    detail.BoundingCaps = ["CAP_SETGID", "CAP_SETUID"];
    const targetDriverExec =
      `podman exec -u cua -e HOME=/home/cua -e DISPLAY=:1 -e CUA_DRIVER_INSTALL_CHANNEL=python_package ` +
      `-e CUA_DRIVER_RS_TELEMETRY_ENABLED=0 ${target.containerName} ${CUA_EXECUTABLE}`;
    const fake = runner({
      "where.exe podman": "C:\\Program Files\\RedHat\\Podman\\podman.exe\n",
      "where.exe docker": new Error("missing"),
      "podman info --format json": '{"host":{"arch":"amd64"}}\n',
      [`podman image inspect ${IMAGE}`]: preparedImageInspect(),
      [`podman inspect ${target.containerName}`]: JSON.stringify([detail]),
      [`${targetDriverExec} --version`]: `cua-driver ${CUA_DRIVER_VERSION}\n`,
      [`${targetDriverExec} status --socket ${CUA_SOCKET}`]: "running\n",
      [`${targetDriverExec} call health_report {} --socket ${CUA_SOCKET}`]: JSON.stringify({
        schema_version: "1",
        overall: "ok",
        checks: [],
      }),
      [`${targetDriverExec} call get_desktop_state {} --socket ${CUA_SOCKET} --screenshot-out-file /tmp/openmausbot-readiness.png`]: "{}\n",
      [`podman exec ${target.containerName} base64 -w0 /tmp/openmausbot-readiness.png`]: validPng.toString("base64"),
    });

    const status = await containerComputerStatus(fake.run, "win32", target);

    expect(status).toMatchObject({
      runtime: "podman",
      security: "hardened",
      persistence: "durable",
      network: "loopback",
      ready: true,
    });
  });

  it("rejects extra effective or bounding capabilities in Podman inspect output", () => {
    const config = {
      Memory: 4 * 1024 * 1024 * 1024,
      MemorySwap: 4 * 1024 * 1024 * 1024,
      NanoCpus: 2_000_000_000,
      PidsLimit: 512,
      CapDrop: ["CAP_CHOWN"],
      CapAdd: [],
      Privileged: false,
      PidMode: "private",
      IpcMode: "private",
      UTSMode: "private",
      ShmSize: 512 * 1024 * 1024,
      Devices: [],
      DeviceRequests: null,
      SecurityOpt: [],
      UsernsMode: "",
      CgroupnsMode: undefined,
      OomKillDisable: false,
      AutoRemove: false,
      RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
    };
    expect(podmanSecurityIsHardened(
      config,
      ["CAP_SETGID", "CAP_SETUID"],
      ["CAP_SETGID", "CAP_SETUID"],
    )).toBe(true);
    expect(podmanSecurityIsHardened(
      config,
      ["CAP_NET_RAW", "CAP_SETGID", "CAP_SETUID"],
      ["CAP_SETGID", "CAP_SETUID"],
    )).toBe(false);
  });

  it("keeps per-bot identities, workspaces, and ephemeral viewer ports separate", async () => {
    const target = perBotLocalVmTarget("bot-a");
    const targetDriverExec =
      `docker exec -u cua -e HOME=/home/cua -e DISPLAY=:1 -e CUA_DRIVER_INSTALL_CHANNEL=python_package ` +
      `-e CUA_DRIVER_RS_TELEMETRY_ENABLED=0 ${target.containerName} ${CUA_EXECUTABLE}`;
    const fake = runner({
      "/usr/bin/which docker": "docker\n",
      "/usr/bin/which podman": new Error("missing"),
      "docker info --format {{.ServerVersion}}": "29\n",
      [`docker image inspect ${IMAGE}`]: preparedImageInspect(),
      [`docker inspect ${target.containerName}`]: perBotReadyInspect("bot-a", 49152),
      [`${targetDriverExec} --version`]: `cua-driver ${CUA_DRIVER_VERSION}\n`,
      [`${targetDriverExec} status --socket ${CUA_SOCKET}`]: "running\n",
      [`${targetDriverExec} call health_report {} --socket ${CUA_SOCKET}`]: JSON.stringify({
        schema_version: "1",
        overall: "ok",
        checks: [],
      }),
      [`${targetDriverExec} call get_desktop_state {} --socket ${CUA_SOCKET} --screenshot-out-file /tmp/openmausbot-readiness.png`]: "{}\n",
      [`docker exec ${target.containerName} base64 -w0 /tmp/openmausbot-readiness.png`]: validPng.toString("base64"),
    });

    const status = await containerComputerStatus(fake.run, "linux", target);

    expect(status).toMatchObject({
      container_name: target.containerName,
      target_key: target.key,
      workspace_path: target.workspaceDir,
      viewer_port: 49152,
      managed: true,
      persistence: "durable",
      ready: true,
    });
    expect(status.viewer_url).toContain("http://127.0.0.1:49152/vnc.html");
  });

  it("refuses a per-bot container carrying another target's label", async () => {
    const target = perBotLocalVmTarget("bot-a");
    const other = perBotLocalVmTarget("bot-b");
    const fake = runner({
      "/usr/bin/which docker": "docker\n",
      "/usr/bin/which podman": new Error("missing"),
      "docker info --format {{.ServerVersion}}": "29\n",
      [`docker image inspect ${IMAGE}`]: preparedImageInspect(),
      [`docker inspect ${target.containerName}`]: perBotReadyInspect("bot-a", 49152, other.label),
    });

    const status = await containerComputerStatus(fake.run, "linux", target);

    expect(status.managed).toBe(false);
    expect(status.ready).toBe(false);
    expect(status.problem).toContain("not created by OpenMausBot");
  });

  it("prefers a running runtime over an earlier installed but stopped one", async () => {
    const fake = runner({
      "/usr/bin/which docker": "docker\n",
      "/usr/bin/which podman": "podman\n",
      "docker info --format {{.ServerVersion}}": new Error("daemon stopped"),
      "podman info --format json": '{"host":{"arch":"amd64"}}\n',
      [`podman image inspect ${IMAGE}`]: preparedImageInspect(),
      [`podman inspect ${CONTAINER}`]: JSON.stringify([
        {
          State: { Running: false },
          HostConfig: { PortBindings: { "6901/tcp": [{ HostIp: "127.0.0.1" }] } },
        },
      ]),
    });

    const status = await containerComputerStatus(fake.run, "linux");

    expect(status.runtime).toBe("podman");
    expect(status.available).toEqual(["docker", "podman"]);
    expect(status.daemonUp).toBe(true);
    expect(status.image).toBe(true);
    expect(status.container).toBe("stopped");
    expect(status.network).toBe("loopback");
  });

  it("uses Apple container's actual system and inspect commands", async () => {
    const fake = runner({
      "/usr/bin/which docker": new Error("missing"),
      "/usr/bin/which podman": new Error("missing"),
      "/usr/bin/which container": "container\n",
      "container system status": "running\n",
      [`container image inspect ${IMAGE}`]: preparedImageInspect(),
      [`container inspect ${CONTAINER}`]: JSON.stringify([
        {
          configuration: {
            image: { reference: IMAGE, descriptor: { digest: "sha256:managed-image-id" } },
            resources: { cpus: 2, memoryInBytes: 4 * 1024 * 1024 * 1024 },
            publishedPorts: [{ hostAddress: "127.0.0.1", containerPort: 6901 }],
            labels: {
              [MANAGED_LABEL]: "1",
              [DRIVER_LABEL]: CUA_DRIVER_VERSION,
              [BASE_IMAGE_LABEL]: BASE_IMAGE_DIGEST,
              [IMAGE_LAYER_LABEL]: IMAGE_LAYER_VERSION,
              [WORKSPACE_LABEL]: "1",
            },
            mounts: [{ source: VM_WORKSPACE_DIR, destination: VM_WORKSPACE_GUEST, options: [] }],
          },
          status: { state: "running" },
        },
      ]),
    });

    const status = await containerComputerStatus(fake.run, "darwin");

    expect(status.runtime).toBe("container");
    expect(status.container).toBe("running");
    expect(status.network).toBe("loopback");
    expect(fake.calls).not.toContain("container info --format {{.ServerVersion}}");
  });

  it("does not report a running container as ready when its viewer is public", async () => {
    const fake = runner({
      "/usr/bin/which docker": "docker\n",
      "/usr/bin/which podman": new Error("missing"),
      "docker info --format {{.ServerVersion}}": "27\n",
      [`docker image inspect ${IMAGE}`]: preparedImageInspect(),
      [`docker inspect ${CONTAINER}`]: readyInspect({
        HostConfig: {
          Memory: 4 * 1024 * 1024 * 1024,
          MemorySwap: 4 * 1024 * 1024 * 1024,
          NanoCpus: 2_000_000_000,
          PidsLimit: 512,
          CapDrop: ["ALL"],
          CapAdd: ["CAP_SETUID", "CAP_SETGID"],
          PortBindings: { "6901/tcp": [{ HostIp: "0.0.0.0" }] },
        },
      }),
    });

    const status = await containerComputerStatus(fake.run, "linux");

    expect(status.container).toBe("running");
    expect(status.network).toBe("unsafe");
    expect(status.ready).toBe(false);
  });

  it("rejects a privileged or host-namespaced Local VM even with correct limits", async () => {
    // pins the stricter shared hardening check: resource limits alone are
    // not hardening — privilege and namespace escapes disqualify the VM too
    const base = JSON.parse(readyInspect())[0].HostConfig;
    for (const override of [
      { Privileged: true },
      { IpcMode: "host" },
      { PidMode: "host" },
      { CgroupnsMode: "host" },
      { SecurityOpt: ["seccomp=unconfined"] },
      { DeviceRequests: [{ Driver: "nvidia" }] },
      { RestartPolicy: { Name: "always", MaximumRetryCount: 0 } },
    ]) {
      const fake = runner({
        "/usr/bin/which docker": "docker\n",
        "/usr/bin/which podman": new Error("missing"),
        "docker info --format {{.ServerVersion}}": "29\n",
        [`docker image inspect ${IMAGE}`]: preparedImageInspect(),
        [`docker inspect ${CONTAINER}`]: readyInspect({ HostConfig: { ...base, ...override } }),
      });
      const status = await containerComputerStatus(fake.run, "linux");
      expect(status.security, JSON.stringify(override)).toBe("unsafe");
      expect(status.ready).toBe(false);
    }
  });

  it("rejects missing or unexpected host mounts instead of exposing them to the bot", async () => {
    const fake = runner({
      "/usr/bin/which docker": "docker\n",
      "/usr/bin/which podman": new Error("missing"),
      "docker info --format {{.ServerVersion}}": "29\n",
      [`docker image inspect ${IMAGE}`]: preparedImageInspect(),
      [`docker inspect ${CONTAINER}`]: readyInspect({
        Mounts: [
          { Type: "bind", Source: VM_WORKSPACE_DIR, Destination: VM_WORKSPACE_GUEST, RW: true },
          { Type: "bind", Source: "/tmp/unexpected", Destination: "/host", RW: true },
        ],
      }),
    });

    const status = await containerComputerStatus(fake.run, "linux");

    expect(status.persistence).toBe("unsafe");
    expect(status.ready).toBe(false);
    expect(status.problem).toContain("durable workspace");
  });

  it("does not mistake an unrelated container executable for Apple container off macOS", async () => {
    const fake = runner({
      "where.exe docker": new Error("missing"),
      "where.exe podman": new Error("missing"),
    });

    const status = await containerComputerStatus(fake.run, "win32");

    expect(status.runtime).toBeNull();
    expect(fake.calls).not.toContain("where.exe container");
  });

  it("reports ready only after the exact image, limits, network, version and daemon pass", async () => {
    const fake = runner({
      "/usr/bin/which docker": "docker\n",
      "/usr/bin/which podman": new Error("missing"),
      "docker info --format {{.ServerVersion}}": "29\n",
      [`docker image inspect ${IMAGE}`]: preparedImageInspect(),
      [`docker inspect ${CONTAINER}`]: readyInspect(),
      [versionProbe]: `cua-driver ${CUA_DRIVER_VERSION}\n`,
      [statusProbe]: "running\n",
      [healthProbe]: JSON.stringify({ schema_version: "1", overall: "ok", checks: [] }),
      [readinessProbe]: "{}\n",
      [readinessRead]: validPng.toString("base64"),
    });

    const status = await containerComputerStatus(fake.run, "linux");

    expect(status).toMatchObject({
      imageMatches: true,
      managed: true,
      network: "loopback",
      security: "hardened",
      persistence: "durable",
      desktopReady: true,
      desktop_error: null,
      ready: true,
      problem: null,
      driver_version: "0.20.0",
    });
    expect(status.viewer_url).toContain("#autoconnect=true&resize=scale&password=secret123");
  });

  it("reports the bounded desktop startup error instead of waiting forever", async () => {
    const errorProbe =
      `docker exec ${CONTAINER} tail -n 4 /var/log/supervisor/cua-driver.error.log`;
    const fake = runner({
      "/usr/bin/which docker": "docker\n",
      "/usr/bin/which podman": new Error("missing"),
      "docker info --format {{.ServerVersion}}": "29\n",
      [`docker image inspect ${IMAGE}`]: preparedImageInspect(),
      [`docker inspect ${CONTAINER}`]: readyInspect(),
      [versionProbe]: new Error("driver unavailable"),
      [errorProbe]: "X display :1 did not become ready within 45 seconds\n",
    });

    const status = await containerComputerStatus(fake.run, "linux");

    expect(status.desktopReady).toBe(false);
    expect(status.desktop_error).toContain("did not become ready");
    expect(status.problem).toContain("desktop failed to start");
  });

  it("does not report ready when the driver's health contract fails", async () => {
    const errorProbe = `docker exec ${CONTAINER} tail -n 4 /var/log/supervisor/cua-driver.error.log`;
    const fake = runner({
      "/usr/bin/which docker": "docker\n",
      "/usr/bin/which podman": new Error("missing"),
      "docker info --format {{.ServerVersion}}": "29\n",
      [`docker image inspect ${IMAGE}`]: preparedImageInspect(),
      [`docker inspect ${CONTAINER}`]: readyInspect(),
      [versionProbe]: `cua-driver ${CUA_DRIVER_VERSION}\n`,
      [statusProbe]: "running\n",
      [healthProbe]: JSON.stringify({ schema_version: "1", overall: "failed", checks: [] }),
      [errorProbe]: "",
    });

    const status = await containerComputerStatus(fake.run, "linux");

    expect(status.desktopReady).toBe(false);
    expect(status.desktop_error).toContain("health report is failed");
    expect(fake.calls).not.toContain(readinessProbe);
  });

  it("keeps an owned stale container removable without treating it as ready", async () => {
    const fake = runner({
      "/usr/bin/which docker": "docker\n",
      "/usr/bin/which podman": new Error("missing"),
      "docker info --format {{.ServerVersion}}": "29\n",
      [`docker image inspect ${IMAGE}`]: preparedImageInspect(),
      [`docker inspect ${CONTAINER}`]: readyInspect({
        Config: {
          Image: IMAGE,
          Labels: {
            [MANAGED_LABEL]: "1",
            [DRIVER_LABEL]: "0.12.4",
            [BASE_IMAGE_LABEL]: "wrong",
            [IMAGE_LAYER_LABEL]: "old",
            [WORKSPACE_LABEL]: "1",
          },
        },
      }),
    });

    const status = await containerComputerStatus(fake.run, "linux");

    expect(status.managed).toBe(true);
    expect(status.imageMatches).toBe(false);
    expect(status.ready).toBe(false);
    expect(status.problem).toContain("older desktop or Cua Driver");
    expect(fake.calls).not.toContain(versionProbe);
  });

  it("rejects a container created from a stale build under the same mutable tag", async () => {
    const fake = runner({
      "/usr/bin/which docker": "docker\n",
      "/usr/bin/which podman": new Error("missing"),
      "docker info --format {{.ServerVersion}}": "29\n",
      [`docker image inspect ${IMAGE}`]: preparedImageInspect(),
      [`docker inspect ${CONTAINER}`]: readyInspect({ Image: "sha256:previous-build-id" }),
    });

    const status = await containerComputerStatus(fake.run, "linux");

    expect(status.image_id).toBe("managed-image-id");
    expect(status.imageMatches).toBe(false);
    expect(status.ready).toBe(false);
    expect(status.problem).toContain("older desktop or Cua Driver");
  });

  it("does not treat an unlabelled image under the local tag as prepared", async () => {
    const fake = runner({
      "/usr/bin/which docker": "docker\n",
      "/usr/bin/which podman": new Error("missing"),
      "docker info --format {{.ServerVersion}}": "29\n",
      [`docker image inspect ${IMAGE}`]: JSON.stringify([{ Config: { Labels: {} } }]),
      [`docker inspect ${CONTAINER}`]: new Error("missing container"),
    });

    const status = await containerComputerStatus(fake.run, "linux");

    expect(status.image).toBe(false);
    expect(status.problem).toContain("Prepare the Cua desktop image");
  });
});

describe("Cua integration", () => {
  it("hands cloud credentials only to the isolated remote adapter", () => {
    expect(computerProxyEnv({ boxId: "bx_1", token: "t" })).toEqual({
      OGB_BOX_ID: "bx_1",
      OGB_BOX_TOKEN: "t",
    });
  });

  it("mounts the official Cua MCP server for Local VM turns", () => {
    const connection = containerComputerMcp("podman");
    expect(connection.command).toBe(process.execPath);
    expect(connection.args.at(-3)).toBe("podman");
    expect(connection.args.at(-2)).toBe(CONTAINER);
    expect(connection.args.at(-1)).toBe(CUA_SOCKET);
    expect(connection.env).toEqual({ ELECTRON_RUN_AS_NODE: "1" });
  });

  it("builds an exact, checksum-verified Cua Driver 0.20.0 image", () => {
    const dockerfile = managedImageDockerfile();
    expect(BASE_IMAGE).toMatch(/@sha256:[a-f0-9]{64}$/);
    expect(dockerfile).toContain(`FROM ${BASE_IMAGE}`);
    expect(dockerfile).toContain("cua_driver-0.20.0-py3-none-manylinux_2_31_x86_64.whl");
    expect(dockerfile).toContain("cua_driver-0.20.0-py3-none-manylinux_2_31_aarch64.whl");
    expect(dockerfile).not.toContain("/tmp/cua-driver.whl");
    expect(dockerfile).toContain("sha256sum -c -");
    expect(dockerfile).toContain(`install -D -m 0755 "$driver_bin" ${CUA_EXECUTABLE}`);
    expect(dockerfile).toContain(`cua-driver ${CUA_DRIVER_VERSION}`);
    expect(dockerfile).toContain(`serve --socket ${CUA_SOCKET} --permission-mode standard`);
    expect(dockerfile).toContain("CUA_DRIVER_RS_TELEMETRY_ENABLED=0");
    expect(dockerfile).toContain("prepare-openmausbot-workspace.sh");
    expect(dockerfile).toContain('if ! chmod 0700 "$workspace"');
    expect(dockerfile).toContain('test -r "$directory" && test -w "$directory" && test -x "$directory"');
    expect(dockerfile).toContain("migrate_profile google-chrome");
    expect(dockerfile).toContain("migrate_profile chromium");
    expect(dockerfile).toContain("SingletonLock");
    expect(dockerfile).toContain(`${IMAGE_LAYER_LABEL}="${IMAGE_LAYER_VERSION}"`);
    expect(dockerfile).toContain("did not become ready within 45 seconds");
    expect(dockerfile).not.toContain("while ! DISPLAY=:1 xset q");
  });

  it("rejects a zero-byte OpenSSL base image before the wheel download needs curl", () => {
    const dockerfile = managedImageDockerfile();
    // both multiarch triplets, both OpenSSL libraries
    expect(dockerfile).toContain('"/lib/$lib_triplet/libssl.so.3"');
    expect(dockerfile).toContain('"/lib/$lib_triplet/libcrypto.so.3"');
    expect(dockerfile).toContain("[ ! -s \"$ssl_lib\" ]");
    expect(dockerfile).toContain("is zero bytes, so curl cannot start");
    // the gate runs in the same RUN as the fetch, ahead of it — a defective
    // layer must be named before curl has any chance to fail confusingly
    const gate = dockerfile.indexOf('[ ! -s "$ssl_lib" ]');
    const fetch = dockerfile.indexOf("curl -fsSL");
    expect(gate).toBeGreaterThan(-1);
    expect(fetch).toBeGreaterThan(gate);
  });

  it("captures the preview through Cua Driver rather than xdotool or VNC", async () => {
    const screenshotCall =
      `${driverExec} call get_desktop_state {} --socket ${CUA_SOCKET} ` +
      "--screenshot-out-file /tmp/openmausbot-preview.png";
    const png = validPng;
    const fake = runner({
      "/usr/bin/which docker": "docker\n",
      "/usr/bin/which podman": new Error("missing"),
      "docker info --format {{.ServerVersion}}": "29\n",
      [`docker image inspect ${IMAGE}`]: preparedImageInspect(),
      [`docker inspect ${CONTAINER}`]: readyInspect(),
      [versionProbe]: `cua-driver ${CUA_DRIVER_VERSION}\n`,
      [statusProbe]: "running\n",
      [healthProbe]: JSON.stringify({ schema_version: "1", overall: "degraded", checks: [] }),
      [readinessProbe]: "{}\n",
      [readinessRead]: png.toString("base64"),
      [screenshotCall]: "{}\n",
      [`docker exec ${CONTAINER} base64 -w0 /tmp/openmausbot-preview.png`]: png.toString("base64"),
    });

    const image = await containerComputerScreenshot(fake.run, "linux");

    expect(image).toBe(`data:image/png;base64,${png.toString("base64")}`);
    expect(fake.calls).toContain(screenshotCall);
    expect(fake.calls.some((call) => /xdotool|scrot|vnc/i.test(call))).toBe(false);
  });

  // The live screen poller broadcasts this shape verbatim to every SSE
  // client, and the phone renders nothing but those events: a data URL here
  // would reach it as base64 that decodes to garbage.
  it("hands the screen poller raw base64 and a bare format, not a data URL", async () => {
    const png = validPng;
    const fake = runner({
      "/usr/bin/which docker": "docker\n",
      "/usr/bin/which podman": new Error("missing"),
      "docker info --format {{.ServerVersion}}": "29\n",
      [`docker image inspect ${IMAGE}`]: preparedImageInspect(),
      [`docker inspect ${CONTAINER}`]: readyInspect(),
      [versionProbe]: `cua-driver ${CUA_DRIVER_VERSION}\n`,
      [statusProbe]: "running\n",
      [healthProbe]: JSON.stringify({ schema_version: "1", overall: "degraded", checks: [] }),
      [readinessProbe]: "{}\n",
      [readinessRead]: png.toString("base64"),
      [`${driverExec} call get_desktop_state {} --socket ${CUA_SOCKET} ` +
        "--screenshot-out-file /tmp/openmausbot-preview.png"]: "{}\n",
      [`docker exec ${CONTAINER} base64 -w0 /tmp/openmausbot-preview.png`]: png.toString("base64"),
    });

    const frame = await containerComputerFrame(fake.run, "linux");

    expect(frame).toEqual({ png: png.toString("base64"), format: "png" });
    expect(frame.png.startsWith("data:")).toBe(false);
  });
});

describe("containerComputerAction", () => {
  it("never removes an exact-name container without OpenMausBot ownership labels", async () => {
    const fake = runner({
      "/usr/bin/which docker": "docker\n",
      "/usr/bin/which podman": new Error("missing"),
      "docker info --format {{.ServerVersion}}": "29\n",
      [`docker image inspect ${IMAGE}`]: preparedImageInspect(),
      [`docker inspect ${CONTAINER}`]: readyInspect({
        Config: { Image: IMAGE, Labels: {}, Env: [] },
      }),
    });

    await expect(containerComputerAction("remove", fake.run, "linux")).rejects.toThrow(
      /not created by OpenMausBot.*remove it manually/i,
    );
    expect(fake.calls).not.toContain(`docker rm -f ${CONTAINER}`);
  });

  it("removes a verified OpenMausBot container even when its version labels are stale", async () => {
    const fake = runner({
      "/usr/bin/which docker": "docker\n",
      "/usr/bin/which podman": new Error("missing"),
      "docker info --format {{.ServerVersion}}": "29\n",
      [`docker image inspect ${IMAGE}`]: preparedImageInspect(),
      [`docker inspect ${CONTAINER}`]: readyInspect({
        Config: {
          Image: IMAGE,
          Labels: {
            [MANAGED_LABEL]: "1",
            [DRIVER_LABEL]: "0.12.4",
            [BASE_IMAGE_LABEL]: "old",
            [IMAGE_LAYER_LABEL]: "old",
            [WORKSPACE_LABEL]: "1",
          },
          Env: [],
        },
      }),
      [`docker rm -f ${CONTAINER}`]: "",
    });

    await containerComputerAction("remove", fake.run, "linux");

    expect(fake.calls).toContain(`docker rm -f ${CONTAINER}`);
  });

  it("fails closed instead of giving Apple container an invalid dynamic-port spec", async () => {
    const target = perBotLocalVmTarget("bot-a");
    const fake = runner({
      "/usr/bin/which docker": new Error("missing"),
      "/usr/bin/which podman": new Error("missing"),
      "/usr/bin/which container": "container\n",
      "container system status": "running\n",
      [`container image inspect ${IMAGE}`]: preparedImageInspect(),
      [`container inspect ${target.containerName}`]: new Error("missing container"),
    });

    await expect(containerComputerAction("run", fake.run, "darwin", target)).rejects.toThrow(
      "require Docker or Podman",
    );
    expect(fake.calls.some((call) => call.startsWith("container run "))).toBe(false);
  });

  it("does not create a VM before its managed image is prepared", async () => {
    const fake = runner({
      "/usr/bin/which docker": "docker\n",
      "/usr/bin/which podman": new Error("missing"),
      "docker info --format {{.ServerVersion}}": "29\n",
      [`docker image inspect ${IMAGE}`]: new Error("missing image"),
      [`docker inspect ${CONTAINER}`]: new Error("missing container"),
    });

    await expect(containerComputerAction("run", fake.run, "linux")).rejects.toThrow(
      "Prepare the Cua desktop image",
    );
    expect(fake.calls.some((call) => call.startsWith("docker run "))).toBe(false);
  });

  it("never starts a stopped desktop because its stale X lock makes resume unsafe", async () => {
    const fake = runner({
      "/usr/bin/which docker": "docker\n",
      "/usr/bin/which podman": new Error("missing"),
      "docker info --format {{.ServerVersion}}": "29\n",
      [`docker image inspect ${IMAGE}`]: preparedImageInspect(),
      [`docker inspect ${CONTAINER}`]: readyInspect({ State: { Running: false } }),
    });

    await expect(containerComputerAction("start", fake.run, "linux")).rejects.toThrow("cannot safely resume");
    expect(fake.calls).not.toContain(`docker start ${CONTAINER}`);
  });
});

describe("setupCommands", () => {
  it("derives opaque, distinct per-bot container and workspace identities", () => {
    const a = perBotLocalVmTarget("bot-a");
    const b = perBotLocalVmTarget("bot-b");

    expect(a).toEqual(perBotLocalVmTarget("bot-a"));
    expect(a.key).not.toBe(b.key);
    expect(a.containerName).not.toBe(b.containerName);
    expect(a.workspaceDir).not.toBe(b.workspaceDir);
    expect(a.containerName).not.toContain("bot-a");
    expect(a.workspaceDir).not.toContain("bot-a");
  });

  it("asks Docker for an ephemeral loopback viewer port for each per-bot VM", () => {
    const target = perBotLocalVmTarget("bot-a");
    const args = containerRunArgs("docker", "secret", target);
    const command = ["docker", ...args].join(" ");

    expect(command).toContain(`--name ${target.containerName}`);
    expect(command).toContain(`--label ${TARGET_LABEL}=${target.label}`);
    expect(command).toContain(`source=${target.workspaceDir},target=${VM_WORKSPACE_GUEST}`);
    expect(command).toContain("-p 127.0.0.1::6901");
    expect(command).not.toContain("127.0.0.1:6080:6901");
  });

  it("does not invent Docker commands when no runtime was detected", () => {
    const commands = setupCommands(null, "darwin");
    expect(commands.pull).toBeNull();
    expect(commands.run).toBeNull();
    expect(commands.start).toBeNull();
    expect(commands.install).toContain("podman");
    expect(commands.install).not.toContain("Docker");
  });

  it("publishes only the password-protected viewer and only on loopback", () => {
    const command = setupCommands("podman", "linux").run!;
    expect(command).toContain("-p 127.0.0.1:6080:6901");
    expect(command).not.toContain(" -p 6080:6901");
    expect(command).not.toContain("5900");
    expect(command).toContain("VNC_PW=CHANGE_ME");
  });

  it("does not suggest docker start for an image that must be recreated", () => {
    expect(setupCommands("docker", "linux").start).toBeNull();
  });

  it("limits resources and retains only the sandbox supervisor's identity-switch caps", () => {
    const command = setupCommands("docker", "linux").run!;
    expect(command).toContain("--memory 4g --memory-swap 4g");
    expect(command).toContain("--cpus 2 --pids-limit 512");
    expect(command).toContain("--ipc private --cgroupns private");
    expect(command).toContain("--cap-drop ALL --cap-add SETUID --cap-add SETGID");
    expect(command).toContain(`--label ${MANAGED_LABEL}=1`);
    expect(command).toContain(`--label ${DRIVER_LABEL}=${CUA_DRIVER_VERSION}`);
    expect(command).toContain(`--label ${WORKSPACE_LABEL}=1`);
    expect(command).toContain(`--hostname ${CONTAINER}`);
    expect(command).toContain(
      `--mount type=bind,source=${VM_WORKSPACE_DIR},target=${VM_WORKSPACE_GUEST}`,
    );
  });

  it("asks rootless Podman to map and privately relabel the durable workspace", () => {
    const command = setupCommands("podman", "linux").run!;
    expect(command).toContain(
      `--mount type=bind,source=${VM_WORKSPACE_DIR},target=${VM_WORKSPACE_GUEST},relabel=private,U=true`,
    );
  });

  it("shows the pinned base pull while creating the managed derivative through the API", () => {
    expect(setupCommands("docker", "linux").pull).toBe(`docker pull ${BASE_IMAGE}`);
    expect(setupCommands("docker", "linux").run).toContain(IMAGE);
  });

  it("uses an explicit local image name so Podman never resolves the managed build on Docker Hub", () => {
    expect(IMAGE).toMatch(/^localhost\/openmausbot\/cua-local-vm:/);
    expect(setupCommands("podman", "darwin").run).toContain(IMAGE);
    expect(setupCommands("podman", "darwin").run).not.toContain("docker.io/openmausbot");
  });

  it("generates Apple container lifecycle commands without Docker-only flags", () => {
    const commands = setupCommands("container", "darwin");
    expect(commands.runtimeStart).toBe("container system start");
    expect(commands.remove).toBe(`container rm --force ${CONTAINER}`);
    expect(commands.run).toContain("--memory 4g --cpus 2 --cap-drop ALL");
    expect(commands.run).not.toContain("--memory-swap");
  });

  it("offers the supported Podman Desktop installer on Windows", () => {
    expect(setupCommands(null, "win32").install).toBe("winget install -e --id RedHat.Podman-Desktop");
  });
});

describe("localVmRecreatableOnDemand", () => {
  const linuxPodman = {
    "/usr/bin/which docker": new Error("missing"),
    "/usr/bin/which podman": "podman\n",
    "podman info --format json": '{"host":{"arch":"amd64"}}\n',
  };

  it("recreates a Local VM the idle timer removed", async () => {
    const target = SHARED_LOCAL_VM_TARGET;
    const fake = runner({
      ...linuxPodman,
      [`podman image inspect ${IMAGE}`]: preparedImageInspect(),
      [`podman inspect ${target.containerName}`]: new Error("no such container"),
    });

    const status = await containerComputerStatus(fake.run, "linux", target);

    expect(status.container).toBe("missing");
    expect(status.problem).toBe("Create the Local VM");
    expect(localVmRecreatableOnDemand(status)).toBe(true);
  });

  it("leaves a stopped container alone, because it is asked to be recreated not started", async () => {
    const target = SHARED_LOCAL_VM_TARGET;
    const detail = JSON.parse(readyInspect())[0];
    detail.State = { Running: false, Status: "exited" };
    const fake = runner({
      ...linuxPodman,
      [`podman image inspect ${IMAGE}`]: preparedImageInspect(),
      [`podman inspect ${target.containerName}`]: JSON.stringify([detail]),
    });

    const status = await containerComputerStatus(fake.run, "linux", target);

    expect(status.container).toBe("stopped");
    expect(localVmRecreatableOnDemand(status)).toBe(false);
  });

  it("does not create anything when no container runtime is installed", async () => {
    const fake = runner({
      "/usr/bin/which docker": new Error("missing"),
      "/usr/bin/which podman": new Error("missing"),
    });

    const status = await containerComputerStatus(fake.run, "linux", SHARED_LOCAL_VM_TARGET);

    expect(status.runtime).toBeNull();
    expect(localVmRecreatableOnDemand(status)).toBe(false);
  });

  it("does not create anything before the desktop image has been prepared", async () => {
    const target = SHARED_LOCAL_VM_TARGET;
    const fake = runner({
      ...linuxPodman,
      [`podman image inspect ${IMAGE}`]: new Error("no such image"),
      [`podman inspect ${target.containerName}`]: new Error("no such container"),
    });

    const status = await containerComputerStatus(fake.run, "linux", target);

    expect(status.image).toBe(false);
    expect(localVmRecreatableOnDemand(status)).toBe(false);
  });
});
