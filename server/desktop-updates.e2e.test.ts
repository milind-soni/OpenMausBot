// The real server after an app update, with the Local VM's container boundary replaced (group-local-vm-hooks.mjs) and a fake
// docker standing in for a VPS: a bot's old desktop is never swapped for the person's own computer, an old Local VM updates
// itself while nothing uses it and keeps its sign-ins, and a turn that needs that desktop waits for it.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { writeFileAtomic } from "./atomic.ts";
import { HOST_WHILE_UPDATING, LOCAL_VM_UPDATING, LOCAL_VM_UPDATING_PROBLEM, VPS_OUTDATED_HINT } from "./desktop-updates.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import { VPS_CONTAINER_LABEL, VPS_MANAGED_LABEL, vpsContainerName } from "./vps-computer.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OLD_DESKTOP = { containers: ["shared"], outdated: ["shared"], imageMissing: true, holdPull: true };

// Two VPS hosts that answer like Docker over SSH: neither has the image for this release, old-vps holds a bot's container on
// the previous one and new-vps none. The sealed server gives its children no system folder on PATH, and sed lives there.
const FAKE_DOCKER = `#!/bin/sh
PATH="/usr/bin:/bin:$PATH"
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$*" in
  *" image inspect "*) echo "Error response from daemon: No such image: openmausbot" >&2; exit 1 ;;
  *" container ls "*) ;;
  "-H ssh://old-vps inspect "*) for arg in "$@"; do name="$arg"; done; sed "s|__NAME__|$name|g" "$FAKE_DOCKER_DIR/vps-container.json" ;;
  *" inspect "*) for arg in "$@"; do name="$arg"; done; echo "Error: No such object: $name" >&2; exit 1 ;;
  *) echo "unexpected docker invocation: $*" >&2; exit 64 ;;
esac
`;
const OLD_VPS_CONTAINER = JSON.stringify([{
  Id: "c".repeat(64), Name: "/__NAME__", Image: `sha256:${"d".repeat(64)}`,
  Config: { Image: "localhost/openmausbot/cua-local-vm:driver-0.20.0-v5", Env: ["VNC_PW=fixture"],
    Labels: { [VPS_MANAGED_LABEL]: "1", [VPS_CONTAINER_LABEL]: "__NAME__" } },
  State: { Running: true }, NetworkSettings: { Networks: { bridge: { IPAddress: "172.17.0.9" } } }, Mounts: [], HostConfig: {},
}]);

