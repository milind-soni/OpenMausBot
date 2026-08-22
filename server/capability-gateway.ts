import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstatSync, realpathSync, type Stats } from "node:fs";
import { appendFile, lstat, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, win32 as winPath } from "node:path";
import { z } from "zod";

import {
  createAgentGraphProfileManifest,
  createCapabilityProfileManifest,
  createObserverRouterProfileManifest,
} from "./access-profile.ts";
import {
  AGENT_GRAPH_MAX_FILE_BYTES,
  readStableAgentGraphFile,
} from "./agent-graph-evidence.ts";
import { writeAnchoredFile } from "./anchored-file.ts";
import { agentGraphPathWithinWorkspace, agentGraphWritePathAllowed } from "./agent-graph-permissions.ts";
import { fullTaskScopedHardDeny } from "./auto-approve.ts";
import { BUILTIN_CAPABILITY_TOOLS } from "./builtin-capability-tools.ts";
import { augmentedPath } from "./env-path.ts";
import {
  FLEET_CAPABILITY_TOOL_DEFINITIONS,
  type FleetCapabilityIndex,
} from "./fleet-capabilities.ts";
import type { HostMcpCatalog, HostMcpServer } from "./host-mcp.ts";
import { killCliTree, spawnCli } from "./procs.ts";
import { SPAWNED_PROXIES } from "./proxy-paths.ts";
import { windowsCmdCommand } from "./windows-cmd.ts";
import {
  OBSERVER_BRIDGE_SERVER,
  OBSERVER_TURN_TTL_MS,
  ObserverTaskPresenceAdapter,
  observerBridgeCall,
  observerBridgeToolDefinitions,
  type ObserverTaskPresenceOptions,
} from "./observer-task-presence.ts";
import {
  isSecretName,
  protectedEnvironmentValues,
  redactKnownValues,
  redactSecrets,
} from "./redact.ts";
import type { AgentGraphPermissionClass } from "../shared/agent-graphs.ts";
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

function contentSha256(value: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
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
  graphPermissionClass?: AgentGraphPermissionClass;
  graphWorkspace?: GraphWorkspaceIdentity;
  expiresAt: number;
  servers: Record<string, HostMcpServer>;
  interactiveInput: string;
  completedCalls: Map<string, any>;
  graphReadPreimages: Map<string, GraphPreimage>;
}

interface GraphFilePreimage {
  kind: "file";
  sha256: string;
  /** True only when the exact UTF-8 body was returned to this graph turn. */
  writable: boolean;
  dev: number;
  ino: number;
  nlink: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  parentPath: string;
  parentDev: number;
  parentIno: number;
}

interface GraphAbsentPreimage {
  kind: "absent";
  sha256: "absent";
  parentPath: string;
  parentDev: number;
  parentIno: number;
}

type GraphPreimage = GraphFilePreimage | GraphAbsentPreimage;

interface GraphWorkspaceIdentity {
  root: string;
  dev: number;
  ino: number;
}

function captureGraphWorkspace(cwd: string | undefined): GraphWorkspaceIdentity {
  if (!cwd) throw new Error("agent graph turn requires an exact workspace root");
  const requestedRoot = resolve(cwd);
  const requestedInfo = lstatSync(requestedRoot);
  if (!requestedInfo.isDirectory() || requestedInfo.isSymbolicLink()) {
    throw new Error("agent graph workspace root must be a real non-symlink directory");
  }
  const root = realpathSync(requestedRoot);
  const info = lstatSync(root);
  if (!info.isDirectory() || info.isSymbolicLink() ||
      info.dev !== requestedInfo.dev || info.ino !== requestedInfo.ino) {
    throw new Error("agent graph workspace root identity changed during canonicalization");
  }
  return { root, dev: info.dev, ino: info.ino };
}

