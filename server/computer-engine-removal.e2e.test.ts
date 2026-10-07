// The Computer engine is gone (decision D5). It ran a whole turn on Boat's own
// agent through /boxes/{id}/prompt, and that agent has no AI sign-in on a
// Cloud: the hosted-desktop bug. Settings saved on it move, once, to the
// engine a new bot gets, and every conversation keeps working where it did:
// on Auto the removed engine always ran on the bot's own cloud computer.
// Every turn runs on the bot's own engine with the cloud computer as a tool,
// and an Auto turn never reads the Boat account at all. Real server, fake
// Claude CLI, and a loopback Boat that fails the test on any call to Boat's
// own agent (/prompt, /prompts/{id}, /events, /interrupt).
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runControlOmb } from "../scripts/control-omb.ts";
import { freePortBlock } from "./testing/ports.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FAKE_CLI = join(ROOT, "server/testing/fake-claude-cli.ts");
const ENGINE_NAME = "Verification Claude";
const REMOVED = "The Computer choice in the model list was removed.";
const JPEG = Buffer.from("/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD8qqKKKAP/2Q==", "base64");

/** One isolated install: its own home, data folder and server process. */
function install(home: string, boatPort: () => number) {
  const data = join(home, "data");
  const dumpFile = join(home, "dump.json");
  let child: ChildProcess | null = null;
  let base = "";
  let output = "";
  mkdirSync(data, { recursive: true });
  mkdirSync(join(home, "static", "assets"), { recursive: true });
  writeFileSync(join(home, "static", "index.html"), "<title>Computer engine removal</title>");
  writeFileSync(join(home, "static", "assets", "test.css"), "body{}");

  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(base + path, {
      method, headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(result)}`).toBeLessThan(400);
    return result;
  };
  const control = (args: string[]) => runControlOmb([...args, "--url", base]) as Promise<any>;
  /** A person's message, whatever the server answers. */
  const send = (botId: string, threadId: string, text: string) => fetch(`${base}/api/bots/${botId}/messages`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, threadId }),
  }).then(response => response.status);
  const bots = async (): Promise<any[]> => (await api("GET", "/api/bots?messages=0")).bots;
  const bot = async (botId: string) => (await bots()).find(entry => entry.id === botId);
  const savedBots = (): any[] => JSON.parse(readFileSync(join(data, "bots.json"), "utf8"));
  const editSavedBot = (botId: string, edit: (bot: any) => void) => {
    const saved = savedBots();
    edit(saved.find(entry => entry.id === botId));
    writeFileSync(join(data, "bots.json"), JSON.stringify(saved, null, 2));
  };
  const editConfig = (edit: (config: any) => void) => {
    const path = join(data, "config.json");
    const config = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
    edit(config);
    writeFileSync(path, JSON.stringify(config, null, 2));
  };
  const lines = async (threadId: string): Promise<string[]> =>
    (await api("GET", `/api/threads/${threadId}/messages?limit=50`)).messages
      .filter((message: any) => message.kind === "activity").map((message: any) => String(message.tool?.name));
  const moveLines = async (threadId: string) => (await lines(threadId)).filter(line => line.includes(REMOVED));
  const dump = async () => {
    let parsed: any = null;
    await expect.poll(() => {
      if (!existsSync(dumpFile)) return false;
      try { parsed = JSON.parse(readFileSync(dumpFile, "utf8")); return true; } catch { return false; }
    }, { timeout: 15_000 }).toBe(true);
    return parsed;
  };
  const turn = async (botId: string, threadId: string, text: string) => {
    rmSync(dumpFile, { force: true });
    await control(["send", "--bot", botId, "--task", threadId, "--text", text]);
    const settled = await control(["wait", "--bot", botId, "--task", threadId, "--timeout", "30"]);
    expect(settled.status, JSON.stringify(settled)).toBe("settled");
    return dump();
  };
  async function start() {
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    output = "";
    const proc = spawn(process.execPath, [join(ROOT, "server/index.ts")], {
      cwd: ROOT, env: {
        PATH: dirname(process.execPath), ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        HOME: home, USERPROFILE: home, OMB_DATA_DIR: data,
        APPDATA: join(home, "appdata"), LOCALAPPDATA: join(home, "localappdata"),
        TEMP: home, TMP: home, TMPDIR: home,
        OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1), OMB_STATIC_DIR: join(home, "static"),
        OMB_BOX_API: `http://127.0.0.1:${boatPort()}`,
        OMB_USER_DATA: join(home, "user-data"),
      }, stdio: ["ignore", "pipe", "pipe"],
    });
    child = proc;
    proc.stdout!.on("data", chunk => { output += chunk; });
    proc.stderr!.on("data", chunk => { output += chunk; });
    await expect.poll(async () => {
      if (proc.exitCode !== null) throw new Error(`server exited during boot:\n${output}`);
      try { return (await fetch(base + "/api/health")).ok; } catch { return false; }
    }, { timeout: 20_000, interval: 50 }).toBe(true);
  }
  async function stop() {
    if (!child) return;
    const proc = child;
    child = null;
    await waitForExit(proc, { signal: "SIGTERM" });
  }
  return { data, dumpFile, api, send, bots, bot, editSavedBot, editConfig, lines, moveLines, turn, start, stop, log: () => output };
}

