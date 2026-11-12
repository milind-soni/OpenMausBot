// Agent-to-agent comms MCP proxy — spawned as an MCP server inside a bot's
// agent process (via the "agents" integration). Exposes two tools that let
// one bot talk to another, routed back through the harness so the harness
// stays the single owner of turns, permissions, and recursion limits:
//
//   list_bots()            → the other bots in this workspace + their status
//   ask_bot(bot_id, msg)   → send msg to that bot, wait, return its reply
//   list/create/claim/update/delegate_task → shared task-board operations
//
// Speaks raw JSON-RPC 2.0 over stdio (no MCP SDK — house style, matches
// permission-proxy). All state comes from env, injected by
// the harness when it builds the integration:
//   GBS_HARNESS_URL  base URL of the harness (http://127.0.0.1:8899)
//   GBS_BOT_ID       the calling bot's id (excluded from list_bots; sender)
//   GBS_COMMS_TOKEN  shared secret for the localhost-only internal endpoints
//   GBS_TURN_DEPTH   this turn's comms depth (the harness refuses recursion)
import readline from "node:readline";

const HARNESS = process.env.GBS_HARNESS_URL ?? "http://127.0.0.1:8899";
const BOT_ID = process.env.GBS_BOT_ID ?? "";
const TOKEN = process.env.GBS_COMMS_TOKEN ?? "";
const DEPTH = Number(process.env.GBS_TURN_DEPTH ?? "0") || 0;

const TOOLS = [
  {
    name: "list_bots",
    description:
      "List the other bots (agents) in this Gerer Build Studio workspace you can message, with their model and whether they're busy. Call this before ask_bot to discover who's available.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "ask_bot",
    description:
      "Send a message to another bot in this workspace and wait for its reply. Use it to delegate a subtask to a specialist bot or ask a peer a question. The other bot runs a full turn under its own model and permissions; the reply is returned to you as text. Returns promptly with a note if that bot is busy.",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: { type: "string", description: "The target bot's id (from list_bots)." },
        message: { type: "string", description: "What to say / ask the bot." },
      },
      required: ["bot_id", "message"],
    },
  },
  {
    name: "list_tasks",
    description:
      "List work on the shared task board. Use filters to find unassigned work you can claim or tasks assigned to a specific agent. Project tasks include their trusted local path when available. Always use the task tools for changes; never edit tasks.json directly.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        project_id: { type: "string" },
        assignee_bot_id: { type: "string", description: "A bot id, or 'unassigned'." },
        status: { type: "string", enum: ["todo", "doing", "review", "done"] },
        type: { type: "string", enum: ["feature", "bug", "task", "research", "documentation", "maintenance"] },
        priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
        tag: { type: "string" },
        overdue: { type: "boolean" },
      },
    },
  },
  {
    name: "create_task",
    description: "Create a structured task on the shared board. You may leave it unassigned, assign it to yourself, or delegate it to another bot id.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        description: { type: "string" },
        acceptance_criteria: { type: "array", items: { type: "string" } },
        status: { type: "string", enum: ["todo", "doing", "review", "done"] },
        type: { type: "string", enum: ["feature", "bug", "task", "research", "documentation", "maintenance"] },
        priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
        tags: { type: "array", items: { type: "string" } },
        due_at: { type: "string", description: "An ISO-8601 date/time." },
        project_id: { type: "string" },
        assignee_bot_id: { type: "string" },
      },
      required: ["title"],
    },
  },
  {
    name: "claim_task",
    description: "Atomically claim an unassigned, incomplete task for yourself and move it to doing. Requires the revision returned by list_tasks.",
    inputSchema: {
      type: "object",
      properties: { task_id: { type: "string" }, revision: { type: "integer" } },
      required: ["task_id", "revision"],
    },
  },
  {
    name: "update_task",
    description: "Update content or progress on a shared task. Requires its current revision; conflicts return the latest task instead of overwriting it.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        revision: { type: "integer" },
        title: { type: "string" },
        description: { type: "string" },
        acceptance_criteria: { type: "array", items: { type: "string" } },
        status: { type: "string", enum: ["todo", "doing", "review", "done"] },
        type: { type: "string", enum: ["feature", "bug", "task", "research", "documentation", "maintenance"] },
        priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
        tags: { type: "array", items: { type: "string" } },
        due_at: { type: ["string", "null"] },
        project_id: { type: ["string", "null"] },
        assignee_bot_id: { type: ["string", "null"] },
      },
      required: ["task_id", "revision"],
    },
  },
  {
    name: "delegate_task",
    description: "Assign an incomplete task to another visible bot. Call list_bots for the target id and use the task's current revision.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        revision: { type: "integer" },
        bot_id: { type: "string" },
      },
      required: ["task_id", "revision", "bot_id"],
    },
  },
  {
    name: "delete_task",
    description: "Permanently delete a task from the shared board. Requires its current revision. Use sparingly — prefer moving a task to done over deleting finished work.",
    inputSchema: {
      type: "object",
      properties: { task_id: { type: "string" }, revision: { type: "integer" } },
      required: ["task_id", "revision"],
    },
  },
].filter((tool) => DEPTH < 1 || (tool.name !== "list_bots" && tool.name !== "ask_bot"));