function sameGraphPath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function requireGraphWorkspace(identity: GraphWorkspaceIdentity | undefined): void {
  if (!identity) throw new Error("agent graph workspace identity is unavailable");
  try {
    const info = lstatSync(identity.root);
    if (!info.isDirectory() || info.isSymbolicLink() || !sameGraphPath(realpathSync(identity.root), identity.root) ||
        info.dev !== identity.dev || info.ino !== identity.ino) {
      throw new Error("agent graph workspace root identity changed after dispatch");
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("identity changed")) throw error;
    throw new Error("agent graph workspace root identity changed after dispatch");
  }
}

function graphFilePreimage(
  info: Stats,
  sha256: string,
  writable: boolean,
  parentPath: string,
  parentInfo: Stats,
): GraphFilePreimage {
  return {
    kind: "file",
    sha256,
    writable,
    dev: info.dev,
    ino: info.ino,
    nlink: info.nlink,
    size: info.size,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
    parentPath,
    parentDev: parentInfo.dev,
    parentIno: parentInfo.ino,
  };
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
  observerPresence?: ObserverTaskPresenceOptions;
  fleetIndex?: FleetCapabilityIndex;
  /** Deterministic race seam; production leaves this unset. */
  beforeGraphAnchoredWrite?: () => void | Promise<void>;
}

