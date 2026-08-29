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
let lastRoutineQuery = "";
let routinesResponse: unknown = {
  now: "2026-08-28T10:30:00.000Z",
  timeZone: "Asia/Kolkata",
  routines: [
    {
      id: "routine-1",
      name: "Morning brief",
      enabled: true,
      schedule: { type: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] },
      nextRunAt: "2026-08-31T03:30:00.000Z",
    },
  ],
};
let lastRoutineRequestBody: any = null;

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
    if (req.method === "GET" && req.url?.startsWith("/api/internal/routines?")) {
      lastRoutineQuery = req.url;
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(routinesResponse));
    }
    if (req.method === "POST" && req.url === "/api/internal/routine-requests") {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        lastRoutineRequestBody = JSON.parse(data);
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ requestId: "routine-request-1", summary: "Weekdays at 09:00 (Asia/Kolkata)" }));
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
  it("answers the MCP handshake and lists all eight tools", async () => {
    const init = await rpc("initialize", { protocolVersion: "2024-11-05" });
    expect(init.result.serverInfo.name).toContain("agents");
    const list = await rpc("tools/list");
    expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual([
      "list_bots",
      "ask_bot",
      "delegate_bot",
      "create_bot",
      "request_credential",
      "list_routines",
      "propose_routine",
      "propose_routine_action",
    ]);
  });

  it("publishes a flat routine schedule schema that survives provider conversion", async () => {
    const list = await rpc("tools/list");
    const create = list.result.tools.find((t: { name: string }) => t.name === "propose_routine");
    expect(create.inputSchema.required).toEqual(["name", "instructions", "schedule"]);
    const schedule = create.inputSchema.properties.schedule;
    // No composition keywords anywhere in the tool surface: several agent
    // CLIs flatten or drop oneOf/anyOf/const when converting MCP tools for
    // their model API, and a model that never saw the branches guesses
    // shapes forever (the 0.1.38 field failure).
    expect(JSON.stringify(create.inputSchema)).not.toMatch(/"oneOf"|"anyOf"|"allOf"|"const"/);
    expect(schedule.type).toBe("object");
    expect(schedule.required).toEqual(["type"]);
    expect(schedule.properties.type.enum).toEqual(["once", "weekly", "daily"]);
    expect(schedule.properties.weekdays.items.enum).toEqual([
      "monday",
      "tuesday",
      "wednesday",
      "thursday",
      "friday",
      "saturday",
      "sunday",
    ]);
    expect(create.description).toContain("does NOT enable");
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

  it("lists only the current bot's routines with authoritative time context", async () => {
    routinesResponse = {
      now: "2026-08-28T10:30:00.000Z",
      timeZone: "Asia/Kolkata",
      routines: [{ id: "routine-1", name: "Morning brief", enabled: true }],
    };
    const res = await callTool("list_routines", {});
    expect(res.result.content[0].text).toContain("routine-1");
    expect(res.result.content[0].text).toContain("Asia/Kolkata");
    const query = new URL(lastRoutineQuery, "http://localhost").searchParams;
    expect(query.get("fromBotId")).toBe("bot-asker");
    expect(query.get("fromThreadId")).toBe("thread-asker-routine");
    expect(lastAuth).toBe(`Bearer ${TOKEN}`);
  });

  it("proposes a weekly routine through a confirmation-only request", async () => {
    lastRoutineRequestBody = null;
    const res = await callTool("propose_routine", {
      name: "Morning brief",
      instructions: "Summarize today's priorities.",
      schedule: { type: "weekly", time: "09:00", weekdays: ["monday", "friday"] },
      run_on: "maus",
      duration_minutes: 45,
    });
    expect(lastRoutineRequestBody).toEqual({
      fromBotId: "bot-asker",
      fromThreadId: "thread-asker-routine",
      action: "create",
      routine: {
        name: "Morning brief",
        instructions: "Summarize today's priorities.",
        schedule: { type: "weekly", time: "09:00", weekdays: ["monday", "friday"] },
        runOn: "maus",
        durationMinutes: 45,
      },
    });
    expect(res.result.content[0].text).toContain("confirmation card");
    expect(res.result.content[0].text).toContain("has not been applied");
    expect(res.result.content[0].text).toContain("do not claim");
    expect(res.result.isError).toBeFalsy();
  });

  it("proposes a one-time routine with the explicit-offset timestamp intact", async () => {
    await callTool("propose_routine", {
      name: "Send follow-up",
      instructions: "Draft the follow-up for review.",
      schedule: { type: "once", at: "2026-09-01T09:00:00+05:30" },
    });
    expect(lastRoutineRequestBody.routine.schedule).toEqual({
      type: "once",
      at: "2026-09-01T09:00:00+05:30",
    });
  });

  it("proposes routine updates and destructive actions without applying them", async () => {
    const update = await callTool("propose_routine_action", {
      routine_id: "routine-1",
      action: "update",
      changes: { name: "Weekday brief", duration_minutes: 60 },
    });
    expect(lastRoutineRequestBody).toEqual({
      fromBotId: "bot-asker",
      fromThreadId: "thread-asker-routine",
      action: "update",
      routineId: "routine-1",
      changes: { name: "Weekday brief", durationMinutes: 60 },
    });
    expect(update.result.content[0].text).toContain("has not been applied");

    await callTool("propose_routine_action", { routine_id: "routine-1", action: "delete" });
    expect(lastRoutineRequestBody).toEqual({
      fromBotId: "bot-asker",
      fromThreadId: "thread-asker-routine",
      action: "delete",
      routineId: "routine-1",
    });
  });

  it("coerces the schedule shapes models actually send", async () => {
    // "daily" is the natural word for every-day; it becomes weekly on all
    // seven days on the wire, so the harness dialect stays unchanged.
    await callTool("propose_routine", {
      name: "Daily check",
      instructions: "Check things.",
      schedule: { type: "daily", time: "09:00" },
    });
    expect(lastRoutineRequestBody.routine.schedule).toEqual({
      type: "weekly",
      time: "09:00",
      weekdays: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"],
    });

    // Capitalized and short weekday names have one obvious meaning.
    await callTool("propose_routine", {
      name: "Caps",
      instructions: "x.",
      schedule: { type: "weekly", time: "09:00", weekdays: ["Monday", "FRI"] },
    });
    expect(lastRoutineRequestBody.routine.schedule.weekdays).toEqual(["monday", "friday"]);

    // Models routinely deliver nested objects as JSON strings.
    await callTool("propose_routine", {
      name: "Str",
      instructions: "x.",
      schedule: JSON.stringify({ type: "weekly", time: "09:00", weekdays: ["monday"] }),
    });
    expect(lastRoutineRequestBody.routine.schedule).toEqual({ type: "weekly", time: "09:00", weekdays: ["monday"] });
  });

  it("answers unsupported schedules with instructions, before calling the harness", async () => {
    lastRoutineRequestBody = null;
    const interval = await callTool("propose_routine", {
      name: "Interval",
      instructions: "x.",
      schedule: { type: "interval", minutes: 30 },
    });
    expect(interval.result.isError).toBe(true);
    expect(interval.result.content[0].text).toContain("sub-day intervals");
    expect(interval.result.content[0].text).toContain('"type":"daily"');

    const noDays = await callTool("propose_routine", {
      name: "NoDays",
      instructions: "x.",
      schedule: { type: "weekly", time: "09:00" },
    });
    expect(noDays.result.isError).toBe(true);
    expect(noDays.result.content[0].text).toContain("weekdays");
    expect(noDays.result.content[0].text).toContain("daily");

    const unknown = await callTool("propose_routine_action", {
      routine_id: "routine-1",
      action: "update",
      changes: { schedule: { type: "fortnightly", time: "09:00" } },
    });
    expect(unknown.result.isError).toBe(true);
    expect(unknown.result.content[0].text).toContain("Unknown schedule type");
    expect(lastRoutineRequestBody).toBeNull();
  });

  it("rejects malformed routine proposals before calling the harness", async () => {
    lastRoutineRequestBody = null;
    const missing = await callTool("propose_routine", {
      name: "No schedule",
      instructions: "This cannot be scheduled yet.",
    });
    expect(missing.result.isError).toBe(true);
    expect(lastRoutineRequestBody).toBeNull();

    const badUpdate = await callTool("propose_routine_action", {
      routine_id: "routine-1",
      action: "update",
      changes: {},
    });
    expect(badUpdate.result.isError).toBe(true);
    expect(lastRoutineRequestBody).toBeNull();
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
