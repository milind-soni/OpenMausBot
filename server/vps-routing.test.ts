// Turn routing for the BYO-VPS backend, end to end on the real harness
// server: a bot patched to cloudBackend:"vps" must get the managed container
// mounted as its computer (integrations.localComputer → the "computer" MCP
// server), carry the VPS system-prompt clause, never provision from Auto,
// and hold/clear its activeVpsThreads claim across the turn.
//
// The "injected VpsCommandRunner" is a fake `docker` executable on
// OMB_EXTRA_PATH: the server runs in its own process, so injection happens
// where defaultRunner actually looks — argv in, canned inspect JSON out,
// every invocation appended to a log the assertions read. The agent is the
// fake ACP CLI in echo-gated mode (see steer-queue.test.ts), whose echo
// reply carries the FULL prompt and whose gate file gives a deterministic
// busy window — no sleeps anywhere.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  BASE_IMAGE_DIGEST,
  BASE_IMAGE_LABEL,
  CUA_DRIVER_VERSION,
  DRIVER_LABEL,
  IMAGE_LAYER_LABEL,
  IMAGE_LAYER_VERSION,
  MANAGED_LABEL,
} from "./container-computer.ts";
import { VPS_CONTAINER_LABEL, VPS_IMAGE, VPS_MANAGED_LABEL } from "./vps-computer.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const IMAGE_ID = `sha256:${"a".repeat(64)}`;
const CONTAINER_ID = "b".repeat(64);

// the fake docker is a POSIX shell script, like every process fixture here
const posixOnly = describe.skipIf(process.platform === "win32");

function imageInspectJson(): string {
  return JSON.stringify([
    {
      Id: IMAGE_ID,
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

/** __NAME__ is substituted by the fake docker from the inspect argv, because
 * the container name derives from a bot id that only exists at runtime. */
function containerInspectTemplate(): string {
  return JSON.stringify([
    {
      Id: CONTAINER_ID,
      Image: IMAGE_ID,
      Config: {
        Image: VPS_IMAGE,
        Labels: {
          [VPS_MANAGED_LABEL]: "1",
          [VPS_CONTAINER_LABEL]: "__NAME__",
          [MANAGED_LABEL]: "1",
          [DRIVER_LABEL]: CUA_DRIVER_VERSION,
          [BASE_IMAGE_LABEL]: BASE_IMAGE_DIGEST,
          [IMAGE_LAYER_LABEL]: IMAGE_LAYER_VERSION,
        },
      },
      State: { Running: true },
      NetworkSettings: { Networks: { bridge: {} } },
      Mounts: [],
      HostConfig: {
        Binds: [],
        VolumesFrom: [],
        NetworkMode: "bridge",
        PortBindings: {},
        PublishAllPorts: false,
        Memory: 4 * 1024 * 1024 * 1024,
        MemorySwap: 4 * 1024 * 1024 * 1024,
        NanoCpus: 2_000_000_000,
        PidsLimit: 512,
        CapDrop: ["ALL"],
        CapAdd: ["CAP_SETUID", "CAP_SETGID"],
        Privileged: false,
        PidMode: "",
        IpcMode: "private",
        UTSMode: "",
        ShmSize: 512 * 1024 * 1024,
        Devices: [],
        DeviceRequests: [],
        SecurityOpt: [],
        UsernsMode: "",
        CgroupnsMode: "private",
        OomKillDisable: false,
        AutoRemove: false,
        RestartPolicy: { Name: "unless-stopped", MaximumRetryCount: 0 },
      },
    },
  ]);
}

const FAKE_DOCKER = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$*" in
  *" image inspect "*) cat "$FAKE_DOCKER_DIR/image.json" ;;
  *" exec "*"--version"*) echo "cua-driver ${CUA_DRIVER_VERSION}" ;;
  *" exec "*"--screenshot-out-file"*) echo "{}" ;;
  *" exec "*"health_report"*) echo '{"schema_version":"1","overall":"ok","checks":[]}' ;;
  *" exec "*"get_desktop_state"*) echo "{}" ;;
  *" exec "*"base64"*) cat "$FAKE_DOCKER_DIR/screenshot.b64" ;;
  *" exec "*"status"*) echo "running" ;;
  *" exec "*"rm -f"*) : ;;
  *" inspect "*) for arg in "$@"; do name="$arg"; done; sed "s|__NAME__|$name|g" "$FAKE_DOCKER_DIR/container.json.tpl" ;;
  *) echo "unexpected docker invocation: $*" >&2; exit 64 ;;
