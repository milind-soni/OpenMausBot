// Contract test for the agent-to-agent comms MCP proxy (agents-proxy.ts):
// spawn it exactly the way a driver's mcpServers entry does (process.execPath
// + entry file + env) against a scripted stub of the harness's /api/internal
// endpoints, and drive the MCP stdio surface end to end. No shebang, no
// shell — plain node child, so this runs on every OS like index.test.ts.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PROXY = join(dirname(fileURLToPath(import.meta.url)), "agents-proxy.ts");
const TOKEN = "test-comms-token";

interface ParallelizeRequest {
  fromBotId: string;
  fromThreadId: string;
  depth: number;
  tasks: Array<{
    label: string;
    instructions: string;
    mode?: "coordinate" | "execute";
    engine_id?: string;
    model?: string;
    effort?: "default" | "none" | "low" | "medium" | "high" | "xhigh" | "max";
  }>;
}

// scripted harness stub
let stub: Server;
let stubPort = 0;
let lastAuth: string | undefined;
let lastAskBody: any = null;
let askResponse: unknown = { botName: "Helper", text: "hi from helper" };
let lastDelegateBody: any = null;
let delegateResponse: unknown = { queued: true, message: "Delegation queued." };
let lastCreateBody: any = null;
let lastCredentialBody: any = null;
let lastParallelizeBody: ParallelizeRequest | null = null;
const captureBodies = new Map<string, any>();

let child: ChildProcess;
const pending = new Map<number, (msg: any) => void>();
let nextId = 100;

function rpc(method: string, params?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${method} timed out`));
    }, 10_000).unref?.();
  });
}
const callTool = (name: string, args: unknown) => rpc("tools/call", { name, arguments: args });

beforeAll(async () => {
  stub = createServer((req, res) => {
    lastAuth = req.headers.authorization;
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "unauthorized" }));
    }
    if (req.method === "GET" && req.url?.startsWith("/api/internal/agents")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(
        JSON.stringify({
          bots: [{ id: "bot-helper", name: "Helper", model: "fake-model", busy: false }],
        }),
      );
    }
    if (req.method === "POST" && req.url === "/api/internal/ask-bot") {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        lastAskBody = JSON.parse(data);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(askResponse));
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/internal/delegate-bot") {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        lastDelegateBody = JSON.parse(data);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(delegateResponse));
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/internal/create-bot") {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        lastCreateBody = JSON.parse(data);
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "bot-designer", name: "Pixel", section: "Work" }));
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/internal/request-credential") {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        lastCredentialBody = JSON.parse(data);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ messageId: "msg-key", label: "OpenCode API key" }));
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/internal/parallelize-work") {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        lastParallelizeBody = JSON.parse(data);
        res.writeHead(202, { "content-type": "application/json" });
        res.end(JSON.stringify({ accepted: 2 }));
      });
      return;
    }
    const captureRoute = req.url;
    if (req.method === "POST" && captureRoute?.startsWith("/api/internal/capture/")) {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        captureBodies.set(captureRoute, JSON.parse(data));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(
          captureRoute === "/api/internal/capture/begin"
            ? { runId: "run-1", cursors: [], pendingOutbox: [] }
            : captureRoute === "/api/internal/capture/finish"
              ? { report: { runId: "run-1", status: "completed" }, outbox: null }
              : { recorded: true, acknowledged: true },
        ));
      });
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unknown" }));
  });
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
  stubPort = (stub.address() as { port: number }).port;

  child = spawn(process.execPath, [PROXY], {
    env: {
      ...process.env,
      OMB_HARNESS_URL: `http://127.0.0.1:${stubPort}`,
      OMB_BOT_ID: "bot-asker",
      OMB_THREAD_ID: "thread-asker-routine",
      OMB_COMMS_TOKEN: TOKEN,
      OMB_TURN_DEPTH: "0",
    },
    stdio: ["pipe", "pipe", "inherit"],
  });
  let buf = "";
  child.stdout!.on("data", (c) => {
    buf += c;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    }
  });
});

afterAll(async () => {
  child?.kill();
  await new Promise<void>((r) => stub.close(() => r()));
});

