// POSIX-gated: the fakes are shebang scripts.
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LIVE_COPY } from "../shared/live-approval.ts";
import { cloudPairingSignature } from "./cloud-home.ts";
import { CLOUD_HOME_PLACE } from "./system-prompt.ts";
import type { LiveCallState } from "../shared/wire.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { startFakeOpenAiLive, type FakeOpenAiLive } from "./testing/fake-openai-live.ts";
import { freePortBlock } from "./testing/ports.ts";
import { openSse } from "./testing/sse.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const FAKE_ACP = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const FAKE_CODEX = join(SERVER_DIR, "testing", "fake-codex-app-server.ts");
const LIVE_KEY = "sk-fake-e2e";
const SDP = "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n";
const posixOnly = describe.skipIf(process.platform === "win32");

posixOnly("Live call e2e", () => {
  let child: ChildProcess;
  let home = "";
  let base = "";
  let output = "";
  let live: FakeOpenAiLive;
  /** while missing, the `steer` engine holds its turn open after its tool result */
  let steerGate = "";
  /** the fake claude's one-shot replies, by a marker in the prompt */
  let titleRoutes = "";
  /** while present, the `codexQueue` engine refuses a live steer */
  let queueSteerGate = "";

  const serverOutput = () => output;
  const post = async (path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: unknown }> => {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  const createBot = async (instanceId = "claude", model = "claude-fake"): Promise<{ id: string; threadId: string; name: string }> => {
    const { bot } = (await post("/api/bots", {})).body as { bot: { id: string; threadId: string; name: string } };
    const res = await fetch(`${base}/api/bots/${bot.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      // On Ask: the calls read cards aloud, and the Slack-style relay expects Ask.
      body: JSON.stringify({ modelSelection: { instanceId, model }, approvalMode: "ask" }),
    });
    expect(res.status).toBe(200);
    return bot;
  };
  const isBusy = async (botId: string): Promise<boolean> => {
    const { bots } = (await (await fetch(`${base}/api/bots`)).json()) as { bots: Array<{ id: string; busy?: boolean }> };
    return bots.find((bot) => bot.id === botId)?.busy === true;
  };
  const spokenTurnsLogged = () => serverOutput().split("text=(spoken)").length - 1;
  const startCall = async (botId: string, client: LiveCallState["client"] = "desktop") => {
    const before = live.sessions.length;
    const started = await post("/api/live/session", { botId, sdp: SDP, client });
    expect(started.status).toBe(201);
    const { call } = started.body as { call: LiveCallState };
    const session = live.sessions[before];
    expect(session).toBeDefined();
    return { started, call, session };
  };
  const setGeneratedTitles = async (on: boolean) => {
    const res = await fetch(`${base}/api/config`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ features: { llmThreadTitles: on } }),
    });
    expect(res.status).toBe(200);
  };

  beforeAll(async () => {
    chmodSync(FAKE_CLAUDE, 0o755);
    chmodSync(FAKE_ACP, 0o755);
    chmodSync(FAKE_CODEX, 0o755);
    live = await startFakeOpenAiLive();
    home = mkdtempSync(join(tmpdir(), "omb-live-call-"));
    mkdirSync(join(home, ".openmausbot"), { recursive: true });
    steerGate = join(home, "steer.gate");
    titleRoutes = join(home, "title-routes.json");
    writeFileSync(titleRoutes, JSON.stringify({ "Requests:\nwhat is six times seven": "Times table question" }));
    queueSteerGate = join(home, "queue-steer.gate");
    writeFileSync(
      join(home, ".openmausbot", "config.json"),
      JSON.stringify({
        instances: {
          claude: {
            driver: "claudeAgent",
            environment: { FAKE_CLAUDE_REPLIES: JSON.stringify(["Six times seven is 42."]), FAKE_CLAUDE_TEXT_ROUTES: titleRoutes },
            config: { cli: FAKE_CLAUDE, permissionMode: "bypassPermissions" },
          },
          // pauses after its tool result until steerGate exists, so a request spoken then is steered into the running turn
          steer: {
            driver: "claudeAgent",
            environment: { FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: steerGate },
            config: { cli: FAKE_CLAUDE, permissionMode: "bypassPermissions" },
          },
          // cannot steer and never finishes: a request made while it works waits in the queue
          acp: { driver: "grokAgent", environment: { FAKE_ACP_MODE: "hang" }, config: { cli: FAKE_ACP, fullAuto: true } },
          // parks its turn on a question and can steer, but refuses while queueSteerGate exists
          codexQueue: {
            driver: "codex",
            environment: { FAKE_CODEX_MODE: "question", FAKE_CODEX_ASK_HOLD: "1", FAKE_CODEX_STEER_ERROR_FILE: queueSteerGate },
            config: { cli: FAKE_CODEX },
          },
          // every turn asks permission to run a command
          asks: { driver: "grokAgent", environment: { FAKE_ACP_MODE: "permission" }, config: { cli: FAKE_ACP, fullAuto: false } },
          questions: { driver: "grokAgent", environment: { FAKE_ACP_MODE: "question" }, config: { cli: FAKE_ACP, fullAuto: false } },
        },
      }),
    );
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        HOME: home,
        USERPROFILE: home,
        OMB_PORT: String(port),
        OMB_WEBHOOK_PORT: String(port + 1),
        OMB_OPENAI_LIVE_URL: live.url,
        OMB_OPENAI_LIVE_KEY: LIVE_KEY,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", (chunk) => (output += chunk));
    child.stderr!.on("data", (chunk) => (output += chunk));
    // Generous: a loaded machine can take most of a minute to boot the harness.
    const deadline = Date.now() + 90_000;
    for (;;) {
      try {
        if ((await fetch(`${base}/api/health`)).ok) break;
      } catch {
      }
      if (Date.now() > deadline) throw new Error(`server never came up. output:\n${output}`);
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. output:\n${output}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }, 120_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await live?.stop();
    if (home) await removeTempDir(home);
  });

  it("runs a spoken request through the bot and speaks the answer", async () => {
    const bot = await createBot();
    const sse = await openSse(`${base}/api/events`);
    try {
      const { started, call, session } = await startCall(bot.id);
      expect(JSON.stringify(started.body)).not.toContain(LIVE_KEY);
      expect(call).toMatchObject({ botId: bot.id, threadId: bot.threadId, client: "desktop" });
      expect(session.body).toMatchObject({ session: { client: { data_channel: { allowed_client_events: ["session.close"] } } } });
      expect((session.body.session as { instructions: string }).instructions).toContain("runs in OpenMausBot on the user's own computer.");
      await live.waitForAttach(session.id);
      await sse.until((frame) => frame.kind === "live.call" && frame.call?.callId === call.callId && frame.call?.status === "live");

      live.emit(session.id, { type: "session.input_transcript.delta", delta: "what is six times seven", start_ms: 100, end_ms: 900 });
      live.emit(session.id, { type: "session.delegation.created", offset_ms: 950, delegation: { id: "del_1", target: "client", type: "delegation" } });

      const asked = await sse.until(
        (frame) => frame.kind === "message" && frame.threadId === bot.threadId && frame.message?.role === "user" && frame.message?.via === "call",
      );
      expect(asked.message.text).toBe("what is six times seven");
      expect(asked.message.callId).toBe(call.callId);
      const spoken = await live.waitForCommand(session.id, (c) => c.type === "session.commentary.append" && String(c.content).includes("42"), 20_000);
      expect(spoken.delegation_id).toBe("del_1");

      const ended = await post("/api/live/call/end", { callId: call.callId });
      expect(ended).toMatchObject({ status: 200, body: { call: { status: "ended", endReason: "hung-up" } } });
      expect(session.commands.some((c) => c.type === "session.close")).toBe(true);
      await sse.until((frame) => frame.kind === "live.call" && frame.call?.callId === call.callId && frame.call?.status === "ended");
      const row = await sse.until((frame) => frame.kind === "message" && frame.threadId === bot.threadId && frame.message?.kind === "call");
      expect(row.message).toMatchObject({
        role: "bot",
        text: `Call with ${bot.name} · 0:42`,
        call: { callId: call.callId, botId: bot.id, client: "desktop", startedAt: call.startedAt, seconds: 42, endReason: "hung-up" },
      });
      expect(row.message.call.endedAt).toBeGreaterThanOrEqual(call.startedAt);
      expect(JSON.stringify(row.message)).not.toMatch(/six times seven/i);
      const { messages } = (await (await fetch(`${base}/api/threads/${bot.threadId}/messages`)).json()) as { messages: Array<{ kind: string; call?: { callId: string } }> };
      expect(messages.filter((message) => message.kind === "call" && message.call?.callId === call.callId)).toHaveLength(1);
      // The pipe can deliver the summary line a moment after the HTTP answer.
      await expect.poll(serverOutput, { timeout: 5_000 }).toMatch(/\[live\] call ended bot=\S+ .*client=desktop .*end=hung-up/);
      expect(serverOutput()).toContain("text=(spoken)");
      expect(serverOutput()).not.toMatch(/six times seven/i);
      expect(serverOutput()).not.toContain(LIVE_KEY);
      expect(JSON.stringify(sse.frames)).not.toContain(LIVE_KEY);
    } finally {
      sse.close();
    }
  }, 40_000);

  it("answers 409 with the running call to a second client", async () => {
    const bot = await createBot();
    const { call, session } = await startCall(bot.id, "web");
    await live.waitForAttach(session.id);

    const second = await post("/api/live/session", { botId: bot.id, sdp: SDP, client: "ios" });
    expect(second.status).toBe(409);
    expect((second.body as { activeCall: LiveCallState }).activeCall).toMatchObject({ callId: call.callId, client: "web" });
    expect(live.sessions.at(-1)).toBe(session);

    const ended = await post("/api/live/call/end", { callId: call.callId });
    expect(ended).toMatchObject({ status: 200, body: { call: { callId: call.callId, status: "ended" } } });
  }, 40_000);

  it("queues a spoken request while the bot is busy, and the drained turn still keeps the words out of the log", async () => {
    const bot = await createBot("acp", "fake-model");
    const sse = await openSse(`${base}/api/events`);
    try {
      expect((await post(`/api/bots/${bot.id}/messages`, { text: "first" })).status).toBe(202);
      await expect.poll(() => isBusy(bot.id), { timeout: 20_000 }).toBe(true);
      const { call, session } = await startCall(bot.id);
      await live.waitForAttach(session.id);

      live.emit(session.id, { type: "session.input_transcript.delta", delta: "spell the word banana", start_ms: 100, end_ms: 900 });
      live.emit(session.id, { type: "session.delegation.created", offset_ms: 950, delegation: { id: "del_q", target: "client", type: "delegation" } });
      await sse.until(
        (frame) => frame.kind === "bot.queued" && (frame.queues?.[bot.threadId] ?? []).some((item: { text?: string }) => item.text === "spell the word banana"),
        20_000,
      );

      const logged = spokenTurnsLogged();
      await post(`/api/bots/${bot.id}/interrupt`, {});
      const drained = await sse.until(
        (frame) => frame.kind === "message" && frame.threadId === bot.threadId && frame.message?.text === "spell the word banana",
        20_000,
      );
      expect(drained.message).toMatchObject({ role: "user", via: "call", callId: call.callId });
      await expect.poll(spokenTurnsLogged, { timeout: 10_000 }).toBeGreaterThan(logged);
      expect(serverOutput()).not.toMatch(/banana/i);

      await post(`/api/bots/${bot.id}/interrupt`, {});
      await expect.poll(() => isBusy(bot.id), { timeout: 20_000 }).toBe(false);
      expect(await post("/api/live/call/end", { callId: call.callId })).toMatchObject({ status: 200 });
    } finally {
      sse.close();
    }
  }, 60_000);

  it("stops waiting for a queued spoken request once it is cancelled in the chat", async () => {
    const bot = await createBot("acp", "fake-model");
    const sse = await openSse(`${base}/api/events`);
    try {
      const { call, session } = await startCall(bot.id);
      await live.waitForAttach(session.id);
      live.emit(session.id, { type: "session.input_transcript.delta", delta: "check the build", start_ms: 100, end_ms: 900 });
      live.emit(session.id, { type: "session.delegation.created", offset_ms: 950, delegation: { id: "del_a", target: "client", type: "delegation" } });
      await expect.poll(() => isBusy(bot.id), { timeout: 20_000 }).toBe(true);
      live.emit(session.id, { type: "session.input_transcript.delta", delta: "and the tests", start_ms: 2_000, end_ms: 2_800 });
      live.emit(session.id, { type: "session.delegation.created", offset_ms: 2_850, delegation: { id: "del_b", target: "client", type: "delegation" } });
      const waiting = await sse.until(
        (frame) => frame.kind === "bot.queued" && (frame.queues?.[bot.threadId] ?? []).some((item: { text?: string }) => item.text === "and the tests"),
        20_000,
      );
      const { queueId } = (waiting.queues[bot.threadId] as Array<{ queueId: string; text: string }>).find((item) => item.text === "and the tests")!;

      const cancelled = await fetch(`${base}/api/bots/${bot.id}/queue/${queueId}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ threadId: bot.threadId }),
      });
      expect(cancelled.status).toBe(200);
      await post(`/api/bots/${bot.id}/interrupt`, {});
      await live.waitForCommand(session.id, (c) => c.type === "session.commentary.append" && c.content === LIVE_COPY.noAnswer, 20_000);
      expect(await post("/api/live/call/end", { callId: call.callId })).toMatchObject({ status: 200 });
    } finally {
      sse.close();
    }
  }, 60_000);

  it("steers a request spoken while the bot works into its turn, with the call's id", async () => {
    rmSync(steerGate, { force: true });
    const bot = await createBot("steer", "claude-fake");
    const sse = await openSse(`${base}/api/events`);
    let callId = "";
    try {
      const { call, session } = await startCall(bot.id);
      callId = call.callId;
      await live.waitForAttach(session.id);
      expect((await post(`/api/bots/${bot.id}/messages`, { text: "start the report" })).status).toBe(202);
      await sse.until((frame) => frame.kind === "message" && frame.threadId === bot.threadId && frame.message?.kind === "activity", 20_000);
      live.emit(session.id, { type: "session.input_transcript.delta", delta: "and add the totals", start_ms: 100, end_ms: 900 });
      live.emit(session.id, { type: "session.delegation.created", offset_ms: 950, delegation: { id: "del_steer", target: "client", type: "delegation" } });
      const steered = await sse.until(
        (frame) => frame.kind === "message" && frame.threadId === bot.threadId && frame.message?.role === "user" && frame.message?.steered === true,
        20_000,
      );
      expect(steered.message).toMatchObject({ text: "and add the totals", via: "call", callId: call.callId });
    } finally {
      writeFileSync(steerGate, "finish");
      await expect.poll(() => isBusy(bot.id), { timeout: 20_000 }).toBe(false);
      if (callId) await post("/api/live/call/end", { callId });
      sse.close();
    }
  }, 60_000);

  it("keeps the call's id on a queued spoken request that is steered from the queue", async () => {
    writeFileSync(queueSteerGate, "refuse live steers until this test clears the gate");
    const { instances } = (await (await fetch(`${base}/api/instances`)).json()) as { instances: Array<{ instanceId: string; models: { default: string } }> };
    const bot = await createBot("codexQueue", instances.find((instance) => instance.instanceId === "codexQueue")!.models.default);
    type Line = { id: string; role: string; text?: string; steered?: boolean; via?: string; callId?: string; card?: { requestId?: string } };
    const lines = async (): Promise<Line[]> => ((await (await fetch(`${base}/api/threads/${bot.threadId}/messages`)).json()) as { messages: Line[] }).messages;
    const sse = await openSse(`${base}/api/events`);
    let callId = "";
    try {
      expect((await post(`/api/bots/${bot.id}/messages`, { text: "first gated turn" })).status).toBe(202);
      await expect.poll(async () => (await lines()).some((line) => line.card?.requestId), { timeout: 20_000 }).toBe(true);
      const { call, session } = await startCall(bot.id);
      callId = call.callId;
      await live.waitForAttach(session.id);

      live.emit(session.id, { type: "session.input_transcript.delta", delta: "steer these queued words", start_ms: 100, end_ms: 900 });
      live.emit(session.id, { type: "session.delegation.created", offset_ms: 950, delegation: { id: "del_queue_steer", target: "client", type: "delegation" } });
      const waiting = await sse.until(
        (frame) => frame.kind === "bot.queued" && (frame.queues?.[bot.threadId] ?? []).some((item: { text?: string }) => item.text === "steer these queued words"),
        20_000,
      );
      const { queueId } = (waiting.queues[bot.threadId] as Array<{ queueId: string; text: string }>).find((item) => item.text === "steer these queued words")!;
      expect((await lines()).some((line) => line.text === "steer these queued words")).toBe(false);

      rmSync(queueSteerGate, { force: true });
      const steered = await post(`/api/bots/${bot.id}/queue/${queueId}/steer`, { threadId: bot.threadId });
      expect(steered).toMatchObject({ status: 200, body: { ok: true, steered: true, queueIds: [queueId] } });
      const line = { text: "steer these queued words", steered: true, via: "call", callId: call.callId };
      expect((steered.body as { messages: unknown[] }).messages).toEqual([expect.objectContaining(line)]);
      expect((await lines()).find((m) => m.text === "steer these queued words")).toMatchObject(line);
    } finally {
      await post(`/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId });
      await expect.poll(() => isBusy(bot.id), { timeout: 20_000 }).toBe(false);
      if (callId) await post("/api/live/call/end", { callId });
      sse.close();
    }
  }, 60_000);

  it("ends a phone's call, and refuses it another, once the companion says it was unpaired", async () => {
    const bot = await createBot();
    const phone = { "x-openmausbot-companion": "1", "x-openmausbot-companion-device": "phone-e2e" };
    const sse = await openSse(`${base}/api/events`);
    try {
      const before = live.sessions.length;
      const started = await post("/api/live/session", { botId: bot.id, sdp: SDP, client: "ios" }, phone);
      expect(started.status).toBe(201);
      const { call } = started.body as { call: LiveCallState };
      const session = live.sessions[before];
      await live.waitForAttach(session.id);
      await sse.until((frame) => frame.kind === "live.call" && frame.call?.callId === call.callId && frame.call?.status === "live");

      expect(await post("/api/live/device-revoked", {}, { ...phone, "x-openmausbot-companion-device": "phone-other" }))
        .toEqual({ status: 200, body: { call: null } });
      expect(await post("/api/live/device-revoked", {}, phone)).toMatchObject({ status: 200, body: { call: { callId: call.callId } } });
      await live.waitForCommand(session.id, (c) => c.type === "session.close", 5_000);
      const ended = await sse.until(
        (frame) => frame.kind === "live.call" && frame.call?.callId === call.callId && frame.call?.status === "ended",
        10_000,
      );
      expect(ended.call).toMatchObject({ endReason: "signed-out", error: LIVE_COPY.unpaired });
      const again = await post("/api/live/session", { botId: bot.id, sdp: SDP, client: "ios" }, phone);
      expect(again.status).toBe(401);
      await expect.poll(serverOutput, { timeout: 5_000 }).toMatch(/\[live\] call ended .*client=ios .*end=signed-out/);
    } finally {
      sse.close();
    }
  }, 40_000);

  it("never reads back a line a worker relayed into the call's chat as the caller's own", async () => {
    const bot = await createBot();
    const { call, session } = await startCall(bot.id);
    type Line = { id: string; role: string; text?: string; relayed?: boolean; requestMessageId?: string; turnTerminal?: boolean };
    const lines = async () => ((await (await fetch(`${base}/api/threads/${bot.threadId}/messages`)).json()) as { messages: Line[] }).messages;
    try {
      await live.waitForAttach(session.id);
      const page = (await (await fetch(`${base}/api/threads/${bot.threadId}/messages?limit=0`)).json()) as { activeLeafId?: string | null };
      const relayed = await post(`/api/bots/${bot.id}/messages/guarded`, {
        threadId: bot.threadId, sendId: "slackjob_live_call_relay_1", text: "relayed from Slack",
        expectedActiveLeafId: page.activeLeafId ?? null, onBehalfOf: { email: "ada@example.test", name: "Ada" },
      });
      expect(relayed.status, JSON.stringify(relayed.body)).toBe(202);
      const relayedId = (relayed.body as { message: { id: string } }).message.id;
      await expect.poll(async () => (await lines()).some((m) => m.requestMessageId === relayedId && m.turnTerminal), { timeout: 20_000 }).toBe(true);
      await expect.poll(() => isBusy(bot.id), { timeout: 20_000 }).toBe(false);

      expect((await post(`/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "typed on the desktop", sendId: "typed-live-call-e2e-0001" })).status).toBe(202);
      await live.waitForCommand(session.id, (c) => c.type === "session.commentary.append" && String(c.content).includes("typed on the desktop"), 20_000);
      const said = session.commands.filter((c) => c.type === "session.commentary.append").map((c) => String(c.content));
      expect(said).toHaveLength(1);
      expect(said[0]).not.toContain("relayed from Slack");

      const stored = await lines();
      expect(stored.find((m) => m.id === relayedId)).toMatchObject({ role: "user", relayed: true });
      expect(stored.find((m) => m.text === "typed on the desktop")?.relayed).toBeUndefined();
    } finally {
      await post("/api/live/call/end", { callId: call.callId });
    }
  }, 60_000);

  it("approves a card by voice and marks it as decided on the call", async () => {
    const bot = await createBot("asks", "fake-model");
    const { call, session } = await startCall(bot.id);
    try {
      await live.waitForAttach(session.id);
      live.emit(session.id, { type: "session.input_transcript.delta", delta: "run the check", start_ms: 100, end_ms: 900 });
      live.emit(session.id, { type: "session.delegation.created", offset_ms: 950, delegation: { id: "del_p", target: "client", type: "delegation" } });
      await live.waitForCommand(session.id, (c) => c.type === "session.instructions.append" && String(c.content).includes("May I?"), 20_000);
      live.emit(session.id, { type: "session.input_transcript.delta", delta: "yes", start_ms: 5_000, end_ms: 5_300 });
      live.emit(session.id, { type: "session.delegation.created", offset_ms: 5_400, delegation: { id: "del_y", target: "client", type: "delegation" } });
      type Card = { requestId?: string; answered?: string; answeredBy?: unknown };
      const approved = async () => {
        const { messages } = (await (await fetch(`${base}/api/threads/${bot.threadId}/messages`)).json()) as { messages: Array<{ card?: Card }> };
        return messages.find((m) => m.card?.requestId && m.card.answered === "allow")?.card;
      };
      await expect.poll(approved, { timeout: 20_000 }).toMatchObject({ answeredBy: { kind: "loopback", via: "call" } });
      const requestId = (await approved())!.requestId;
      const decision = async () => ((await (await fetch(`${base}/api/decisions`)).json()) as { decisions: Array<{ requestId?: string; decision: string; via?: string }> })
        .decisions.find((row) => row.requestId === requestId && row.decision === "user-approved");
      await expect.poll(decision, { timeout: 10_000 }).toMatchObject({ via: "call" });
    } finally {
      await post("/api/live/call/end", { callId: call.callId });
    }
  }, 60_000);

  it("reports a rejected question answer honestly and can retry it after the provider settles", async () => {
    const bot = await createBot("questions", "fake-model");
    const { call, session } = await startCall(bot.id);
    try {
      await live.waitForAttach(session.id);
      live.emit(session.id, { type: "session.input_transcript.delta", delta: "ask me which color", start_ms: 100, end_ms: 900 });
      live.emit(session.id, { type: "session.delegation.created", offset_ms: 950, delegation: { id: "del_question", target: "client" } });
      await live.waitForCommand(session.id, (c) => c.type === "session.instructions.append" && String(c.content).includes("Which color"), 20_000);
      type Line = { id: string; role: string; replyToId?: string; via?: string; callId?: string; card?: { requestId?: string; answered?: string; answeredText?: string; answeredBy?: unknown } };
      const lines = async (): Promise<Line[]> => ((await (await fetch(`${base}/api/threads/${bot.threadId}/messages`)).json()) as { messages: Line[] }).messages;
      const original = (await lines()).find((m) => m.card?.requestId)!;
      live.emit(session.id, { type: "session.input_transcript.delta", delta: "Purple", start_ms: 5_000, end_ms: 5_300 });
      live.emit(session.id, { type: "session.delegation.created", offset_ms: 5_400, delegation: { id: "del_rejected", target: "client" } });
      await live.waitForCommand(session.id, (c) => c.type === "session.commentary.append" && String(c.content).includes("could not be saved"), 5_000);
      expect((await lines()).find((m) => m.id === original.id)?.card).not.toHaveProperty("answeredText");
      expect(session.commands.some((c) => c.type === "session.thinking.append" && c.content === LIVE_COPY.answerPassed)).toBe(false);
      await expect.poll(() => isBusy(bot.id), { timeout: 5_000 }).toBe(false);

      live.emit(session.id, { type: "session.input_transcript.delta", delta: "Blue", start_ms: 8_000, end_ms: 8_300 });
      live.emit(session.id, { type: "session.delegation.created", offset_ms: 8_400, delegation: { id: "del_retry", target: "client" } });
      await expect.poll(async () => (await lines()).find((m) => m.id === original.id)?.card, { timeout: 10_000 }).toMatchObject({ answered: "answer", answeredText: "Blue", answeredBy: { kind: "loopback", via: "call" } });
      expect((await lines()).find((m) => m.role === "user" && m.replyToId === original.id)).toMatchObject({ via: "call", callId: call.callId });
      expect(serverOutput()).not.toContain("text=Blue");
    } finally {
      await post("/api/bots/" + bot.id + "/interrupt", { threadId: bot.threadId });
      await post("/api/live/call/end", { callId: call.callId });
    }
  }, 40_000);

  it("delivers a spoken answer to a persistent question after its turn is stopped", async () => {
    const bot = await createBot("questions", "fake-model");
    const { call, session } = await startCall(bot.id);
    try {
      await live.waitForAttach(session.id);
      live.emit(session.id, { type: "session.input_transcript.delta", delta: "ask me which color", start_ms: 100, end_ms: 900 });
      live.emit(session.id, { type: "session.delegation.created", offset_ms: 950, delegation: { id: "del_stopped_question", target: "client" } });
      await live.waitForCommand(session.id, (c) => c.type === "session.instructions.append" && String(c.content).includes("Which color"), 20_000);
      type Line = { id: string; role: string; replyToId?: string; via?: string; callId?: string; card?: { requestId?: string; answered?: string; answeredText?: string; answeredBy?: unknown } };
      const lines = async (): Promise<Line[]> => ((await (await fetch(`${base}/api/threads/${bot.threadId}/messages`)).json()) as { messages: Line[] }).messages;
      const original = (await lines()).find((m) => m.card?.requestId)!;
      expect((await post(`/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId })).status).toBe(200);
      // Stop ends the turn; a loaded CI runner can take longer than a few seconds to wind the fake engine down.
      await expect.poll(() => isBusy(bot.id), { timeout: 15_000 }).toBe(false);
      live.emit(session.id, { type: "session.input_transcript.delta", delta: "Green", start_ms: 5_000, end_ms: 5_300 });
      live.emit(session.id, { type: "session.delegation.created", offset_ms: 5_400, delegation: { id: "del_late", target: "client" } });
      await expect.poll(async () => (await lines()).find((m) => m.id === original.id)?.card, { timeout: 5_000 }).toMatchObject({ answered: "answer", answeredText: "Green", answeredBy: { kind: "loopback", via: "call" } });
      expect((await lines()).find((m) => m.role === "user" && m.replyToId === original.id)).toMatchObject({ via: "call", callId: call.callId });
      expect(serverOutput()).not.toContain("text=Green");
    } finally {
      await post(`/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId });
      await post("/api/live/call/end", { callId: call.callId });
    }
  }, 60_000);

  it("ends the call and tells clients when the sideband drops", async () => {
    const bot = await createBot();
    const sse = await openSse(`${base}/api/events`);
    try {
      const { call, session } = await startCall(bot.id);
      await live.waitForAttach(session.id);
      await sse.until((frame) => frame.kind === "live.call" && frame.call?.callId === call.callId && frame.call?.status === "live");

      live.dropSideband(session.id);

      const ended = await sse.until(
        (frame) => frame.kind === "live.call" && frame.call?.callId === call.callId && frame.call?.status === "ended",
      );
      expect(ended).toMatchObject({ botId: bot.id, threadId: bot.threadId, call: { endReason: "sideband-lost" } });
      const row = await sse.until((frame) => frame.kind === "message" && frame.threadId === bot.threadId && frame.message?.kind === "call");
      expect(row.message.call).toMatchObject({ callId: call.callId, endReason: "sideband-lost" });
      const current = await (await fetch(`${base}/api/live/call`)).json();
      expect(current).toEqual({ call: null });
      await expect.poll(serverOutput, { timeout: 5_000 }).toContain("end=sideband-lost");
    } finally {
      sse.close();
    }
  }, 40_000);

  it("leaves no row for a call that never went live", async () => {
    const bot = await createBot();
    const sse = await openSse(`${base}/api/events`);
    let callId = "";
    try {
      // 404, not 401: Node's WebSocket retries a refused 401 upgrade, and the retry is accepted.
      live.refuseNextAttach(404);
      const { call } = await startCall(bot.id);
      callId = call.callId;
      await sse.until((frame) => frame.kind === "live.call" && frame.call?.callId === call.callId && frame.call?.status === "ended", 20_000);
      expect(sse.frames.some((frame) => frame.kind === "live.call" && frame.call?.callId === call.callId && frame.call?.status === "live")).toBe(false);
      const { messages } = (await (await fetch(`${base}/api/threads/${bot.threadId}/messages`)).json()) as { messages: Array<{ kind: string }> };
      expect(messages.some((message) => message.kind === "call")).toBe(false);
    } finally {
      if (callId) await post("/api/live/call/end", { callId });
      await expect.poll(() => isBusy(bot.id), { timeout: 20_000 }).toBe(false);
      sse.close();
    }
  }, 40_000);

  // The first call's missing title is checked only after the second's title arrives: an event, not a clock.
  it("names a call from what was asked on it when generated titles are on, and never one that ended while they were off", async () => {
    const quiet = await createBot();
    const named = await createBot();
    const sse = await openSse(`${base}/api/events`);
    let callId = "";
    const askAndHangUp = async (bot: { id: string; threadId: string }) => {
      const { call, session } = await startCall(bot.id);
      callId = call.callId;
      await live.waitForAttach(session.id);
      live.emit(session.id, { type: "session.input_transcript.delta", delta: "what is six times seven", start_ms: 100, end_ms: 900 });
      live.emit(session.id, { type: "session.delegation.created", offset_ms: 950, delegation: { id: `del_${bot.id}`, target: "client", type: "delegation" } });
      await live.waitForCommand(session.id, (c) => c.type === "session.commentary.append" && String(c.content).includes("42"), 20_000);
      expect(await post("/api/live/call/end", { callId })).toMatchObject({ status: 200 });
      return sse.until((frame) => frame.kind === "message" && frame.threadId === bot.threadId && frame.message?.kind === "call", 10_000);
    };
    try {
      const first = await askAndHangUp(quiet);
      expect(first.message.call.title).toBeUndefined();

      await setGeneratedTitles(true);
      const second = await askAndHangUp(named);
      expect(second.message.call.title).toBeUndefined();
      const titled = await sse.until(
        (frame) => frame.kind === "message.patch" && frame.message?.id === second.message.id && typeof frame.message?.call?.title === "string",
        15_000,
      );
      expect(titled.message.call).toMatchObject({ callId: second.message.call.callId, title: "Times table question" });
      expect(titled.message.text).toBe(second.message.text);

      const { messages } = (await (await fetch(`${base}/api/threads/${quiet.threadId}/messages`)).json()) as { messages: Array<{ id: string; call?: { title?: string } }> };
      expect(messages.find((message) => message.id === first.message.id)?.call?.title).toBeUndefined();
      expect(sse.frames.some((frame) => frame.kind === "message.patch" && frame.message?.id === first.message.id)).toBe(false);
    } finally {
      await setGeneratedTitles(false);
      if (callId) await post("/api/live/call/end", { callId });
      for (const bot of [quiet, named]) await expect.poll(() => isBusy(bot.id), { timeout: 20_000 }).toBe(false);
      sse.close();
    }
  }, 90_000);

  it("keeps a finished call's row out of the next call's voice history", async () => {
    const bot = await createBot();
    const first = await startCall(bot.id);
    try {
      await live.waitForAttach(first.session.id);
      live.emit(first.session.id, { type: "session.input_transcript.delta", delta: "what is six times seven", start_ms: 100, end_ms: 900 });
      live.emit(first.session.id, { type: "session.delegation.created", offset_ms: 950, delegation: { id: "del_history", target: "client", type: "delegation" } });
      await live.waitForCommand(first.session.id, (c) => c.type === "session.commentary.append" && String(c.content).includes("42"), 20_000);
      await expect.poll(() => isBusy(bot.id), { timeout: 20_000 }).toBe(false);
    } finally {
      await post("/api/live/call/end", { callId: first.call.callId });
      await expect.poll(() => isBusy(bot.id), { timeout: 20_000 }).toBe(false);
    }
    const lines = async () => ((await (await fetch(`${base}/api/threads/${bot.threadId}/messages`)).json()) as { messages: Array<{ kind: string }> }).messages;
    await expect.poll(async () => (await lines()).some((message) => message.kind === "call"), { timeout: 10_000 }).toBe(true);

    const second = await startCall(bot.id);
    try {
      const history = JSON.stringify((second.session.body.session as { input?: unknown }).input ?? []);
      expect(history).toContain("what is six times seven");
      expect(history).not.toContain("Call with");
    } finally {
      await post("/api/live/call/end", { callId: second.call.callId });
      await expect.poll(() => isBusy(bot.id), { timeout: 20_000 }).toBe(false);
    }
  }, 60_000);

  it("leaves no row, and no error, for a call whose bot is deleted during it", async () => {
    const bot = await createBot();
    const sse = await openSse(`${base}/api/events`);
    let callId = "";
    try {
      const { call, session } = await startCall(bot.id);
      callId = call.callId;
      await live.waitForAttach(session.id);
      await sse.until((frame) => frame.kind === "live.call" && frame.call?.callId === call.callId && frame.call?.status === "live");
      expect((await fetch(`${base}/api/bots/${bot.id}`, { method: "DELETE" })).status).toBeLessThan(300);
      const ended = await sse.until((frame) => frame.kind === "live.call" && frame.call?.callId === call.callId && frame.call?.status === "ended", 20_000);
      expect(ended.call.endReason).toBe("deleted");
      await expect.poll(serverOutput, { timeout: 5_000 }).toMatch(/\[live\] call ended bot=\S+ .*end=deleted errors=none/);
      expect(sse.frames.some((frame) => frame.kind === "message" && frame.message?.kind === "call")).toBe(false);
      expect(await (await fetch(`${base}/api/live/call`)).json()).toEqual({ call: null });
    } finally {
      if (callId) await post("/api/live/call/end", { callId });
      await expect.poll(() => isBusy(bot.id), { timeout: 20_000 }).toBe(false);
      sse.close();
    }
  }, 40_000);
});

