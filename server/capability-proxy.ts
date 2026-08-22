// Per-turn stdio facade for the app-owned capability gateway. The provider
// receives only the loopback URL, boot token, and opaque turn token. Host MCP
// commands, headers, credentials, and backend processes remain in the harness.
import readline from "node:readline";

type Json = Record<string, any>;

const HARNESS = process.env.OMB_HARNESS_URL ?? "http://127.0.0.1:8799";
const AUTH_TOKEN = process.env.OMB_COMMS_TOKEN ?? "";
const TURN_TOKEN = process.env.OMB_TURN_TOKEN ?? "";

const TOOLS = [
  {
    name: "list_capabilities",
    description: "List the intentional host capability servers available to this task and the active manifest hash.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_capability_tools",
    description: "List the tools exposed by one capability server. The backend starts lazily on the first request.",
    inputSchema: {
      type: "object",
      properties: { server: { type: "string", description: "Server name from list_capabilities." } },
      required: ["server"],
    },
  },
  {
    name: "call_capability",
    description: "Call a named tool on an intentional host capability server. Results are sanitized by the host gateway.",
    inputSchema: {
      type: "object",
      properties: {
        server: { type: "string" },
        tool: { type: "string" },
        arguments: { type: "object", additionalProperties: true },
      },
      required: ["server", "tool"],
    },
  },
  {
    name: "list_credential_aliases",
    description: "List CredVault logical aliases without reading or returning any credential value.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "select_credential_alias",
    description: "Select a logical CredVault alias for host-side injection into a capability backend. The raw value never enters this process or its result.",
    inputSchema: {
      type: "object",
      properties: {
        server: { type: "string" },
        alias: { type: "string" },
        environment_name: { type: "string", description: "Environment name expected by the selected backend." },
      },
      required: ["server", "alias", "environment_name"],
    },
  },
] as const;

const send = (message: Json): void => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};
const ok = (id: unknown, result: unknown) => send({ jsonrpc: "2.0", id, result });
const rpcError = (id: unknown, code: number, message: string) =>
  send({ jsonrpc: "2.0", id, error: { code, message } });

async function api(path: string, init?: RequestInit): Promise<Json> {
  const response = await fetch(`${HARNESS}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${AUTH_TOKEN}`,
      "x-openmaus-turn-token": TURN_TOKEN,
      ...init?.headers,
    },
    signal: AbortSignal.timeout(65_000),
  });
  const body = (await response.json().catch(() => ({}))) as Json;
  if (!response.ok) throw new Error(String(body.error ?? `capability gateway returned HTTP ${response.status}`));
  return body;
}

async function call(name: string, args: Json): Promise<any> {
  if (name === "list_capabilities") return (await api("/api/internal/capabilities")).result;
  if (name === "list_capability_tools") {
    const server = String(args.server ?? "");
    return (await api(`/api/internal/capabilities/${encodeURIComponent(server)}/tools`)).result;
  }
  if (name === "call_capability") {
    return (await api("/api/internal/capabilities/call", {
      method: "POST",
      body: JSON.stringify({
        server: String(args.server ?? ""),
        tool: String(args.tool ?? ""),
        arguments: args.arguments && typeof args.arguments === "object" ? args.arguments : {},
      }),
    })).result;
  }
  if (name === "list_credential_aliases") {
    const aliases = (await api("/api/internal/capabilities/credential-aliases")).aliases ?? [];
    return { content: [{ type: "text", text: JSON.stringify(aliases) }] };
  }
  if (name === "select_credential_alias") {
    await api("/api/internal/capabilities/credential-alias", {
      method: "POST",
      body: JSON.stringify({
        server: String(args.server ?? ""),
        alias: String(args.alias ?? ""),
        environmentName: String(args.environment_name ?? ""),
      }),
    });
    return { content: [{ type: "text", text: "Credential alias selected for host-side injection." }] };
  }
  throw new Error("unknown capability tool");
}

async function handle(message: Json): Promise<void> {
  const method = String(message.method ?? "");
  const id = message.id;
  if (method === "initialize") {
    ok(id, {
      protocolVersion: String(message.params?.protocolVersion ?? "2024-11-05"),
      capabilities: { tools: {} },
      serverInfo: { name: "openmaus-capability-gateway", version: "1" },
    });
    return;
  }
  if (["notifications/initialized", "notifications/cancelled"].includes(method)) return;
  if (method === "ping") return ok(id, {});
  if (method === "tools/list") return ok(id, { tools: TOOLS });
  if (method === "tools/call") {
    const name = String(message.params?.name ?? "");
    if (!TOOLS.some((tool) => tool.name === name)) return rpcError(id, -32602, "unknown capability tool");
    try {
      return ok(id, await call(name, (message.params?.arguments ?? {}) as Json));
    } catch (error) {
      return ok(id, {
        content: [{ type: "text", text: error instanceof Error ? error.message : "capability call failed" }],
        isError: true,
      });
    }
  }
  if (id !== undefined) rpcError(id, -32601, `method not found: ${method}`);
}

const input = readline.createInterface({ input: process.stdin, terminal: false });
input.on("line", (line) => {
  let message: Json;
  try {
    message = JSON.parse(line) as Json;
  } catch {
    return;
  }
  void handle(message).catch((error) => {
    if (message.id !== undefined) rpcError(message.id, -32603, error instanceof Error ? error.message : "internal error");
  });
});
input.on("close", () => process.exit(0));
