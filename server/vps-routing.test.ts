// Turn routing for the BYO-VPS backend, end to end on the real harness
// server: a bot patched to cloudBackend:"vps" must get the managed container
// mounted as its computer (integrations.localComputer → the "computer" MCP
// server), carry the VPS system-prompt clause, never provision from Auto,
// hold/clear its activeVpsThreads claim across the turn, and run several
// of its threads on the VPS at once — the desktop alone is exclusive, and
// only from the first computer call on.
//
// The "injected VpsCommandRunner" is a fake `docker` executable on
// OMB_EXTRA_PATH: the server runs in its own process, so injection happens
// where defaultRunner actually looks — argv in, canned inspect JSON out,
// every invocation appended to a log the assertions read. The agent is the
// fake ACP CLI in echo-gated mode (see steer-queue.test.ts), whose echo
// reply carries the FULL prompt and whose gate file gives a deterministic
// busy window — no sleeps anywhere.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { VPS_CONTAINER_LABEL, VPS_IMAGE, VPS_MANAGED_LABEL, VPS_VIEWER_LABEL, vpsContainerName } from "./vps-computer.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import type { RoutineSchedule } from "../shared/routines.ts";

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
      Name: "/__NAME__",
      Image: IMAGE_ID,
      Config: {
        Image: VPS_IMAGE,
        Env: ["VNC_PW=test-viewer-secret"],
        Labels: {
          [VPS_MANAGED_LABEL]: "1",
          [VPS_CONTAINER_LABEL]: "__NAME__",
          [MANAGED_LABEL]: "1",
          [DRIVER_LABEL]: CUA_DRIVER_VERSION,
          [BASE_IMAGE_LABEL]: BASE_IMAGE_DIGEST,
          [IMAGE_LAYER_LABEL]: IMAGE_LAYER_VERSION,
          [VPS_VIEWER_LABEL]: "1",
        },
      },
      State: { Running: true },
      NetworkSettings: { Networks: { bridge: { IPAddress: "172.17.0.5" } } },
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
if [ -f "$FAKE_DOCKER_DIR/hold" ]; then
  : > "$FAKE_DOCKER_DIR/started"
  while [ -f "$FAKE_DOCKER_DIR/hold" ]; do sleep 0.05; done
