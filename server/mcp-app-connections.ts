// OMB's own connections to MCP app servers: they read an app's UI resource and run its view's calls long
// after the turn that called the tool has ended. A command server is spawned with the probe environment.
import { createHash } from "node:crypto";

import { APP_EXTENSION_KEY } from "../shared/app.ts";
import type { McpServerSpec, RemoteMcpSpec, StdioMcpSpec } from "./contracts.ts";
import { createLineSplitter } from "./mcp-bridge.ts";
import { UI_EXTENSION, withUiExtension } from "./mcp-app-observer.ts";
import { MAX_REMOTE_MCP_BYTES, McpHttpError, McpRpcError, REMOTE_MCP_STARTUP_MS, RemoteMcpClient } from "./mcp-http.ts";
import { probeEnvironment } from "./mcp-probe.ts";
import { killCliTree, spawnCli } from "./procs.ts";

export const APP_CONNECTION_IDLE_MS = 5 * 60_000;
export const APP_CONNECTIONS_MAX = 6;
export const APP_TOOLS_CACHE_MS = 60_000;
const TOOL_PAGES = 100;

type Json = Record<string, unknown>;
function isRecord(value: unknown): value is Json {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export interface AppClient {
  request(method: string, params: unknown, signal: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
  readonly extensions: "ok" | "refused" | undefined;
  readonly serverInfo: Json | undefined;
  readonly closed: boolean;
}

export interface AppClientHooks {
  onNotification(method: string): void;
}

class StdioAppClient implements AppClient {
  private readonly child: ReturnType<typeof spawnCli>;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private nextId = 1;
  private stdoutBytes = 0;
  closed = false;
  extensions: "ok" | "refused" | undefined;
  serverInfo: Json | undefined;

  constructor(server: StdioMcpSpec, hooks: AppClientHooks) {
    this.child = spawnCli(server.command, server.args, { cwd: process.cwd(), env: probeEnvironment(server), stdio: ["pipe", "pipe", "pipe"] });
    const splitter = createLineSplitter((line) => this.onLine(line, hooks));
    this.child.stdout.on("data", (chunk: Buffer) => {
      // A connection lives for minutes; the bound is per message, not total.
      this.stdoutBytes += chunk.byteLength;
      if (this.stdoutBytes > MAX_REMOTE_MCP_BYTES) { this.fail(new McpHttpError("protocol", "message too large")); return; }
      splitter.push(chunk);
    });
    // Child stderr may carry secrets: drained, never kept.
    this.child.stderr.resume();
    this.child.once("error", () => this.fail(new McpHttpError("network", "could not start the server")));
    this.child.once("close", () => this.fail(new McpHttpError("network", "the server stopped")));
  }

  private onLine(line: string, hooks: AppClientHooks): void {
    this.stdoutBytes = 0;
    if (!line.trim()) return;
    let message: unknown;
    try { message = JSON.parse(line); } catch { return; }
    if (!isRecord(message)) return;
    if (typeof message.method === "string") {
      if (message.id === undefined) hooks.onNotification(message.method);
      else this.write({ jsonrpc: "2.0", id: message.id, ...(message.method === "ping" ? { result: {} } : { error: { code: -32601, message: "Method not supported by this client" } }) });
      return;
    }
    const entry = typeof message.id === "number" ? this.pending.get(message.id) : undefined;
    if (!entry) return;
    this.pending.delete(message.id as number);
    if (message.error !== undefined) {
      const detail = isRecord(message.error) && typeof message.error.message === "string" ? message.error.message : "request failed";
      const code = isRecord(message.error) && Number.isSafeInteger(message.error.code) ? message.error.code as number : undefined;
      entry.reject(new McpRpcError(code, detail));
    } else entry.resolve(message.result);
  }

  private write(frame: unknown): void {
    if (this.closed) throw new McpHttpError("network", "the server stopped");
    this.child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
    void killCliTree(this.child);
  }

  request(method: string, params: unknown, signal: AbortSignal): Promise<unknown> {
    if (this.closed) return Promise.reject(new McpHttpError("network", "the server stopped"));
    if (signal.aborted) return Promise.reject(new McpHttpError("network", "aborted"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.pending.delete(id);
        try { this.write({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "Request cancelled" } }); } catch { /* gone */ }
        reject(new McpHttpError("network", "aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        resolve: (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
        reject: (error) => { signal.removeEventListener("abort", onAbort); reject(error); },
      });
      try { this.write({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }); }
      catch (error) { this.pending.delete(id); signal.removeEventListener("abort", onAbort); reject(error as Error); }
    });
  }

  async initialize(signal: AbortSignal, extension: boolean): Promise<void> {
    const params = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "OpenMausBot", version: "1" } };
    let result: unknown;
    if (extension) {
      try {
        result = await this.request("initialize", withUiExtension(params), signal);
        this.extensions = "ok";
      } catch (error) {
        if (!(error instanceof McpRpcError)) throw error;
        this.extensions = "refused";
        result = await this.request("initialize", params, signal);
      }
    } else {
      result = await this.request("initialize", params, signal);
    }
    this.serverInfo = isRecord(result) && isRecord(result.serverInfo) ? result.serverInfo : undefined;
    this.write({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  async close(): Promise<void> {
    this.fail(new McpHttpError("network", "client closed"));
  }
}

class RemoteAppClient implements AppClient {
  private readonly client: RemoteMcpClient;
  serverInfo: Json | undefined;
  closed = false;

  constructor(server: RemoteMcpSpec, hooks: AppClientHooks) {
    this.client = new RemoteMcpClient(server, {
      maxBytes: MAX_REMOTE_MCP_BYTES,
      onNotification: (message) => { if (typeof message.method === "string") hooks.onNotification(message.method); },
    });
  }

  get extensions(): "ok" | "refused" | undefined { return this.client.extensions; }

  async initialize(signal: AbortSignal, extension: boolean): Promise<void> {
    const result = await this.client.initialize("OpenMausBot", signal, extension ? { extensions: { [APP_EXTENSION_KEY]: UI_EXTENSION } } : {});
    this.serverInfo = isRecord(result) && isRecord(result.serverInfo) ? result.serverInfo : undefined;
  }

  request(method: string, params: unknown, signal: AbortSignal): Promise<unknown> {
    return this.client.request(method, params, signal);
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.client.close();
  }
}

export async function openAppClient(server: McpServerSpec, hooks: AppClientHooks, extension: boolean, signal: AbortSignal): Promise<AppClient> {
  const client = "url" in server ? new RemoteAppClient(server, hooks) : new StdioAppClient(server, hooks);
  try {
    await client.initialize(signal, extension);
    return client;
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
}

interface Slot {
  name: string;
  server: McpServerSpec;
  client: Promise<AppClient>;
  opened?: AppClient;
  used: number;
  idle?: ReturnType<typeof setTimeout>;
  tools?: { at: number; list: Promise<Json[]> };
}

export interface AppConnectionsOptions {
  idleMs?: number;
  max?: number;
  now?: () => number;
  open?: typeof openAppClient;
  onTools?(name: string, server: McpServerSpec, tools: Json[], extensions: "ok" | "refused" | undefined): void;
}

function connectionLost(error: unknown): boolean {
  return !(error instanceof McpRpcError);
}

export class AppConnections {
  private readonly slots = new Map<string, Slot>();
  private readonly idleMs: number;
  private readonly max: number;
  private readonly now: () => number;
  private readonly open: typeof openAppClient;
  private readonly onTools: AppConnectionsOptions["onTools"];

  constructor(options: AppConnectionsOptions = {}) {
    this.idleMs = options.idleMs ?? APP_CONNECTION_IDLE_MS;
    this.max = options.max ?? APP_CONNECTIONS_MAX;
    this.now = options.now ?? Date.now;
    this.open = options.open ?? openAppClient;
    this.onTools = options.onTools;
  }

  get size(): number { return this.slots.size; }

  private key(name: string, server: McpServerSpec): string {
    return `${name}\u0000${createHash("sha256").update(JSON.stringify(server)).digest("hex")}`;
  }

  private slot(name: string, server: McpServerSpec, extension: boolean): Slot {
    const key = this.key(name, server);
    let slot = this.slots.get(key);
    if (!slot) {
      while (this.slots.size >= this.max) {
        const oldest = [...this.slots.entries()].sort((a, b) => a[1].used - b[1].used)[0];
        if (!oldest) break;
        this.drop(oldest[0]);
      }
      const opening = this.open(server, {
        onNotification: (method) => {
          if (method === "notifications/tools/list_changed") {
            const current = this.slots.get(key);
            if (current) delete current.tools;
          }
        },
      }, extension, AbortSignal.timeout(REMOTE_MCP_STARTUP_MS));
      const created: Slot = { name, server, client: opening, used: this.now() };
      slot = created;
      this.slots.set(key, created);
      void opening.then((client) => { created.opened = client; }, () => { if (this.slots.get(key) === created) this.slots.delete(key); });
    }
    slot.used = this.now();
    if (slot.idle) clearTimeout(slot.idle);
    slot.idle = setTimeout(() => this.drop(key), this.idleMs);
    slot.idle.unref?.();
    return slot;
  }

  private drop(key: string): void {
    const slot = this.slots.get(key);
    if (!slot) return;
    this.slots.delete(key);
    if (slot.idle) clearTimeout(slot.idle);
    // A command server's group is sent SIGTERM before this returns; a client still opening closes once it opens.
    if (slot.opened) void slot.opened.close().catch(() => {});
    else void slot.client.then((client) => client.close()).catch(() => {});
  }

  /** A connection that failed (not a JSON-RPC error answer) is closed, so the next request opens a new one. */
  async request(name: string, server: McpServerSpec, method: string, params: unknown, signal: AbortSignal, extension = true): Promise<unknown> {
    const key = this.key(name, server);
    const slot = this.slot(name, server, extension);
    try {
      const client = await slot.client;
      if (client.closed) throw new McpHttpError("network", "the server stopped");
      return await client.request(method, params, signal);
    } catch (error) {
      if (connectionLost(error) && this.slots.get(key) === slot) this.drop(key);
      throw error;
    }
  }

  tools(name: string, server: McpServerSpec, signal: AbortSignal, extension = true): Promise<Json[]> {
    const slot = this.slot(name, server, extension);
    if (slot.tools && this.now() - slot.tools.at < APP_TOOLS_CACHE_MS) return slot.tools.list;
    const list = (async () => {
      const tools: Json[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      for (let page = 0; page < TOOL_PAGES; page += 1) {
        const result = await this.request(name, server, "tools/list", cursor === undefined ? {} : { cursor }, signal, extension);
        if (!isRecord(result) || !Array.isArray(result.tools)) throw new McpHttpError("protocol", "invalid tool list");
        for (const tool of result.tools) if (isRecord(tool) && typeof tool.name === "string" && tool.name) tools.push(tool);
        const next = result.nextCursor;
        if (typeof next !== "string" || !next || cursors.has(next)) break;
        cursors.add(next);
        cursor = next;
      }
      const client = await slot.client;
      this.onTools?.(name, server, tools, client.extensions);
      return tools;
    })();
    slot.tools = { at: this.now(), list };
    void list.catch(() => { if (slot.tools?.list === list) delete slot.tools; });
    return list;
  }

  async serverInfo(name: string, server: McpServerSpec): Promise<Json | undefined> {
    const slot = this.slots.get(this.key(name, server));
    return slot ? (await slot.client.catch(() => undefined))?.serverInfo : undefined;
  }

  closeServer(name: string): void {
    for (const [key, slot] of this.slots) if (slot.name === name) this.drop(key);
  }

  closeAll(): void {
    for (const key of this.slots.keys()) this.drop(key);
  }
}
