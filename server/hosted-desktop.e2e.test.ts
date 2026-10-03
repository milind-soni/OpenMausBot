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
  const upstream = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://fixture").pathname;
    let raw = ""; for await (const part of req) raw += part;
    const body = raw ? JSON.parse(raw) : {};
    res.setHeader("content-type", "application/json");
    if (path === "/v1/models") return res.end(JSON.stringify({ data: [{ id: "tools-off-model" }] }));
    if (path === "/v1/chat/completions") {
      res.setHeader("content-type", "text/event-stream");
      return res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "Fixture reply" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
    }
    if (path === "/api/provider-models") return res.end(JSON.stringify({ "claude-code": { models: [{ id: "claude-fable-5" }] } }));
    if (path === "/me") return res.end(JSON.stringify({ ok: true }));
    // Boat's own runner: the one thing a Hosted desktop turn must never reach.
    if (path.endsWith("/prompt")) {
      prompts++;
      res.statusCode = 409;
      return res.end(JSON.stringify({ ok: false, code: "provider_not_configured", message: "Prompting is locked until Claude Code is configured on the Agents page." }));
    }
    if (path === "/boxes" && req.method === "POST") {
      boxesCreated++;
      const row = { id: "bx_23456789", name: body.name, state: "idle" }; rows.push(row);
      return res.end(JSON.stringify({ box: row }));
    }
    if (path === "/boxes") return res.end(JSON.stringify({ boxes: rows }));
    if (path.endsWith("/commands")) { commands.push(String(body.command)); return res.end(JSON.stringify({ exitCode: 0, stdout: "captured", stderr: "" })); }
    if (path.endsWith("/artifacts")) { res.setHeader("content-type", "image/jpeg"); return res.end(JPEG); }
    if (path.endsWith("/desktop")) return res.end(JSON.stringify({ desktopUrl: "https://desktop.fixture.invalid" }));
    const row = rows.find(entry => path === "/boxes/" + entry.id);
    if (row) {
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
  const fixture = await launchVerificationServer({ FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: gate },
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
  const lastRows = async (thread: string) => (await apiOk("GET", `/api/threads/${thread}/messages?limit=30`)).messages
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

    // An engine without computer tools is refused before anything is created,
    // with the one setting that changes it; that setting unbreaks the bot.
    await apiOk("PUT", "/api/config", { openaiCompat: { url: `${origin}/v1`, key: "synthetic-fixture-key", model: "tools-off-model" } });
    await apiOk("PATCH", "/api/instances/openaiCompat", { tools: false });
    const { bot: plain } = await control(["new-bot", "--name", "Tools-off fixture"]);
    await control(["set-model", "--bot", plain.id, "--instance", "openaiCompat", "--model", "tools-off-model"]);
    await apiOk("PATCH", `/api/bots/${plain.id}`, { computer: "cloud" });
    await control(["send", "--bot", plain.id, "--task", plain.activeTaskId, "--text", "hello"]);
    expect((await control(["wait", "--bot", plain.id, "--task", plain.activeTaskId, "--timeout", "30"])).status).toBe("failed");
    expect((await lastRows(plain.activeTaskId)).at(-1)).toBe("error: This model can't use a computer. Choose another model, or set Works on to Auto.");
    expect(boxesCreated).toBe(1);
    expect((await task(plain.id, plain.activeTaskId)).busy).toBe(false);
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
