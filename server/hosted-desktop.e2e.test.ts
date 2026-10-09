// "Works on: Cloud" (Hosted desktop) end to end, the incident of Oct 3: a
// Claude bot set to the cloud computer had its turn handed to the Computer
// engine, which posted the prompt to Boat's own runner; on an OMB Cloud that
// runner has no AI sign-in, so every turn failed with a bare
// provider_not_configured and the bot looked broken until it was recreated.
// Now the bot keeps its own engine and model, and the cloud computer arrives
// as one more stdio computer server the harness serves. Real server, fake
// Claude CLI, and a loopback Boat that fails the test on any /prompt call.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

const BOAT_TOKEN = "box_verification_fixture";
const JPEG = Buffer.from("/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD8qqKKKAP/2Q==", "base64");

/** The spawned computer server, driven over stdio the way an engine drives it. */
function mcpClient(server: { command: string; args: string[]; env: Record<string, string> }) {
  const child: ChildProcessWithoutNullStreams = spawn(server.command, server.args, {
    env: { ...server.env, PATH: process.env.PATH ?? "" }, stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  let nextId = 1;
  const waiting = new Map<number, (message: any) => void>();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const message = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      waiting.get(message.id)?.(message);
      waiting.delete(message.id);
    }
  });
  const request = (method: string, params: unknown = {}) => new Promise<any>((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error(`no answer to ${method}`)), 15_000);
    waiting.set(id, message => { clearTimeout(timer); resolve(message); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  const close = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill();
    await new Promise<void>(resolve => child.once("close", () => resolve()));
  };
  return { request, close };
}

