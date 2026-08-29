// permission-proxy — the MCP stdio server the claude CLI spawns for
// --permission-prompt-tool. It forwards asks over a local broker socket and
// keeps the MCP call alive across a short broker/app restart.
//
// stdout is the MCP channel — never console.log here.
import { connect, type Socket } from "node:net";
import { randomUUID } from "node:crypto";

const socketPath = process.argv[2] ?? "";

type JsonRecord = Record<string, unknown>;
type AskBehavior = "allow" | "deny" | "answer";

interface BrokerAnswer {
  id: string;
  behavior?: AskBehavior;
  message?: string;
  always?: boolean;
}
interface PendingCall {
  line: string;
  resolve: (answer: BrokerAnswer) => void;
  connection: Socket | null;
  disconnectedTimeout: ReturnType<typeof setTimeout> | null;
}

const waiting = new Map<string, PendingCall>();
const CONNECT_BACKOFF_MS = [25, 50, 100, 250, 500, 1_000, 2_000, 4_000] as const;
const BROKER_GRACE_MS = 15_000;
let conn: Socket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;
let shuttingDown = false;

const isRecord = (value: unknown): value is JsonRecord => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const asRecord = (value: unknown): JsonRecord => (isRecord(value) ? value : {});

const send = (obj: unknown): void => { process.stdout.write(JSON.stringify(obj) + "\n"); };

const unavailable = (id: string): BrokerAnswer => ({
  id,
  behavior: "deny",
  message: "OpenMausBot: permission broker unavailable — skip this action",
});

function armDisconnectedTimeout(id: string, pending: PendingCall): void {
  if (pending.disconnectedTimeout) return;
  pending.disconnectedTimeout = setTimeout(() => settleUnavailable(id), BROKER_GRACE_MS);
  pending.disconnectedTimeout.unref?.();
}

function clearDisconnectedTimeout(pending: PendingCall): void {
  if (!pending.disconnectedTimeout) return;
  clearTimeout(pending.disconnectedTimeout);
  pending.disconnectedTimeout = null;
}

function settleUnavailable(id: string): void {
  const pending = waiting.get(id);
  if (!pending) return;
  waiting.delete(id);
  clearDisconnectedTimeout(pending);
  pending.resolve(unavailable(id));
}

function scheduleReconnect(): void {
  if (shuttingDown || reconnectTimer || conn || !waiting.size) return;
  const delay = CONNECT_BACKOFF_MS[Math.min(reconnectAttempt, CONNECT_BACKOFF_MS.length - 1)];
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectBroker();
  }, delay);
  reconnectTimer.unref?.();
}

function sendPending(socket: Socket): void {
  for (const [id, pending] of waiting) {
    if (pending.connection === socket) continue;
    pending.connection = socket;
    try {
      socket.write(pending.line, (error?: Error | null) => {
        if (!error || pending.connection !== socket) return;
        pending.connection = null;
        armDisconnectedTimeout(id, pending);
        socket.destroy();
      });
    } catch {
      pending.connection = null;
      armDisconnectedTimeout(id, pending);
      socket.destroy();
    }
  }
}

function connectBroker(): void {
  if (shuttingDown || conn || !socketPath) return;
  const candidate = connect(socketPath);
  conn = candidate;
  let buffer = "";
  const detach = () => {
    if (conn !== candidate) return;
    conn = null;
    for (const [id, pending] of waiting) {
      if (pending.connection === candidate) {
        pending.connection = null;
        armDisconnectedTimeout(id, pending);
      }
    }
    candidate.destroy();
    reconnectAttempt++;
    scheduleReconnect();
  };
  candidate.on("connect", () => {
    reconnectAttempt = 0;
    for (const pending of waiting.values()) clearDisconnectedTimeout(pending);
    sendPending(candidate);
  });
  candidate.on("data", (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(value) || value.t !== "answer" || typeof value.id !== "string") continue;
      const pending = waiting.get(value.id);
      if (!pending) continue;
      waiting.delete(value.id);
      clearDisconnectedTimeout(pending);
      pending.resolve({
        id: value.id,
        behavior: value.behavior === "allow" || value.behavior === "deny" || value.behavior === "answer" ? value.behavior : "deny",
        message: typeof value.message === "string" ? value.message : undefined,
        always: value.always === true,
      });
    }
  });
  candidate.on("error", detach);
  candidate.on("close", detach);
}