fi
case "$*" in
  *" run "*) rm -f "$FAKE_DOCKER_DIR/container-missing" ;;
  *" start "*) sed 's/"Running":false/"Running":true/' "$FAKE_DOCKER_DIR/container.json.tpl" > "$FAKE_DOCKER_DIR/container.next"; mv "$FAKE_DOCKER_DIR/container.next" "$FAKE_DOCKER_DIR/container.json.tpl" ;;
  *" container ls "*) if [ ! -f "$FAKE_DOCKER_DIR/inventory-empty" ]; then echo "${CONTAINER_ID}"; fi ;;
  *" container inspect "*) name=$(cat "$FAKE_DOCKER_DIR/container.name"); sed "s|__NAME__|$name|g" "$FAKE_DOCKER_DIR/container.json.tpl" ;;
  *" image inspect "*) cat "$FAKE_DOCKER_DIR/image.json" ;;
  *" exec "*"--version"*) echo "cua-driver ${CUA_DRIVER_VERSION}" ;;
  *" exec "*"--screenshot-out-file"*)
    : > "$FAKE_DOCKER_DIR/capture-started"
    while [ -f "$FAKE_DOCKER_DIR/hold-capture" ]; do sleep 0.05; done
    if [ -f "$FAKE_DOCKER_DIR/fail-capture" ]; then echo "fixture capture failed" >&2; exit 1; fi
    echo "{}" ;;
  *" exec "*"health_report"*) echo '{"schema_version":"1","overall":"ok","checks":[]}' ;;
  *" exec "*"get_desktop_state"*) echo "{}" ;;
  *" exec "*"base64"*) cat "$FAKE_DOCKER_DIR/screenshot.b64" ;;
  *" exec "*"status"*) echo "running" ;;
  *" exec "*"rm -f"*) : ;;
  *" inspect "*) if [ -f "$FAKE_DOCKER_DIR/container-missing" ]; then echo "No such container" >&2; exit 1; fi; for arg in "$@"; do name="$arg"; done; printf '%s' "$name" > "$FAKE_DOCKER_DIR/container.name"; sed "s|__NAME__|$name|g" "$FAKE_DOCKER_DIR/container.json.tpl" ;;
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

  type ApiBody = Record<string, string | boolean | null | RoutineSchedule | { instanceId: string; model: string } | { sshAlias: string }>;

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
    // Only the viewer's local listening socket is simulated; no SSH network
    // or real VPS is contacted. The provider owns and closes this child.
    writeFileSync(join(fakeBin, "ssh"), `#!${process.execPath}
import { createServer } from 'node:net';
const args = process.argv.slice(2);
const forward = args[args.indexOf('-L') + 1];
const port = Number(forward.split(':')[1]);
createServer(socket => socket.end()).listen(port, '127.0.0.1');
`, { mode: 0o755 });
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

  it("shares a canceled preview with retries and opens control without racing destructive actions", async () => {
    expect((await api("PUT", "/api/config", { vps: { sshAlias: "production-vps" } })).status).toBe(200);
    const bot = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${bot.id}`, { computer: "cloud", cloudBackend: "vps" });
    const fixtureDir = dirname(dockerLog);
    const hold = join(fixtureDir, "hold-capture");
    const started = join(fixtureDir, "capture-started");
    const failed = join(fixtureDir, "fail-capture");
    const captures = () => readFileSync(dockerLog, "utf8").split("\n").filter(line => line.includes("--screenshot-out-file")).length;
    const path = `/api/bots/${bot.id}/computer`;
    let retries: Array<Promise<{ status: number; body: any }>> = [];
    try {
      writeFileSync(hold, "hold");
      rmSync(started, { force: true });
      const before = captures();
      const cancel = new AbortController();
      const first = fetch(`${BASE}${path}/screenshot`, {
        method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: cancel.signal,
      });
      await until(async () => existsSync(started), "the pending preview");
      cancel.abort();
      await expect(first).rejects.toThrow();
      retries = [api("POST", `${path}/screenshot`, {}), api("POST", `${path}/screenshot`, {})];

      // These must still exclude the capture even after its HTTP client left.
      for (const action of ["provision", "sleep", "remove"]) {
        const blocked = await api("POST", `${path}/${action}`, {});
        expect(blocked.status, action).toBe(409);
        expect(blocked.body.error).toMatch(/preview.*refreshing/);
      }
      expect((await api("DELETE", `/api/bots/${bot.id}`)).status).toBe(409);
      expect((await api("PUT", "/api/config", { vps: { sshAlias: "other-vps" } })).status).toBe(409);

      // A preview is not a computer change: opening the existing viewer is
      // safe, and cannot be rejected merely because a frame is slow.
      expect((await api("POST", `${path}/control`, { action: "take" })).status).toBe(200);
      const joined = await api("POST", `${path}/join`, {});
      expect(joined.status, JSON.stringify(joined.body)).toBe(200);
      expect(joined.body.joinUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/vnc\.html#/);
      expect(captures() - before).toBe(1);
      rmSync(hold, { force: true });
      for (const result of await Promise.all(retries)) {
        expect(result.status).toBe(200);
        expect(result.body).toMatchObject({ format: "png", png: expect.any(String) });
      }
      expect(captures() - before).toBe(1);

      // A failed capture must also release its reservation for later retries.
      writeFileSync(failed, "fail");
      const failure = await api("POST", `${path}/screenshot`, {});
      expect(failure.status).toBe(500);
      expect(failure.body.error).toMatch(/fixture capture failed/);
      rmSync(failed, { force: true });
      expect((await api("POST", `${path}/screenshot`, {})).status).toBe(200);
    } finally {
      rmSync(hold, { force: true });
      rmSync(failed, { force: true });
      await Promise.allSettled(retries);
      await api("POST", `${path}/viewer-close`, {});
      await api("POST", `${path}/control`, { action: "release" });
    }
  }, 30_000);

  it.each(["stopped", "missing", "stopped-during-turn"])(
    "lets Auto discover a %s VPS and start or create it through its chat tool",
    async state => {
      await api("PUT", "/api/config", { vps: { sshAlias: "production-vps" } });
      const bot = (await api("POST", "/api/bots")).body.bot;
      const template = join(dirname(dockerLog), "container.json.tpl");
      const missing = join(dirname(dockerLog), "container-missing");
      const original = readFileSync(template, "utf8");
      try {
        if (state === "stopped") writeFileSync(template, original.replace('"Running":true', '"Running":false'));
        else if (state === "missing") writeFileSync(missing, "missing");
        writeFileSync(join(dirname(dockerLog), "container.name"), vpsContainerName(bot.id));
        rmSync(gateFile, { force: true }); rmSync(`${acpDump}.mcp.json`, { force: true });
        await api("PATCH", `/api/bots/${bot.id}`, { browser: false, cloudBackend: "vps", computer: null,
          modelSelection: { instanceId: "vps", model: "fake-model" } });
        expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "Open Chrome on the available remote VM" })).status).toBe(202);
        await until(async () => existsSync(`${acpDump}.mcp.json`), "the discovery turn");
        const first = JSON.parse(readFileSync(`${acpDump}.mcp.json`, "utf8"));
        if (state === "stopped-during-turn") {
          expect(first.find((tool: { name: string }) => tool.name === "computer")).toBeTruthy();
          writeFileSync(template, original.replace('"Running":true', '"Running":false'));
        } else expect(first.find((tool: { name: string }) => tool.name === "computer")).toBeUndefined();
        const agents = first.find((tool: { name: string }) => tool.name === "agents");
        const token = agents.env.find((entry: { name: string }) => entry.name === "OMB_COMMS_TOKEN").value;
        const availability = await (await fetch(`${BASE}/api/internal/computer/select`, { headers: { authorization: `Bearer ${token}` } })).json() as any;
        expect(availability.options.find((option: any) => option.surface === "cloud")).toMatchObject({ available: true, ready: false,
          canStart: state !== "missing", canCreate: state === "missing" });
        const selected = await fetch(`${BASE}/api/internal/computer/select`, { method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ surface: "auto" }) });
        expect(await selected.json()).toMatchObject({ status: "pending", surface: "cloud" });
        rmSync(`${acpDump}.mcp.json`, { force: true });
        const before = readFileSync(dockerLog, "utf8").length;
        writeFileSync(gateFile, "open");
        await until(async () => existsSync(`${acpDump}.mcp.json`) && !(await botById(bot.id))?.busy, "the switched VPS turn");
        const next = JSON.parse(readFileSync(`${acpDump}.mcp.json`, "utf8"));
        expect(next.find((tool: { name: string }) => tool.name === "computer")?.args).toContain("production-vps");
        const commands = readFileSync(dockerLog, "utf8").slice(before);
        expect(commands).toContain(state === "missing" ? " run " : " start ");
        expect(commands).not.toMatch(/ssh:\/\/production-vps (?:pull|build) /);
        if (state !== "missing") expect(commands).not.toContain(" run ");
        const saved = await botById(bot.id);
        expect(saved.messages.filter((message: { role: string; kind: string }) => message.role === "user" && message.kind === "text")).toHaveLength(1);
      } finally {
        writeFileSync(gateFile, "open");
        await api("POST", `/api/bots/${bot.id}/interrupt`, {});
        rmSync(missing, { force: true });
        writeFileSync(template, original);
      }
    },
    45_000,
  );

  it(
    "mounts the VPS computer on the turn, tells the model, reuses without provisioning, and clears the claim",
    async () => {
      writeFileSync(dockerLog, "");
      rmSync(gateFile, { force: true });
      expect((await api("PUT", "/api/config", { vps: { sshAlias: "production-vps" } })).status).toBe(200);

      const bot = (await api("POST", "/api/bots")).body.bot;
      writeFileSync(join(dirname(dockerLog), "container.name"), vpsContainerName(bot.id));
      await api("PATCH", `/api/bots/${bot.id}`, {
        name: "Remote hand",
        modelSelection: { instanceId: "vps", model: "fake-model" },
      });
      expect((await api("PATCH", `/api/bots/${bot.id}`, { cloudBackend: "vps" })).status).toBe(200);
      expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "cloud" })).status).toBe(200);

      // A lifecycle request claims the bot and container before its first SSH
      // round trip. An alias change must lose while that readiness work is in
      // flight, rather than moving the later polls to a different host.
      const fixtureDir = dirname(dockerLog);
      writeFileSync(join(fixtureDir, "hold"), "hold");
      rmSync(join(fixtureDir, "started"), { force: true });
      const provisioning = api("POST", `/api/bots/${bot.id}/computer/provision`, {});
      await until(async () => {
        try {
          readFileSync(join(fixtureDir, "started"));
          return true;
        } catch {
          return false;
        }
      }, "the held VPS lifecycle call");
      const lifecycleRace = await api("PUT", "/api/config", { vps: { sshAlias: "other-vps" } });
      expect(lifecycleRace.status).toBe(409);
      expect(lifecycleRace.body.error).toMatch(/cloud computer actions|VPS computer actions/i);
      rmSync(join(fixtureDir, "hold"), { force: true });
      expect((await provisioning).status).toBe(200);
      expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: null })).status).toBe(200);
      // Auto remains read-only and never provisions.

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
      expect(echo).toContain("This is a VPS, not Box");
      expect(echo).toContain("using it does not require a Box API key");
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

      // Explicit Cloud with the VPS backend is still the selected local ACP
      // engine with a VPS tool mount, not the unrelated native Box runner.
      expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "cloud" })).status).toBe(200);
      const explicitThread = (await api("POST", `/api/bots/${bot.id}/tasks`, {})).body.task.threadId;
      rmSync(`${acpDump}.mcp.json`, { force: true });
      const cloudTurn = await api("POST", `/api/bots/${bot.id}/messages`, { threadId: explicitThread, text: "Open Chrome on the VPS and inspect the page" });
      expect(cloudTurn.status, JSON.stringify(cloudTurn.body)).toBe(202);
      await until(async () => existsSync(`${acpDump}.mcp.json`) && (await botById(bot.id))?.busy === false, "the explicit VPS turn");
      const explicitTools = JSON.parse(readFileSync(`${acpDump}.mcp.json`, "utf8"));
      expect(explicitTools.find((tool: { name: string }) => tool.name === "computer")?.args).toContain("production-vps");
      const threadPreview = await api("GET", `/api/bots/${bot.id}/computer?threadId=${explicitThread}`);
      expect(threadPreview.body).toMatchObject({ surface: "cloud", backend: "vps", ready: true });

      // Scheduling on the bot's setup must retain its ACP model + VPS tools,
      // without requiring credentials for the unrelated Box-hosted runner.
      const created = await api("POST", "/api/routines", {
        botId: bot.id, name: "VPS scheduled check", prompt: "Check the existing VPS.", enabled: false,
        schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 },
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      expect(created.body.routine.runOn).toBe("maus");
      rmSync(`${acpDump}.mcp.json`, { force: true });
      const started = await api("POST", `/api/routines/${created.body.routine.id}/run`);
      expect(started.status, JSON.stringify(started.body)).toBe(201);
      let completed: any;
      await until(async () => {
        completed = (await api("GET", "/api/routines")).body.runs.find((run: any) => run.id === started.body.run.id);
        return completed?.status === "completed";
      }, "the routine on the existing VPS");
      const routineTools = JSON.parse(readFileSync(`${acpDump}.mcp.json`, "utf8"));
      expect(routineTools.find((tool: { name: string }) => tool.name === "computer")?.args).toContain("production-vps");
      const routineMessages = (await api("GET", `/api/threads/${completed.threadId}/messages?limit=100`)).body.messages;
      expect(routineMessages.some((message: any) => message.text?.includes("This is a VPS, not Box"))).toBe(true);

      // The turn claim is gone, but its durable container remains on the old
      // host. Keep that resource visible until the user removes it.
      const released = await api("PUT", "/api/config", { vps: { sshAlias: "other-vps" } });
      expect(released.status, JSON.stringify(released.body)).toBe(409);
      expect(released.body.error).toMatch(/remove.*VPS computers/i);

      // Once a fresh old-host inventory proves there are no local rows, hold
      // the validation request open and prove the opposite race: new turns,
      // lifecycle actions, and bot deletion all reject until commit.
      writeFileSync(join(fixtureDir, "inventory-empty"), "empty");
      writeFileSync(join(fixtureDir, "hold"), "hold");
      rmSync(join(fixtureDir, "started"), { force: true });
      const changing = api("PUT", "/api/config", { vps: { sshAlias: "other-vps" } });
      await until(async () => {
        try {
          readFileSync(join(fixtureDir, "started"));
          return true;
        } catch {
          return false;
        }
      }, "the held VPS alias validation");
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "do not cross hosts" })).status).toBe(409);
      expect((await api("POST", `/api/bots/${bot.id}/computer/provision`, {})).status).toBe(409);
      expect((await api("DELETE", `/api/bots/${bot.id}`)).status).toBe(409);
      rmSync(join(fixtureDir, "hold"), { force: true });
      expect((await changing).status).toBe(200);
      expect((await api("PUT", "/api/config", { vps: { sshAlias: "production-vps" } })).status).toBe(200);
    },
    60_000,
  );

  // Arjav, Sep 17: a bot's 3-hourly routines sat behind its own long task
  // with "Waiting for computer — … is using it", then failed after 30
  // minutes. The container is shared by the bot, but only the desktop
  // inside it needs one driver at a time, and only once someone drives it.
  it(
    "runs two turns of one bot on the VPS at once; the desktop is claimed by the first computer call and waited for by name",
    async () => {
      writeFileSync(dockerLog, "");
      rmSync(gateFile, { force: true });
      rmSync(`${acpDump}.mcp.json`, { force: true });
      expect((await api("PUT", "/api/config", { vps: { sshAlias: "production-vps" } })).status).toBe(200);
      const bot = (await api("POST", "/api/bots")).body.bot;
      writeFileSync(join(dirname(dockerLog), "container.name"), vpsContainerName(bot.id));
      await api("PATCH", `/api/bots/${bot.id}`, { name: "TCPR operator", modelSelection: { instanceId: "vps", model: "fake-model" } });
      expect((await api("PATCH", `/api/bots/${bot.id}`, { cloudBackend: "vps" })).status).toBe(200);
      expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "cloud" })).status).toBe(200);
      const mountedComputer = () => {
        const servers = JSON.parse(readFileSync(`${acpDump}.mcp.json`, "utf8")) as Array<{ name: string; args?: string[]; env?: Array<{ name: string; value: string }> }>;
        const computer = servers.find((server) => server.name === "computer");
        expect(computer, "no computer MCP server reached the agent").toBeTruthy();
        const env = (name: string) => computer!.env?.find((entry) => entry.name === name)?.value ?? "";
        return { args: computer!.args ?? [], url: env("OMB_CONTROL_URL"), token: env("OMB_CONTROL_TOKEN") };
      };
      const gate = async (mount: { url: string; token: string }) =>
        (await fetch(mount.url, { headers: { authorization: `Bearer ${mount.token}` } })).json() as Promise<any>;
      const activities = async (threadId: string) =>
        ((await api("GET", `/api/threads/${threadId}/messages`)).body.messages as any[])
          .filter((m) => m.kind === "activity").map((m) => String(m.tool?.name ?? ""));
      const taskBusy = async (threadId: string) => Boolean((await botById(bot.id))?.tasks?.find((t: any) => t.threadId === threadId)?.busy);

      const refill = (await api("POST", `/api/bots/${bot.id}/tasks`, { title: "TCPR 3 hour capacity refill" })).body.task;
      const check = (await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Queue check" })).body.task;
      try {
        // the long task: gated open, so it holds its turn for as long as we like
        expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: refill.threadId, text: "Refill capacity on the VPS" })).status).toBe(202);
        await until(async () => existsSync(`${acpDump}.mcp.json`) && await taskBusy(refill.threadId), "the long VPS turn");
        const refillMount = mountedComputer();
        expect(refillMount.args).toContain("production-vps");
        rmSync(`${acpDump}.mcp.json`, { force: true });

        // a second thread of the same bot starts NOW, with the VPS mounted,
        // instead of queueing behind the long task until it ends
        expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: check.threadId, text: "Check the queue on the VPS" })).status).toBe(202);
        await until(async () => existsSync(`${acpDump}.mcp.json`) && await taskBusy(check.threadId), "the second VPS turn, while the first still runs");
        const checkMount = mountedComputer();
        expect(checkMount.args).toContain("production-vps");
        expect(checkMount.token).not.toBe(refillMount.token);
        expect(await taskBusy(refill.threadId)).toBe(true);
        expect((await activities(check.threadId)).join("|")).not.toContain("Waiting for its turn");
        expect((await activities(refill.threadId)).join("|")).not.toContain("Waiting for its turn");
        // the alias is pinned while ANY of the bot's threads runs on the VPS
        expect((await api("PUT", "/api/config", { vps: { sshAlias: "other-vps" } })).status).toBe(409);

        // The desktop: nobody has touched it, so the second thread's first
        // computer call claims it at once…
        expect(await gate(checkMount)).toEqual({ held: false, helpOpen: false });
        // …and the long task's first computer call finds it taken: refused
        // with the pause text, and its chip names who is running what.
        expect(await gate(refillMount)).toMatchObject({
          held: true, helpOpen: false,
          blockedReason: "Another thread is using this computer. This call was not performed. Pause computer work until that thread finishes, then take a fresh screenshot before acting.",
        });
        await until(async () => (await activities(refill.threadId)).includes(
          "Waiting for its turn on this computer — TCPR operator is running Queue check. Starts automatically when that finishes.",
        ), "the wait chip naming the holder");

        // both turns finish; the wait settles as free-and-continuing or as
        // stopped, depending on which turn ended first — never as an error
        writeFileSync(gateFile, "open");
        await until(async () => (await botById(bot.id))?.busy === false, "both turns settling");
        const settled = await activities(refill.threadId);
        expect(settled.some((name) => name === "Computer free — continuing" || name === "Stopped waiting for the computer")).toBe(true);
        expect(settled.join("|")).not.toMatch(/still busy|error/i);
        // the last thread out clears the claim: the alias can move again
        expect((await api("PUT", "/api/config", { vps: { sshAlias: "production-vps" } })).status).toBe(200);
      } finally {
        writeFileSync(gateFile, "open");
        await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: refill.threadId });
        await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: check.threadId });
      }
    },
    60_000,
  );
});