// Booted as a Cloud home behind its edge, with only loopback reachable.
posixOnly("Live call on the person's Cloud", () => {
  const HOST = "omb-t-0123456789ab.fly.dev";
  const secret = randomBytes(32).toString("base64url");
  const OWNER_KEY = "sk-fake-cloud-owner";
  let child: ChildProcess;
  let home = "";
  let base = "";
  let output = "";
  let live: FakeOpenAiLive;
  let ownerToken = "";

  const request = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        // what the Caddy edge adds to every request it forwards
        host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https",
        ...(ownerToken ? { authorization: `Bearer ${ownerToken}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    // SAFETY: test-only JSON bodies, checked field by field below.
    return { status: res.status, body: await res.json().catch(() => null) as any };
  };

  beforeAll(async () => {
    chmodSync(FAKE_CLAUDE, 0o755);
    live = await startFakeOpenAiLive();
    home = mkdtempSync(join(tmpdir(), "omb-live-cloud-"));
    const dataDir = join(home, ".openmausbot");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({
      instances: {
        // Pin the fleet's other defaults so this never probes an installed CLI.
        ...Object.fromEntries(["codex", "cursor", "githubCopilot", "openaiCompat", "qwen", "hermes", "pi"].map((id) => [id, { driver: "not-a-real-driver" }])),
        claude: { driver: "claudeAgent", config: { cli: FAKE_CLAUDE, permissionMode: "bypassPermissions" } },
      },
    }));
    mkdirSync(join(home, "web"));
    writeFileSync(join(home, "web", "index.html"), "<!doctype html><title>OpenMausBot</title>");
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    // Only loopback answers: the fake GPT-Live. The Admin and OpenAI are offline.
    const loopbackOnly = `data:text/javascript,${encodeURIComponent(
      "const real = globalThis.fetch; globalThis.fetch = async (input, init) => new URL(input instanceof Request ? input.url : String(input)).hostname === \"127.0.0.1\" ? real(input, init) : new Response(\"offline fixture\", { status: 503 });",
    )}`;
    child = spawn(process.execPath, ["--import", loopbackOnly, join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        HOME: home, USERPROFILE: home, OMB_DATA_DIR: dataDir, OMB_STATIC_DIR: join(home, "web"),
        OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1),
        OMB_CLOUD_ROLE: "home", OMB_CLOUD_MACHINE_ID: "3f9c2a4e-8b1d-4c6e-9a7f-2d5e8c1b0a93", OMB_CLOUD_ADMIN_URL: "https://cloud.example.test",
        OMB_CLOUD_BOOTSTRAP_SECRET: secret, OMB_PUBLIC_URL: `https://${HOST}`,
        // no OMB_OPENAI_LIVE_KEY: no plan includes one
        OMB_OPENAI_LIVE_URL: live.url,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", (chunk) => (output += chunk));
    child.stderr!.on("data", (chunk) => (output += chunk));
    const deadline = Date.now() + 90_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`the Cloud home exited ${child.exitCode}. output:\n${output}`);
      try {
        const health = (await (await fetch(`${base}/api/health`)).json()) as { pid?: number };
        if (health.pid === child.pid) break;
      } catch {
      }
      if (Date.now() > deadline) throw new Error(`the Cloud home never came up. output:\n${output}`);
      await new Promise((r) => setTimeout(r, 150));
    }
    const pairing = JSON.stringify({ label: "OpenMausBot app (Cloud)", ttlSeconds: 300 });
    const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString("base64url");
    const granted = await request("POST", "/api/cloud/pairing", JSON.parse(pairing), {
      "x-omb-cloud-timestamp": timestamp, "x-omb-cloud-nonce": nonce,
      "x-omb-cloud-signature": `v1=${cloudPairingSignature(secret, timestamp, nonce, pairing)}`,
    });
    expect(granted.status, JSON.stringify(granted.body)).toBe(200);
    const paired = await request("POST", "/api/auth/pair", { code: granted.body.code });
    expect(paired.status, JSON.stringify(paired.body)).toBe(200);
    ownerToken = paired.body.token;
  }, 120_000);

  afterAll(async () => {
    if (child) await waitForExit(child, { signal: "SIGTERM" });
    await live?.stop();
    if (home) await removeTempDir(home);
  });

  it("saves the owner's OpenAI key on the Cloud, and a Live call starts with it", async () => {
    const before = await request("GET", "/api/config");
    expect(before.body).toMatchObject({ cloudHome: true, live: { configured: false } });
    const created = await request("POST", "/api/bots", { name: "Ada", modelSelection: { instanceId: "claude", model: "claude-fake" } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const { id: botId, threadId } = created.body.bot as { id: string; threadId: string };

    const refused = await request("POST", "/api/live/session", { botId, sdp: SDP, client: "desktop" });
    expect(refused, JSON.stringify(refused.body)).toMatchObject({ status: 409, body: { needsKey: true } });
    expect(live.sessions).toHaveLength(0);

    const saved = await request("PUT", "/api/config", { live: { key: OWNER_KEY } });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body).toMatchObject({ cloudHome: true, live: { configured: true } });
    expect(JSON.stringify(saved.body)).not.toContain(OWNER_KEY);

    const started = await request("POST", "/api/live/session", { botId, sdp: SDP, client: "desktop" });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    expect(started.body).toMatchObject({ call: { botId, threadId }, transport: { type: "webrtc", sdp: expect.any(String) } });
    expect(live.sessions).toHaveLength(1);
    const [session] = live.sessions;
    expect(session.key).toBe(OWNER_KEY);
    const { instructions } = session.body.session as { instructions: string };
    expect(instructions.split("\n")[0]).toBe(`You are Ada, an AI agent that runs on ${CLOUD_HOME_PLACE}.`);
    expect(instructions).not.toContain("on the user's own computer");
    await live.waitForAttach(session.id);

    const ended = await request("POST", "/api/live/call/end", { callId: started.body.call.callId });
    expect(ended).toMatchObject({ status: 200, body: { call: { status: "ended" } } });
    expect(JSON.stringify(started.body)).not.toContain(OWNER_KEY);
    expect(output).not.toContain(OWNER_KEY);
  }, 40_000);
});