/** The fake Claude CLI as this install's engine. */
const claudeEntry = (dumpFile: string) => ({
  driver: "claudeAgent", displayName: ENGINE_NAME, config: { cli: FAKE_CLI }, environment: { FAKE_CLAUDE_DUMP: dumpFile },
});
const onEngine = (model: string) => ({ instanceId: "computer", model });
/** A bot (and each of its conversations) as v0.1.94 saved it on the engine. */
const savedOnEngine = (saved: any) => {
  saved.modelSelection = onEngine("claude-fable-5");
  for (const task of saved.tasks) task.modelSelection = onEngine("claude-fable-5");
};

describe("removing the Computer engine", () => {
  const homes: string[] = [];
  const running: Array<{ stop: () => Promise<void> }> = [];
  let boatServer: Server;
  const rows: Array<{ id: string; name: string; state: string }> = [];
  /** Every request to the Boat account, reads included. */
  let boatCalls = 0;
  let boxesCreated = 0;
  /** Calls to Boat's own agent: the place no turn may ever go. */
  const agentCalls: string[] = [];
  const boatPort = () => (boatServer.address() as { port: number }).port;
  const fresh = () => {
    const home = mkdtempSync(join(tmpdir(), "omb-computer-engine-"));
    homes.push(home);
    const server = install(home, boatPort);
    running.push(server);
    return { home, server };
  };

  beforeAll(async () => {
    boatServer = createServer(async (req, res) => {
      const path = new URL(req.url ?? "/", "http://box.fixture").pathname;
      let raw = ""; for await (const part of req) raw += part;
      const body = raw ? JSON.parse(raw) : {};
      res.setHeader("content-type", "application/json");
      boatCalls++;
      if (/\/(prompt|events|interrupt)$|\/prompts\//.test(path)) {
        agentCalls.push(`${req.method} ${path}`);
        res.statusCode = 409;
        return res.end(JSON.stringify({ ok: false, code: "provider_not_configured", message: "Claude login required" }));
      }
      if (path === "/boxes" && req.method === "POST") {
        boxesCreated++;
        const row = { id: `bx_2345678${"abcdefgh"[rows.length]}`, name: body.name, state: "idle" }; rows.push(row);
        return res.end(JSON.stringify({ box: row }));
      }
      if (path === "/boxes") return res.end(JSON.stringify({ boxes: rows }));
      if (path.endsWith("/commands")) return res.end(JSON.stringify({ exitCode: 0, stdout: "captured", stderr: "" }));
      if (path.endsWith("/artifacts")) { res.setHeader("content-type", "image/jpeg"); return res.end(JPEG); }
      if (path.endsWith("/desktop")) return res.end(JSON.stringify({ desktopUrl: "https://desktop.fixture.invalid" }));
      const row = rows.find(entry => path === "/boxes/" + entry.id);
      if (row) {
        if (req.method === "PATCH" && typeof body.name === "string") row.name = body.name;
        return res.end(JSON.stringify({ box: row }));
      }
      res.end("{}");
    });
    await new Promise<void>(resolve => boatServer.listen(0, "127.0.0.1", resolve));
  });
  afterAll(async () => {
    for (const server of running) await server.stop();
    if (boatServer) { boatServer.closeAllConnections(); await new Promise<void>(resolve => boatServer.close(() => resolve())); }
    for (const home of homes) await removeTempDir(home);
  });

  it("moves bots off it once, keeps each conversation where it worked, and never hands a turn to Boat's own agent", async () => {
    const { server } = fresh();
    // A turn on the cloud computer uses it: its first computer call is what
    // creates the Boat, as with a real model. So this test's engine is the
    // file's claudeEntry plus a fake Claude that uses the cloud computer.
    const claudeEntry = (dumpFile: string) => ({
      driver: "claudeAgent", displayName: ENGINE_NAME, config: { cli: FAKE_CLI },
      environment: { FAKE_CLAUDE_DUMP: dumpFile, FAKE_CLAUDE_USES_CLOUD_COMPUTER: "1" },
    });
    server.editConfig(config => Object.assign(config, { box: { token: "box_verification_fixture" }, instances: { claude: claudeEntry(server.dumpFile) } }));
    await server.start();
    const [starter] = await server.bots();
    // A new conversation becomes the bot's open one; the first is the other.
    const { task: opened } = await server.api("POST", `/api/bots/${starter.id}/tasks`, {});
    const main = opened.threadId;
    const other = starter.threadId;
    const { bot: auto } = await server.api("POST", "/api/bots", { name: "Atlas" });
    const { bot: mixed } = await server.api("POST", "/api/bots", { name: "Iris" });
    const { task: mixedConversation } = await server.api("POST", `/api/bots/${mixed.id}/tasks`, {});
    await server.stop();

    // Everything as v0.1.94 saved it. The fleet, the new-bot defaults and the
    // automatic-recovery backup name the engine.
    server.editConfig(config => Object.assign(config, {
      instances: { claude: claudeEntry(server.dumpFile), computer: { driver: "boxAgent" } },
      defaultModelSelection: { instanceId: "computer", model: "claude-fable-5" },
      newBotDefaults: { profile: { modelSelection: { instanceId: "computer", model: "claude-fable-5" } } },
      automaticRecovery: { enabled: true, backup: { instanceId: "computer", model: "sonnet" } },
    }));
    // The starter: on the engine with Works on Cloud, another conversation
    // and a backup on it, and Boat's run id.
    server.editSavedBot(starter.id, saved => {
      saved.modelSelection = onEngine("claude-fable-5");
      saved.computer = "cloud";
      saved.fallback = [onEngine("sonnet")];
      saved.resumeCursors = { computer: "boat-prompt-run" };
      for (const task of saved.tasks) task.modelSelection = onEngine(task.threadId === other ? "gpt-5.4" : "claude-fable-5");
    });
    // Atlas: on the engine with Works on Auto, the default for new bots.
    server.editSavedBot(auto.id, saved => {
      saved.modelSelection = onEngine("claude-fable-5");
      delete saved.computer;
      for (const task of saved.tasks) task.modelSelection = onEngine("claude-fable-5");
    });
    // Iris: on Claude and Auto, with its open conversation switched to the engine.
    server.editSavedBot(mixed.id, saved => {
      saved.tasks.find((task: any) => task.threadId === mixedConversation.threadId).modelSelection = onEngine("claude-fable-5");
    });

    await server.start();
    // The deleted model id is not offered.
    const { instances } = await server.api("GET", "/api/instances");
    expect(instances.map((instance: any) => instance.instanceId)).not.toContain("computer");
    expect(instances.map((instance: any) => instance.driverKind)).not.toContain("boxAgent");
    const replacement = { instanceId: "claude", model: instances.find((instance: any) => instance.instanceId === "claude").models.default };

    // The starter moved, kept Works on Cloud, and each of its conversations
    // says so, once, in its own words.
    const movedStarter = await server.bot(starter.id);
    expect(movedStarter.modelSelection).toEqual(replacement);
    expect(movedStarter.computer).toBe("cloud");
    expect(movedStarter.fallback ?? []).toEqual([]);
    expect(movedStarter.threadId).toBe(main);
    expect(movedStarter.tasks.find((task: any) => task.threadId === other).modelSelection).toEqual(replacement);
    const starterLine = `${starter.name} now uses ${ENGINE_NAME}. ${REMOVED} ${starter.name} still works on its cloud computer.`;
    const otherLine = `This conversation now uses ${ENGINE_NAME}. ${REMOVED} It still works on ${starter.name}'s cloud computer.`;
    expect(await server.moveLines(main)).toEqual([starterLine]);
    expect(await server.moveLines(other)).toEqual([otherLine]);

    // Atlas was on Auto, which on the engine meant its own cloud computer:
    // it keeps that place, and its line says so truthfully.
    const movedAuto = await server.bot(auto.id);
    expect(movedAuto.modelSelection).toEqual(replacement);
    expect(movedAuto.computer).toBe("cloud");
    expect(await server.moveLines(auto.threadId)).toEqual([`Atlas now uses ${ENGINE_NAME}. ${REMOVED} Atlas still works on its cloud computer.`]);

    // Iris keeps its own engine and Auto. Only the conversation that was on
    // the engine moved, and only that conversation hears about it.
    const movedMixed = await server.bot(mixed.id);
    expect(movedMixed.modelSelection).toEqual(mixed.modelSelection);
    expect(movedMixed.computer).toBeUndefined();
    expect(await server.moveLines(mixed.threadId)).toEqual([]);
    expect(await server.moveLines(mixedConversation.threadId))
      .toEqual([`This conversation now uses ${ENGINE_NAME}. ${REMOVED} It still works on Iris's cloud computer.`]);
    const mixedTask = movedMixed.tasks.find((task: any) => task.threadId === mixedConversation.threadId);
    expect(mixedTask.modelSelection).toEqual(replacement);
    expect(mixedTask).toMatchObject({ surface: "cloud", surfaceAuto: true });

    // New bots get the replacement at once, not after another restart.
    const defaults = await server.api("GET", "/api/bot-defaults");
    expect(defaults.defaults.profile.modelSelection).toEqual(replacement);
    expect(defaults.modelSelection).toEqual(replacement);
    const { bot: created } = await server.api("POST", "/api/bots", { name: "Nova" });
    expect(created.modelSelection).toEqual(replacement);
    expect(created.computer).toBeUndefined();
    // A backup on the removed engine could never run; Settings no longer
    // shows recovery as on with it.
    expect((await server.api("GET", "/api/config")).automaticRecovery).toEqual({ enabled: false });

    // Once: another start adds nothing.
    await server.stop();
    await server.start();
    expect(await server.moveLines(main)).toEqual([starterLine]);
    expect(await server.moveLines(other)).toEqual([otherLine]);
    expect(await server.moveLines(auto.threadId)).toHaveLength(1);
    expect(await server.moveLines(mixedConversation.threadId)).toHaveLength(1);

    // Works on: Cloud runs on the bot's own engine, with the cloud computer as
    // a tool; Boat's own agent is never asked.
    const cloudTurn = await server.turn(starter.id, main, "Take a screenshot of the cloud computer.");
    expect(cloudTurn.argv[cloudTurn.argv.indexOf("--model") + 1]).toBe(replacement.model);
    expect(cloudTurn.mcpConfig.mcpServers.computer.args).toEqual([expect.stringMatching(/harness-mcp-proxy\.(?:ts|js)$/), "computer"]);
    expect(boxesCreated).toBe(1);
    expect(agentCalls).toEqual([]);

    // Atlas's new conversation reaches its own cloud computer the same way.
    const { task: atlasNew } = await server.api("POST", `/api/bots/${auto.id}/tasks`, {});
    const autoMovedTurn = await server.turn(auto.id, atlasNew.threadId, "Take a screenshot of the cloud computer.");
    expect(autoMovedTurn.mcpConfig.mcpServers.computer.args).toEqual([expect.stringMatching(/harness-mcp-proxy\.(?:ts|js)$/), "computer"]);
    expect(boxesCreated).toBe(2);
    expect(agentCalls).toEqual([]);

    // Auto, with this bot's cloud computer running: zero Boat calls of any
    // kind (the removed engine was the one case where Auto attached a Boat).
    await server.api("PATCH", `/api/bots/${starter.id}`, { computer: null });
    const callsBeforeAuto = boatCalls;
    const autoTurn = await server.turn(starter.id, other, "what is 2+2?");
    expect(autoTurn.mcpConfig?.mcpServers?.computer?.args?.[1]).not.toBe("computer");
    expect(boatCalls - callsBeforeAuto, "an Auto turn reached the Boat account").toBe(0);
    expect(agentCalls).toEqual([]);
    await server.stop();
  }, 180_000);

  it("moves a bot later, as soon as an engine is there to move it to", async () => {
    const { home, server } = fresh();
    // Its only engine is not installed yet, so nothing can take the bot at
    // start. (A fleet without a "claude" id is kept exactly as written.)
    const cli = join(home, "later", "claude.mjs");
    const later = { driver: "claudeAgent", displayName: ENGINE_NAME, config: { cli }, environment: { FAKE_CLAUDE_DUMP: server.dumpFile } };
    server.editConfig(config => Object.assign(config, { box: { token: "box_verification_fixture" }, instances: { later } }));
    await server.start();
    const [starter] = await server.bots();
    await server.stop();
    server.editConfig(config => Object.assign(config, { instances: { later, computer: { driver: "boxAgent" } } }));
    server.editSavedBot(starter.id, saved => {
      saved.modelSelection = { instanceId: "computer", model: "claude-fable-5" };
      for (const task of saved.tasks) task.modelSelection = { instanceId: "computer", model: "claude-fable-5" };
    });

    await server.start();
    await server.api("GET", "/api/instances");
    expect((await server.bot(starter.id)).modelSelection.instanceId).toBe("computer");

    // Claude arrives (an install, a sign-in or a key); the next look at the
    // engines moves the bot without a restart.
    mkdirSync(dirname(cli), { recursive: true });
    writeFileSync(cli, `#!/usr/bin/env node\nawait import(${JSON.stringify(pathToFileURL(FAKE_CLI).href)});\n`, { mode: 0o755 });
    const { instances } = await server.api("GET", "/api/instances");
    const model = instances.find((instance: any) => instance.instanceId === "later").models.default;
    await expect.poll(async () => (await server.bot(starter.id)).modelSelection, { timeout: 15_000 })
      .toEqual({ instanceId: "later", model });
    expect(await server.moveLines(starter.threadId)).toEqual([
      `${starter.name} now uses ${ENGINE_NAME}. ${REMOVED} ${starter.name} still works on its cloud computer.`,
    ]);
    await server.stop();
  }, 120_000);

  it("keeps serving when the move fails at start, and moves the bots on a later try", async () => {
    const { server } = fresh();
    const teams = join(server.data, "section-contexts.json");
    server.editConfig(config => Object.assign(config, { box: { token: "box_verification_fixture" }, instances: { claude: claudeEntry(server.dumpFile) } }));
    await server.start();
    const [starter] = await server.bots();
    await server.stop();
    server.editConfig(config => Object.assign(config, { instances: { claude: claudeEntry(server.dumpFile), computer: { driver: "boxAgent" } } }));
    server.editSavedBot(starter.id, savedOnEngine);
    // An unreadable teams file stops every save of the bots, the move's too.
    writeFileSync(teams, "not json");

    await server.start();
    expect(server.log()).toContain("[engines] moving bots off the removed Computer engine failed");
    // Nothing moved halfway: the bot still names the engine, and no line claims a move.
    expect((await server.bot(starter.id)).modelSelection.instanceId).toBe("computer");
    expect(await server.moveLines(starter.threadId)).toEqual([]);

    // Once the file is readable, the next message to the bot moves it, with
    // no app reading the engines (a headless server). That message is
    // refused; the move line tells the person what changed.
    rmSync(teams);
    await server.send(starter.id, starter.threadId, "hello");
    await expect.poll(async () => (await server.bot(starter.id)).modelSelection.instanceId, { timeout: 15_000 }).toBe("claude");
    expect((await server.bot(starter.id)).computer).toBe("cloud");
    expect(await server.moveLines(starter.threadId)).toEqual([
      `${starter.name} now uses ${ENGINE_NAME}. ${REMOVED} ${starter.name} still works on its cloud computer.`,
    ]);
    await server.stop();
  }, 120_000);

  it("keeps a bot on Auto when the engine it moves to can't use a computer, and says so", async () => {
    const { server } = fresh();
    // An OpenAI-compatible endpoint with tools off: it answers, but has no computer.
    const chat = {
      driver: "openai-compat", displayName: "Chat Only",
      config: { url: "http://127.0.0.1:9/v1", key: "sk-verification-fixture", tools: false, model: "chat-model" },
    };
    server.editConfig(config => Object.assign(config, { box: { token: "box_verification_fixture" }, instances: { chat } }));
    await server.start();
    const [starter] = await server.bots();
    await server.stop();
    server.editConfig(config => Object.assign(config, { instances: { chat, computer: { driver: "boxAgent" } } }));
    server.editSavedBot(starter.id, saved => { savedOnEngine(saved); delete saved.computer; });

    await server.start();
    const moved = await server.bot(starter.id);
    expect(moved.modelSelection).toEqual({ instanceId: "chat", model: "chat-model" });
    // Works on: Cloud would refuse every turn on this engine.
    expect(moved.computer).toBeUndefined();
    expect(await server.moveLines(starter.threadId)).toEqual([
      `${starter.name} now uses Chat Only. ${REMOVED} Chat Only can't use a computer, so ${starter.name} no longer works ` +
      "on its cloud computer. To use it again, choose a model that can use a computer.",
    ]);
    await server.stop();
  }, 120_000);
});
