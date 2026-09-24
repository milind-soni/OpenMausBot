// Surface-pin provenance end to end: a person's pin survives a Works on
// change, the machine's recorded pin yields, and the boot repair preserves
// unknown pins from before provenance existed. Real server, fake engine, and a
// restartable fixture home so tests can seed bots.json between boots — the
// sourceless pin shapes only exist on disk.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { freePortBlock } from "./testing/ports.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

describe("surface pin provenance against the real server", () => {
  let home = "";
  let data = "";
  let ui = "";
  let stateFile = "";
  let dumpFile = "";
  let finishFile = "";
  let cuaDescriptor = "";
  let output = "";
  let child: ChildProcess | null = null;
  let base = "";
  let boxServer: Server;
  let boxApi = "";

  const vmState = (state: Record<string, unknown> = {}) => writeFileSync(stateFile, JSON.stringify(state));
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
  const dump = (): Promise<any> => until((): any => {
    if (!existsSync(dumpFile)) return null;
    try { return JSON.parse(readFileSync(dumpFile, "utf8")); } catch { return null; }
  }, Boolean);
  const mountedComputer = (sent: any) => sent.mcpConfig.mcpServers.computer;
  const threadState = (botId: string, threadId: string) =>
    api("GET", "/api/bots?messages=0").then(({ body }) =>
      body.bots.find((bot: any) => bot.id === botId)?.tasks.find((task: any) => task.threadId === threadId));
  const busy = (botId: string, threadId: string) => until(() => threadState(botId, threadId), Boolean);
  const idle = (botId: string, threadId: string) => until(() => threadState(botId, threadId), task => !task?.busy);
  const savedTask = (botId: string, threadId: string) =>
    (JSON.parse(readFileSync(join(data, "bots.json"), "utf8")) as any[])
      .find((bot: any) => bot.id === botId)?.tasks.find((task: any) => task.threadId === threadId);
  const editSavedBot = (botId: string, edit: (bot: any) => void) => {
    const bots = JSON.parse(readFileSync(join(data, "bots.json"), "utf8")) as any[];
    edit(bots.find((bot: any) => bot.id === botId));
    writeFileSync(join(data, "bots.json"), JSON.stringify(bots, null, 2));
  };

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
        OMB_BOX_API: boxApi, OMB_USER_DATA: join(home, "user-data"),
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

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "omb-surface-pins-"));
    data = join(home, "data");
    ui = join(home, "static");
    stateFile = join(home, "vm.json");
    dumpFile = join(home, "dump.json");
    finishFile = join(home, "finish");
    cuaDescriptor = join(home, "user-data", "cua-connection.json");
    vmState();
    mkdirSync(data);
    mkdirSync(join(ui, "assets"), { recursive: true });
    writeFileSync(join(ui, "index.html"), "<title>Surface pins</title>");
    writeFileSync(join(ui, "assets", "test.css"), "body{}");
    boxServer = createServer(async (req, res) => {
      res.setHeader("content-type", "application/json");
      if (new URL(req.url ?? "/", "http://box.fixture").pathname === "/boxes") return res.end(JSON.stringify({ boxes: [] }));
      return res.end("{}");
    });
    await new Promise<void>(resolve => boxServer.listen(0, "127.0.0.1", resolve));
    boxApi = `http://127.0.0.1:${(boxServer.address() as { port: number }).port}`;
    writeFileSync(join(data, "config.json"), JSON.stringify({ instances: { claude: {
      driver: "claudeAgent", config: { cli: join(ROOT, "server/testing/fake-claude-cli.ts") },
      environment: { FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_DUMP: dumpFile, FAKE_CLAUDE_SLOW_FINISH_GATE: finishFile },
    }, computer: { driver: "boxAgent", config: { pollMs: 10 } } } }));
  });
  afterAll(async () => {
    await stop();
    if (boxServer) await new Promise<void>(resolve => boxServer.close(() => resolve()));
    if (home) await removeTempDir(home);
  });
  afterEach(async () => { await stop(); resetTurn(); });

  it("marks a person's thread pin as theirs and clears provenance with the pin", async () => {
    await start();
    const { bot } = await apiOk("POST", "/api/bots", { name: "Pin Bot" });
    const { task } = await apiOk("POST", `/api/bots/${bot.id}/tasks`, {});
    await apiOk("PATCH", `/api/bots/${bot.id}/tasks/${task.threadId}`, { surface: "local" });
    expect(savedTask(bot.id, task.threadId)).toMatchObject({ surface: "local", surfaceSource: "user" });
    await apiOk("PATCH", `/api/bots/${bot.id}/tasks/${task.threadId}`, { surface: null });
    const cleared = savedTask(bot.id, task.threadId)!;
    expect(cleared.surface).toBeUndefined();
    expect(cleared.surfaceSource).toBeUndefined();
    await apiOk("DELETE", `/api/bots/${bot.id}`);
    await stop();
  });

  it("still refuses to change a busy thread's surface", async () => {
    await start();
    const { bot } = await apiOk("POST", "/api/bots", { name: "Busy Pin Bot" });
    const { task } = await apiOk("POST", `/api/bots/${bot.id}/tasks`, {});
    resetTurn();
    await apiOk("POST", `/api/bots/${bot.id}/messages`, { text: "Work slowly.", threadId: task.threadId });
    await busy(bot.id, task.threadId);
    // The running Auto turn records where it landed with explicit provenance.
    await until(() => savedTask(bot.id, task.threadId)?.surface === "vm", Boolean);
    const refused = await api("PATCH", `/api/bots/${bot.id}/tasks/${task.threadId}`, { surface: "vm" });
    expect(refused.status).toBe(409);
    const pinned = savedTask(bot.id, task.threadId)!;
    expect(pinned.surface).toBe("vm");
    expect(pinned.surfaceSource).toBe("auto");
    writeFileSync(finishFile, "finish");
    await idle(bot.id, task.threadId);
    await apiOk("DELETE", `/api/bots/${bot.id}`);
    await stop();
  });

  it("sweeps only conflicting auto pins when Works on is set, and nothing when it returns to Auto", async () => {
    await start();
    const { bot } = await apiOk("POST", "/api/bots", { name: "Sweep Bot" });
    const [autoMismatch, personMismatch, autoMatch] = (await Promise.all([
      apiOk("POST", `/api/bots/${bot.id}/tasks`, {}),
      apiOk("POST", `/api/bots/${bot.id}/tasks`, {}),
      apiOk("POST", `/api/bots/${bot.id}/tasks`, {}),
    ])).map(({ task }) => task);
    await apiOk("PATCH", `/api/bots/${bot.id}/tasks/${personMismatch.threadId}`, { surface: "local" });
    await stop();
    // Seed positively identified machine pins; missing provenance is unknown.
    editSavedBot(bot.id, saved => {
      Object.assign(saved.tasks.find((task: any) => task.threadId === autoMismatch.threadId), { surface: "local", surfaceSource: "auto" });
      Object.assign(saved.tasks.find((task: any) => task.threadId === autoMatch.threadId), { surface: "vm", surfaceSource: "auto" });
    });
    await start(); // Works on is still Auto: the boot repair must leave them alone.
    expect(output).not.toContain("auto-pinned");
    expect(savedTask(bot.id, autoMismatch.threadId)?.surface).toBe("local");
    await apiOk("PATCH", `/api/bots/${bot.id}`, { computer: "vm" });
    expect(savedTask(bot.id, autoMismatch.threadId)?.surface).toBeUndefined();
    expect(savedTask(bot.id, personMismatch.threadId)).toMatchObject({ surface: "local", surfaceSource: "user" });
    expect(savedTask(bot.id, autoMatch.threadId)?.surface).toBe("vm");
    await apiOk("PATCH", `/api/bots/${bot.id}`, { computer: null });
    expect(savedTask(bot.id, personMismatch.threadId)).toMatchObject({ surface: "local", surfaceSource: "user" });
    expect(savedTask(bot.id, autoMatch.threadId)?.surface).toBe("vm");
    expect(savedTask(bot.id, autoMismatch.threadId)?.surface).toBeUndefined();
    await apiOk("DELETE", `/api/bots/${bot.id}`);
    await stop();
  });

  it("preserves pre-provenance user pins at boot and after Works on changes", async () => {
    await start();
    const { bot } = await apiOk("POST", "/api/bots", { name: "Repair Bot" });
    const { task } = await apiOk("POST", `/api/bots/${bot.id}/tasks`, {});
    await apiOk("PATCH", `/api/bots/${bot.id}/tasks/${task.threadId}`, { surface: "local" });
    await stop();
    editSavedBot(bot.id, saved => {
      saved.computer = "vm";
      const target = saved.tasks.find((entry: any) => entry.threadId === task.threadId);
      target.surface = "local";
      delete target.surfaceSource;
    });
    await start();
    expect(output).not.toContain("auto-pinned thread");
    expect(savedTask(bot.id, task.threadId)?.surface).toBe("local");
    expect(savedTask(bot.id, task.threadId)?.surfaceSource).toBeUndefined();
    const place = await apiOk("GET", `/api/bots/${bot.id}/computer?threadId=${task.threadId}`);
    expect(place.surface).toBe("local");
    await apiOk("PATCH", `/api/bots/${bot.id}`, { computer: "browser" });
    expect(savedTask(bot.id, task.threadId)?.surface).toBe("local");
    await stop();
    await start();
    expect(output).not.toContain("auto-pinned thread");
    expect(savedTask(bot.id, task.threadId)?.surface).toBe("local");
    await apiOk("DELETE", `/api/bots/${bot.id}`);
    await stop();
  });

  it("mounts the VM for a turn into a thread auto-pinned to this computer", async () => {
    await start();
    const { bot } = await apiOk("POST", "/api/bots", { name: "Incident Bot" });
    const { task } = await apiOk("POST", `/api/bots/${bot.id}/tasks`, {});
    await apiOk("PATCH", `/api/bots/${bot.id}/tasks/${task.threadId}`, { surface: "local" });
    await stop();
    editSavedBot(bot.id, saved => {
      saved.computer = "vm";
      saved.tasks.find((entry: any) => entry.threadId === task.threadId).surfaceSource = "auto";
    });
    await start(); // The boot repair moved the thread to the bot's Works on.
    expect(output.match(/auto-pinned thread/g)).toHaveLength(1);
    await stop();
    await start(); // Known auto pins are repaired only once.
    expect(output).not.toContain("auto-pinned thread");
    resetTurn();
    await apiOk("POST", `/api/bots/${bot.id}/messages`, { text: "Work where you should.", threadId: task.threadId });
    const sent = await dump();
    expect(sent.systemPrompt).toContain("Local VM");
    expect(mountedComputer(sent).args.some((arg: string) => arg.includes("container-mcp"))).toBe(true);
    expect(sent.systemPrompt).not.toContain("You can act on the user's computer");
    writeFileSync(finishFile, "finish");
    await idle(bot.id, task.threadId);
    expect(savedTask(bot.id, task.threadId)?.surface).toBeUndefined();
    await apiOk("DELETE", `/api/bots/${bot.id}`);
    await stop();
  });

  it("records future auto pins and moves them when Works on changes", async () => {
    await start();
    const { bot } = await apiOk("POST", "/api/bots", { name: "New Auto Pin Bot" });
    const { task } = await apiOk("POST", `/api/bots/${bot.id}/tasks`, {});
    resetTurn();
    await apiOk("POST", `/api/bots/${bot.id}/messages`, { text: "Use the available computer.", threadId: task.threadId });
    expect(mountedComputer(await dump()).args.some((arg: string) => arg.includes("container-mcp"))).toBe(true);
    expect(savedTask(bot.id, task.threadId)).toMatchObject({ surface: "vm", surfaceSource: "auto" });
    expect(await threadState(bot.id, task.threadId)).not.toHaveProperty("surfaceSource");
    writeFileSync(finishFile, "finish");
    await idle(bot.id, task.threadId);
    await stop();
    await start();
    expect(savedTask(bot.id, task.threadId)).toMatchObject({ surface: "vm", surfaceSource: "auto" });
    await apiOk("PATCH", `/api/bots/${bot.id}`, { computer: "off" });
    expect(savedTask(bot.id, task.threadId)?.surface).toBeUndefined();
    expect(savedTask(bot.id, task.threadId)?.surfaceSource).toBeUndefined();
    resetTurn();
    await apiOk("POST", `/api/bots/${bot.id}/messages`, { text: "Continue without a computer.", threadId: task.threadId });
    expect(mountedComputer(await dump())).toBeUndefined();
    writeFileSync(finishFile, "finish");
    await idle(bot.id, task.threadId);
    await apiOk("DELETE", `/api/bots/${bot.id}`);
    await stop();
  });

  it("keeps a person's pin when Works on changes under it", async () => {
    await start();
    const { bot } = await apiOk("POST", "/api/bots", { name: "Person Pin Bot" });
    const { task } = await apiOk("POST", `/api/bots/${bot.id}/tasks`, {});
    await apiOk("PATCH", `/api/bots/${bot.id}/tasks/${task.threadId}`, { surface: "local" });
    await stop();
    editSavedBot(bot.id, saved => { saved.computer = "vm"; });
    await start();
    expect(output).not.toContain("auto-pinned thread");
    expect(savedTask(bot.id, task.threadId)).toMatchObject({ surface: "local", surfaceSource: "user" });
    const place = await apiOk("GET", `/api/bots/${bot.id}/computer?threadId=${task.threadId}`);
    expect(place.surface).toBe("local");
    // The incident's other half: the person's pin still wins the mount.
    if (process.platform !== "linux") {
      mkdirSync(dirname(cuaDescriptor), { recursive: true });
      writeFileSync(cuaDescriptor, JSON.stringify({ mode: "bundled", mcpCommand: "/fixture/cua-driver", mcpArgs: ["mcp"] }));
      try {
        resetTurn();
        await apiOk("POST", `/api/bots/${bot.id}/messages`, { text: "Stay where I pinned you.", threadId: task.threadId });
        const sent = await dump();
        expect(sent.systemPrompt).toContain("You can act on the user's computer");
        expect(mountedComputer(sent).env.OMB_CUA_COMMAND).toBe("/fixture/cua-driver");
        expect(mountedComputer(sent).args.some((arg: string) => arg.includes("container-mcp"))).toBe(false);
        writeFileSync(finishFile, "finish");
        await idle(bot.id, task.threadId);
      } finally {
        rmSync(cuaDescriptor, { force: true });
      }
    }
    await apiOk("DELETE", `/api/bots/${bot.id}`);
    await stop();
  });
});