function builtinTools(server: Extract<HostMcpServer, { type: "builtin" }>) {
  return server.family === "fleet" ? FLEET_CAPABILITY_TOOL_DEFINITIONS : BUILTIN_CAPABILITY_TOOLS;
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
  private readonly credentialBroker: CredentialBrokerOptions;
  private readonly observerOnly: boolean;
  private readonly observerPresence: ObserverTaskPresenceAdapter | null;
  private readonly fleetIndex?: FleetCapabilityIndex;
  private readonly beforeGraphAnchoredWrite?: () => void | Promise<void>;

  constructor(
    catalog: HostMcpCatalog,
    options: CapabilityGatewayOptions = {},
  ) {
    this.catalog = catalog;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    this.listAliasesImpl = options.listAliases ?? listCredentialAliases;
    this.credentialBroker = options.credentialBroker ?? {};
    this.observerOnly = catalog.manifest.profile === "observer-router";
    this.observerPresence = this.observerOnly
      ? new ObserverTaskPresenceAdapter(options.observerPresence)
      : null;
    this.fleetIndex = options.fleetIndex;
    this.beforeGraphAnchoredWrite = options.beforeGraphAnchoredWrite;
    this.protectedValues = protectedEnvironmentValues();
    this.protectServerValues(catalog.servers);
  }

  private readonly listAliasesImpl: () => Promise<string[]>;

  beginTurn(token: string, turn: {
    botId: string;
    threadId: string;
    cwd?: string;
    graphPermissionClass?: AgentGraphPermissionClass;
    ttlMs?: number;
    servers?: Record<string, HostMcpServer>;
  }): void {
    if (!token || token.length < 24) throw new Error("invalid capability turn token");
    if (this.activeTurns.has(token)) this.endTurn(token);
    const requestedTtl = turn.ttlMs ?? (this.observerOnly ? OBSERVER_TURN_TTL_MS : 24 * 60 * 60_000);
    const ttlMs = this.observerOnly
      ? Math.min(Math.max(requestedTtl, 1), OBSERVER_TURN_TTL_MS)
      : requestedTtl;
    const graphWorkspace = turn.graphPermissionClass ? captureGraphWorkspace(turn.cwd) : undefined;
    this.activeTurns.set(token, {
      botId: turn.botId,
      threadId: turn.threadId,
      cwd: graphWorkspace?.root ?? turn.cwd,
      graphPermissionClass: turn.graphPermissionClass,
      graphWorkspace,
      expiresAt: this.now() + ttlMs,
      servers: this.observerOnly ? {} : { ...turn.servers },
      interactiveInput: "",
      completedCalls: new Map(),
      graphReadPreimages: new Map(),
    });
    if (!this.observerOnly) this.protectServerValues(turn.servers ?? {});
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

  graphPermissionClass(token: string): AgentGraphPermissionClass | undefined {
    this.requireTurn(token);
    return this.activeTurns.get(token)?.graphPermissionClass;
  }

  turnContext(token: string): Readonly<Pick<ActiveTurn, "botId" | "threadId" | "cwd">> {
    this.requireTurn(token);
    const turn = this.activeTurns.get(token)!;
    return { botId: turn.botId, threadId: turn.threadId, cwd: turn.cwd };
  }

  private requireTurn(token: string): void {
    if (!this.ownsTurn(token)) throw new Error("capability request rejected: turn is no longer active");
    const turn = this.activeTurns.get(token)!;
    if (turn.graphPermissionClass) requireGraphWorkspace(turn.graphWorkspace);
  }

  extendTurn(token: string, servers: Record<string, HostMcpServer>): void {
    this.requireTurn(token);
    // App integrations, computers, shell/file tools, and arbitrary MCPs are
    // outside the observer profile. Ignore the app's generic extension step
    // while retaining the single identity-pinned catalog bridge.
    if (this.observerOnly) return;
    const turn = this.activeTurns.get(token)!;
    for (const [name, server] of Object.entries(servers)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$/.test(name) || /cred(?:ential)?vault/i.test(name)) {
        throw new Error("invalid capability server name");
      }
      if (this.catalog.servers[name] && JSON.stringify(this.catalog.servers[name]) !== JSON.stringify(server)) {
        throw new Error("turn capability cannot replace a host capability");
      }
      turn.servers[name] = server;
    }
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
    this.requireTurn(token);
    const turn = this.activeTurns.get(token)!;
    if (turn.graphPermissionClass) {
      return createAgentGraphProfileManifest(turn.graphPermissionClass);
    }
    const inventory = Object.entries(this.serversFor(token)).flatMap(([name, server]) =>
      server.type === "builtin" ? builtinTools(server).map((tool) => `${name}:${tool.name}`) : [name],
    );
    if (this.observerOnly) return createObserverRouterProfileManifest({ serverInventory: inventory });
    return createCapabilityProfileManifest({ toolInventory: inventory });
  }

  inventory(token: string): { manifest: HostMcpCatalog["manifest"]; servers: Array<{ name: string; type: string }> } {
    const servers = this.serversFor(token);
    const graphPermissionClass = this.activeTurns.get(token)?.graphPermissionClass;
    if (graphPermissionClass) {
      const host = servers["openmaus-host"];
      return {
        manifest: createAgentGraphProfileManifest(graphPermissionClass),
        servers: host ? [{ name: "openmaus-host", type: host.type }] : [],
      };
    }
    return {
      manifest: this.manifestFor(token),
      servers: Object.entries(servers).map(([name, server]) => ({ name, type: server.type })),
    };
  }

  async aliases(token: string): Promise<string[]> {
    this.requireTurn(token);
    if (this.observerOnly) throw new Error("observer profile does not expose credential aliases");
    if (this.activeTurns.get(token)?.graphPermissionClass) {
      throw new Error("agent graph profile does not expose credential aliases");
    }
    return [...new Set(await this.listAliasesImpl())].filter((name) => /^[A-Za-z0-9_.\/-]{1,200}$/.test(name)).sort();
  }

  async selectCredentialAlias(
    token: string,
    serverName: string,
    alias: string,
    envVar: string,
  ): Promise<void> {
    this.requireTurn(token);
    if (this.observerOnly) throw new Error("observer profile does not allow credential selection");
    if (this.activeTurns.get(token)?.graphPermissionClass) {
      throw new Error("agent graph profile does not allow credential selection");
    }
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
    const withoutSecrets = redactKnownValues(redactSecrets(value), this.protectedValues);
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
    if (this.observerOnly) {
      if (serverName !== OBSERVER_BRIDGE_SERVER || !this.serverFor(token, serverName)) {
        throw new Error("observer profile exposes only the identity-pinned fleet bridge");
      }
      const definitions = [
        ...observerBridgeToolDefinitions(),
        ...(this.observerPresence?.toolDefinitions() ?? []),
      ];
      const tools = [...new Map(definitions.map((tool) => [tool.name, tool])).values()];
      return {
        tools,
        _meta: {
          "openmaus.observer": {
            schema: "openmaus.observer_tool_projection.v1",
            surface: "openmausbot",
            instructionAuthority: false,
            mutationAuthority: "ack-only",
            duplicateToolsSuppressed: definitions.length - tools.length,
          },
        },
      };
    }
    const turn = this.activeTurns.get(token)!;
    if (turn.graphPermissionClass && serverName !== "openmaus-host") {
      throw new Error("agent graphs expose only the bounded local capability gateway");
    }
    const server = this.serverFor(token, serverName);
    if (server?.type === "builtin") {
      if (!turn.graphPermissionClass) return { tools: builtinTools(server) };
      const allowed = turn.graphPermissionClass === "workspace-write"
        ? new Set(["filesystem_read", "filesystem_stat", "filesystem_write"])
        : turn.graphPermissionClass === "read"
          ? new Set(["filesystem_read", "filesystem_stat"])
          : new Set<string>();
      return { tools: BUILTIN_CAPABILITY_TOOLS.filter((tool) => allowed.has(tool.name)) };
    }
    const backend = this.backend(token, serverName);
    try {
      return this.sanitize(await backend.client.request("tools/list", {}));
    } finally {
      this.releaseBackend(backend.key);
    }
  }

  async callTool(token: string, serverName: string, tool: string, args: JsonObject): Promise<any> {
    this.requireTurn(token);
    if (this.observerOnly) return this.callObserverTool(token, serverName, tool, args);
    const turn = this.activeTurns.get(token)!;
    if (turn.graphPermissionClass && serverName !== "openmaus-host") {
      throw new Error("agent graphs expose only the bounded local capability gateway");
    }
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

  private observerDenied(reason: string): JsonObject {
    return {
      content: [{ type: "text", text: `OpenMausBot observer denied this capability request: ${reason}.` }],
      isError: true,
      _meta: {
        "openmaus.observer": {
          instructionAuthority: false,
          mutationAuthority: "none",
        },
      },
    };
  }

  private observerResult(tool: string, result: any, duplicateSuppressed = false): any {
    const sanitized = this.sanitize(result);
    if (!sanitized || typeof sanitized !== "object" || Array.isArray(sanitized)) return sanitized;
    const currentMeta = sanitized._meta && typeof sanitized._meta === "object" && !Array.isArray(sanitized._meta)
      ? sanitized._meta
      : {};
    return {
      ...sanitized,
      _meta: {
        ...currentMeta,
        "openmaus.observer": {
          schema: "openmaus.observer_result.v1",
          tool,
          surface: "openmausbot",
          instructionAuthority: false,
          mutationAuthority: tool === "message_ack" ? "ack-only" : "none",
          duplicateSuppressed,
        },
      },
    };
  }

  private async callObserverTool(token: string, serverName: string, tool: string, args: JsonObject): Promise<any> {
    if (serverName !== OBSERVER_BRIDGE_SERVER || !this.serverFor(token, serverName)) {
      return this.observerDenied("only the identity-pinned fleet bridge is available");
    }
    if (this.observerPresence?.handles(tool)) {
      try {
        const result = await this.observerPresence.callTool(tool, args);
        return this.observerResult(tool, {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
          isError: false,
        });
      } catch {
        return this.observerDenied("invalid observer read request");
      }
    }
    let call;
    try {
      call = observerBridgeCall(tool, args);
    } catch {
      return this.observerDenied("invalid observer bridge request");
    }
    if (!call) {
      return this.observerDenied(
        "tool is outside list/status/proposals and addressed pull/ack/status scope",
      );
    }
    const turn = this.activeTurns.get(token)!;
    if (call.duplicateKey && turn.completedCalls.has(call.duplicateKey)) {
      return this.observerResult(tool, turn.completedCalls.get(call.duplicateKey), true);
    }
    const backend = this.backend(token, serverName);
    try {
      const result = await backend.client.request("tools/call", {
        name: call.backendTool,
        arguments: call.arguments,
      });
      const safeResult = this.observerResult(tool, result);
      if (call.duplicateKey && safeResult?.isError !== true) {
        turn.completedCalls.set(call.duplicateKey, safeResult);
      }
      return safeResult;
    } finally {
      this.releaseBackend(backend.key);
    }
  }

  private async callBuiltin(token: string, serverName: string, tool: string, args: JsonObject): Promise<any> {
    const turn = this.activeTurns.get(token);
    this.requireTurn(token);
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
    const requestedCwd = args.cwd ?? turn?.cwd ?? process.cwd();
    if (turn?.graphPermissionClass && (
      typeof requestedCwd !== "string" || !agentGraphPathWithinWorkspace(requestedCwd, turn.cwd)
    )) throw new Error("agent graph capability cwd is outside the approved workspace");
    const cwd = boundedPath(requestedCwd, turn?.cwd);
    if (tool === "shell_execute") {
      if (typeof args.command !== "string" || !args.command.trim()) throw new Error("command is required");
      if (turn?.graphPermissionClass) throw new Error("agent graph shell execution requires a separate OS sandbox");
      const timeoutMs = Math.min(Math.max(Number(args.timeoutMs) || 60_000, 100), 300_000);
      return this.sanitize(await shellCommand(args.command, cwd, timeoutMs));
    }
    if (turn?.graphPermissionClass && (
      typeof args.path !== "string" || !agentGraphPathWithinWorkspace(args.path, turn.cwd)
    )) throw new Error("agent graph capability path is outside the approved workspace");
    const path = boundedPath(args.path, turn?.cwd);
    if (tool === "filesystem_read") {
      const maxBytes = Math.min(Math.max(Number(args.maxBytes) || MAX_TOOL_RESULT_BYTES, 1), MAX_TOOL_RESULT_BYTES);
      let body: Buffer;
      if (turn?.graphPermissionClass) {
        requireGraphWorkspace(turn.graphWorkspace);
        const stable = await readStableAgentGraphFile(turn.cwd!, path, AGENT_GRAPH_MAX_FILE_BYTES);
        body = stable.body;
        const utf8 = body.toString("utf8");
        const fullUtf8Returned = body.byteLength <= maxBytes && !body.includes(0) && Buffer.from(utf8, "utf8").equals(body);
        turn.graphReadPreimages.set(path, graphFilePreimage(
          stable.info,
          stable.sha256,
          fullUtf8Returned,
          stable.parentPath,
          stable.parentInfo,
        ));
      } else {
        body = await readFile(path);
      }
      const sha256 = contentSha256(body);
      if (body.includes(0)) return { content: "[binary capability output omitted]", bytes: body.byteLength, sha256 };
      return this.sanitize({ path, content: body.subarray(0, maxBytes).toString("utf8"), sha256, truncated: body.byteLength > maxBytes });
    }
    if (tool === "filesystem_write") {
      if (turn?.graphPermissionClass !== undefined && turn.graphPermissionClass !== "workspace-write") {
        throw new Error("agent graph filesystem write is outside the approved permission class");
      }
      if (typeof args.content !== "string") throw new Error("content must be a string");
      if (turn?.graphPermissionClass) {
        if (typeof args.path !== "string" || !agentGraphWritePathAllowed(args.path, turn.cwd)) {
          throw new Error("agent graph filesystem write targets repository control metadata or an unsafe path");
        }
        if (args.append === true) throw new Error("agent graph filesystem append is not preimage-bound");
        const expected = typeof args.expectedSha256 === "string" ? args.expectedSha256 : "";
        const preimage = turn.graphReadPreimages.get(path);
        if (!/^(?:absent|sha256:[0-9a-f]{64})$/.test(expected) || preimage?.sha256 !== expected) {
          throw new Error("agent graph filesystem write requires the exact preimage returned by this turn");
        }
        if (preimage.kind === "file" && !preimage.writable) {
          throw new Error("agent graph filesystem write requires a complete UTF-8 preimage returned by this turn");
        }
        if (!agentGraphWritePathAllowed(args.path, turn.cwd)) {
          throw new Error("agent graph filesystem write path changed after the approved read");
        }
        const bytes = Buffer.from(args.content, "utf8");
        if (bytes.byteLength > AGENT_GRAPH_MAX_FILE_BYTES) {
          throw new Error("agent graph filesystem write exceeds the bounded file size");
        }
        const parentPath = dirname(path);
        const parentBefore = await lstat(parentPath);
        if (!parentBefore.isDirectory() || parentBefore.isSymbolicLink() ||
            parentBefore.dev !== preimage.parentDev || parentBefore.ino !== preimage.parentIno) {
          throw new Error("agent graph filesystem write rejected parent drift since the approved read");
        }
        let written;
        try {
          written = await writeAnchoredFile({
            path,
            parent: { dev: preimage.parentDev, ino: preimage.parentIno },
            mode: preimage.kind === "file" ? "replace" : "create",
            content: bytes,
            maximumBytes: AGENT_GRAPH_MAX_FILE_BYTES,
            ...(preimage.kind === "file" ? {
              expectedFile: {
                dev: preimage.dev,
                ino: preimage.ino,
                nlink: preimage.nlink,
                size: preimage.size,
                mtimeMs: preimage.mtimeMs,
                ctimeMs: preimage.ctimeMs,
                sha256: preimage.sha256,
              },
            } : {}),
          }, { beforeSpawn: this.beforeGraphAnchoredWrite });
        } catch (error) {
          if (preimage.kind === "file" && /identity|content changed/.test((error as Error).message)) {
            throw new Error("agent graph filesystem write rejected owner drift since the approved read");
          }
          throw error;
        }
        const sha256 = contentSha256(args.content);
        const finalPathInfo = await lstat(path);
        if (!finalPathInfo.isFile() || finalPathInfo.nlink !== 1 ||
            finalPathInfo.dev !== written.dev || finalPathInfo.ino !== written.ino) {
          throw new Error("agent graph filesystem write rejected a post-write path swap");
        }
        const parentAfter = await lstat(parentPath);
        if (!parentAfter.isDirectory() || parentAfter.isSymbolicLink() ||
            parentAfter.dev !== preimage.parentDev || parentAfter.ino !== preimage.parentIno) {
          throw new Error("agent graph filesystem write rejected a post-write parent swap");
        }
        turn.graphReadPreimages.set(path, graphFilePreimage(finalPathInfo, sha256, true, parentPath, parentAfter));
        return { path, bytes: Buffer.byteLength(args.content), appended: false, sha256 };
      }
      await mkdir(dirname(path), { recursive: true });
      if (args.append === true) await appendFile(path, args.content, { encoding: "utf8", mode: 0o600 });
      else await writeFile(path, args.content, { encoding: "utf8", mode: 0o600 });
      return { path, bytes: Buffer.byteLength(args.content), appended: args.append === true };
    }
    if (tool === "filesystem_delete") {
      if (turn?.graphPermissionClass) throw new Error("agent graphs cannot delete through the local capability gateway");
      await rm(path, { recursive: args.recursive === true, force: false });
      return { path, deleted: true };
    }
    if (tool === "filesystem_stat") {
      try {
        const info = turn?.graphPermissionClass ? await lstat(path) : await stat(path);
        if (turn?.graphPermissionClass) requireGraphWorkspace(turn.graphWorkspace);
        if (turn?.graphPermissionClass && (info.isSymbolicLink() || (info.isFile() && info.nlink !== 1))) {
          throw new Error("agent graph stat rejected a symlink or hard-linked file");
        }
        return { path, exists: true, type: info.isDirectory() ? "directory" : info.isFile() ? "file" : "other", size: info.size, modifiedAt: info.mtime.toISOString() };
      } catch (error) {
        if (turn?.graphPermissionClass && (error as NodeJS.ErrnoException).code === "ENOENT") {
          const parentPath = dirname(path);
          const parent = await lstat(parentPath);
          if (!parent.isDirectory() || parent.isSymbolicLink()) {
            throw new Error("agent graph filesystem creation requires an existing regular parent directory");
          }
          turn.graphReadPreimages.set(path, {
            kind: "absent",
            sha256: "absent",
            parentPath,
            parentDev: parent.dev,
            parentIno: parent.ino,
          });
          return { path, exists: false, type: "missing", sha256: "absent" };
        }
        throw error;
      }
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
