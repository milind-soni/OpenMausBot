import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, win32 as winPath } from "node:path";
import { z } from "zod";

import { createCapabilityProfileManifest } from "./access-profile.ts";
import { fullTaskScopedHardDeny } from "./auto-approve.ts";
import { BUILTIN_CAPABILITY_TOOLS, FLEET_BUILTIN_TOOLS } from "./builtin-capability-tools.ts";
import { augmentedPath } from "./env-path.ts";
import type { FleetCapabilityIndex } from "./fleet-capabilities.ts";
import type { HostMcpCatalog, HostMcpServer } from "./host-mcp.ts";
import { killCliTree, spawnCli } from "./procs.ts";
import { SPAWNED_PROXIES } from "./proxy-paths.ts";
import { windowsCmdCommand } from "./windows-cmd.ts";
import {
  createKnownValueRedactor,
  isSecretName,
  protectedEnvironmentValues,
  redactSecrets,
} from "./redact.ts";
import { suggestRoleOverlays } from "./role-overlays.ts";

type JsonObject = Record<string, any>;

const MCP_PROTOCOL = "2024-11-05";
const REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;
const MAX_TOOL_RESULT_BYTES = 256 * 1024;
const MAX_INTERACTIVE_RESULT_BYTES = 8 * 1024 * 1024;
const SAFE_ENV_NAMES = [
  "HOME",
  "USERPROFILE",
  "PATH",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "SHELL",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
] as const;

function minimalEnvironment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: augmentedPath(), ...extra };
  for (const name of SAFE_ENV_NAMES) if (typeof process.env[name] === "string") env[name] = process.env[name];
  return env;
}

function boundedPath(raw: unknown, cwd?: string): string {
  if (typeof raw !== "string" || !raw.trim() || raw.includes("\0")) throw new Error("a valid path is required");
  const expanded = raw.trim().replace(/^~(?=\/|$)/, homedir());
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd || process.cwd(), expanded);
}

function shellCommand(command: string, cwd: string, timeoutMs: number): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const shell = process.platform === "win32"
    ? process.env.ComSpec || process.env.COMSPEC || "cmd.exe"
    : process.platform === "darwin"
      ? "/bin/zsh"
      : "/bin/sh";
  const shellArgs = process.platform === "win32"
    ? ["/d", "/v:off", "/s", "/c", command]
    : ["-lc", command];
  return new Promise((resolveResult, reject) => {
    execFile(
      shell,
      shellArgs,
      {
        cwd,
        env: minimalEnvironment(),
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: MAX_TOOL_RESULT_BYTES,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException).code && !(error as { code?: unknown }).code?.toString().match(/^\d+$/)) {
          return reject(new Error("host shell could not execute the command"));
        }
        resolveResult({
          exitCode: typeof (error as { code?: unknown } | null)?.code === "number" ? (error as { code: number }).code : error ? 1 : 0,
          stdout: String(stdout).slice(0, MAX_TOOL_RESULT_BYTES),
          stderr: String(stderr).slice(0, MAX_TOOL_RESULT_BYTES),
        });
      },
    );
  });
}

function hasSecretArgument(args: string[]): boolean {
  return args.some((arg) => redactSecrets(arg) !== arg);
}

function parseHttpFrame(text: string, id: unknown): JsonObject | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{")) return JSON.parse(trimmed) as JsonObject;
  const frames = trimmed
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((line) => line && line !== "[DONE]")
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as JsonObject];
      } catch {
        return [];
      }
    });
  return frames.findLast((frame) => frame.id === id) ?? frames.at(-1) ?? null;
}

interface BackendClient {
  readonly alive: boolean;
  request(method: string, params?: JsonObject): Promise<any>;
  close(): void;
}

interface CredentialSelection {
  alias: string;
  envVar: string;
}

export interface CredentialBrokerOptions {
  command?: string;
  prefixArgs?: string[];
  platform?: NodeJS.Platform;
  executable?: string;
  proxyPath?: string;
}

