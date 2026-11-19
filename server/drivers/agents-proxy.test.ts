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
let lastBotHeader: string | undefined;
let lastAskBody: any = null;
let askResponse: unknown = { botName: "Helper", text: "hi from helper" };
let lastTaskRequest: { method?: string; url?: string; body?: any } | null = null;
let taskStatus = 200;
let lastAppCall: { url?: string; body?: any } | null = null;
const task = {
  id: "task-one",
  title: "Build board",
  description: "Shared work",
  acceptanceCriteria: ["Agents can claim it"],
  status: "todo",
  type: "feature",
  priority: "high",
  tags: ["agents"],
  dueAt: null,
  revision: 3,
  project: { id: "project-one", name: "Studio", mention: "studio", available: true, path: "/workspace/studio" },
  assignee: null,
};

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
    lastBotHeader = req.headers["x-gbs-bot-id"] as string | undefined;
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "unauthorized" }));
    }
    if (req.url === "/api/internal/approval") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ approved: false, always: false }));
    }
    if (req.url?.startsWith("/api/internal/preview-testing/")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ sessionId: "test-session", image: "aW1hZ2U=", artifactPath: "/project/evidence.png" }));
    }
    if (req.method === "GET" && req.url?.startsWith("/api/internal/apps")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ apps: [{ id: "edits", name: "Edits", status: "ready", actions: [{ name: "create_project" }] }] }));
    }
    if (req.method === "POST" && req.url?.startsWith("/api/internal/apps/")) {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        lastAppCall = { url: req.url, body: JSON.parse(data) };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ result: { content: [{ type: "text", text: "Project TEST · montage created" }, { type: "image", data: "anBn", mimeType: "image/jpeg" }] } }));
      });
      return;
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
    if (req.method === "GET" && req.url?.startsWith("/api/internal/tasks")) {
      lastTaskRequest = { method: req.method, url: req.url };
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ tasks: [task] }));
    }
    if (req.url?.startsWith("/api/internal/tasks") && ["POST", "PATCH", "DELETE"].includes(req.method ?? "")) {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        lastTaskRequest = { method: req.method, url: req.url, body: data ? JSON.parse(data) : {} };
        res.writeHead(taskStatus, { "content-type": "application/json" });
        res.end(JSON.stringify(taskStatus === 409 ? { error: "stale revision", latest: task } : { task }));
        taskStatus = 200;
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
      GBS_HARNESS_URL: `http://127.0.0.1:${stubPort}`,
      GBS_BOT_ID: "bot-asker",
      GBS_COMMS_TOKEN: TOKEN,
      GBS_TURN_DEPTH: "0",
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
  it("answers the MCP handshake and lists communication and task tools", async () => {
    const init = await rpc("initialize", { protocolVersion: "2024-11-05" });
    expect(init.result.serverInfo.name).toContain("agents");
    const list = await rpc("tools/list");
    expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual([
      "request_approval", "preview_status", "preview_open", "preview_snapshot", "preview_screenshot", "preview_diagnostics", "preview_close", "preview_action",
      "list_schedules", "cancel_schedule", "create_schedule", "list_apps", "use_app", "list_bots", "ask_bot", "list_tasks", "create_task", "claim_task", "update_task", "delegate_task", "delete_task",
    ]);
  });

  it("returns consent denial as a tool result the Buddy must respect", async () => {
    const result = await callTool("request_approval", { action: "affinity.copy_files", scope: "/Desktop/TEST", summary: "Copy test files" });
    expect(result.result.isError).toBe(true);
    expect(JSON.parse(result.result.content[0].text)).toEqual({ approved: false, always: false });
  });

  it("returns screenshot image content without putting base64 into its text result", async () => {
    const res = await callTool("preview_screenshot", { session_id: "test-session" });
    expect(res.result.content[0].text).toContain("/project/evidence.png");
    expect(res.result.content[0].text).not.toContain("aW1hZ2U=");
    expect(res.result.content[1]).toEqual({ type: "image", data: "aW1hZ2U=", mimeType: "image/png" });
  });

  it("list_apps and use_app go through the harness, never straight to the app", async () => {
    const list = await callTool("list_apps", {});
    expect(list.result.content[0].text).toContain("create_project");
    const res = await callTool("use_app", { app_id: "edits", tool: "create_project", arguments: { name: "TEST · montage" } });
    expect(lastAppCall).toEqual({ url: "/api/internal/apps/edits/call", body: { tool: "create_project", arguments: { name: "TEST · montage" } } });
    expect(res.result.content[0].text).toBe("Project TEST · montage created");
    expect(res.result.content[1]).toEqual({ type: "image", data: "anBn", mimeType: "image/jpeg" });
    expect(lastAuth).toBe(`Bearer ${TOKEN}`);
  });

  it("forwards Affinity render results as images without base64 in text", async () => {
    const res = await callTool("use_app", { app_id: "affinity", tool: "render_spread", arguments: { document_session_uuid: "TEST-doc", spread_index: 0 } });
    expect(lastAppCall).toMatchObject({ url: "/api/internal/apps/affinity/call", body: { tool: "render_spread" } });
    expect(res.result.content[0].text).not.toContain("anBn");
    expect(res.result.content[1]).toEqual({ type: "image", data: "anBn", mimeType: "image/jpeg" });
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
    expect(lastAskBody).toMatchObject({ fromBotId: "bot-asker", toBotId: "bot-helper", message: "ping", depth: 0 });
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

  it("rejects unknown tools with -32602", async () => {
    const res = await rpc("tools/call", { name: "made_up", arguments: {} });
    expect(res.error.code).toBe(-32602);
  });

  it("requires bot_id and message", async () => {
    const res = await callTool("ask_bot", { bot_id: "", message: "" });
    expect(res.result.isError).toBe(true);
  });

  it("lists filtered tasks with trusted project context and caller identity", async () => {
    const res = await callTool("list_tasks", { status: "todo", assignee_bot_id: "unassigned", tag: "agents" });
    const output = res.result.content[0].text;
    expect(output).toContain("Build board");
    expect(output).toContain("/workspace/studio");
    expect(lastTaskRequest?.url).toContain("status=todo");
    expect(lastTaskRequest?.url).toContain("assigneeBotId=unassigned");
    expect(lastBotHeader).toBe("bot-asker");
  });

  it("creates tasks with mapped structured fields", async () => {
    const res = await callTool("create_task", {
      title: "Build board",
      acceptance_criteria: ["Agents can claim it"],
      project_id: "project-one",
      priority: "high",
    });
    expect(res.result.content[0].text).toContain("Created task");
    expect(lastTaskRequest).toMatchObject({
      method: "POST",
      url: "/api/internal/tasks",
      body: { title: "Build board", acceptanceCriteria: ["Agents can claim it"], projectId: "project-one" },
    });
  });

  it("claims, updates, and delegates with explicit revisions", async () => {
    await callTool("claim_task", { task_id: "task-one", revision: 3 });
    expect(lastTaskRequest).toMatchObject({ url: "/api/internal/tasks/task-one/claim", body: { revision: 3 } });

    await callTool("update_task", { task_id: "task-one", revision: 3, status: "review", tags: ["done"] });
    expect(lastTaskRequest).toMatchObject({
      method: "PATCH",
      url: "/api/internal/tasks/task-one",
      body: { revision: 3, patch: { status: "review", tags: ["done"] } },
    });

    await callTool("delegate_task", { task_id: "task-one", revision: 3, bot_id: "bot-helper" });
    expect(lastTaskRequest).toMatchObject({
      url: "/api/internal/tasks/task-one/delegate",
      body: { revision: 3, botId: "bot-helper" },
    });
  });

  it("deletes a task with its revision", async () => {
    const res = await callTool("delete_task", { task_id: "task-one", revision: 3 });
    expect(lastTaskRequest).toMatchObject({
      method: "DELETE",
      url: "/api/internal/tasks/task-one",
      body: { revision: 3 },
    });
    expect(res.result.content[0].text).toContain("Deleted task task-one");
  });

  it("returns the latest task when an update conflicts", async () => {
    taskStatus = 409;
    const res = await callTool("update_task", { task_id: "task-one", revision: 2, status: "doing" });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain("stale revision");
    expect(res.result.content[0].text).toContain("Latest task");
    expect(res.result.content[0].text).toContain("task-one");
  });
});
