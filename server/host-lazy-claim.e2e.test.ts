// Issue #1650: the Auto host fallback must mount the gated CUA integration
// without taking the exclusive computer:host seat, and a conversation pins
// the host desktop only when a screen tool call actually claims it. Real
// server, fake engine, a reachable CUA descriptor, and no Local VM in the
// inventory so Auto falls through to the host desktop.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { freePortBlock } from "./testing/ports.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

describe("lazy host claim and pin on use (issue #1650)", () => {
  let home = "";
  let data = "";
  let ui = "";
  let stateFile = "";
  let dumpFile = "";
  let finishFile = "";
  let output = "";
  let child: ChildProcess | null = null;
  let base = "";

  // No Local VM anywhere: the boot inventory marks nothing seen, so an Auto
  // turn falls past attachLocalVm to the host fallback.
  const vmState = () => writeFileSync(stateFile, JSON.stringify({ noContainers: true }));
  const resetTurn = () => { vmState(); rmSync(dumpFile, { force: true }); rmSync(finishFile, { force: true }); };
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
  async function until<T>(read: () => T | Promise<T>, accept: (value: T) => boolean): Promise<T> {
    const end = Date.now() + 20_000;
    for (;;) {
      const value = await read();
      if (accept(value)) return value;
      if (Date.now() >= end) throw new Error(`Fixture wait expired: ${JSON.stringify(value)}`);
      await new Promise(resolve => setTimeout(resolve, 40));
    }
  }
  // The dump file is rewritten by every dispatch; wait for THIS bot's turn.
  const dumpFor = (botId: string): Promise<any> => until((): any => {
    if (!existsSync(dumpFile)) return null;
    try {
      const sent = JSON.parse(readFileSync(dumpFile, "utf8"));
      return sent.mcpConfig?.mcpServers?.computer?.env?.OMB_CONTROL_URL?.includes(botId) ? sent : null;
    } catch { return null; }
  }, Boolean);
  const mountedComputer = (sent: any) => sent.mcpConfig.mcpServers.computer;
  // The first screen tools/call, exactly as the mounted proxy issues it.
  const gate = (computer: any) => fetch(computer.env.OMB_CONTROL_URL, {
    headers: { authorization: `Bearer ${computer.env.OMB_CONTROL_TOKEN}` },
  }).then(response => response.json() as Promise<any>);
  const threadState = (botId: string, threadId: string) =>
    api("GET", "/api/bots?messages=0").then(({ body }) =>
      body.bots.find((bot: any) => bot.id === botId)?.tasks.find((task: any) => task.threadId === threadId));
  const busy = (botId: string, threadId: string) => until(() => threadState(botId, threadId), Boolean);
  const idle = (botId: string, threadId: string) => until(() => threadState(botId, threadId), task => !task?.busy);
  const savedTask = (botId: string, threadId: string) =>
    (JSON.parse(readFileSync(join(data, "bots.json"), "utf8")) as any[])
      .find((bot: any) => bot.id === botId)?.tasks.find((task: any) => task.threadId === threadId);

  async function start() {
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    output = "";
    const proc = spawn(process.execPath, ["--import", pathToFileURL(join(ROOT, "server/testing/group-local-vm-hooks.mjs")).href, join(ROOT, "server/index.ts")], {
      cwd: ROOT, env: {
        PATH: dirname(process.execPath), ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        HOME: home, USERPROFILE: home, OMB_DATA_DIR: data,
        APPDATA: join(home, "appdata"), LOCALAPPDATA: join(home, "localappdata"),
        TEMP: home, TMP: home, TMPDIR: home,
        OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1), OMB_STATIC_DIR: ui, OMB_TEST_VM_STATE: stateFile,
        OMB_USER_DATA: join(home, "user-data"),
      }, stdio: ["ignore", "pipe", "pipe"],
    });
    child = proc;
    proc.stdout!.on("data", chunk => { output += chunk; });
    proc.stderr!.on("data", chunk => { output += chunk; });
    await until(async () => {
      if (proc.exitCode !== null) throw new Error(`server exited during boot:\n${output}`);
      try { return (await fetch(base + "/api/health")).ok; } catch { return false; }
    }, Boolean);
  }
  async function stop() {
    if (!child) return;
    const proc = child;
    child = null;
    writeFileSync(finishFile, "finish");
    await waitForExit(proc, { signal: "SIGTERM" });
  }
  // Auto may land on the person's own desktop only on macOS and Windows.
  const itAutoHost = process.platform === "linux" ? it.skip : it;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "omb-host-lazy-claim-"));
    data = join(home, "data");
    ui = join(home, "static");
    stateFile = join(home, "vm.json");
    dumpFile = join(home, "dump.json");
    finishFile = join(home, "finish");
    vmState();
    mkdirSync(data);
    mkdirSync(join(ui, "assets"), { recursive: true });
    writeFileSync(join(ui, "index.html"), "<title>Host lazy claim</title>");
    writeFileSync(join(ui, "assets", "test.css"), "body{}");
    mkdirSync(join(home, "user-data"), { recursive: true });
    writeFileSync(join(home, "user-data", "cua-connection.json"), JSON.stringify({
      mode: "embedded", status: "ready", socketPath: join(home, "cua.sock"),
      mcpCommand: "/fixture/cua-driver", mcpArgs: ["mcp"], mcpEnv: {},
    }), { mode: 0o600 });
    writeFileSync(join(data, "config.json"), JSON.stringify({ instances: { claude: {
      driver: "claudeAgent", config: { cli: join(ROOT, "server/testing/fake-claude-cli.ts") },
      environment: { FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_DUMP: dumpFile, FAKE_CLAUDE_SLOW_FINISH_GATE: finishFile },
    }, computer: { driver: "boxAgent", config: { pollMs: 10 } } } }));
  });
  afterAll(async () => {
    await stop();
    if (home) await removeTempDir(home);
  });
  afterEach(async () => { await stop(); resetTurn(); });

  itAutoHost("holds no computer:host claim and records no pin until a screen tool runs", async () => {
    await start();
    const { bot: holder } = await apiOk("POST", "/api/bots", { name: "Screenless Host Bot" });
    const { task } = await apiOk("POST", `/api/bots/${holder.id}/tasks`, {});
    resetTurn();
    await apiOk("POST", `/api/bots/${holder.id}/messages`, { text: "Work slowly without touching the screen.", threadId: task.threadId });
    await busy(holder.id, task.threadId);
    const computer = mountedComputer(await dumpFor(holder.id));
    // The gated host integration is mounted…
    expect(computer.env.OMB_CUA_COMMAND).toBe("/fixture/cua-driver");
    expect(computer.args.some((arg: string) => arg.includes("local-computer-proxy"))).toBe(true);
    // …but the turn pinned nothing and took no seat.
    expect(savedTask(holder.id, task.threadId)).not.toHaveProperty("surface");
    // Another turn's first screen call claims instantly — proof the
    // screen-less turn holds no computer:host claim — and pins its own
    // conversation, never the screen-less one's.
    const { bot: claimer } = await apiOk("POST", "/api/bots", { name: "Host Claim Bot" });
    const { task: claimTask } = await apiOk("POST", `/api/bots/${claimer.id}/tasks`, {});
    await apiOk("POST", `/api/bots/${claimer.id}/messages`, { text: "Work slowly too.", threadId: claimTask.threadId });
    await busy(claimer.id, claimTask.threadId);
    expect(await gate(mountedComputer(await dumpFor(claimer.id)))).toEqual({ held: false, helpOpen: false });
    await until(() => savedTask(claimer.id, claimTask.threadId)?.surface === "local", Boolean);
    expect(savedTask(holder.id, task.threadId)).not.toHaveProperty("surface");
    writeFileSync(finishFile, "finish");
    await idle(holder.id, task.threadId);
    await idle(claimer.id, claimTask.threadId);
  });

  itAutoHost("claims the seat and records the pin on the first screen tool call", async () => {
    await start();
    const { bot } = await apiOk("POST", "/api/bots", { name: "Host Screen Bot" });
    const { task } = await apiOk("POST", `/api/bots/${bot.id}/tasks`, {});
    resetTurn();
    await apiOk("POST", `/api/bots/${bot.id}/messages`, { text: "Work slowly; the screen comes later.", threadId: task.threadId });
    await busy(bot.id, task.threadId);
    const computer = mountedComputer(await dumpFor(bot.id));
    expect(savedTask(bot.id, task.threadId)).not.toHaveProperty("surface");
    // First screen tools/call: the gate fires the deferred exclusive claim…
    expect(await gate(computer)).toEqual({ held: false, helpOpen: false });
    // …and the conversation pins the desktop this turn now actually holds.
    await until(() => savedTask(bot.id, task.threadId)?.surface === "local", Boolean);
    expect(savedTask(bot.id, task.threadId)).toMatchObject({ surface: "local", surfaceSource: "auto" });
    // The seat stays held for the rest of the turn: another turn's first
    // screen call is answered with real contention, not let through.
    const { bot: second } = await apiOk("POST", "/api/bots", { name: "Host Contended Bot" });
    const { task: secondTask } = await apiOk("POST", `/api/bots/${second.id}/tasks`, {});
    await apiOk("POST", `/api/bots/${second.id}/messages`, { text: "Also work slowly.", threadId: secondTask.threadId });
    await busy(second.id, secondTask.threadId);
    const contested = await gate(mountedComputer(await dumpFor(second.id)));
    expect(contested).toMatchObject({ held: true, helpOpen: false });
    expect(contested.blockedReason).toContain("Another thread is using this computer");
    writeFileSync(finishFile, "finish");
    await idle(bot.id, task.threadId);
    await idle(second.id, secondTask.threadId);
  });
});