export interface CredentialBackendSpawnSpec {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

const CredentialListPayload = z.object({
  result: z.object({
    credentials: z.array(z.object({
      name: z.string().optional(),
      aliases: z.array(z.string()).optional(),
    })).optional(),
  }).optional(),
});

export function credentialBackendSpawnSpec(
  selection: CredentialSelection,
  options: CredentialBrokerOptions = {},
): CredentialBackendSpawnSpec {
  const platform = options.platform ?? process.platform;
  const executable = options.executable ?? process.execPath;
  const proxyPath = options.proxyPath ?? SPAWNED_PROXIES.credentialRedactor;
  const prefix = options.prefixArgs ?? [];
  if (hasSecretArgument(prefix)) throw new Error("credential broker argv is not allowed to contain credential-shaped values");
  const isWindowsNode = platform === "win32"
    && /^(?:node|nodejs)(?:\.exe)?$/i.test(winPath.basename(executable));
  const launcher = platform === "win32"
    ? isWindowsNode
      ? [executable, proxyPath]
      : [
        process.env.ComSpec || process.env.COMSPEC || "cmd.exe",
        "/d",
        "/v:off",
        "/s",
        "/c",
        windowsCmdCommand([
          winPath.join(winPath.dirname(proxyPath), "credential-redacting-node-launcher.cmd"),
          executable,
          proxyPath,
        ]),
      ]
    : ["/usr/bin/env", "ELECTRON_RUN_AS_NODE=1", executable, proxyPath];
  return {
    command: options.command ?? "cv",
    args: [
      ...prefix,
      "--source",
      "main",
      "stdio-exec",
      "--env",
      `${selection.envVar}=${selection.alias}`,
      "--",
      ...launcher,
    ],
    env: minimalEnvironment(),
  };
}

class StdioBackend implements BackendClient {
  private readonly name: string;
  private readonly server: Extract<HostMcpServer, { type: "stdio" }>;
  private readonly credential?: CredentialSelection;
  private readonly credentialBroker: CredentialBrokerOptions;
  private child: ReturnType<typeof spawnCli> | null = null;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private started: Promise<void> | null = null;
  private closed = false;

  constructor(
    name: string,
    server: Extract<HostMcpServer, { type: "stdio" }>,
    credential: CredentialSelection | undefined,
    credentialBroker: CredentialBrokerOptions,
  ) {
    this.name = name;
    this.server = server;
    this.credential = credential;
    this.credentialBroker = credentialBroker;
  }

  get alive(): boolean {
    return !this.closed;
  }

  private start(): Promise<void> {
    if (this.started) return this.started;
    this.started = (async () => {
      if (hasSecretArgument(this.server.args)) {
        throw new Error(`${this.name}: credential-shaped argv is not allowed`);
      }
      const credentialSpec = this.credential
        ? credentialBackendSpawnSpec(this.credential, this.credentialBroker)
        : null;
      const command = credentialSpec?.command ?? this.server.command;
      const args = credentialSpec?.args ?? this.server.args;
      this.child = spawnCli(command, args, {
        cwd: this.server.cwd ?? homedir(),
        env: credentialSpec?.env ?? minimalEnvironment(this.server.env),
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.child.stdout.setEncoding("utf8");
      this.child.stdout.on("data", (chunk) => this.onData(String(chunk)));
      // A backend can exit between the liveness check and a write. Own the
      // stream error so EPIPE rejects pending work through the normal backend
      // failure path instead of becoming an uncaught process-level exception.
      this.child.stdin.on("error", () =>
        this.fail(new Error(`${this.name}: capability backend stdin failed`)),
      );
      // stderr can contain wrapper diagnostics with logical aliases. It can
      // also contain provider output, so it is deliberately neither logged
      // nor copied into errors returned to the agent.
      this.child.stderr.resume();
      this.child.on("error", () => this.fail(new Error(`${this.name}: capability backend could not start`)));
      this.child.on("close", () => this.fail(new Error(`${this.name}: capability backend closed`)));
      if (this.credential) {
        this.child.stdin.write(`${JSON.stringify({
          schema: "openmaus.credential-backend-bootstrap.v1",
          command: this.server.command,
          args: this.server.args,
          cwd: this.server.cwd ?? homedir(),
          env: this.server.env,
          protectedEnvironmentNames: [this.credential.envVar, ...Object.keys(this.server.env)],
        })}\n`);
      }
      await this.rawRequest("initialize", {
        protocolVersion: MCP_PROTOCOL,
        capabilities: {},
        clientInfo: { name: "openmausbot-capability-gateway", version: "1" },
      });
      this.notify("notifications/initialized", {});
    })();
    return this.started;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message: JsonObject;
      try {
        message = JSON.parse(line) as JsonObject;
      } catch {
        continue;
      }
      if (message.id === undefined) continue;
      const pending = this.pending.get(String(message.id));
      if (!pending) continue;
      this.pending.delete(String(message.id));
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`${this.name}: capability request failed`));
      else pending.resolve(message.result);
    }
  }