esac
`;

posixOnly("VPS turn routing e2e (fake ACP fleet + fake docker over SSH)", () => {
  let child: ChildProcess;
  let home: string;
  let stderr = "";
  let gateFile: string;
  let acpDump: string;
  let dockerLog: string;

  type ApiBody = Record<string, string | boolean | { instanceId: string; model: string } | { sshAlias: string }>;

  const api = async (method: string, path: string, body?: ApiBody): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };

  const botById = async (id: string) =>
    (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === id);

  const until = async (probe: () => Promise<boolean>, what: string, timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await probe()) return;
      if (Date.now() > deadline) throw new Error(`${what} never happened. stderr: ${stderr.slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  };

  beforeAll(async () => {
    chmodSync(FAKE_CLI, 0o755);
    home = mkdtempSync(join(tmpdir(), "omb-vps-routing-"));
    mkdirSync(join(home, ".openmausbot"), { recursive: true });
    const fakeBin = join(home, "fakebin");
    mkdirSync(fakeBin, { recursive: true });
    gateFile = join(home, "turn.gate");
    acpDump = join(home, "acp.dump.json");
    dockerLog = join(fakeBin, "docker.log");

    writeFileSync(join(fakeBin, "docker"), FAKE_DOCKER, { mode: 0o755 });
    chmodSync(join(fakeBin, "docker"), 0o755);
    writeFileSync(join(fakeBin, "image.json"), imageInspectJson());
    writeFileSync(join(fakeBin, "container.json.tpl"), containerInspectTemplate());
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(600),
      Buffer.from("IEND", "ascii"),
    ]);
    writeFileSync(join(fakeBin, "screenshot.b64"), png.toString("base64"));
    writeFileSync(dockerLog, "");

    writeFileSync(
      join(home, ".openmausbot", "config.json"),
      JSON.stringify({
        instances: {
          vps: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "echo-gated", FAKE_ACP_GATE_FILE: gateFile, FAKE_ACP_DUMP: acpDump },
            config: { cli: FAKE_CLI, fullAuto: true },
          },
        },
      }),
    );

    const env: NodeJS.ProcessEnv = {
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(PORT),
      OMB_EXTRA_PATH: fakeBin,
      FAKE_DOCKER_DIR: fakeBin,
      FAKE_DOCKER_LOG: dockerLog,
    };
    if (process.env.PATH) env.PATH = process.env.PATH;
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (c) => (stderr += c));

    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        if ((await fetch(`${BASE}/api/health`)).ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }, 40_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  it(
    "mounts the VPS computer on the turn, tells the model, reuses without provisioning, and clears the claim",
    async () => {
      expect((await api("PUT", "/api/config", { vps: { sshAlias: "production-vps" } })).status).toBe(200);

      const bot = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${bot.id}`, {
        name: "Remote hand",
        modelSelection: { instanceId: "vps", model: "fake-model" },
      });
      expect((await api("PATCH", `/api/bots/${bot.id}`, { cloudBackend: "vps" })).status).toBe(200);
      // bot.computer stays unset — Auto, the mode that must never provision

      const sent = await api("POST", `/api/bots/${bot.id}/messages`, { text: "check the remote desktop" });
      expect(sent.status).toBe(202);
      await until(async () => (await botById(bot.id))?.busy === true, "the gated turn");

      // the turn is claimed: the SSH alias cannot be swapped under it...
      const aliasChange = await api("PUT", "/api/config", { vps: { sshAlias: "other-vps" } });
      expect(aliasChange.status).toBe(409);
      expect(aliasChange.body.error).toMatch(/active VPS turn/);
      // ...and neither can the bot's cloud backend
      expect((await api("PATCH", `/api/bots/${bot.id}`, { cloudBackend: "box" })).status).toBe(409);

      // open the gate: the echo settles carrying the FULL prompt
      writeFileSync(gateFile, "open");
      let snapshot: any;
      await until(async () => {
        snapshot = await botById(bot.id);
        return (
          snapshot?.busy === false &&
          snapshot.messages.some((m: any) => m.kind === "text" && m.text?.startsWith("echo: "))
        );
      }, "the echoed turn");

      const echo = snapshot.messages.find((m: any) => m.kind === "text" && m.text?.startsWith("echo: ")).text;
      // the VPS clause, including the disposable-filesystem warning
      expect(echo).toContain("self-hosted remote Linux computer");
      expect(echo).toContain("wiped whenever its container is recreated");

      // the official Cua MCP server was mounted through the VPS bridge
      // SAFETY: the fake ACP CLI wrote this dump itself from session/new's
      // mcpServers array; the shape is pinned by fake-acp-cli.ts.
      const mcpServers = JSON.parse(readFileSync(`${acpDump}.mcp.json`, "utf8")) as Array<{
        name: string;
        command: string;
        args?: string[];
      }>;
      const computer = mcpServers.find((s) => s.name === "computer");
      expect(computer, "no computer MCP server reached the agent").toBeTruthy();
      const bridgeArgs = computer?.args ?? [];
      expect(bridgeArgs.some((a) => a.includes("vps-container-mcp"))).toBe(true);
      expect(bridgeArgs.includes("production-vps")).toBe(true);
      expect(bridgeArgs.includes(CONTAINER_ID)).toBe(true);

      // Auto attached to the existing container and NEVER provisioned: every
      // docker-over-SSH invocation is an inspection or an exec. (The Local VM
      // boot probe also hits the fake docker without -H; it is not the VPS.)
      const invocations = readFileSync(dockerLog, "utf8")
        .split("\n")
        .filter((line) => line.startsWith("-H ssh://"));
      expect(invocations.length).toBeGreaterThan(0);
      for (const line of invocations) {
        const command = line.split(" ")[2];
        expect(["image", "inspect", "exec", "version"], line).toContain(command);
      }

      // the status route reads the same fake daemon and reports ready
      const status = await api("GET", `/api/bots/${bot.id}/computer`);
      expect(status.status).toBe(200);
      expect(status.body).toMatchObject({ backend: "vps", ready: true, container: "running" });

      // turn settled → the claim is gone: the alias may change again
      const released = await api("PUT", "/api/config", { vps: { sshAlias: "other-vps" } });
      expect(released.status).toBe(200);
      expect((await api("PUT", "/api/config", { vps: { sshAlias: "production-vps" } })).status).toBe(200);
    },
    60_000,
  );
});