describe.skipIf(process.platform === "win32")("a bot's old desktop after an app update", () => {
  let home = "";
  let data = "";
  let stateFile = "";
  let dumpFile = "";
  let finishFile = "";
  let fakeBin = "";
  let output = "";
  let child: ChildProcess | null = null;
  let base = "";

  const vm = (state: Record<string, unknown>) => writeFileAtomic(stateFile, JSON.stringify(state));
  const readVm = () => JSON.parse(readFileSync(stateFile, "utf8"));
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(base + path, {
      method, headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as any };
  };
  const apiOk = async (method: string, path: string, body?: unknown) => {
    const result = await api(method, path, body);
    expect(result.status, `${method} ${path}: ${JSON.stringify(result.body)}`).toBeLessThan(400);
    return result.body;
  };
  async function until<T>(read: () => T | Promise<T>, accept: (value: T) => boolean, what: string, timeoutMs = 20_000): Promise<T> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const value = await read();
      if (accept(value)) return value;
      if (Date.now() >= end) throw new Error(`${what} never happened: ${JSON.stringify(value)}\n${output.slice(-2000)}`);
      await new Promise(resolve => setTimeout(resolve, 40));
    }
  }
  /** The dump is rewritten by every dispatch; this waits for the turn that was sent `text`. */
  const dumpFor = (text: string) => until<any>(() => {
    if (!existsSync(dumpFile)) return null;
    try {
      const sent = JSON.parse(readFileSync(dumpFile, "utf8"));
      return JSON.stringify(sent.prompt ?? "").includes(text) ? sent : null;
    } catch { return null; }
  }, Boolean, `the turn for "${text}"`);
  const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).body.messages as any[];
  const idle = (botId: string, threadId: string) => until(() => api("GET", "/api/bots?messages=0").then(({ body }) =>
    body.bots.find((bot: any) => bot.id === botId)?.tasks.find((task: any) => task.threadId === threadId)), task => !task?.busy, "the turn ending");
  const send = async (botId: string, text: string) => {
    const { task } = await apiOk("POST", `/api/bots/${botId}/tasks`, {});
    await apiOk("POST", `/api/bots/${botId}/messages`, { text, threadId: task.threadId });
    return task.threadId as string;
  };
  const finish = async (botId: string, threadId: string) => {
    writeFileSync(finishFile, "finish");
    await idle(botId, threadId);
    rmSync(finishFile, { force: true });
  };
  const actions = () => (readVm().actions ?? []).map((entry: { action: string }) => entry.action) as string[];

  async function start() {
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    output = "";
    // Started as the desktop app starts its own server, so this computer really is on offer and must still be withheld.
    const proc = spawn(process.execPath, ["--import", pathToFileURL(join(ROOT, "server/testing/group-local-vm-hooks.mjs")).href,
      "--import", pathToFileURL(join(ROOT, "server/testing/desktop-parent.mjs")).href, join(ROOT, "server/index.ts")], {
      cwd: ROOT, env: {
        PATH: dirname(process.execPath), ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        HOME: home, USERPROFILE: home, OMB_DATA_DIR: data,
        APPDATA: join(home, "appdata"), LOCALAPPDATA: join(home, "localappdata"),
        TEMP: home, TMP: home, TMPDIR: home,
        OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1), OMB_STATIC_DIR: join(home, "static"), OMB_TEST_VM_STATE: stateFile,
        OMB_TEST_DESKTOP_CUA_CONNECTION: join(home, "user-data", "cua-connection.json"), OMB_EXTRA_PATH: fakeBin,
        FAKE_DOCKER_DIR: fakeBin, FAKE_DOCKER_LOG: join(fakeBin, "docker.log"), OMB_TEST_SEALED_PATH: "1",
      }, stdio: ["ignore", "pipe", "pipe"],
    });
    child = proc;
    proc.stdout!.on("data", chunk => { output += chunk; });
    proc.stderr!.on("data", chunk => { output += chunk; });
    await until(async () => {
      if (proc.exitCode !== null) throw new Error(`server exited during boot:\n${output}`);
      try { return (await fetch(base + "/api/health")).ok; } catch { return false; }
    }, Boolean, "the server starting");
    // Chief first makes the seeded bot its team's Chief, which answers a teammate's failed run with a Team incidents turn
    // of its own that quotes the failed request, on this computer: dumpFor would take it for the turn under test. Stepped
    // down, each dump is the test's own. Only the first boot finds it a Chief.
    const seeded = (await apiOk("GET", "/api/bots?messages=0")).bots.find((bot: any) => bot.chiefOfStaff);
    if (seeded) await apiOk("PATCH", `/api/bots/${seeded.id}`, { chiefOfStaff: false });
  }
  async function stop() {
    if (!child) return;
    const proc = child;
    child = null;
    writeFileSync(finishFile, "finish");
    await waitForExit(proc, { signal: "SIGTERM" });
    rmSync(finishFile, { force: true });
  }

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "omb-desktop-updates-"));
    data = join(home, "data");
    stateFile = join(home, "vm.json");
    dumpFile = join(home, "dump.json");
    finishFile = join(home, "finish");
    fakeBin = join(home, "fakebin");
    mkdirSync(data);
    mkdirSync(fakeBin);
    mkdirSync(join(home, "static", "assets"), { recursive: true });
    writeFileSync(join(home, "static", "index.html"), "<title>Old desktops</title>");
    writeFileSync(join(home, "static", "assets", "test.css"), "body{}");
    writeFileSync(join(fakeBin, "docker"), FAKE_DOCKER, { mode: 0o755 });
    chmodSync(join(fakeBin, "docker"), 0o755);
    writeFileSync(join(fakeBin, "vps-container.json"), OLD_VPS_CONTAINER);
    // This computer's own desktop is on offer, as on a Mac with computer control turned on.
    mkdirSync(join(home, "user-data"), { recursive: true });
    writeFileSync(join(home, "user-data", "cua-connection.json"), JSON.stringify({
      mode: "embedded", status: "ready", socketPath: join(home, "cua.sock"),
      mcpCommand: "/fixture/cua-driver", mcpArgs: ["mcp"], mcpEnv: {},
    }), { mode: 0o600 });
    writeFileSync(join(data, "config.json"), JSON.stringify({ instances: { claude: {
      driver: "claudeAgent", config: { cli: join(ROOT, "server/testing/fake-claude-cli.ts") },
      environment: { FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_DUMP: dumpFile, FAKE_CLAUDE_SLOW_FINISH_GATE: finishFile },
    } } }));
  });
  afterAll(async () => {
    await stop();
    if (home) await removeTempDir(home);
  });
  afterEach(async () => {
    await stop();
    rmSync(dumpFile, { force: true });
  });

  it("gives an Auto chat no computer and a plain note, updates the desktop by itself keeping sign-ins, then uses it", async () => {
    vm(OLD_DESKTOP);
    await start();
    const { bot } = await apiOk("POST", "/api/bots", { name: "Desk Auto Bot", browser: false });
    const threadId = await send(bot.id, "Check the dashboard on the desktop.");
    const sent = await dumpFor("Check the dashboard on the desktop.");
    expect(sent.mcpConfig?.mcpServers?.computer, "neither the old desktop nor this computer is mounted").toBeUndefined();
    expect(sent.systemPrompt).toContain("This bot's Local VM desktop is being updated to the new version");
    expect(sent.systemPrompt).toContain("do not use another computer");
    expect((await api("GET", "/api/local-computer")).body.problem).toBe(LOCAL_VM_UPDATING_PROBLEM);
    const token = sent.mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN as string;
    const offered = await fetch(`${base}/api/internal/computer/select`, { headers: { authorization: `Bearer ${token}` } }).then(r => r.json() as any);
    expect(offered.options.find((option: any) => option.surface === "local")).toMatchObject({ available: false, reason: HOST_WHILE_UPDATING });
    expect(offered.options.find((option: any) => option.surface === "vm")).toMatchObject({ available: false, reason: LOCAL_VM_UPDATING_PROBLEM });
    expect(actions()).toEqual([]);
    await finish(bot.id, threadId);

    const releasedAt = Date.now();
    vm({ ...readVm(), holdPull: false });
    await until(actions, done => done.includes("run"), "the automatic update");
    const updateMs = Date.now() - releasedAt;
    // The image is built once; the old desktop is stopped so Firefox writes its profile out, the profile is copied into the
    // durable folder, and only then is the desktop removed and made again.
    expect(actions()).toEqual(["pull", "stop", "rescue", "remove", "run"]);
    const after = await until(() => api("GET", "/api/local-computer").then(({ body }) => body), body => body.ready === true, "the new desktop");
    expect(after.problem).toBeNull();
    console.info(`automatic update after the image was ready: ${updateMs} ms`);

    const nextThread = await send(bot.id, "Now check the dashboard again.");
    const next = await dumpFor("Now check the dashboard again.");
    const computer = next.mcpConfig.mcpServers.computer;
    expect(computer.args.some((arg: string) => arg.includes("container-mcp"))).toBe(true);
    expect(computer.args.some((arg: string) => arg.includes("local-computer-proxy"))).toBe(false);
    expect(next.systemPrompt).not.toContain("is being updated");
    await finish(bot.id, nextThread);
  }, 60_000);

  it("holds a turn whose place is the Local VM until its desktop is updated, then gives it that desktop", async () => {
    vm(OLD_DESKTOP);
    await start();
    const { bot } = await apiOk("POST", "/api/bots", { name: "Desk VM Bot", browser: false });
    await apiOk("PATCH", `/api/bots/${bot.id}`, { computer: "vm" });
    const threadId = await send(bot.id, "Fill the form in your desktop.");
    await until(() => messages(threadId), list => list.some(m => m.tool?.name === LOCAL_VM_UPDATING), "the plain waiting line");
    expect(existsSync(dumpFile)).toBe(false);
    expect(actions()).toEqual([]);
    vm({ ...readVm(), holdPull: false });
    const sent = await dumpFor("Fill the form in your desktop.");
    expect(sent.mcpConfig.mcpServers.computer.args.some((arg: string) => arg.includes("container-mcp"))).toBe(true);
    expect(actions()).toEqual(["pull", "stop", "rescue", "remove", "run"]);
    expect((await messages(threadId)).filter(m => String(m.tool?.name ?? "").startsWith("error:"))).toEqual([]);
    await finish(bot.id, threadId);
  }, 60_000);

  it("runs an unattended routine on the updated desktop instead of this computer", async () => {
    vm(OLD_DESKTOP);
    await start();
    const { bot } = await apiOk("POST", "/api/bots", { name: "Desk Routine Bot", browser: false });
    const created = await apiOk("POST", "/api/routines", {
      botId: bot.id, name: "Morning desk check", prompt: "Open the morning report on the desktop.", enabled: false,
      schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 },
    });
    const started = await apiOk("POST", `/api/routines/${created.routine.id}/run`, {});
    const threadId = await until<string>(() => api("GET", "/api/routines").then(({ body }) =>
      body.runs.find((run: any) => run.id === started.run.id)?.threadId), Boolean, "the routine thread");
    await until(() => messages(threadId), list => list.some(m => m.tool?.name === LOCAL_VM_UPDATING), "the routine waiting for the desktop");
    expect(existsSync(dumpFile)).toBe(false);
    vm({ ...readVm(), holdPull: false });
    const sent = await dumpFor("Open the morning report on the desktop.");
    const computer = sent.mcpConfig.mcpServers.computer;
    expect(computer.args.some((arg: string) => arg.includes("container-mcp"))).toBe(true);
    expect(computer.args.some((arg: string) => arg.includes("local-computer-proxy"))).toBe(false);
    writeFileSync(finishFile, "finish");
  }, 60_000);

  it("keeps the old desktop, and keeps the bot off this computer, when its sign-ins cannot be copied", async () => {
    vm({ ...OLD_DESKTOP, holdPull: false, failRescue: true });
    await start();
    await until(() => api("GET", "/api/local-computer").then(({ body }) => body.problem as string),
      problem => problem.startsWith("This desktop could not be updated automatically: could not copy the desktop's Firefox profile"), "the failed update");
    expect(readVm().containers).toEqual(["shared"]);
    expect(actions()).toEqual(["pull", "stop"]);
    const { bot } = await apiOk("POST", "/api/bots", { name: "Desk Kept Bot", browser: false });
    const threadId = await send(bot.id, "Look at the desktop.");
    const sent = await dumpFor("Look at the desktop.");
    expect(sent.mcpConfig?.mcpServers?.computer).toBeUndefined();
    expect(sent.systemPrompt).toContain("could not be updated automatically (could not copy the desktop's Firefox profile");
    await finish(bot.id, threadId);
  }, 60_000);

  it("copies the sign-ins out before a person deletes an old desktop", async () => {
    vm({ containers: ["shared"], outdated: ["shared"], holdPull: false });
    await start();
    // Already updated by itself at boot: make another old one by hand, as if the update had been refused.
    await until(actions, done => done.includes("run"), "the boot update");
    vm({ ...readVm(), outdated: ["shared"], actions: [] });
    await apiOk("POST", "/api/local-computer/remove", {});
    expect(actions()).toEqual(["stop", "rescue", "remove"]);
  }, 60_000);

  // A bot on its own server while the default is new-vps: a check made on the default would find nothing there to update.
  it.each([
    { server: "the default VPS", name: "Old VPS Bot", defaultAlias: "old-vps", botAlias: undefined },
    { server: "its own VPS", name: "Own VPS Bot", defaultAlias: "new-vps", botAlias: "old-vps" },
  ])("never lands an Auto chat on this computer while its desktop on $server runs an older version", async ({ name, defaultAlias, botAlias }) => {
    // No Local VM can be made either, so without the rule the turn would fall through to this computer.
    vm({ noContainers: true });
    rmSync(join(fakeBin, "docker.log"), { force: true });
    await start();
    expect((await api("PUT", "/api/config", { vps: { sshAlias: defaultAlias } })).status).toBe(200);
    const { bot } = await apiOk("POST", "/api/bots", { name, browser: false });
    await apiOk("PATCH", `/api/bots/${bot.id}`, { cloudBackend: "vps", computer: null, ...(botAlias ? { vpsAlias: botAlias } : {}) });
    const threadId = await send(bot.id, "Check the VPS desktop.");
    const sent = await dumpFor("Check the VPS desktop.");
    expect(sent.mcpConfig?.mcpServers?.computer, "this computer must not stand in for the VPS").toBeUndefined();
    expect(readFileSync(join(fakeBin, "docker.log"), "utf8")).toContain(`-H ssh://old-vps inspect ${vpsContainerName(bot.id)}`);
    // Nor can the bot pick it: select_computer offers this computer to no bot whose own desktop awaits its update.
    const token = sent.mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN as string;
    const select = (method: "GET" | "POST") => fetch(`${base}/api/internal/computer/select`, {
      method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(method === "POST" ? { body: JSON.stringify({ surface: "auto" }) } : {}),
    }).then(async (response) => ({ status: response.status, body: await response.json() as any }));
    const offered = (await select("GET")).body.options as any[];
    expect(offered.find(option => option.surface === "local")).toMatchObject({ available: false, reason: HOST_WHILE_UPDATING });
    expect(offered.find(option => option.surface === "cloud").reason).toContain(VPS_OUTDATED_HINT);
    const picked = await select("POST");
    expect(picked.body.surface).not.toBe("local");
    await finish(bot.id, threadId);
  }, 60_000);
});