  private rawRequest(method: string, params: JsonObject = {}): Promise<any> {
    if (!this.child || this.closed) return Promise.reject(new Error(`${this.name}: capability backend unavailable`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new Error(`${this.name}: capability request timed out`));
      }, REQUEST_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(String(id), { resolve, reject, timer });
      this.child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  private notify(method: string, params: JsonObject): void {
    this.child?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async request(method: string, params: JsonObject = {}): Promise<any> {
    await this.start();
    return this.rawRequest(method, params);
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      // A broken stdin pipe does not imply the backend process exited. Reap
      // the exact owned tree here because every later close path observes the
      // closed flag and must remain idempotent.
      killCliTree(child);
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  close(): void {
    if (this.closed) return;
    this.fail(new Error(`${this.name}: capability backend stopped`));
  }
}

class HttpBackend implements BackendClient {
  private readonly name: string;
  private readonly server: Extract<HostMcpServer, { type: "http" }>;
  private sessionId = "";
  private started: Promise<void> | null = null;
  private closed = false;
  private nextId = 1;

  constructor(
    name: string,
    server: Extract<HostMcpServer, { type: "http" }>,
  ) {
    this.name = name;
    this.server = server;
  }

  get alive(): boolean {
    return !this.closed;
  }

  private async post(message: JsonObject, expectResponse: boolean): Promise<any> {
    if (this.closed) throw new Error(`${this.name}: capability backend unavailable`);
    const response = await fetch(this.server.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...this.server.headers,
        ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
      },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const nextSession = response.headers.get("mcp-session-id");
    if (nextSession) this.sessionId = nextSession;
    if (!response.ok) throw new Error(`${this.name}: capability service returned HTTP ${response.status}`);
    if (!expectResponse) return undefined;
    const frame = parseHttpFrame(await response.text(), message.id);
    if (!frame) throw new Error(`${this.name}: capability service returned no response`);
    if (frame.error) throw new Error(`${this.name}: capability request failed`);
    return frame.result;
  }

  private start(): Promise<void> {
    if (this.started) return this.started;
    this.started = (async () => {
      const id = this.nextId++;
      await this.post({
        jsonrpc: "2.0",
        id,
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL,
          capabilities: {},
          clientInfo: { name: "openmausbot-capability-gateway", version: "1" },
        },
      }, true);
      await this.post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, false);
    })();
    return this.started;
  }

  async request(method: string, params: JsonObject = {}): Promise<any> {
    await this.start();
    const id = this.nextId++;
    return this.post({ jsonrpc: "2.0", id, method, params }, true);
  }

  close(): void {
    this.closed = true;
  }
}

interface ActiveTurn {
  botId: string;
  threadId: string;
  cwd?: string;
  expiresAt: number;
  servers: Record<string, HostMcpServer>;
  interactiveInput: string;
}

interface BackendSlot {
  name: string;
  fingerprint: string;
  client: BackendClient;
  idle: NodeJS.Timeout | null;
  active: number;
}

export interface CapabilityGatewayOptions {
  idleTimeoutMs?: number;
  now?: () => number;
  listAliases?: () => Promise<string[]>;
  credentialBroker?: CredentialBrokerOptions;
  fleetIndex?: FleetCapabilityIndex;
}

function builtinTools(server: Extract<HostMcpServer, { type: "builtin" }>) {
  return server.family === "fleet" ? FLEET_BUILTIN_TOOLS : BUILTIN_CAPABILITY_TOOLS;
}

/** App-owned MCP union. The provider sees one small proxy; backend processes
 * stay here, start on first use, are shared across turns, and are reaped after
 * an idle window or app shutdown. */
export class CapabilityGateway {
  readonly catalog: HostMcpCatalog;
  private readonly activeTurns = new Map<string, ActiveTurn>();
  private readonly backends = new Map<string, BackendSlot>();
  private readonly selections = new Map<string, Map<string, CredentialSelection>>();
  private readonly idleTimeoutMs: number;
  private readonly now: () => number;
  private readonly protectedValues: Set<string>;
  private knownValueRedactor: (input: unknown) => unknown;
  private readonly credentialBroker: CredentialBrokerOptions;
  private readonly fleetIndex?: FleetCapabilityIndex;