function askBroker(ask: JsonRecord): Promise<BrokerAnswer> {
  const id = randomUUID();
  const isQuestion = ask.kind === "question";
  const line = JSON.stringify({ t: "ask", id, ...(isQuestion ? { kind: "question" } : {}), tool: ask.tool, input: ask.input }) + "\n";
  return new Promise((resolve) => {
    const pending: PendingCall = { line, resolve, connection: null, disconnectedTimeout: null };
    waiting.set(id, pending);
    armDisconnectedTimeout(id, pending);
    connectBroker();
    scheduleReconnect();
    if (conn) sendPending(conn);
  });
}

const TOOLS = [
  {
    name: "approve",
    description: "Ask the OpenMausBot user whether a tool use is allowed",
    inputSchema: {
      type: "object",
      properties: {
        tool_name: { type: "string" },
        input: { type: "object" },
        tool_use_id: { type: "string" },
      },
      required: ["tool_name", "input"],
    },
  },
  {
    name: "ask_user",
    description:
      "Ask the human who owns this bot a question and wait for their answer. Use whenever you need a decision, a preference, missing information, or sign-off before doing something consequential — do not guess on things the owner would want to decide. Returns their answer as text.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question, with enough context to answer at a glance" },
        choices: { type: "array", items: { type: "string" }, description: "Optional 2-5 suggested answers, shown as one-tap buttons" },
      },
      required: ["question"],
    },
  },
];

async function handle(value: unknown): Promise<void> {
  if (!isRecord(value)) return;
  const id = value.id;
  if (value.method === "initialize") {
    return send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: asRecord(value.params).protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "openmausbot-permissions", version: "1" },
      },
    });
  }
  if (value.method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
  if (value.method === "tools/call") {
    const params = asRecord(value.params);
    const args = asRecord(params.arguments);
    const name = params.name;
    const answer = await askBroker({
      kind: name === "ask_user" ? "question" : "permission",
      tool: name === "ask_user" ? "ask_user" : args.tool_name,
      input: name === "ask_user" ? { question: args.question, choices: args.choices } : args.input,
    });
    const suggestions = Array.isArray(args.permission_suggestions)
      ? args.permission_suggestions
      : Array.isArray(args.suggestions)
        ? args.suggestions
        : null;
    let text = answer.message || "No answer was given — use your best judgment.";
    if (name !== "ask_user") {
      if (answer.behavior === "allow") {
        const result: JsonRecord = { behavior: "allow", updatedInput: asRecord(args.input) };
        if (answer.always && suggestions) result.updatedPermissions = suggestions;
        text = JSON.stringify(result);
      } else {
        text = JSON.stringify({ behavior: "deny", message: answer.message || "Denied from OpenMausBot" });
      }
    }
    return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });
  }
  if (typeof value.method === "string" && value.method.startsWith("notifications/")) return;
  if (id !== undefined && id !== null) send({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found: " + String(value.method) } });
}

let inputBuffer = "";
process.stdin.on("data", (chunk) => {
  inputBuffer += chunk;
  let nl;
  while ((nl = inputBuffer.indexOf("\n")) !== -1) {
    const line = inputBuffer.slice(0, nl);
    inputBuffer = inputBuffer.slice(nl + 1);
    if (!line.trim()) continue;
    try {
      void handle(JSON.parse(line));
    } catch {
      /* ignore malformed lines */
    }
  }
});
process.stdin.on("end", () => {
  shuttingDown = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  conn?.destroy();
  process.exit(0);
});

connectBroker();
