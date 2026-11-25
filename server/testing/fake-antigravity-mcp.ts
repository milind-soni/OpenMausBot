// The MCP side of the offline native Antigravity CLI stand-in, as measured against 1.5.14 and 1.5.16 over ACP:
//   - every session/new and session/resume server is started over stdio, its whole tools/list is read, and each tool is
//     written to <state>/mcp/<server>/<tool>.json as {name, description, parameters};
//   - the model sees every tool eagerly, and when the session's tool JSON passes the shared budget (between 58,700 and
//     60,600 bytes of those files, google-antigravity/antigravity-cli#1530) the largest are dropped, largest first, with no
//     lazy fallback and no call_mcp_tool;
//   - a tool's name to the model and in permission requests is mcp_<server>_<tool>; a server registered again in the same
//     process under the same name with another command, arguments or environment is renamed <server>_<8 hex>.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface AcpStdioServer {
  name: string;
  command: string;
  args?: string[];
  env?: Array<{ name: string; value: string }>;
}

export const DEFAULT_TOOL_BUDGET = 60_000;

/** A tool's size as the CLI measures it: its definition file. */
export function toolBytes(tool: McpTool): number {
  return Buffer.byteLength(JSON.stringify({ name: tool.name, description: tool.description ?? "", parameters: tool.inputSchema ?? { type: "object" } }));
}

/** `server/tool` keys of the tools the budget drops, largest first. */
export function droppedTools(servers: ReadonlyArray<{ name: string; tools: readonly McpTool[] }>, budget = DEFAULT_TOOL_BUDGET): Set<string> {
  const sized = servers.flatMap((server) => server.tools.map((tool) => ({ key: `${server.name}/${tool.name}`, bytes: toolBytes(tool) })))
    .sort((a, b) => b.bytes - a.bytes);
  let total = sized.reduce((sum, tool) => sum + tool.bytes, 0);
  const dropped = new Set<string>();
  for (const tool of sized) {
    if (total <= budget) break;
    total -= tool.bytes;
    dropped.add(tool.key);
  }
  return dropped;
}

/** The name a server gets in this process: its own the first time, then <name>_<8 hex> when it comes back changed. */
export class ServerNames {
  private readonly registered = new Map<string, string>();

  nameFor(server: AcpStdioServer): string {
    const key = JSON.stringify([server.command, server.args ?? [], server.env ?? []]);
    const first = this.registered.get(server.name);
    if (first === undefined) {
      this.registered.set(server.name, key);
      return server.name;
    }
    return first === key ? server.name : `${server.name}_${createHash("sha256").update(key).digest("hex").slice(0, 8)}`;
  }
}

type Json = Record<string, unknown>;

export class McpConnection {
  readonly tools: McpTool[] = [];
  readonly name: string;
  readonly server: AcpStdioServer;
  private readonly child: ChildProcess;
  private nextId = 1;
  private readonly waiting = new Map<number, (message: Json) => void>();

  private constructor(name: string, server: AcpStdioServer, cwd: string) {
    this.name = name;
    this.server = server;
    const env = { ...process.env, ...Object.fromEntries((server.env ?? []).map(({ name, value }) => [name, value])) };
    this.child = spawn(server.command, server.args ?? [], { cwd, env, stdio: ["pipe", "pipe", "ignore"] });
    this.child.on("error", () => this.failAll());
    this.child.on("exit", () => this.failAll());
    createInterface({ input: this.child.stdout! }).on("line", (line) => {
      let message: Json;
      try { message = JSON.parse(line) as Json; } catch { return; }
      const wait = typeof message.id === "number" ? this.waiting.get(message.id) : undefined;
      if (wait) {
        this.waiting.delete(message.id as number);
        wait(message);
      }
    });
  }

  static async open(name: string, server: AcpStdioServer, cwd: string, clientVersion: string): Promise<McpConnection> {
    const connection = new McpConnection(name, server, cwd);
    await connection.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "antigravity", version: clientVersion } });
    connection.child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    let cursor: unknown;
    do {
      const listed = await connection.request("tools/list", cursor === undefined ? {} : { cursor });
      const result = (listed.result ?? {}) as { tools?: McpTool[]; nextCursor?: unknown };
      connection.tools.push(...(result.tools ?? []));
      cursor = result.nextCursor;
    } while (typeof cursor === "string" && cursor);
    return connection;
  }

  request(method: string, params: unknown, timeoutMs = 60_000): Promise<Json> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        resolve({ error: { code: -32001, message: `${method} timed out` } });
      }, timeoutMs);
      this.waiting.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      if (!this.child.stdin?.writable) return this.waiting.get(id)?.({ error: { code: -32000, message: "the server has exited" } });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  close(): void {
    this.child.stdin?.end();
    this.child.kill();
  }

  private failAll(): void {
    for (const [id, wait] of this.waiting) {
      this.waiting.delete(id);
      wait({ error: { code: -32000, message: "the server has exited" } });
    }
  }
}

/** One session's mounted servers and what its model can see. */
export class SessionTools {
  readonly connections: McpConnection[];
  readonly dropped: Set<string>;

  private constructor(connections: McpConnection[], dropped: Set<string>) {
    this.connections = connections;
    this.dropped = dropped;
  }

  static async mount(servers: readonly AcpStdioServer[], options: { names: ServerNames; cwd: string; stateDir: string; budget: number; version: string }): Promise<SessionTools> {
    const connections: McpConnection[] = [];
    for (const server of servers) {
      if (!server || typeof server.command !== "string") continue;
      connections.push(await McpConnection.open(options.names.nameFor(server), server, options.cwd, options.version));
    }
    for (const connection of connections) {
      const folder = join(options.stateDir, "mcp", connection.name);
      rmSync(folder, { recursive: true, force: true });
      mkdirSync(folder, { recursive: true });
      for (const tool of connection.tools) {
        writeFileSync(join(folder, `${tool.name}.json`), JSON.stringify({ name: tool.name, description: tool.description ?? "", parameters: tool.inputSchema ?? { type: "object" } }));
      }
    }
    return new SessionTools(connections, droppedTools(connections.map(({ name, tools }) => ({ name, tools })), options.budget));
  }

  /** The names the model sees, as mcp_<server>_<tool>. */
  visible(): string[] {
    return this.connections.flatMap((connection) => connection.tools.filter((tool) => !this.dropped.has(`${connection.name}/${tool.name}`))
      .map((tool) => `mcp_${connection.name}_${tool.name}`));
  }

  hidden(): string[] {
    return [...this.dropped].map((key) => `mcp_${key.replace("/", "_")}`);
  }

  /** A server's tool by the server's configured name, when the model can see it. */
  find(serverName: string, toolName: string): { connection: McpConnection; tool: McpTool; nativeName: string } | undefined {
    const connection = this.connections.find((candidate) => candidate.server.name === serverName);
    const tool = connection?.tools.find((candidate) => candidate.name === toolName);
    if (!connection || !tool || this.dropped.has(`${connection.name}/${tool.name}`)) return undefined;
    return { connection, tool, nativeName: `mcp_${connection.name}_${tool.name}` };
  }

  close(): void {
    for (const connection of this.connections) connection.close();
  }
}