  constructor(
    catalog: HostMcpCatalog,
    options: CapabilityGatewayOptions = {},
  ) {
    this.catalog = catalog;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    this.listAliasesImpl = options.listAliases ?? listCredentialAliases;
    this.credentialBroker = options.credentialBroker ?? {};
    this.fleetIndex = options.fleetIndex;
    this.protectedValues = protectedEnvironmentValues();
    this.knownValueRedactor = createKnownValueRedactor(this.protectedValues);
    this.protectServerValues(catalog.servers);
  }

  private readonly listAliasesImpl: () => Promise<string[]>;

  private validateTurnServers(servers: Record<string, HostMcpServer>): void {
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
      throw new Error("invalid capability server definitions");
    }
    for (const [name, server] of Object.entries(servers)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$/.test(name) || /cred(?:ential)?vault/i.test(name)) {
        throw new Error("invalid capability server name");
      }
      if (this.catalog.servers[name] && JSON.stringify(this.catalog.servers[name]) !== JSON.stringify(server)) {
        throw new Error("turn capability cannot replace a host capability");
      }
      const valid = Boolean(server && typeof server === "object" && (
        (server.type === "stdio" &&
          typeof server.command === "string" && server.command.length > 0 && !server.command.includes("\0") &&
          Array.isArray(server.args) && server.args.every((arg) => typeof arg === "string") &&
          server.env && typeof server.env === "object" && !Array.isArray(server.env) &&
          Object.entries(server.env).every(([key, value]) => /^[A-Z_][A-Z0-9_]*$/.test(key) && typeof value === "string") &&
          (server.cwd === undefined || typeof server.cwd === "string")) ||
        (server.type === "http" && (() => {
          try {
            const url = new URL(server.url);
            return /^https?:$/.test(url.protocol) &&
              server.headers && typeof server.headers === "object" && !Array.isArray(server.headers) &&
              Object.values(server.headers).every((value) => typeof value === "string");
          } catch {
            return false;
          }
        })())
      ));
      if (!valid) throw new Error("invalid capability server definition");
    }
  }

  beginTurn(token: string, turn: {
    botId: string;
    threadId: string;
    cwd?: string;
    ttlMs?: number;
    servers?: Record<string, HostMcpServer>;
  }): void {
    if (!token || token.length < 24) throw new Error("invalid capability turn token");
    const servers = turn.servers ?? {};
    this.validateTurnServers(servers);
    if (this.activeTurns.has(token)) this.endTurn(token);
    this.activeTurns.set(token, {
      botId: turn.botId,
      threadId: turn.threadId,
      cwd: turn.cwd,
      expiresAt: this.now() + (turn.ttlMs ?? 24 * 60 * 60_000),
      servers: { ...servers },
      interactiveInput: "",
    });
    this.protectServerValues(servers);
  }

  endTurn(token: string): void {
    const ended = this.activeTurns.get(token);
    const selections = this.selections.get(token);
    this.activeTurns.delete(token);
    this.selections.delete(token);
    if (!ended) return;
    for (const [name, server] of Object.entries(ended.servers)) {
      const key = this.backendFingerprint(server, selections?.get(name));
      const stillReferenced = [...this.activeTurns.values()].some((turn) =>
        JSON.stringify(turn.servers[name]) === JSON.stringify(server),
      );
      if (!stillReferenced) this.closeBackend(key);
    }
    for (const [name, selection] of selections ?? []) {
      const server = ended.servers[name] ?? this.catalog.servers[name];
      if (!server || server.type !== "stdio") continue;
      if (!this.selectionReferenced(name, server, selection)) {
        this.closeBackend(this.backendFingerprint(server, selection));
      }
    }
  }

  ownsTurn(token: string): boolean {
    const turn = this.activeTurns.get(token);
    if (!turn) return false;
    if (turn.expiresAt > this.now()) return true;
    this.endTurn(token);
    return false;
  }

  private requireTurn(token: string): void {
    if (!this.ownsTurn(token)) throw new Error("capability request rejected: turn is no longer active");
  }

  extendTurn(token: string, servers: Record<string, HostMcpServer>): void {
    this.requireTurn(token);
    this.validateTurnServers(servers);
    const turn = this.activeTurns.get(token)!;
    Object.assign(turn.servers, servers);
    this.protectServerValues(servers);
  }

  private serversFor(token: string): Record<string, HostMcpServer> {
    this.requireTurn(token);
    return { ...this.catalog.servers, ...this.activeTurns.get(token)!.servers };
  }

  private serverFor(token: string, name: string): HostMcpServer | undefined {
    return this.activeTurns.get(token)?.servers[name] ?? this.catalog.servers[name];
  }

  private manifestFor(token: string): HostMcpCatalog["manifest"] {
    const inventory = Object.entries(this.serversFor(token)).flatMap(([name, server]) =>
      server.type === "builtin" ? builtinTools(server).map((tool) => `${name}:${tool.name}`) : [name],
    );
    return createCapabilityProfileManifest({
      toolInventory: inventory,
      telemetryMode: this.catalog.manifest.telemetryMode,
    });
  }

  inventory(token: string): { manifest: HostMcpCatalog["manifest"]; servers: Array<{ name: string; type: string }> } {
    const servers = this.serversFor(token);
    return {
      manifest: this.manifestFor(token),
      servers: Object.entries(servers).map(([name, server]) => ({ name, type: server.type })),
    };
  }

  async aliases(token: string): Promise<string[]> {
    this.requireTurn(token);
    return [...new Set(await this.listAliasesImpl())].filter((name) => /^[A-Za-z0-9_.\/-]{1,200}$/.test(name)).sort();
  }

  async selectCredentialAlias(
    token: string,
    serverName: string,
    alias: string,
    envVar: string,
  ): Promise<void> {
    this.requireTurn(token);
    const server = this.serverFor(token, serverName);
    if (!server) throw new Error("unknown capability server");
    if (server.type !== "stdio") {
      throw new Error("credential alias injection requires a stdio capability server");
    }
    if (!/^[A-Z_][A-Z0-9_]{1,80}$/.test(envVar)) throw new Error("invalid credential environment name");
    const aliases = await this.aliases(token);
    if (!aliases.includes(alias)) throw new Error("unknown credential alias");
    const turnSelections = this.selections.get(token) ?? new Map<string, CredentialSelection>();
    const previous = turnSelections.get(serverName);
    const next = { alias, envVar };
    turnSelections.set(serverName, next);
    this.selections.set(token, turnSelections);
    if (previous && this.backendFingerprint(server, previous) !== this.backendFingerprint(server, next)) {
      if (!this.selectionReferenced(serverName, server, previous)) {
        this.closeBackend(this.backendFingerprint(server, previous));
      }
    }
  }

  private selectionFor(token: string, name: string): CredentialSelection | undefined {
    return this.selections.get(token)?.get(name);
  }

  private selectionReferenced(name: string, server: HostMcpServer, selection: CredentialSelection): boolean {
    const serverIdentity = JSON.stringify(server);
    const selectionIdentity = JSON.stringify(selection);
    return [...this.activeTurns.keys()].some((token) => {
      const candidateServer = this.serverFor(token, name);
      const candidateSelection = this.selectionFor(token, name);
      return JSON.stringify(candidateServer) === serverIdentity
        && JSON.stringify(candidateSelection) === selectionIdentity;
    });
  }

  private backendFingerprint(server: HostMcpServer, selection?: CredentialSelection): string {
    return createHash("sha256").update(JSON.stringify({ server, selection: selection ?? null })).digest("hex");
  }

  private backend(token: string, name: string): { key: string; client: BackendClient } {
    const server = this.serverFor(token, name);
    if (!server) throw new Error("unknown capability server");
    if (server.type === "builtin") throw new Error("built-in capabilities do not start a backend");
    const selection = this.selectionFor(token, name);
    const key = this.backendFingerprint(server, selection);
    const existing = this.backends.get(key);
    if (existing?.client.alive) {
      if (existing.idle) clearTimeout(existing.idle);
      existing.idle = null;
      existing.active += 1;
      return { key, client: existing.client };
    }
    if (existing) this.backends.delete(key);
    const client: BackendClient = server.type === "stdio"
      ? new StdioBackend(name, server, selection, this.credentialBroker)
      : new HttpBackend(name, server);
    this.backends.set(key, { name, fingerprint: key, client, idle: null, active: 1 });
    return { key, client };
  }

  private releaseBackend(key: string): void {
    const slot = this.backends.get(key);
    if (!slot) return;
    slot.active = Math.max(0, slot.active - 1);
    if (slot.active === 0 && !slot.idle) slot.idle = this.armIdle(key);
  }

  private armIdle(key: string): NodeJS.Timeout {
    const timer = setTimeout(() => this.closeBackend(key), this.idleTimeoutMs);
    timer.unref?.();
    return timer;
  }

  private sanitize(value: unknown, options: { preserveImages?: boolean } = {}): any {
    const withoutSecrets = this.knownValueRedactor(redactSecrets(value));
    const stripBinary = (input: any, depth = 0): any => {
      if (depth > 12 || input === null || typeof input !== "object") return input;
      if (Array.isArray(input)) return input.map((item) => stripBinary(item, depth + 1));
      if (!options.preserveImages && ["image", "audio"].includes(String(input.type)) && typeof input.data === "string") {
        return { type: "text", text: "[binary capability output omitted]" };
      }
      return Object.fromEntries(Object.entries(input).map(([key, item]) => {
        if (!options.preserveImages && typeof item === "string" && /^(?:data|blob|binary|screenshot|image)$/i.test(key) && item.length > 128) {
          return [key, "[binary capability output omitted]"];
        }
        return [key, stripBinary(item, depth + 1)];
      }));
    };
    const sanitized = stripBinary(withoutSecrets);
    const serialized = JSON.stringify(sanitized);
    const limit = options.preserveImages ? MAX_INTERACTIVE_RESULT_BYTES : MAX_TOOL_RESULT_BYTES;
    if (Buffer.byteLength(serialized) <= limit) return sanitized;
    // Never slice a base64 image into an invalid JSON-looking text result. A
    // pathological interactive payload falls back to the normal binary-free
    // representation; ordinary screenshots remain visible to the model while
    // telemetry and RAG continue to omit them independently.
    if (options.preserveImages) return this.sanitize(value);
    return {
      content: [{ type: "text", text: `${serialized.slice(0, MAX_TOOL_RESULT_BYTES / 2)}\n[oversized capability output truncated]` }],
      isError: false,
    };
  }

  async listTools(token: string, serverName: string): Promise<any> {
    this.requireTurn(token);
    const server = this.serverFor(token, serverName);
    if (server?.type === "builtin") return { tools: builtinTools(server) };
    const backend = this.backend(token, serverName);
    try {
      return this.sanitize(await backend.client.request("tools/list", {}));
    } finally {
      this.releaseBackend(backend.key);
    }
  }

  async callTool(token: string, serverName: string, tool: string, args: JsonObject): Promise<any> {
    this.requireTurn(token);
    const turn = this.activeTurns.get(token)!;
    const interactive = /(?:computer|browser|cua|desktop)/i.test(`${serverName}:${tool}`);
    const interactiveInput = interactive ? this.interactiveText(turn, tool, args) : null;
    const denial = fullTaskScopedHardDeny(
      `${serverName}:${tool}`,
      interactiveInput?.text || JSON.stringify(args),
      { cwd: turn.cwd },
    );
    if (denial) {
      return {
        content: [{ type: "text", text: `OpenMausBot denied this capability request: ${denial}.` }],
        isError: true,
      };
    }
    if (interactiveInput?.append) turn.interactiveInput = interactiveInput.text;
    if (interactiveInput?.commit) turn.interactiveInput = "";
    const safeArgs = this.sanitize(args) as JsonObject;
    if (this.serverFor(token, serverName)?.type === "builtin") {
      return this.callBuiltin(token, serverName, tool, safeArgs);
    }
    const backend = this.backend(token, serverName);
    try {
      const result = await backend.client.request("tools/call", { name: tool, arguments: safeArgs });
      if (interactive && this.credentialStoreResult(result)) {
        return {
          content: [{ type: "text", text: "OpenMausBot denied this capability result: credential-value-disclosure." }],
          isError: true,
        };
      }
      return this.sanitize(result, { preserveImages: interactive });
    } finally {
      this.releaseBackend(backend.key);
    }
  }

  private async callBuiltin(token: string, serverName: string, tool: string, args: JsonObject): Promise<any> {
    this.requireTurn(token);
    const turn = this.activeTurns.get(token);
    const server = this.serverFor(token, serverName);
    if (server?.type !== "builtin") throw new Error("unknown built-in capability server");
    if (server.family === "fleet") {
      if (tool === "suggest_role_overlays") {
        return this.sanitize(suggestRoleOverlays(String(args.task ?? ""), Number(args.limit) || 3));
      }
      if (!this.fleetIndex) throw new Error("fleet capability index is unavailable");
      if (tool === "search_capabilities") {
        return this.sanitize(this.fleetIndex.search({
          query: String(args.query ?? ""),
          kind: String(args.kind ?? ""),
          surface: String(args.surface ?? ""),
          limit: Number(args.limit) || 10,
        }));
      }
      if (tool === "suggest_capabilities") {
        return this.sanitize(this.fleetIndex.suggest(String(args.task ?? ""), Number(args.limit) || 10));
      }
      if (tool === "select_capability") {
        return this.sanitize(this.fleetIndex.select(
          String(args.id ?? ""),
          Object.keys(this.serversFor(token)),
        ));
      }
      throw new Error("unknown fleet capability tool");
    }
    const cwd = boundedPath(args.cwd ?? turn?.cwd ?? process.cwd(), turn?.cwd);
    if (tool === "shell_execute") {
      if (typeof args.command !== "string" || !args.command.trim()) throw new Error("command is required");
      const timeoutMs = Math.min(Math.max(Number(args.timeoutMs) || 60_000, 100), 300_000);
      return this.sanitize(await shellCommand(args.command, cwd, timeoutMs));
    }
    const path = boundedPath(args.path, turn?.cwd);
    if (tool === "filesystem_read") {
      const maxBytes = Math.min(Math.max(Number(args.maxBytes) || MAX_TOOL_RESULT_BYTES, 1), MAX_TOOL_RESULT_BYTES);
      const body = await readFile(path);
      if (body.includes(0)) return { content: "[binary capability output omitted]", bytes: body.byteLength };
      return this.sanitize({ path, content: body.subarray(0, maxBytes).toString("utf8"), truncated: body.byteLength > maxBytes });
    }
    if (tool === "filesystem_write") {
      if (typeof args.content !== "string") throw new Error("content must be a string");
      await mkdir(dirname(path), { recursive: true });
      if (args.append === true) await appendFile(path, args.content, { encoding: "utf8", mode: 0o600 });
      else await writeFile(path, args.content, { encoding: "utf8", mode: 0o600 });
      return { path, bytes: Buffer.byteLength(args.content), appended: args.append === true };
    }
    if (tool === "filesystem_delete") {
      await rm(path, { recursive: args.recursive === true, force: false });
      return { path, deleted: true };
    }
    if (tool === "filesystem_stat") {
      const info = await stat(path);
      return { path, type: info.isDirectory() ? "directory" : info.isFile() ? "file" : "other", size: info.size, modifiedAt: info.mtime.toISOString() };
    }
    throw new Error("unknown built-in capability tool");
  }

  private interactiveText(
    turn: ActiveTurn,
    tool: string,
    args: JsonObject,
  ): { text: string; append: boolean; commit: boolean } {
    const strings: string[] = [];
    const visit = (value: unknown, key = "", depth = 0): void => {
      if (depth > 6 || value === null || value === undefined) return;
      if (typeof value === "string") {
        if (!key || /(?:text|value|command|script|url|uri|path|key|keys|app|application|query|name)/i.test(key)) {
          strings.push(value);
        }
        return;
      }
      if (Array.isArray(value)) {
        for (const item of value) visit(item, key, depth + 1);
      } else if (typeof value === "object") {
        for (const [childKey, item] of Object.entries(value as Record<string, unknown>)) visit(item, childKey, depth + 1);
      }
    };
    visit(args);
    const combined = `${turn.interactiveInput}${strings.join("")}`.slice(-100_000);
    const commitsKey = /press/i.test(tool) && strings.some((value) => /^(?:enter|return)$/i.test(value.trim()));
    return {
      text: combined,
      append: /(?:type|write|fill|paste|input|key)/i.test(tool) && !commitsKey,
      commit: commitsKey || /(?:submit|enter|click|tap|open|navigate|launch|exec|run)/i.test(tool),
    };
  }

  private credentialStoreResult(value: unknown): boolean {
    const text = JSON.stringify(value).slice(0, MAX_TOOL_RESULT_BYTES);
    return /(?:Keychain Access|(?:System Settings|chrome:\/\/settings)[^\n]{0,80}(?:Passwords?|Cookies?)|chrome:\/\/password-manager|1Password|Bitwarden|LastPass|Dashlane|CredVault|credential store)/i.test(text);
  }

  stats(): { activeTurns: number; activeBackends: string[] } {
    return {
      activeTurns: this.activeTurns.size,
      activeBackends: [...this.backends.values()].map((slot) => slot.name).sort(),
    };
  }

  private closeBackend(key: string): void {
    const slot = this.backends.get(key);
    if (!slot) return;
    if (slot.idle) clearTimeout(slot.idle);
    slot.client.close();
    this.backends.delete(key);
  }

  shutdown(): void {
    this.activeTurns.clear();
    this.selections.clear();
    for (const key of this.backends.keys()) this.closeBackend(key);
  }

  private protectServerValues(servers: Record<string, HostMcpServer>): void {
    const previousSize = this.protectedValues.size;
    for (const server of Object.values(servers)) {
      if (server.type === "stdio") {
        for (const [name, value] of Object.entries(server.env)) {
          if (isSecretName(name)) this.protectedValues.add(value);
        }
      } else if (server.type === "http") {
        for (const [name, value] of Object.entries(server.headers)) {
          if (!isSecretName(name)) continue;
          const protectedValue = value.replace(/^Bearer\s+/i, "").trim();
          if (protectedValue) this.protectedValues.add(protectedValue);
        }
      }
    }
    if (this.protectedValues.size !== previousSize) {
      this.knownValueRedactor = createKnownValueRedactor(this.protectedValues);
    }
  }
}

export function listCredentialAliases(): Promise<string[]> {
  const candidates: Array<[string, string[]]> = [
    ["cv", ["--source", "main", "--json", "list", "--limit", "5000"]],
    [join(homedir(), ".local", "bin", "cv"), ["--source", "main", "--json", "list", "--limit", "5000"]],
  ];
  return new Promise((resolve) => {
    const attempt = (index: number) => {
      const candidate = candidates[index];
      if (!candidate) return resolve([]);
      execFile(
        candidate[0],
        candidate[1],
        { timeout: 10_000, encoding: "utf8", env: minimalEnvironment(), windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
        (error, stdout) => {
          if (error) return attempt(index + 1);
          let aliases: string[] = [];
          try {
            const payload = CredentialListPayload.parse(JSON.parse(stdout));
            aliases = (payload.result?.credentials ?? []).flatMap((credential) => [
              ...(credential.name ? [credential.name] : []),
              ...(credential.aliases ?? []),
            ]);
          } catch {
            return attempt(index + 1);
          }
          return aliases.length ? resolve(aliases) : attempt(index + 1);
        },
      );
    };
    attempt(0);
  });
}