it("keeps the bot's own engine on the cloud computer, and a failed place never breaks the bot", async () => {
  const rows: Array<{ id: string; name: string; state: string }> = [];
  const commands: string[] = [];
  let prompts = 0;
  let boxesCreated = 0;
  /** Every request to the Boat account, reads included. */
  let boatCalls = 0;
  /** A new Boat whose desktop link can't be made, and whose rollback delete
   * then fails: the provision fails and leaves a deletion fence. */
  let failNewBoat = false;
  const upstream = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://fixture").pathname;
    let raw = ""; for await (const part of req) raw += part;
    const body = raw ? JSON.parse(raw) : {};
    res.setHeader("content-type", "application/json");
    if (path.startsWith("/boxes")) boatCalls++;
    if (path === "/v1/models") return res.end(JSON.stringify({ data: [{ id: "tools-off-model" }] }));
    if (path === "/v1/chat/completions") {
      res.setHeader("content-type", "text/event-stream");
      return res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "Fixture reply" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
    }
    // Boat's own runner: the one thing a Hosted desktop turn must never reach.
    if (path.endsWith("/prompt")) {
      prompts++;
      res.statusCode = 409;
      return res.end(JSON.stringify({ ok: false, code: "provider_not_configured", message: "Prompting is locked until Claude Code is configured on the Agents page." }));
    }
    if (path === "/boxes" && req.method === "POST") {
      boxesCreated++;
      const row = { id: ["bx_23456789", "bx_3456789a"][rows.length]!, name: body.name, state: "idle" }; rows.push(row);
      return res.end(JSON.stringify({ box: row }));
    }
    if (path === "/boxes") return res.end(JSON.stringify({ boxes: rows }));
    if (path.endsWith("/commands")) { commands.push(String(body.command)); return res.end(JSON.stringify({ exitCode: 0, stdout: "captured", stderr: "" })); }
    if (path.endsWith("/artifacts")) { res.setHeader("content-type", "image/jpeg"); return res.end(JPEG); }
    if (path.endsWith("/desktop")) return res.end(JSON.stringify(failNewBoat ? {} : { desktopUrl: "https://desktop.fixture.invalid" }));
    const row = rows.find(entry => path === "/boxes/" + entry.id);
    if (row) {
      if (req.method === "DELETE" && failNewBoat) { res.statusCode = 500; return res.end(JSON.stringify({ ok: false, message: "fixture refused delete" })); }
      if (req.method === "PATCH" && typeof body.name === "string") row.name = body.name;
      return res.end(JSON.stringify({ box: row }));
    }
    res.end("{}");
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("fixture failed to bind");
  const origin = `http://127.0.0.1:${address.port}`;
  const gate = join(await import("node:os").then(os => os.tmpdir()), `omb-hosted-desktop-gate-${process.pid}-${Date.now()}`);
  // Each turn on the cloud computer uses it, as a real model would: its first
  // computer call is what creates or wakes the Boat.
  const fixture = await launchVerificationServer({ FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: gate, FAKE_CLAUDE_USES_CLOUD_COMPUTER: "1" },
    undefined, undefined, undefined, undefined, undefined, [], origin).catch(async error => {
    upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); throw error;
  });
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(fixture.info.url + path, { method, headers: { "content-type": "application/json", origin: fixture.info.url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  };
  const apiOk = async (method: string, path: string, body?: unknown) => {
    const result = await api(method, path, body);
    expect(result.status, `${method} ${path}: ${JSON.stringify(result.body)}`).toBeLessThan(400);
    return result.body;
  };
  const control = (args: string[]) => runControlOmb([...args, "--url", fixture.info.url]) as Promise<any>;
  // The rows a person reads; a turn's digest comes after them.
  const lastRows = async (thread: string) => (await apiOk("GET", `/api/threads/${thread}/messages?limit=30`)).messages
    .filter((message: any) => message.kind !== "digest")
    .map((message: any) => message.kind === "activity" ? String(message.tool?.name) : `${message.role}:${message.kind}`);
  const task = async (botId: string, threadId: string) =>
    (await apiOk("GET", "/api/bots")).bots.find((bot: any) => bot.id === botId).tasks.find((entry: any) => entry.threadId === threadId);
  const dump = async () => {
    await expect.poll(() => existsSync(fixture.fixtureDumpPath), { timeout: 15_000 }).toBe(true);
    let parsed: any = null;
    await expect.poll(() => {
      try { parsed = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")); return true; } catch { return false; }
    }, { timeout: 5_000 }).toBe(true);
    return parsed;
  };
  const finish = async (botId: string, threadId: string) => {
    writeFileSync(gate, "finish");
    expect((await control(["wait", "--bot", botId, "--task", threadId, "--timeout", "30"])).status).toBe("settled");
    rmSync(gate, { force: true });
  };
  /** One Hosted desktop turn: the bot's own engine, the cloud computer as a
   * stdio server, its tools reaching the Boat, refused once the turn ends. */
  const hostedTurn = async (botId: string, threadId: string, model: string) => {
    rmSync(fixture.fixtureDumpPath, { force: true });
    const before = commands.length;
    await control(["send", "--bot", botId, "--task", threadId, "--text", "Take a screenshot of the hosted desktop."]);
    // 1. The bot's own engine and model; Boat's runner is never asked (the
    // incident: the turn went to /prompt and came back provider_not_configured).
    await expect.poll(() => existsSync(fixture.fixtureDumpPath) || prompts > 0, { timeout: 15_000 }).toBe(true);
    expect(prompts, "the turn was handed to Boat's own runner").toBe(0);
    const sent = await dump();
    expect(sent.argv[sent.argv.indexOf("--model") + 1]).toBe(model);
    expect(sent.systemPrompt).toContain("You control the assigned cloud computer");
    // 2. The cloud computer is one more stdio computer server, and the agent
    // process holds only a turn-scoped capability, never a Boat credential.
    const computer = sent.mcpConfig.mcpServers.computer;
    expect(computer.args).toEqual([expect.stringMatching(/harness-mcp-proxy\.(?:ts|js)$/), "computer"]);
    expect(computer.env.OMB_MCP_TOKEN).toEqual(expect.any(String));
    expect(computer.env.OMB_HARNESS_URL).toBe(fixture.info.url);
    expect(JSON.stringify(sent)).not.toContain(BOAT_TOKEN);
    expect(Object.keys(sent.env).filter(key => /BOAT|BOX_TOKEN|OMB_CLOUD/.test(key))).toEqual([]);
    // Pre-allowed like any isolated computer: no new approval prompts.
    expect(sent.argv[sent.argv.indexOf("--allowedTools") + 1].split(",")).toContain("mcp__computer");
    // 3. Its tools reach this bot's Boat through the harness.
    const client = mcpClient(computer);
    try {
      expect((await client.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "fixture", version: "1" } })).result.serverInfo.name).toBe("openmausbot-computer");
      expect((await client.request("tools/list")).result.tools).toHaveLength(10);
      const shot = await client.request("tools/call", { name: "screenshot", arguments: {} });
      expect(shot.result.content[0]).toMatchObject({ type: "image", mimeType: "image/jpeg" });
      const exec = await client.request("tools/call", { name: "exec", arguments: { command: "printf hosted-desktop" } });
      expect(exec.result.isError).not.toBe(true);
      expect(commands.slice(before).some(command => command.includes(".model.jpg"))).toBe(true);
      expect(commands.slice(before).some(command => command.includes("printf hosted-desktop"))).toBe(true);
      // Arguments are checked before anything reaches the Boat.
      const bad = await client.request("tools/call", { name: "click", arguments: { x: "1; touch /tmp/owned", y: 2 } });
      expect(bad.result.isError).toBe(true);
      expect(commands.slice(before).some(command => command.includes("touch /tmp/owned"))).toBe(false);
      await finish(botId, threadId);
      // The capability ends with the turn.
      const afterTurn = commands.length;
      const late = await client.request("tools/call", { name: "exec", arguments: { command: "printf too-late" } });
      expect(late.result.isError).toBe(true);
      expect(commands.length).toBe(afterTurn);
    } finally { await client.close(); }
    expect(prompts).toBe(0);
  };

  try {
    const { bot } = await control(["new-bot", "--name", "Hosted fixture"]);
    const model = (await apiOk("GET", "/api/bots")).bots.find((entry: any) => entry.id === bot.id).modelSelection.model as string;
    expect(model).not.toBe("claude-fable-5");

    // Works on: Cloud, the reporter's setting.
    await apiOk("PATCH", `/api/bots/${bot.id}`, { computer: "cloud" });
    await hostedTurn(bot.id, bot.activeTaskId, model);
    expect(boxesCreated).toBe(1);
    // A new thread on the same bot.
    const fresh = (await apiOk("POST", `/api/bots/${bot.id}/tasks`, {})).task.threadId as string;
    await hostedTurn(bot.id, fresh, model);
    // A person's composer pin, with Works on back on Auto.
    await apiOk("PATCH", `/api/bots/${bot.id}`, { computer: null });
    await apiOk("PATCH", `/api/bots/${bot.id}/tasks/${bot.activeTaskId}`, { surface: "cloud" });
    await hostedTurn(bot.id, bot.activeTaskId, model);
    expect(boxesCreated).toBe(1);

    // Auto never reaches the Boat for an engine that uses it as a computer,
    // even while this bot's Boat is running: no Boat call before the engine
    // starts, and no place recorded, so a later message can't wake or
    // recreate a machine nobody chose for this conversation.
    const autoThread = (await apiOk("POST", `/api/bots/${bot.id}/tasks`, {})).task.threadId as string;
    const callsBeforeAuto = boatCalls;
    rmSync(fixture.fixtureDumpPath, { force: true });
    await control(["send", "--bot", bot.id, "--task", autoThread, "--text", "what is 2+2?"]);
    expect((await dump()).mcpConfig?.mcpServers?.computer?.args?.[1]).not.toBe("computer");
    await finish(bot.id, autoThread);
    expect(boatCalls - callsBeforeAuto, "an Auto turn read the Boat account").toBe(0);
    expect((await task(bot.id, autoThread)).surface).toBeUndefined();
    rows.length = 0; // the Boat is gone; the conversation still never creates one
    await control(["send", "--bot", bot.id, "--task", autoThread, "--text", "and 3+3?"]);
    await finish(bot.id, autoThread);
    expect(boxesCreated).toBe(1);
    expect(boatCalls - callsBeforeAuto).toBe(0);

    // A Hosted desktop turn whose new Boat can't be finished, and whose
    // rollback delete isn't confirmed, leaves the Boat fenced for deletion.
    // Its failure says what happened in plain words, with one way on and no
    // Boat jargon; an Auto turn never reads the fenced Boat, so the same
    // conversation answers again.
    failNewBoat = true;
    const { bot: fenced } = await control(["new-bot", "--name", "Fenced fixture"]);
    await apiOk("PATCH", `/api/bots/${fenced.id}`, { computer: "cloud" });
    await control(["send", "--bot", fenced.id, "--task", fenced.activeTaskId, "--text", "Use the hosted desktop."]);
    expect((await control(["wait", "--bot", fenced.id, "--task", fenced.activeTaskId, "--timeout", "30"])).status).toBe("failed");
    expect((await lastRows(fenced.activeTaskId)).at(-1)).toBe("error: Fenced fixture's cloud computer didn't start. Try again.");
    const failedRow = (await apiOk("GET", `/api/threads/${fenced.activeTaskId}/messages?limit=30`)).messages
      .filter((message: any) => message.kind !== "digest").at(-1);
    expect(failedRow.tool.place).toEqual({ state: "cc-no-start", params: { bot: "Fenced fixture" }, source: "works-on" });
    await control(["send", "--bot", fenced.id, "--task", fenced.activeTaskId, "--text", "Try the hosted desktop again."]);
    expect((await control(["wait", "--bot", fenced.id, "--task", fenced.activeTaskId, "--timeout", "30"])).status).toBe("failed");
    expect((await lastRows(fenced.activeTaskId)).at(-1)).toBe("error: Fenced fixture's previous cloud computer is still being removed. Try again.");
    await apiOk("PATCH", `/api/bots/${fenced.id}`, { computer: null });
    const callsBeforeFencedAuto = boatCalls;
    await control(["send", "--bot", fenced.id, "--task", fenced.activeTaskId, "--text", "what is 2+2?"]);
    await finish(fenced.id, fenced.activeTaskId);
    expect(boatCalls).toBe(callsBeforeFencedAuto);
    failNewBoat = false;
    expect(boxesCreated).toBe(2);

    // An engine without computer tools is refused before anything is created,
    // with the one fix (another model); Works on back to Auto also unbreaks it.
    await apiOk("PUT", "/api/config", { openaiCompat: { url: `${origin}/v1`, key: "synthetic-fixture-key", model: "tools-off-model" } });
    await apiOk("PATCH", "/api/instances/openaiCompat", { tools: false });
    const { bot: plain } = await control(["new-bot", "--name", "Tools-off fixture"]);
    await control(["set-model", "--bot", plain.id, "--instance", "openaiCompat", "--model", "tools-off-model"]);
    await apiOk("PATCH", `/api/bots/${plain.id}`, { computer: "cloud" });
    await control(["send", "--bot", plain.id, "--task", plain.activeTaskId, "--text", "hello"]);
    expect((await control(["wait", "--bot", plain.id, "--task", plain.activeTaskId, "--timeout", "30"])).status).toBe("failed");
    expect((await lastRows(plain.activeTaskId)).at(-1)).toBe("error: tools-off-model can't use a computer. Choose a model that can, such as Claude or ChatGPT. Choose another model in Tools-off fixture's settings.");
    expect(boxesCreated).toBe(2);
    expect((await task(plain.id, plain.activeTaskId)).busy).toBe(false);
    // A cloud routine is refused by the same rule, with the same fix.
    const { routine } = await apiOk("POST", "/api/routines", { name: "Tools-off cloud", botId: plain.id,
      prompt: "Inspect the cloud desktop.", runOn: "cloud", enabled: false,
      schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 } });
    const { run } = await apiOk("POST", `/api/routines/${routine.id}/run`, {});
    let routineThread = "";
    await expect.poll(async () => {
      routineThread = (await apiOk("GET", "/api/routines")).runs.find((entry: any) => entry.id === run.id)?.threadId ?? "";
      return routineThread;
    }, { timeout: 15_000 }).not.toBe("");
    expect((await control(["wait", "--bot", plain.id, "--task", routineThread, "--timeout", "30"])).status).toBe("failed");
    expect((await lastRows(routineThread)).at(-1)).toBe("error: tools-off-model can't use a computer. Choose a model that can, such as Claude or ChatGPT. Choose another model in Tools-off fixture's settings.");
    expect(boxesCreated).toBe(2);
    await apiOk("PATCH", `/api/bots/${plain.id}`, { computer: null });
    await control(["send", "--bot", plain.id, "--task", plain.activeTaskId, "--text", "hello again"]);
    expect((await control(["wait", "--bot", plain.id, "--task", plain.activeTaskId, "--timeout", "30"])).status).toBe("settled");
    expect(prompts).toBe(0);
  } finally {
    rmSync(gate, { force: true });
    await fixture.close();
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
}, 180_000);