// No plan anywhere and no Live key: a phone's call starts once the person's own OpenAI key is in Settings → API keys.
posixOnly("Live calls for everyone, with the person's own OpenAI key", () => {
  const OPENAI_KEY = "sk-fake-api-keys-openai";
  const phone = { "x-openmausbot-companion": "1", "x-openmausbot-companion-device": "phone-byok" };
  let child: ChildProcess;
  let home = "";
  let base = "";
  let output = "";
  let live: FakeOpenAiLive;

  const request = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    // SAFETY: test-only JSON bodies, checked field by field below.
    return { status: res.status, body: await res.json().catch(() => null) as any };
  };

  beforeAll(async () => {
    chmodSync(FAKE_CLAUDE, 0o755);
    live = await startFakeOpenAiLive();
    home = mkdtempSync(join(tmpdir(), "omb-live-byok-"));
    const dataDir = join(home, ".openmausbot");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({
      instances: {
        // Pin the fleet's other defaults so this never probes an installed CLI.
        ...Object.fromEntries(["codex", "cursor", "githubCopilot", "openaiCompat", "qwen", "hermes", "pi"].map((id) => [id, { driver: "not-a-real-driver" }])),
        claude: { driver: "claudeAgent", config: { cli: FAKE_CLAUDE, permissionMode: "bypassPermissions" } },
      },
    }));
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        HOME: home, USERPROFILE: home, OMB_DATA_DIR: dataDir,
        OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1),
        OMB_OPENAI_LIVE_URL: live.url,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", (chunk) => (output += chunk));
    child.stderr!.on("data", (chunk) => (output += chunk));
    const deadline = Date.now() + 90_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. output:\n${output}`);
      try {
        const health = (await (await fetch(`${base}/api/health`)).json()) as { pid?: number };
        if (health.pid === child.pid) break;
      } catch {
      }
      if (Date.now() > deadline) throw new Error(`server never came up. output:\n${output}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }, 120_000);

  afterAll(async () => {
    if (child) await waitForExit(child, { signal: "SIGTERM" });
    await live?.stop();
    if (home) await removeTempDir(home);
  });

  it("asks a phone for a key, never a plan; then calls with the OpenAI key from API keys, and a separate Live key wins", async () => {
    const created = await request("POST", "/api/bots", { name: "Ada", modelSelection: { instanceId: "claude", model: "claude-fake" } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const botId = created.body.bot.id as string;
    const start = (client: LiveCallState["client"], headers: Record<string, string> = {}) =>
      request("POST", "/api/live/session", { botId, sdp: SDP, client }, headers);
    const hangUp = async (callId: string, session: { id: string }) => {
      await live.waitForAttach(session.id);
      expect(await request("POST", "/api/live/call/end", { callId })).toMatchObject({ status: 200, body: { call: { status: "ended" } } });
    };

    for (const [client, headers] of [["ios", phone], ["android", {}], ["desktop", {}]] as const) {
      expect(await start(client, headers), client).toEqual({
        status: 409, body: { error: "Live calls use your own OpenAI key. Add it in Settings → API keys.", needsKey: true },
      });
    }
    expect(live.sessions).toHaveLength(0);

    const saved = await request("PUT", "/api/config", { openai: { key: OPENAI_KEY } });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.live).toMatchObject({ configured: true, keySource: "openai" });
    const fromPhone = await start("ios", phone);
    expect(fromPhone.status, JSON.stringify(fromPhone.body)).toBe(201);
    expect(live.sessions).toHaveLength(1);
    expect(live.sessions[0]!.key).toBe(OPENAI_KEY);
    await hangUp(fromPhone.body.call.callId, live.sessions[0]!);

    const own = await request("PUT", "/api/config", { live: { key: LIVE_KEY } });
    expect(own.body.live).toMatchObject({ configured: true, keySource: "live" });
    const fromDesktop = await start("desktop");
    expect(fromDesktop.status, JSON.stringify(fromDesktop.body)).toBe(201);
    expect(live.sessions[1]!.key).toBe(LIVE_KEY);
    await hangUp(fromDesktop.body.call.callId, live.sessions[1]!);

    expect((await request("PUT", "/api/config", { live: { key: "" } })).body.live).toMatchObject({ configured: true, keySource: "openai" });
    const config = await request("GET", "/api/config");
    for (const secret of [OPENAI_KEY, LIVE_KEY]) {
      expect(JSON.stringify(config.body)).not.toContain(secret);
      expect(output).not.toContain(secret);
    }
  }, 40_000);
});
