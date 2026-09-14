// A minimal MCP (Model Context Protocol) stdio client for API-driven engines.
//
// CLI engines (Claude, Codex, ACP) mount `turn.integrations.*` MCP servers
// themselves. API engines (vision, grok, minimax) have no such machinery:
// until now they could never receive computer, browser, or phone tools, so
// every computer destination was refused for them ("this model engine cannot
// use the Local VM"). This client gives the harness what it needs to bridge
// that gap: spawn one server per integration, complete the JSON-RPC 2.0
// handshake, list tools, and execute calls — nothing more.
//
// The lifecycle is deliberately synchronous-with-the-turn: each turn spawns
// its own server, uses it, and shuts it down in a `finally`. No connection
// pool, no idle reaping, no cross-turn state to leak between threads or
// approve flows.

import { spawn, type ChildProcess } from "node:child_process";

/** One result the harness hands back to the model as the tool's answer. */
export interface McpToolResult {
  isError: boolean;
  /** Concatenated text blocks from the result payload. */
  text: string;
  /** Screenshot images (MCP image content blocks), base64 PNG/JPEG. */
  images: Array<{ data: string; mimeType: string }>;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const INITIALIZE_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 120_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Readability cap for a tool result riding back to the model as text. */
const MAX_RESULT_CHARS = 60_000;

function textFromResult(result: unknown): McpToolResult {
  const out: McpToolResult = { isError: false, text: "", images: [] };
  if (!isRecord(result)) return out;
  out.isError = result.isError === true;
  const content = Array.isArray(result.content) ? result.content : [];
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
      out.images.push({ data: block.data, mimeType: block.mimeType });
    } else if (block.type === "resource" && isRecord(block.resource)) {
      const resource = block.resource;
      if (typeof resource.text === "string") parts.push(resource.text);
    }
  }
  out.text = parts.join("\n").slice(0, MAX_RESULT_CHARS);
  return out;
}

export class McpStdioClient {
  private child!: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, PendingCall>();
  private stdoutBuffer = "";
  private tools: Array<{ name: string; description?: string; inputSchema?: unknown }> = [];
  private shuttingDown = false;

  /** Tools advertised by the server after initialize, for logging/gating. */
  get toolNames(): string[] {
    return this.tools.map((tool) => tool.name);
  }

  private constructor() {}

  /** Spawn, handshake, and (optionally) refresh the tool list. */
  static async start(spec: { command: string; args: string[]; env?: Record<string, string> }): Promise<McpStdioClient> {
    const client = new McpStdioClient();
    client.child = spawn(spec.command, spec.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...spec.env },
      windowsHide: true,
    });
    client.child.stdout?.setEncoding("utf8");
    client.child.stdout?.on("data", (chunk: string) => client.ingest(chunk));
    client.child.stderr?.setEncoding("utf8");
    client.child.stderr?.on("data", () => {
      // Logs only; a chatty server must never kill its bridge.
    });
    client.child.on("exit", (code) => {
      const error = new Error(`MCP server exited early (code ${code ?? "signal"})`);
      for (const pending of client.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      client.pending.clear();
    });
    await client.rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "openmausbot-harness", version: "1.0.0" },
    }, INITIALIZE_TIMEOUT_MS).then(() => client.rpc("notifications/initialized", {}, 5_000, true));
    return client;
  }

  /** Call tools/list once so the harness can prove the mount before promising it to the model. */
  async listTools(): Promise<Array<{ name: string; description?: string }>> {
    const result = await this.rpc("tools/list", {});
    const tools = isRecord(result) && Array.isArray(result.tools) ? result.tools : [];
    this.tools = tools
      .filter(isRecord)
      .map((tool) => ({
        name: typeof tool.name === "string" ? tool.name : "",
        description: typeof tool.description === "string" ? tool.description : undefined,
      }))
      .filter((tool) => tool.name);
    return this.tools;
  }

  /** Execute one tool call and normalize the result for the model. */
  async callTool(name: string, args: Record<string, unknown> | undefined, timeoutMs = CALL_TIMEOUT_MS): Promise<McpToolResult> {
    const raw = await this.rpc("tools/call", { name, arguments: args ?? {} }, timeoutMs);
    return textFromResult(raw);
  }

  /** Graceful shutdown: try notifications, then SIGTERM, then SIGKILL. */
  async close(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    try {
      this.child.stdin?.end();
    } catch {
      // stdin may already be gone; SIGTERM below is the real closer.
    }
    const exited = new Promise<void>((resolve) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) return resolve();
      this.child.once("exit", () => resolve());
    });
    const killer = setTimeout(() => {
      try {
        this.child.kill("SIGTERM");
      } catch {
        // Already dead.
      }
      setTimeout(() => {
        try {
          this.child.kill("SIGKILL");
        } catch {
          // Already dead.
        }
      }, 2_000);
    }, 2_000);
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 6_000))]);
    clearTimeout(killer);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("MCP server closed during shutdown"));
    }
    this.pending.clear();
  }

  private ingest(chunk: string) {
    this.stdoutBuffer += chunk;
    let newline: number;
    while ((newline = this.stdoutBuffer.indexOf("\n")) !== -1) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let message: Record<string, unknown> | null = null;
      stdioParse: try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        break stdioParse;
      }
      if (!message) continue;
      const id = message.id;
      if ((typeof id === "number" || typeof id === "string") && (message.result !== undefined || message.error !== undefined)) {
        const key = typeof id === "string" ? Number(id) : id;
        const pending = typeof key === "number" ? this.pending.get(key) : undefined;
        if (pending) {
          this.pending.delete(key as number);
          clearTimeout(pending.timer);
          if (message.error !== undefined) {
            const err = isRecord(message.error) ? message.error : {};
            pending.reject(new Error(typeof err.message === "string" ? err.message : "MCP tool call failed"));
          } else {
            pending.resolve(message.result);
          }
          continue;
        }
      }
      // Notifications and requests FROM the server are ignored: the mounted
      // integrations here (computer/browser proxies) are tool servers, not
      // elicitation or sampling peers.
    }
  }

  private rpc(method: string, params: unknown, timeoutMs = CALL_TIMEOUT_MS, notification = false): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (this.shuttingDown) return reject(new Error("MCP client is shutting down"));
      if (!this.child.stdin?.writable) return reject(new Error("MCP server stdin is closed"));
      const id = notification ? null : this.nextId++;
      const frame = JSON.stringify({ jsonrpc: "2.0", method, params, ...(id !== null ? { id } : {}) });
      if (id === null) {
        // A notification has no id, so no response can match it — fire and forget.
        try {
          this.child.stdin.write(`${frame}\n`);
          resolve(undefined);
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child.stdin.write(`${frame}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
}
