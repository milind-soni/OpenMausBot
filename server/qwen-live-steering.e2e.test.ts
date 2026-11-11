import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { LIVE_COPY } from "../shared/live-approval.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import { startFakeOpenAiLive, type FakeOpenAiLive } from "./testing/fake-openai-live.ts";
import { openSse } from "./testing/sse.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
type Bot = { id: string; threadId: string };
type Line = { id: string; role: string; kind: string; text?: string; steered?: boolean; via?: string; callId?: string; queueId?: string; requestMessageId?: string; turnTerminal?: boolean };
type Provider = { socket: WebSocket; commands: Record<string, unknown>[] };

describe.skipIf(process.platform === "win32")("Qwen spoken sends during a real engine turn", () => {
  let child: ChildProcess;
  let home = "";
  let base = "";
  let output = "";
  let gate = "";
  let steered = "";
  let upstream: WebSocketServer;
  let openai: FakeOpenAiLive;
  const providers: Provider[] = [];
  let requestNumber = 0;

  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
    return { status: response.status, body: await response.json() as any };
  };
  const botState = async (bot: Bot) => (await api("GET", "/api/bots")).body.bots.find((value: Bot) => value.id === bot.id);
  const lines = async (bot: Bot): Promise<Line[]> => (await botState(bot)).messages;
  const command = (bot: Bot, action: "continuation" | "owner" | "hold-steer-ack" | "release-steer-ack" | "steer-state", text = "fixture continuation") => new Promise<{ requestMessageId: string | null; steerCalls: number; ackHeld: boolean }>((resolve, reject) => {
    const id = ++requestNumber;
    const timer = setTimeout(() => { child.off("message", received); reject(new Error(`fixture IPC timed out: ${output.slice(-1_000)}`)); }, 5_000);
    const received = (message: any) => {
      if (message.fixture !== "qwen-steering" || message.id !== id) return;
      clearTimeout(timer); child.off("message", received); resolve(message);
    };
    child.on("message", received);
    child.send({ fixture: "qwen-steering", id, action, botId: bot.id, threadId: bot.threadId, text });
  });
  const createBot = async () => {
    rmSync(gate, { force: true }); rmSync(steered, { force: true });
    const created = await api("POST", "/api/bots", { name: "Qwen steering fixture" });
    expect(created.status).toBe(201);
    const bot = created.body.bot as Bot;
    expect((await api("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: "steer", model: "claude-fake" } })).status).toBe(200);
    return bot;
  };
  const working = async (bot: Bot) => {
    await expect.poll(async () => (await lines(bot)).some(line => line.kind === "activity"), { timeout: 15_000 }).toBe(true);
    expect((await botState(bot)).busy).toBe(true);
  };
  const sendProvider = (provider: Provider, event: Record<string, unknown>) => provider.socket.send(JSON.stringify(event));
  const speak = (provider: Provider, id: string, text: string) => {
    for (const event of [
      { type: "input_audio_buffer.speech_started", item_id: id, audio_start_ms: 0 },
      { type: "input_audio_buffer.speech_stopped", item_id: id, audio_end_ms: 100 },
      { type: "input_audio_buffer.committed", item_id: id },
      { type: "response.created", response: { id: `r-${id}` } },
      { type: "conversation.item.input_audio_transcription.completed", item_id: id, transcript: text },
      { type: "response.function_call_arguments.done", response_id: `r-${id}`, call_id: id, name: "delegate_to_bot", arguments: "{}" },
      { type: "response.done", response: { id: `r-${id}`, status: "completed" } },
    ]) sendProvider(provider, event);
  };
  const results = (provider: Provider, id: string) => provider.commands
    .filter(event => event.type === "conversation.item.create")
    .map(event => event.item as { call_id?: string; output?: string })
    .filter(item => item.call_id === id && item.output)
    .map(item => JSON.parse(item.output!) as { status: string; result: string; request_id: string });
  const startQwen = async (bot: Bot) => {
    expect((await api("PATCH", "/api/live/settings", { provider: "qwen" })).status).toBe(200);
    const count = providers.length;
    const started = await api("POST", "/api/live/session", { botId: bot.id, client: "web", transports: ["ws-pcm"], sdp: "fixture-offer-discarded" });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    const callId = started.body.call.callId as string;
    await expect.poll(() => providers.length).toBe(count + 1);
    const provider = providers[count];
    const media = new WebSocket(`${base.replace(/^http/, "ws")}/api/live/media`);
    const ready = new Promise<void>((resolve) => media.on("message", data => { if (JSON.parse(String(data)).type === "media.ready") resolve(); }));
    await once(media, "open"); media.send(JSON.stringify({ type: "bind", callId })); await ready;
    return { provider, callId, close: async () => { await api("POST", "/api/live/call/end", { callId }); media.terminate(); } };
  };

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "omb-qwen-steering-"));
    const dataDir = join(home, ".openmausbot"); mkdirSync(dataDir);
    gate = join(home, "finish.gate"); steered = join(home, "steer.received");
    upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(upstream, "listening");
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("fixture needs a loopback port");
    upstream.on("connection", socket => {
      const provider = { socket, commands: [] as Record<string, unknown>[] }; providers.push(provider);
      let readout = 0;
      socket.on("message", data => {
        const event = JSON.parse(String(data)); provider.commands.push(event);
        if (event.type === "session.update") sendProvider(provider, { type: "session.updated" });
        if (event.type === "response.create") {
          const id = `readout-${++readout}`;
          sendProvider(provider, { type: "response.created", response: { id } });
          sendProvider(provider, { type: "response.done", response: { id, status: "completed" } });
        }
      });
    });
    openai = await startFakeOpenAiLive();
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({
      features: { llmThreadTitles: false },
      live: { provider: "openai", qwen: { enabled: true, key: "qwen-isolated-fixture", keyFor: "qwen:dashscope.aliyuncs.com" } },
      instances: { steer: { driver: "claudeAgent", config: { cli: join(SERVER_DIR, "testing/fake-claude-cli.ts"), permissionMode: "bypassPermissions" },
        environment: { FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: gate, FAKE_CLAUDE_STEER_RECEIVED: steered } } },
    }));
    const port = await freePortBlock([0, 1]); base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ["--import", join(SERVER_DIR, "testing/qwen-live-steering-hooks.mjs"), join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."), stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, OMB_DATA_DIR: dataDir, OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1),
        OMB_TEST_QWEN_STEERING: "1", OMB_TEST_QWEN_UPSTREAM: `ws://127.0.0.1:${address.port}`,
        OMB_OPENAI_LIVE_URL: openai.url, OMB_OPENAI_LIVE_KEY: "openai-isolated-fixture" },
    });
    child.stdout!.on("data", value => { output += value; }); child.stderr!.on("data", value => { output += value; });
    child.on("message", (message: any) => { if (message.error) output += message.error; });
    await vi.waitFor(async () => {
      if (child.exitCode !== null) throw new Error(`fixture exited: ${output.slice(-3_000)}`);
      expect((await fetch(`${base}/api/health`)).ok).toBe(true);
    }, { timeout: 25_000, interval: 100 });
  }, 35_000);

  afterAll(async () => {
    if (child) await waitForExit(child, { signal: "SIGTERM" });
    for (const provider of providers) provider.socket.terminate();
    if (upstream) await new Promise<void>(resolve => upstream.close(() => resolve()));
    await openai?.stop();
    if (home) await removeTempDir(home);
  });

  it("queues Qwen before steering an unassociated card continuation, then reads the queued request's own terminal result", async () => {
    const bot = await createBot();
    const sse = await openSse(`${base}/api/events`);
    let call: Awaited<ReturnType<typeof startQwen>> | undefined;
    try {
      await command(bot, "continuation"); await working(bot);
      expect((await command(bot, "owner")).requestMessageId).toBeNull();
      call = await startQwen(bot);
      speak(call.provider, "queued-speech", "the queued spoken fixture request");
      const decision = await sse.until(frame => (frame.kind === "bot.queued" && (frame.queues?.[bot.threadId] ?? []).some((item: any) => item.text === "the queued spoken fixture request"))
        || (frame.kind === "message" && frame.threadId === bot.threadId && frame.message?.text === "the queued spoken fixture request"));
      expect(decision.kind).toBe("bot.queued");
      expect(existsSync(steered)).toBe(false);
      expect((await lines(bot)).some(line => line.text === "the queued spoken fixture request")).toBe(false);
      writeFileSync(gate, "finish");
      const requested = await sse.until(frame => frame.kind === "message" && frame.threadId === bot.threadId && frame.message?.text === "the queued spoken fixture request");
      expect(requested.message).toMatchObject({ via: "call", callId: call.callId, queueId: expect.any(String) });
      expect(requested.message.steered).toBeUndefined();
      const terminal = await sse.until(frame => (frame.kind === "message" || frame.kind === "message.patch") && frame.threadId === bot.threadId && frame.message?.turnTerminal && frame.message.requestMessageId === requested.message.id);
      expect(terminal.message.text).toContain("the queued spoken fixture request");
      await expect.poll(() => results(call!.provider, "queued-speech").find(result => result.status === "completed"), { timeout: 10_000 }).toMatchObject({ request_id: requested.message.id, result: expect.stringContaining("the queued spoken fixture request") });
      expect(JSON.stringify(call.provider.commands)).not.toContain(LIVE_COPY.noAnswer);
    } finally { writeFileSync(gate, "finish"); sse.close(); await call?.close(); await api("POST", `/api/bots/${bot.id}/interrupt`); }
  }, 30_000);

  it("still steers Qwen into an associated running request and reads that request's result", async () => {
    const bot = await createBot();
    let call: Awaited<ReturnType<typeof startQwen>> | undefined;
    try {
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "original associated request" })).status).toBe(202);
      await working(bot);
      const owner = (await command(bot, "owner")).requestMessageId;
      expect(owner).toEqual(expect.any(String));
      call = await startQwen(bot); speak(call.provider, "steered-speech", "also add spoken totals");
      await expect.poll(async () => (await lines(bot)).find(line => line.text === "also add spoken totals"), { timeout: 10_000 }).toMatchObject({ steered: true, via: "call", callId: call.callId });
      await expect.poll(() => existsSync(steered)).toBe(true);
      writeFileSync(gate, "finish");
      await expect.poll(() => results(call!.provider, "steered-speech").find(result => result.status === "completed"), { timeout: 10_000 }).toMatchObject({ request_id: owner, result: expect.stringContaining("also add spoken totals") });
    } finally { writeFileSync(gate, "finish"); await call?.close(); await api("POST", `/api/bots/${bot.id}/interrupt`); }
  }, 30_000);

  it("pins a delayed steering receipt to the original request after a different request starts", async () => {
    const bot = await createBot();
    const spoken = "spoken addition for the original request";
    let call: Awaited<ReturnType<typeof startQwen>> | undefined;
    try {
      const original = await api("POST", `/api/bots/${bot.id}/messages`, { text: "original request before delayed acknowledgement" });
      expect(original.status).toBe(202);
      await working(bot);
      const originalId = (await command(bot, "owner")).requestMessageId;
      expect(originalId).toEqual(expect.any(String));
      await command(bot, "hold-steer-ack");
      call = await startQwen(bot);
      speak(call.provider, "delayed-steering", spoken);
      await expect.poll(async () => (await command(bot, "steer-state")).ackHeld, { timeout: 10_000 }).toBe(true);
      expect((await command(bot, "steer-state")).steerCalls).toBe(1);
      await expect.poll(() => existsSync(steered)).toBe(true);
      writeFileSync(gate, "finish");
      await expect.poll(async () => (await lines(bot)).find(line => line.turnTerminal && line.requestMessageId === originalId), { timeout: 10_000 })
        .toMatchObject({ text: expect.stringContaining(spoken) });
      await expect.poll(async () => (await botState(bot)).busy).toBe(false);
      rmSync(gate, { force: true });
      const later = await api("POST", `/api/bots/${bot.id}/messages`, { text: "unrelated later request" });
      expect(later.status).toBe(202);
      const laterId = (await command(bot, "owner")).requestMessageId;
      expect(laterId).toEqual(expect.any(String));
      expect(laterId).not.toBe(originalId);
      expect((await botState(bot)).busy).toBe(true);
      await command(bot, "release-steer-ack");
      await expect.poll(async () => (await lines(bot)).filter(line => line.text === spoken)).toHaveLength(1);
      const spokenLine = (await lines(bot)).find(line => line.text === spoken)!;
      expect(spokenLine).toMatchObject({ steered: true, via: "call", callId: call.callId });
      expect(spokenLine.queueId).toBeUndefined();
      expect((await command(bot, "steer-state")).steerCalls).toBe(1);
      writeFileSync(gate, "finish");
      await expect.poll(async () => (await lines(bot)).some(line => line.turnTerminal && line.requestMessageId === laterId), { timeout: 10_000 }).toBe(true);
      await expect.poll(() => results(call!.provider, "delayed-steering").find(result => result.status === "completed"), { timeout: 10_000 })
        .toMatchObject({ request_id: originalId, result: expect.stringContaining(spoken) });
      expect(results(call.provider, "delayed-steering").filter(result => result.status === "completed")).toHaveLength(1);
      expect(results(call.provider, "delayed-steering").some(result => result.request_id === laterId)).toBe(false);
      expect((await lines(bot)).filter(line => line.text === spoken)).toHaveLength(1);
      expect(JSON.stringify(call.provider.commands)).not.toContain(LIVE_COPY.noAnswer);
    } finally {
      await command(bot, "release-steer-ack");
      writeFileSync(gate, "finish");
      await call?.close();
      await api("POST", `/api/bots/${bot.id}/interrupt`);
    }
  }, 40_000);

  it("preserves typed steering into a continuation without a request ID", async () => {
    const bot = await createBot();
    try {
      await command(bot, "continuation"); await working(bot);
      expect((await command(bot, "owner")).requestMessageId).toBeNull();
      const sent = await api("POST", `/api/bots/${bot.id}/messages`, { text: "typed continuation steering" });
      expect(sent.status).toBe(202); expect(sent.body.steered).toBe(true);
      await expect.poll(() => existsSync(steered)).toBe(true);
    } finally { writeFileSync(gate, "finish"); await api("POST", `/api/bots/${bot.id}/interrupt`); }
  }, 30_000);

  it.each(["openai", "qwen"] as const)("keeps %s call history after the newest fresh-start divider", async providerName => {
    const bot = await createBot();
    let callId: string | undefined;
    let qwen: Awaited<ReturnType<typeof startQwen>> | undefined;
    try {
      writeFileSync(gate, "finish");
      const send = async (text: string) => {
        expect((await api("POST", `/api/bots/${bot.id}/messages`, { text })).status).toBe(202);
        await expect.poll(async () => (await lines(bot)).some(line => line.turnTerminal && line.text?.includes(text)), { timeout: 10_000 }).toBe(true);
        await expect.poll(async () => (await botState(bot)).busy).toBe(false);
      };
      await send("FRESH_HISTORY_OLD_ONLY");
      const reset = await api("POST", `/api/bots/${bot.id}/start-fresh`, { threadId: bot.threadId });
      expect(reset.status).toBe(200);
      expect(reset.body.message.compaction.fresh).toBe(true);
      await send("FRESH_HISTORY_CURRENT");
      expect((await lines(bot)).some(line => line.text === "FRESH_HISTORY_OLD_ONLY")).toBe(true);

      let history: unknown;
      if (providerName === "qwen") {
        qwen = await startQwen(bot);
        history = qwen.provider.commands.filter(event => event.type === "conversation.item.create").map(event => event.item);
      } else {
        expect((await api("PATCH", "/api/live/settings", { provider: "openai" })).status).toBe(200);
        const count = openai.sessions.length;
        const started = await api("POST", "/api/live/session", { botId: bot.id, client: "web", sdp: "v=0\r\n" });
        expect(started.status, JSON.stringify(started.body)).toBe(201);
        callId = started.body.call.callId;
        const session = openai.sessions[count];
        await openai.waitForAttach(session.id);
        history = (session.body.session as { input?: unknown }).input;
      }
      expect(JSON.stringify(history)).toContain("FRESH_HISTORY_CURRENT");
      expect(JSON.stringify(history)).not.toContain("FRESH_HISTORY_OLD_ONLY");
    } finally {
      await qwen?.close();
      if (callId) expect((await api("POST", "/api/live/call/end", { callId })).status).toBe(200);
      await api("POST", `/api/bots/${bot.id}/interrupt`);
    }
  }, 30_000);

  it("preserves OpenAI spoken steering into a continuation without a request ID", async () => {
    const bot = await createBot();
    let callId: string | undefined;
    try {
      await command(bot, "continuation"); await working(bot);
      expect((await command(bot, "owner")).requestMessageId).toBeNull();
      expect((await api("PATCH", "/api/live/settings", { provider: "openai" })).status).toBe(200);
      const count = openai.sessions.length;
      const started = await api("POST", "/api/live/session", { botId: bot.id, client: "web", sdp: "v=0\r\n" });
      expect(started.status, JSON.stringify(started.body)).toBe(201); callId = started.body.call.callId;
      const session = openai.sessions[count]; await openai.waitForAttach(session.id);
      openai.emit(session.id, { type: "session.input_transcript.delta", delta: "OpenAI continuation steering", start_ms: 0, end_ms: 100 });
      openai.emit(session.id, { type: "session.delegation.created", offset_ms: 100, delegation: { id: "openai-speech", target: "client" } });
      await expect.poll(async () => (await lines(bot)).find(line => line.text === "OpenAI continuation steering"), { timeout: 10_000 }).toMatchObject({ steered: true, via: "call", callId });
      await expect.poll(() => existsSync(steered)).toBe(true);
    } finally { writeFileSync(gate, "finish"); if (callId) await api("POST", "/api/live/call/end", { callId }); await api("POST", `/api/bots/${bot.id}/interrupt`); }
  }, 30_000);
});
