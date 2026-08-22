// dweb MCP proxy — spawned as an MCP server inside a bot's agent process.
// Exposes dweb's HTTP API (the local OpenMaus network daemon) as tools an
// agent can call to inspect the network and run model requests:
//
//   dweb_status          → ping dweb, summarize server + peer state
//   dweb_repo_status     → the OpenMausBot repo the daemon is tracking
//   dweb_opencode_models → models available on the opencode integration
//   dweb_opencode_run    → run a model command, wait up to 5 min for output
//
// Speaks raw JSON-RPC 2.0 over stdio (no MCP SDK — house style, matches
// agents-proxy / computer-proxy / permission-proxy). Config comes from env:
//   DWEB_URL  base URL of the local dweb daemon (http://127.0.0.1:49737)
import readline from "node:readline";

const DWEB = (process.env.DWEB_URL ?? "http://127.0.0.1:49737").replace(/\/+$/, "");
const DWEB_DISPLAY = (() => {
  try {
    const url = new URL(DWEB);
    url.username = "";
    url.password = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return "(invalid DWEB_URL)";
  }
})();

const TOOLS = [
  {
    name: "dweb_status",
    description:
      "Ping the local dweb daemon and report its status: server id, hostname, platform, version, uptime, peer count, and the services it runs. Call this first to confirm the network is reachable and see what's available.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "dweb_repo_status",
    description:
      "Report the state of the OpenMausBot repository the dweb daemon is tracking: repo name, checked-out branch, last commit, file count, and checkout path.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "dweb_opencode_models",
    description:
      "List the models available on dweb's opencode integration. Each has an id you can pass to dweb_opencode_run. Returns a note if no models are available.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "dweb_opencode_run",
    description:
      "Run a model on dweb's opencode integration and wait for the result. Give a command for the model to process; optionally pick a model with the 'model' arg (defaults to dweb's choice). Can take several minutes — use this for long-running model work and report the output back verbatim.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command/prompt to run on the model." },
        model: { type: "string", description: "Optional model id (from dweb_opencode_models)." },
      },
      required: ["command"],
    },
  },
];

type Json = Record<string, unknown>;
const send = (msg: Json) => process.stdout.write(JSON.stringify(msg) + "\n");
const ok = (id: unknown, result: unknown) => send({ jsonrpc: "2.0", id, result });
const rpcErr = (id: unknown, code: number, message: string) => send({ jsonrpc: "2.0", id, error: { code, message } });
const textResult = (id: unknown, text: string, isError = false) =>
  ok(id, { content: [{ type: "text", text }], isError });

async function api(path: string, init?: RequestInit): Promise<Json> {
  const res = await fetch(DWEB + path, {
    signal: AbortSignal.timeout(30_000),
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const body = (await res.json().catch(() => ({}))) as Json;
  if (!res.ok) throw new Error(String(body.error ?? `HTTP ${res.status}`));
  return body;
}

async function callTool(name: string, args: Json): Promise<{ text: string; isError?: boolean }> {
  if (name === "dweb_status") {
    const r = await api("/ping");
    const lines = [
      `status: ${String(r.status ?? "unknown")}`,
      `server: ${String(r.server ?? "unknown")}`,
      `id: ${String(r.id ?? "unknown")}`,
      `hostname: ${String(r.hostname ?? "unknown")}`,
      `platform: ${String(r.platform ?? "unknown")}`,
      `version: ${String(r.version ?? "unknown")}`,
      `uptime: ${String(r.uptime ?? "unknown")}`,
      `peers: ${String(r.peers ?? "unknown")}`,
      `services: ${String(r.services ?? "unknown")}`,
    ];
    return { text: `dweb status:\n${lines.join("\n")}` };
  }
  if (name === "dweb_repo_status") {
    const r = await api("/api/repo/status");
    const lines = [
      `repo: ${String(r.repo ?? "unknown")}`,
      `branch: ${String(r.branch ?? "unknown")}`,
      `commit: ${String(r.commit ?? "unknown")}`,
      `files: ${String(r.files ?? "unknown")}`,
      `path: ${String(r.path ?? "unknown")}`,
    ];
    return { text: `dweb repo status:\n${lines.join("\n")}` };
  }
  if (name === "dweb_opencode_models") {
    const r = await api("/api/opencode/models");
    const models = Array.isArray(r.models) ? r.models : [];
    if (!models.length) return { text: "No models available on dweb's opencode integration." };
    const lines = models.map((model) => {
      const id = typeof model === "object" && model !== null && "id" in model ? model.id : model;
      return `- ${String(id)}`;
    });
    return { text: `Models available on dweb's opencode integration:\n${lines.join("\n")}` };
  }
  if (name === "dweb_opencode_run") {
    if (typeof args.command !== "string" || !args.command.trim()) {
      return { text: "dweb_opencode_run needs a string command.", isError: true };
    }
    if (args.model !== undefined && typeof args.model !== "string") {
      return { text: "dweb_opencode_run model must be a string.", isError: true };
    }
    const command = args.command.trim();
    const model = args.model?.trim() || undefined;
    const r = await api("/api/opencode/run", {
      method: "POST",
      body: JSON.stringify({ command, ...(model !== undefined ? { model } : {}) }),
      signal: AbortSignal.timeout(300000),
    });
    if (r.status === "error") {
      return {
        text: `dweb request failed at ${DWEB_DISPLAY}: ${String(r.error ?? r.output ?? "opencode run failed")}`,
        isError: true,
      };
    }
    return { text: String(r.output ?? "(no output)") };
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
        serverInfo: { name: "dweb-proxy", version: "0.1.0" },
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
        const rawArgs = params.arguments;
        const args = typeof rawArgs === "object" && rawArgs !== null && !Array.isArray(rawArgs) ? (rawArgs as Json) : {};
        const { text, isError } = await callTool(name, args);
        textResult(id, text, isError);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        textResult(id, `dweb request failed at ${DWEB_DISPLAY}: ${message}`, true);
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