type Json = Record<string, unknown>;
const send = (msg: Json) => process.stdout.write(JSON.stringify(msg) + "\n");
const ok = (id: unknown, result: unknown) => send({ jsonrpc: "2.0", id, result });
const rpcErr = (id: unknown, code: number, message: string) => send({ jsonrpc: "2.0", id, error: { code, message } });
const textResult = (id: unknown, text: string, isError = false) =>
  ok(id, { content: [{ type: "text", text }], isError });

async function api(path: string, init?: RequestInit): Promise<Json> {
  const res = await fetch(HARNESS + path, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${TOKEN}`,
      "x-gbs-bot-id": BOT_ID,
      ...(init?.headers ?? {}),
    },
  });
  const body = (await res.json().catch(() => ({}))) as Json;
  if (!res.ok) {
    const latest = body.latest ? `\nLatest task:\n${JSON.stringify(body.latest, null, 2)}` : "";
    throw new Error(`${String(body.error ?? `HTTP ${res.status}`)}${latest}`);
  }
  return body;
}

function taskInput(args: Json): Json {
  const mapped: Json = {};
  const fields: Array<[string, string]> = [
    ["title", "title"], ["description", "description"], ["acceptance_criteria", "acceptanceCriteria"],
    ["status", "status"], ["type", "type"], ["priority", "priority"], ["tags", "tags"],
    ["due_at", "dueAt"], ["project_id", "projectId"], ["assignee_bot_id", "assigneeBotId"],
  ];
  for (const [source, target] of fields) if (args[source] !== undefined) mapped[target] = args[source];
  return mapped;
}

function renderTask(task: Json): string {
  const project = task.project as Json | null | undefined;
  const assignee = task.assignee as Json | null | undefined;
  const lines = [
    `${task.title} [id: ${task.id}, revision: ${task.revision}]`,
    `status: ${task.status} | priority: ${task.priority} | type: ${task.type}`,
    `assignee: ${assignee?.name ?? "unassigned"}${assignee?.id ? ` (${assignee.id})` : ""}`,
    `project: ${project ? `#${project.mention} (${project.name})${project.path ? ` at ${project.path}` : project.available ? "" : " [unavailable]"}` : "none"}`,
  ];
  if (task.trelloCardUrl) lines.push(`trello: ${task.trelloCardUrl}`);
  if (task.tags && (task.tags as unknown[]).length) lines.push(`tags: ${(task.tags as unknown[]).join(", ")}`);
  if (task.dueAt) lines.push(`due: ${new Date(Number(task.dueAt)).toISOString()}`);
  if (task.description) lines.push(`description: ${task.description}`);
  if (task.acceptanceCriteria && (task.acceptanceCriteria as unknown[]).length) {
    lines.push(`acceptance criteria:\n${(task.acceptanceCriteria as unknown[]).map((item) => `- ${item}`).join("\n")}`);
  }
  return lines.join("\n");
}

async function callTool(name: string, args: Json): Promise<{ text: string; isError?: boolean }> {
  if (name === "list_bots") {
    const r = await api(`/api/internal/agents?self=${encodeURIComponent(BOT_ID)}`);
    const bots = (r.bots as Array<Json>) ?? [];
    if (!bots.length) return { text: "No other bots in this workspace yet." };
    const lines = bots.map((b) => {
      const role = b.title ? ` — ${b.title}` : "";
      const about = b.description ? ` (${String(b.description).slice(0, 120)})` : "";
      return `- ${b.name}${role}${about} [id: ${b.id}, model: ${b.model}${b.busy ? ", busy" : ""}]`;
    });
    return { text: `Other bots you can message with ask_bot:\n${lines.join("\n")}` };
  }
  if (name === "ask_bot") {
    const toBotId = String(args.bot_id ?? "").trim();
    const message = String(args.message ?? "").trim();
    if (!toBotId || !message) return { text: "ask_bot needs bot_id and message.", isError: true };
    const r = await api(`/api/internal/ask-bot`, {
      method: "POST",
      body: JSON.stringify({ fromBotId: BOT_ID, toBotId, message, depth: DEPTH }),
    });
    if (r.busy) return { text: `That bot is busy right now — try again after it finishes.` };
    if (r.error) return { text: `Couldn't reach that bot: ${r.error}`, isError: true };
    return { text: `${r.botName ?? "Bot"} replied:\n${r.text ?? "(no reply)"}` };
  }
  if (name === "list_tasks") {
    const query = new URLSearchParams();
    for (const [source, target] of [
      ["text", "text"], ["project_id", "projectId"], ["assignee_bot_id", "assigneeBotId"],
      ["status", "status"], ["type", "type"], ["priority", "priority"], ["tag", "tag"], ["overdue", "overdue"],
    ]) {
      if (args[source] !== undefined) query.set(target, String(args[source]));
    }
    const r = await api(`/api/internal/tasks${query.size ? `?${query}` : ""}`);
    const tasks = (r.tasks as Json[]) ?? [];
    if (!tasks.length) return { text: "No tasks match those filters." };
    return { text: `Shared task board (${tasks.length}):\n\n${tasks.map(renderTask).join("\n\n---\n\n")}` };
  }
  if (name === "create_task") {
    if (!String(args.title ?? "").trim()) return { text: "create_task needs a title.", isError: true };
    const r = await api("/api/internal/tasks", { method: "POST", body: JSON.stringify(taskInput(args)) });
    return { text: `Created task:\n${renderTask(r.task as Json)}` };
  }
  if (name === "claim_task") {
    const taskId = String(args.task_id ?? "").trim();
    const revision = Number(args.revision);
    if (!taskId || !Number.isInteger(revision)) return { text: "claim_task needs task_id and revision.", isError: true };
    const r = await api(`/api/internal/tasks/${encodeURIComponent(taskId)}/claim`, {
      method: "POST", body: JSON.stringify({ revision }),
    });
    return { text: `Claimed task:\n${renderTask(r.task as Json)}` };
  }
  if (name === "update_task") {
    const taskId = String(args.task_id ?? "").trim();
    const revision = Number(args.revision);
    const patch = taskInput(args);
    if (!taskId || !Number.isInteger(revision)) return { text: "update_task needs task_id and revision.", isError: true };
    if (!Object.keys(patch).length) return { text: "update_task needs at least one field to change.", isError: true };
    const r = await api(`/api/internal/tasks/${encodeURIComponent(taskId)}`, {
      method: "PATCH", body: JSON.stringify({ revision, patch }),
    });
    return { text: `Updated task:\n${renderTask(r.task as Json)}` };
  }
  if (name === "delegate_task") {
    const taskId = String(args.task_id ?? "").trim();
    const botId = String(args.bot_id ?? "").trim();
    const revision = Number(args.revision);
    if (!taskId || !botId || !Number.isInteger(revision)) {
      return { text: "delegate_task needs task_id, revision, and bot_id.", isError: true };
    }
    const r = await api(`/api/internal/tasks/${encodeURIComponent(taskId)}/delegate`, {
      method: "POST", body: JSON.stringify({ revision, botId }),
    });
    return { text: `Delegated task:\n${renderTask(r.task as Json)}` };
  }
  if (name === "delete_task") {
    const taskId = String(args.task_id ?? "").trim();
    const revision = Number(args.revision);
    if (!taskId || !Number.isInteger(revision)) return { text: "delete_task needs task_id and revision.", isError: true };
    await api(`/api/internal/tasks/${encodeURIComponent(taskId)}`, {
      method: "DELETE", body: JSON.stringify({ revision }),
    });
    return { text: `Deleted task ${taskId}.` };
  }
  return { text: `Unknown tool: ${name}`, isError: true };
}