describe("agents-proxy MCP surface", () => {
  it("answers the MCP handshake and lists the coordination and capture tools", async () => {
    const init = await rpc("initialize", { protocolVersion: "2024-11-05" });
    expect(init.result.serverInfo.name).toContain("agents");
    const list = await rpc("tools/list");
    expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual([
      "list_bots",
      "ask_bot",
      "delegate_bot",
      "create_bot",
      "parallelize_work",
      "request_credential",
      "record_task_evidence",
      "capture_status",
      "capture_begin",
      "capture_record_source",
      "capture_finish",
      "capture_ack_delivery",
      "capture_read_browser_receipts",
      "capture_read_notification_mirror",
      "capture_read_plaud_archive",
      "capture_read_chrome_history",
      "capture_read_local_inbox",
      "capture_read_whoop_export",
      "capture_read_hevy_export",
      "capture_read_anvil_bi_health",
      "capture_read_anvil_bi_mercury",
      "capture_read_telegram_relay_health",
      "capture_memory_search",
      "capture_memory_upsert",
      "capture_memory_tombstone",
      "capture_world_assert",
      "world_model_resolve",
    ]);
  });

  it("forwards the durable capture lifecycle with bot and thread ownership", async () => {
    await callTool("capture_status", {});
    await callTool("capture_begin", {
      kind: "fast",
      scheduled_for: 123,
      sources: [{ id: "gmail", required: true }],
    });
    await callTool("capture_record_source", {
      run_id: "run-1",
      source_id: "gmail",
      status: "empty",
      cursor: { historyId: "42" },
      item_count: 0,
    });
    await callTool("capture_finish", { run_id: "run-1" });
    await callTool("capture_ack_delivery", { outbox_id: "outbox-1" });
    await callTool("capture_read_browser_receipts", {
      source_id: "plaud",
      cursor: { capturedAt: "2026-08-26T13:00:00.000Z", captureId: "11111111-1111-4111-8111-111111111111" },
    });
    await callTool("capture_read_notification_mirror", {
      cursor: { occurredAt: 0, eventId: "" },
      limit: 25,
    });
    await callTool("capture_read_plaud_archive", {
      path: "C:/Users/shane/Documents/Plaud Archive",
      cursor: { files: {} },
    });
    await callTool("capture_read_chrome_history", { cursor: { lastVisitTime: "42", urlId: 7 }, limit: 25 });
    await callTool("capture_read_local_inbox", { path: "C:/Users/shane/Documents/inbox", cursor: { files: {} }, max_files: 25 });
    await callTool("capture_read_whoop_export", { path: "C:/Users/shane/Documents/whoop.json", cursor: { files: {} }, max_files: 10 });

    expect(captureBodies.get("/api/internal/capture/status")).toEqual({ botId: "bot-asker" });

    expect(captureBodies.get("/api/internal/capture/begin")).toMatchObject({
      botId: "bot-asker",
      threadId: "thread-asker-routine",
      kind: "fast",
    });
    expect(captureBodies.get("/api/internal/capture/source")).toMatchObject({
      botId: "bot-asker",
      run_id: "run-1",
      source_id: "gmail",
    });
    expect(captureBodies.get("/api/internal/capture/finish")).toEqual({
      botId: "bot-asker",
      run_id: "run-1",
    });
    expect(captureBodies.get("/api/internal/capture/ack")).toEqual({
      botId: "bot-asker",
      outbox_id: "outbox-1",
    });
    expect(captureBodies.get("/api/internal/capture/read/browser")).toMatchObject({
      botId: "bot-asker",
      sourceId: "plaud",
    });
    expect(captureBodies.get("/api/internal/capture/read/plaud-archive")).toEqual({
      botId: "bot-asker",
      path: "C:/Users/shane/Documents/Plaud Archive",
      cursor: { files: {} },
    });
    expect(captureBodies.get("/api/internal/capture/read/chrome-history")).toEqual({
      botId: "bot-asker",
      cursor: { lastVisitTime: "42", urlId: 7 },
      limit: 25,
    });
    expect(captureBodies.get("/api/internal/capture/read/local-inbox")).toEqual({
      botId: "bot-asker",
      path: "C:/Users/shane/Documents/inbox",
      cursor: { files: {} },
      maxFiles: 25,
    });
    expect(captureBodies.get("/api/internal/capture/read/whoop")).toEqual({
      botId: "bot-asker",
      path: "C:/Users/shane/Documents/whoop.json",
      cursor: { files: {} },
      maxFiles: 10,
    });
  });

  it("list_bots renders the roster and authenticates with the shared token", async () => {
    const res = await callTool("list_bots", {});
    const text = res.result.content[0].text;
    expect(text).toContain("Helper");
    expect(text).toContain("bot-helper");
    expect(lastAuth).toBe(`Bearer ${TOKEN}`);
  });

  it("ask_bot forwards sender + depth and returns the reply", async () => {
    askResponse = { botName: "Helper", text: "hi from helper" };
    const res = await callTool("ask_bot", { bot_id: "bot-helper", message: "ping" });
    expect(res.result.content[0].text).toContain("Helper replied:");
    expect(res.result.content[0].text).toContain("hi from helper");
    expect(lastAskBody).toMatchObject({
      fromBotId: "bot-asker",
      fromThreadId: "thread-asker-routine",
      toBotId: "bot-helper",
      message: "ping",
      depth: 0,
    });
  });

  it("renders a busy peer as a clean answer, not an error", async () => {
    askResponse = { busy: true };
    const res = await callTool("ask_bot", { bot_id: "bot-helper", message: "ping" });
    expect(res.result.content[0].text).toContain("busy");
    expect(res.result.isError).toBeFalsy();
  });

  it("surfaces the harness's depth refusal as a tool error", async () => {
    askResponse = { error: "message chains are limited to one hop" };
    const res = await callTool("ask_bot", { bot_id: "bot-helper", message: "ping" });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain("one hop");
  });

  it("forwards the source thread when queueing a delegation", async () => {
    delegateResponse = { queued: true, message: "Delegation queued." };
    const res = await callTool("delegate_bot", {
      bot_id: "bot-helper",
      message: "take this",
      reason: "follow-up",
    });
    expect(res.result.content[0].text).toContain("Delegation queued");
    expect(lastDelegateBody).toMatchObject({
      fromBotId: "bot-asker",
      fromThreadId: "thread-asker-routine",
      toBotId: "bot-helper",
      message: "take this",
      reason: "follow-up",
      depth: 0,
    });
  });

  it("returns queue refusal guidance to the agent as a tool error", async () => {
    delegateResponse = { error: "delegation chains are limited to one hop — do this one yourself" };
    const res = await callTool("delegate_bot", { bot_id: "bot-helper", message: "take this" });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain("do this one yourself");
  });

  it("lets a Chief create a bounded specialist through the harness", async () => {
    const res = await callTool("create_bot", {
      name: "Pixel",
      role: "Product designer",
      instructions: "Design and review the user experience.",
    });
    expect(res.result.content[0].text).toContain("Created @Pixel in Work");
    expect(lastCreateBody).toEqual({
      fromBotId: "bot-asker",
      fromThreadId: "thread-asker-routine",
      name: "Pixel",
      role: "Product designer",
      instructions: "Design and review the user experience.",
    });
  });

  it("starts a bounded batch of independent workers and tells Chief to reply without polling", async () => {
    const res = await callTool("parallelize_work", {
      tasks: [
        {
          label: "Audit",
          instructions: "Inspect the current behavior.",
          mode: "coordinate",
          model: "Fable",
          effort: "high",
        },
        {
          label: "Test",
          instructions: "Run an independent verification.",
          mode: "execute",
          engine_id: "claude",
          model: "Haiku",
          effort: "low",
        },
      ],
    });

    expect(lastParallelizeBody).toEqual({
      fromBotId: "bot-asker",
      fromThreadId: "thread-asker-routine",
      depth: 0,
      requestKey: expect.stringMatching(/^[a-f0-9-]{36}$/),
      tasks: [
        {
          label: "Audit",
          instructions: "Inspect the current behavior.",
          mode: "coordinate",
          model: "Fable",
          effort: "high",
        },
        {
          label: "Test",
          instructions: "Run an independent verification.",
          mode: "execute",
          engine_id: "claude",
          model: "Haiku",
          effort: "low",
        },
      ],
    });
    expect(res.result.content[0].text).toContain("task rail shows exact progress");
    expect(res.result.content[0].text).toContain("Keep the chat quiet");
    expect(res.result.content[0].text).toContain("do not poll");
  });

  it("rejects more than eight parallel tasks before contacting the harness", async () => {
    lastParallelizeBody = null;
    const res = await callTool("parallelize_work", {
      tasks: Array.from({ length: 9 }, (_, index) => ({
        label: `Task ${index + 1}`,
        instructions: "Do one independent thing.",
      })),
    });

    expect(res.result.isError).toBe(true);
    expect(lastParallelizeBody).toBeNull();
  });

  it("requests an allowlisted credential without putting a secret in the request", async () => {
    const res = await callTool("request_credential", {
      credential_id: "opencodeGoApiKey",
      reason: "The selected model needs it.",
    });
    expect(res.result.content[0].text).toContain("secure OpenCode API key card");
    expect(res.result.content[0].text).toContain("End this turn");
    expect(lastCredentialBody).toEqual({
      fromBotId: "bot-asker",
      fromThreadId: "thread-asker-routine",
      credentialId: "opencodeGoApiKey",
      reason: "The selected model needs it.",
    });
    expect(JSON.stringify(lastCredentialBody)).not.toContain("secret");
  });

  it("rejects credential ids outside the fixed allowlist locally", async () => {
    lastCredentialBody = null;
    const res = await callTool("request_credential", { credential_id: "arbitrary.config.path" });
    expect(res.result.isError).toBe(true);
    expect(lastCredentialBody).toBeNull();
  });

  it("rejects unknown tools with -32602", async () => {
    const res = await rpc("tools/call", { name: "made_up", arguments: {} });
    expect(res.error.code).toBe(-32602);
  });

  it("requires bot_id and message", async () => {
    const res = await callTool("ask_bot", { bot_id: "", message: "" });
    expect(res.result.isError).toBe(true);
  });
});