async function handle(msg: Json) {
  const id = msg.id;
  const method = msg.method as string | undefined;
  if (!method) return;
  const params = (msg.params ?? {}) as Json;
  switch (method) {
    case "initialize":
      ok(id, {
        protocolVersion: (params.protocolVersion as string) ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "gerer-build-studio-agents", version: "0.1.0" },
      });
      return;
    case "notifications/initialized":
    case "notifications/cancelled":
      return;
    case "ping":
      ok(id, {});
      return;
    case "tools/list":
      ok(id, { tools: TOOLS });
      return;
    case "tools/call": {
      const name = params.name as string;
      if (!TOOLS.some((t) => t.name === name)) return rpcErr(id, -32602, `Unknown tool: ${name}`);
      try {
        const { text, isError } = await callTool(name, (params.arguments ?? {}) as Json);
        textResult(id, text, isError);
      } catch (e) {
        textResult(id, (e as Error).message, true);
      }
      return;
    }
    default:
      if (id !== undefined) rpcErr(id, -32601, `Method not found: ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const t = line.trim();
  if (!t) return;
  let msg: Json;
  try {
    msg = JSON.parse(t) as Json;
  } catch {
    return;
  }
  void handle(msg).catch((e) => {
    if (msg.id !== undefined) rpcErr(msg.id, -32603, (e as Error).message);
  });
});
rl.on("close", () => process.exit(0));
