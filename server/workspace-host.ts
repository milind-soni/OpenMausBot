// Per-account workspaces on the public NATION server.
//
// Isolation is a separate data directory per account, served by its own
// server process: bots, conversations, memory, routines, connected apps and
// uploads live under <data dir>/workspaces/<workspace id>/ and nowhere else.
// Only this process (the founder's server) listens on the public address. It
// signs people in (server/account-gateway.ts), starts their workspace server
// on a loopback port the first time they need it, and forwards their
// requests there.
//
// What a workspace server gets, and what it does not:
//   - One `client` session for its one account, minted over loopback with a
//     key made for that start. Requests are forwarded with that bearer and
//     never as the loopback owner: owner means admin, and admin could add
//     engines, keys, MCP servers or computers.
//   - The NATION API engine only (see workspaceConfig): no desks and no
//     command-line engines on this machine.
//   - Computers and a browser of its own (see WorkspaceTools): NATION's cloud
//     computers, one per (workspace, account, bot), never this machine's
//     desktop, a Local VM, an SSH computer or a shared one; and the built-in
//     browser behind an egress guard (browser-egress-guard.ts), with its temp
//     files and sockets in a private directory of its own. When the workspace
//     stops, any browser process it left and that directory go with it.
//   - Unauthenticated loopback requests are not its owner, so nothing on this
//     machine becomes its admin by reaching its port.
//   - A fixed list of environment values: the model, search and credit
//     settings this server already runs with. Never this server's data
//     directory, sign-in lists, mail credentials or desk credentials.
//   - The credit ledger file this server uses, so payment amounts stay unique
//     across accounts and the one payment scanner here credits every account.
import { addedProviderConfigured } from "../shared/hosted-computers.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { Agent, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { isWorkspaceId, type WorkspaceRef } from "./accounts.ts";

export const WORKSPACE_KEY_HEADER = "x-nation-workspace-key";
export const WORKSPACE_SESSION_PATH = "/api/workspace-host/session";
export const WORKSPACE_ACTIVITY_PATH = "/api/workspace-host/activity";

export const WORKSPACE_UNAVAILABLE = "Your workspace could not start. Try again in a minute.";
export const WORKSPACE_BUSY = "Nation Team Chat is busy right now. Try again in a minute.";
export const WORKSPACE_NO_ANSWER = "Your workspace did not answer. Try again in a moment.";

/** Settings the founder chooses for everyone (admin Settings), copied into each workspace at start. */
export interface SharedWorkspaceSettings {
  modelRouting?: unknown;
  webSearch?: unknown;
}

/** What a member's bots may use besides chat, decided here at each start. */
export interface WorkspaceTools {
  hostedComputers?: import("../shared/hosted-computers.ts").HostedComputersConfig;
  /** NATION's cloud computers: remote machines, one per (workspace, account, bot). */
  computers: boolean;
  /** The built-in browser, run on this machine behind the egress guard. */
  browser: boolean;
  /** NATION's cloud computer credential. It reaches a workspace server through
   * its environment only: never its config file, a response or an engine. */
  boxToken?: string | null;
  /** The browser engine this server resolved, reused by workspace servers. */
  browserEngine?: string | null;
}

/** The operator's switches: both on unless NATION_WORKSPACE_COMPUTERS=0 or
 * NATION_WORKSPACE_BROWSER=0. A computer also needs NATION's cloud computer
 * credential and a browser needs the engine; without them each stays off. */
export function workspaceTools(env: NodeJS.ProcessEnv, available: { boxToken?: string | null; browserEngine?: string | null; hostedComputers?: import("../shared/hosted-computers.ts").HostedComputersConfig }): WorkspaceTools {
  const boxToken = available.boxToken?.trim() || null;
  const browserEngine = available.browserEngine?.trim() || null;
  return {
    computers: env.NATION_WORKSPACE_COMPUTERS !== "0" && (boxToken !== null || addedProviderConfigured(available.hostedComputers, "orgo") || addedProviderConfigured(available.hostedComputers, "daytona")),
    hostedComputers: available.hostedComputers,
    browser: env.NATION_WORKSPACE_BROWSER !== "0" && browserEngine !== null,
    boxToken,
    browserEngine,
  };
}

/** A short private directory for one workspace's browser: Chrome's temp files
 * and agent-browser's sockets. A Unix socket path is capped near 104 bytes,
 * which a path under the workspace's own folder overruns, so it lives in
 * /tmp under a name derived from the workspace id. */
export function workspaceRuntimeDir(workspaceId: string, base = "/tmp"): string {
  if (!isWorkspaceId(workspaceId)) throw new Error("invalid workspace id");
  return join(base, `nw-${createHash("sha256").update(workspaceId).digest("hex").slice(0, 12)}`);
}

/** Create a directory only this server's user may enter, or refuse one that
 * someone else made first (a link, another owner, or open permissions). */
export function ensurePrivateDirectory(path: string): void {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = lstatSync(path);
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (!stat.isDirectory() || stat.isSymbolicLink() || (uid !== null && stat.uid !== uid) || (stat.mode & 0o077) !== 0) {
    throw new Error(`${path} is not a private directory of this server`);
  }
  for (const name of ["t", "s", "r"]) mkdirSync(join(path, name), { recursive: true, mode: 0o700 });
}

/** Processes a stopped workspace left behind (a browser daemon, Chrome, a tool
 * helper): anything whose environment or command line points into its private
 * directory. Linux only; elsewhere there is no /proc and nothing is found. */
export function workspaceProcesses(runtimeDir: string, proc = "/proc"): number[] {
  const markers = [`TMPDIR=${join(runtimeDir, "t")}`, `AGENT_BROWSER_SOCKET_DIR=${join(runtimeDir, "s")}`];
  let entries: string[];
  try {
    entries = readdirSync(proc);
  } catch {
    return [];
  }
  const found: number[] = [];
  for (const name of entries) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    try {
      const environ = readFileSync(join(proc, name, "environ"), "latin1").split("\0");
      const cmdline = readFileSync(join(proc, name, "cmdline"), "latin1").split("\0").join(" ");
      if (environ.some((entry) => markers.includes(entry)) || cmdline.includes(`${runtimeDir}/`)) found.push(Number(name));
    } catch {
      // gone, or not ours to read
    }
  }
  return found;
}

/** Stop what a workspace left running and remove its private directory. */
export function tearDownWorkspaceRuntime(runtimeDir: string, log: (line: string) => void = () => {}, proc = "/proc"): void {
  const leftovers = workspaceProcesses(runtimeDir, proc);
  for (const pid of leftovers) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
  if (leftovers.length) log(`workspace runtime ${runtimeDir}: stopped ${leftovers.length} process(es) it left behind`);
  rmSync(runtimeDir, { recursive: true, force: true });
}

/** Values a workspace server may inherit from this one. Anything not listed stays here. */
export const INHERITED_ENVIRONMENT = [
  // the system
  "PATH", "LANG", "LC_ALL", "TZ", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
  "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy",
  // NATION API: server-held model keys and routing; members never see them
  "OPENROUTER_API_KEY", "OPENROUTER_API_URL", "OPENROUTER_MODEL", "NATION_OPENROUTER_MODEL", "NATION_DEFAULT_MODEL",
  "NATION_MODEL_FAST", "NATION_MODEL_STANDARD", "NATION_MODEL_STRONG", "NATION_IMAGE_MODEL",
  "NATION_CODING_ENABLED", "NATION_CODING_MODEL", "NATION_CODING_PUBLIC_ORIGIN",
  // web search and reading for agents
  "NATION_SEARCH_PROVIDER", "NATION_SEARCH_API_KEY", "NATION_SEARCH_API_URL", "NATION_SEARCH_MODEL",
  "NATION_SEARCH_PRICE_USD", "NATION_READER_PRICE_USD",
  // connected apps
  "COMPOSIO_API_KEY", "OMB_COMPOSIO_API", "OMB_COMPOSIO_TOOLKITS_API", "OMB_COMPOSIO_BROKER_URL", "OMB_COMPOSIO_BROKER_TOKEN",
  // the NATION wallet: creates a passkey-held wallet per account; it cannot move their funds
  "TURNKEY_ORGANIZATION_ID", "TURNKEY_API_PUBLIC_KEY", "TURNKEY_API_PRIVATE_KEY", "TURNKEY_API_BASE_URL",
  // credit prices and payment rules (the scan itself runs only here)
  "NATION_TREASURY_ROBINHOOD", "NATION_RPC_ROBINHOOD", "NATION_TOKEN_USD_PRICE", "NATION_TOKEN_DISCOUNT",
  "NATION_FREE_CREDIT_USD", "NATION_CREDIT_MARKUP", "NATION_LOW_BALANCE_USD", "NATION_PACKS_USD",
  "NATION_FREE_GRANTS_PER_IP_PER_DAY", "NATION_CONFIRMATIONS", "NATION_DISPOSABLE_EMAIL_DOMAINS",
  "NATION_PUBLIC_NAME",
  // cloud computers' endpoint, and the Chrome the browser engine starts
  // (production pins its exact path for the Chrome sandbox profile)
  "OMB_BOX_API", "AGENT_BROWSER_EXECUTABLE_PATH", "NATION_TEST_ORGO_API", "NATION_TEST_DAYTONA_API", "NATION_TEST_CODING",
] as const;

export function workspaceServerEnvironment(parent: NodeJS.ProcessEnv, input: {
  root: string;
  port: number;
  workspaceId: string;
  key: string;
  creditsDb: string;
  brandFile?: string | null;
  /** The workspace's private directory (workspaceRuntimeDir), when it has one. */
  runtimeDir?: string | null;
  tools?: WorkspaceTools;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of INHERITED_ENVIRONMENT) if (parent[name]) env[name] = parent[name];
  const temp = input.runtimeDir ? join(input.runtimeDir, "t") : join(input.root, "tmp");
  Object.assign(env, {
    HOME: input.root,
    USERPROFILE: input.root,
    XDG_CONFIG_HOME: join(input.root, ".config"),
    XDG_CACHE_HOME: join(input.root, ".cache"),
    XDG_DATA_HOME: join(input.root, ".local", "share"),
    TMPDIR: temp,
    TEMP: temp,
    TMP: temp,
    NATION_DATA_DIR: input.root,
    OMB_DATA_DIR: input.root,
    OMB_PORT: String(input.port),
    OMB_WEBHOOK_PORT: String(input.port + 1),
    // A member is never the product owner, whatever this server is.
    NATION_PRODUCT_OWNER: "0",
    NATION_PRODUCT_ADMIN: "0",
    NATION_CREDITS_DB: input.creditsDb,
    NATION_CREDIT_WATCHER: "0",
    // X-Real-IP is written by this server for every forwarded request.
    NATION_TRUST_PROXY: "1",
    NATION_WORKSPACE_ID: input.workspaceId,
    NATION_WORKSPACE_KEY: input.key,
    // Reaching its port from this machine proves nothing: no owner by loopback.
    NATION_WORKSPACE_LOOPBACK_OWNER: "0",
  });
  if (input.runtimeDir) {
    env.AGENT_BROWSER_SOCKET_DIR = join(input.runtimeDir, "s");
    env.XDG_RUNTIME_DIR = join(input.runtimeDir, "r");
  }
  if (input.tools?.computers && input.tools.hostedComputers) env.NATION_HOSTED_COMPUTERS_CONFIG = JSON.stringify(input.tools.hostedComputers);
  if (input.tools?.computers && input.tools.boxToken) env.BOX_TOKEN = input.tools.boxToken;
  if (input.tools?.browser && input.tools.browserEngine) env.OMB_AGENT_BROWSER_PATH = input.tools.browserEngine;
  if (input.brandFile) env.NATION_BRAND_FILE = input.brandFile;
  return env;
}

/** The parts of a workspace's config.json this server owns. Everything else
 * (bots' look, rooms, onboarding) is the workspace's own. */
export function workspaceConfig(
  existing: Record<string, unknown>,
  email: string,
  shared: SharedWorkspaceSettings = {},
  tools: Pick<WorkspaceTools, "computers" | "browser"> = { computers: false, browser: false },
): Record<string, unknown> {
  const features = existing.features && typeof existing.features === "object" && !Array.isArray(existing.features) ? existing.features as Record<string, unknown> : {};
  const next: Record<string, unknown> = {
    ...existing,
    // The one account that may hold a session here.
    signIn: { admins: [], members: [email] },
    // NATION API only: no command-line engines or desks. The server picks its
    // own default model on it; routing picks per turn.
    instances: { nationApi: { driver: "nation-openrouter", displayName: "NATION API" } },
    // Cloud computers and the guarded browser when this server offers them;
    // never computer sharing.
    features: { ...features, browser: tools.browser, computers: tools.computers, sharedComputers: false },
  };
  const selection = next.defaultModelSelection as { instanceId?: unknown } | undefined;
  if (selection && selection.instanceId !== "nationApi") delete next.defaultModelSelection;
  // Never copied in, and removed if present. (`composio` stays: the workspace
  // records its own connected-apps session ids there, and never a key.)
  // `box` carries no key here: the credential arrives by environment only.
  // `browserEngine` could attach the browser to another Chrome.
  for (const key of ["box", "hostedComputers", "vps", "localVm", "browserEngine", "anthropic", "xai", "openaiCompat", "opencodeGo", "customDomain", "cliStartup"]) delete next[key];
  const composio = next.composio as Record<string, unknown> | undefined;
  if (composio && typeof composio === "object") delete composio.apiKey;
  if (shared.modelRouting !== undefined) next.modelRouting = shared.modelRouting;
  else delete next.modelRouting;
  if (shared.webSearch !== undefined) next.webSearch = shared.webSearch;
  else delete next.webSearch;
  return next;
}

function readJson(file: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.unref();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

async function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createNetServer();
    probe.unref();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

/** Two consecutive free loopback ports: the app port and its webhook port. */
async function freePortPair(): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = await freePort();
    if (port < 65_535 && await portFree(port + 1)) return port;
  }
  throw new Error("no free loopback port pair");
}

const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"]);

/** What a forwarded request carries: the browser's own headers minus every
 * credential and proxy claim, plus this workspace's bearer and the caller's
 * address. The one cookie that crosses is the starter-credit device id. */
export function forwardedRequestHeaders(headers: IncomingHttpHeaders, input: { token: string; port: number; clientIp: string }): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (value === undefined || HOP_BY_HOP.has(key)) continue;
    if (["cookie", "authorization", "host", "origin", "referer", "forwarded", "x-real-ip"].includes(key)) continue;
    if (key.startsWith("x-forwarded-") || key.startsWith("x-openmausbot-") || key.startsWith("x-nation-")) continue;
    out[key] = value;
  }
  const device = /(?:^|;\s*)nation_device=([0-9a-f-]{36})(?:;|$)/i.exec(String(headers.cookie ?? ""))?.[1];
  if (device) out.cookie = `nation_device=${device}`;
  out.authorization = `Bearer ${input.token}`;
  out.host = `127.0.0.1:${input.port}`;
  out["x-real-ip"] = input.clientIp;
  return out;
}

/** What goes back to the browser: everything but hop-by-hop headers, and no
 * cookie except the starter-credit device id. */
export function returnedResponseHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (value === undefined || HOP_BY_HOP.has(key)) continue;
    if (key === "set-cookie") {
      const kept = (Array.isArray(value) ? value : [value]).filter((cookie) => /^nation_device=/i.test(cookie));
      if (kept.length) out[key] = kept;
      continue;
    }
    out[key] = value;
  }
  return out;
}

interface Running {
  ref: WorkspaceRef;
  child: ChildProcess;
  port: number;
  key: string;
  token: string;
  startedAt: number;
  lastUsedAt: number;
  /** Forwarded requests still open, event streams included. */
  inflight: number;
  exited: Promise<void>;
  stopping: boolean;
}

export interface WorkspaceHostOptions {
  /** This server's data directory; workspaces live under its workspaces/ folder. */
  dataDir: string;
  /** The shared credit ledger file. */
  creditsDb: string;
  env?: NodeJS.ProcessEnv;
  /** How to start a workspace server; defaults to this process's own entry point. */
  command?: { file: string; args: string[]; cwd?: string };
  brandFile?: () => string | null;
  sharedSettings?: () => SharedWorkspaceSettings;
  /** Computers and browser for members (workspaceTools); none when absent. */
  tools?: () => WorkspaceTools;
  /** Where private browser directories go (workspaceRuntimeDir); /tmp by default. */
  runtimeBase?: string;
  maxRunning?: number;
  idleMs?: number;
  startTimeoutMs?: number;
  log?: (line: string) => void;
}

/** This process's own entry point, without debugger flags a second process
 * could not reuse. Under a process manager the script may be its wrapper, so
 * NATION_WORKSPACE_SERVER_ENTRY names the server's entry explicitly, and PM2's
 * own record of the script (pm_exec_path) is preferred to argv. */
export function ownServerCommand(env: NodeJS.ProcessEnv = process.env): { file: string; args: string[]; cwd?: string } {
  const execArgv = process.execArgv.filter((arg) => !arg.startsWith("--inspect") && !arg.startsWith("--debug"));
  const entry = env.NATION_WORKSPACE_SERVER_ENTRY?.trim() || env.pm_exec_path?.trim() || process.argv[1]!;
  return { file: process.execPath, args: [...execArgv, entry] };
}

function positiveInteger(value: string | undefined, fallback: number, max: number): number {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 && number <= max ? number : fallback;
}

export class WorkspaceHost {
  private readonly running = new Map<string, Running>();
  private readonly starting = new Map<string, Promise<Running>>();
  /** Workspaces being stopped, until their server has exited and cleared its
   * private directory. A start waits for it: the directory is named for the
   * workspace, and clearing it stops every process that uses it. */
  private readonly exiting = new Map<string, Promise<void>>();
  private readonly failures = new Map<string, { count: number; at: number }>();
  private readonly agent = new Agent({ keepAlive: true, maxSockets: 64 });
  private readonly options: WorkspaceHostOptions;
  private readonly env: NodeJS.ProcessEnv;
  private readonly log: (line: string) => void;
  private readonly maxRunning: number;
  private readonly idleMs: number;
  private readonly sweeper: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(options: WorkspaceHostOptions) {
    this.options = options;
    this.env = options.env ?? process.env;
    this.log = options.log ?? ((line) => console.warn(line));
    // Each running workspace is a server process of about 200 MB; eight at once is about 1.6 GB.
    this.maxRunning = options.maxRunning ?? positiveInteger(this.env.NATION_WORKSPACE_MAX_RUNNING, 8, 1_000);
    this.idleMs = options.idleMs ?? positiveInteger(this.env.NATION_WORKSPACE_IDLE_MINUTES, 30, 24 * 60) * 60_000;
    this.sweeper = setInterval(() => { void this.sweep(); }, 60_000);
    this.sweeper.unref();
  }

  rootOf(workspaceId: string): string {
    if (!isWorkspaceId(workspaceId)) throw new Error("invalid workspace id");
    return join(this.options.dataDir, "workspaces", workspaceId);
  }

  isRunning(workspaceId: string): boolean {
    return this.running.has(workspaceId);
  }

  runningCount(): number {
    return this.running.size;
  }

  /** A guest's model capability may reach only the coding gateway of an
   * already-running workspace. Never mint a member session or start a server. */
  async forwardCoding(req: IncomingMessage, res: ServerResponse, workspaceId: string): Promise<void> {
    const running = this.running.get(workspaceId);
    if (!running || running.stopping || !/^Bearer [a-f0-9]{64}$/.test(String(req.headers.authorization ?? ""))) {
      res.writeHead(403, { "content-type": "application/json" }); res.end('{"error":"Coding task authorization ended."}'); return;
    }
    running.inflight++;
    try {
      await new Promise<void>(resolve => {
        const upstream = httpRequest({ host: "127.0.0.1", port: running.port, path: req.url, method: req.method,
          headers: { authorization: req.headers.authorization, "content-type": "application/json", ...(req.headers.origin ? { origin: req.headers.origin } : {}) },
          agent: this.agent, timeout: 190_000 }, response => {
          res.writeHead(response.statusCode ?? 502, { "content-type": response.headers["content-type"] ?? "application/json", "cache-control": "no-store" });
          response.pipe(res); response.on("end", resolve); response.on("error", () => { res.destroy(); resolve(); });
        });
        let bytes = 0;
        req.on("data", chunk => { bytes += chunk.length; if (bytes > 2_000_000) upstream.destroy(); });
        upstream.on("timeout", () => upstream.destroy());
        upstream.on("error", () => { if (!res.headersSent) { res.writeHead(502); res.end(); } else res.destroy(); resolve(); });
        res.on("close", () => upstream.destroy());
        req.pipe(upstream);
      });
    } finally { running.inflight--; }
  }

  /** Create the folder on first use, the private runtime directory for this
   * start, and (re)write the settings this server owns. */
  prepare(ref: WorkspaceRef): { root: string; runtimeDir: string | null; tools: WorkspaceTools } {
    const root = this.rootOf(ref.id);
    mkdirSync(join(root, "tmp"), { recursive: true, mode: 0o700 });
    mkdirSync(join(root, "logs"), { recursive: true, mode: 0o700 });
    let tools: WorkspaceTools = this.options.tools?.() ?? { computers: false, browser: false };
    let runtimeDir: string | null = workspaceRuntimeDir(ref.id, this.options.runtimeBase);
    try {
      // Whatever an earlier run of this workspace left (if this server was
      // killed, say) goes first: each start gets a fresh directory.
      tearDownWorkspaceRuntime(runtimeDir, this.log);
      ensurePrivateDirectory(runtimeDir);
    } catch (error) {
      // The browser cannot start without a short private directory, and must
      // not borrow one: this start goes without it.
      this.log(`workspace ${ref.id}: no private runtime directory (${error instanceof Error ? error.message : String(error)}); its browser stays off`);
      runtimeDir = null;
      tools = { ...tools, browser: false };
    }
    const configFile = join(root, "config.json");
    const next = workspaceConfig(readJson(configFile), ref.email, this.options.sharedSettings?.() ?? {}, tools);
    const temp = `${configFile}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(temp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
    renameSync(temp, configFile);
    return { root, runtimeDir, tools };
  }

  /** The workspace server for this account, started if it is not running. */
  async ensure(ref: WorkspaceRef): Promise<{ port: number; token: string }> {
    if (this.closed) throw new Error("workspace host is closed");
    const current = this.running.get(ref.id);
    if (current && !current.stopping) {
      current.lastUsedAt = Date.now();
      return current;
    }
    let pending = this.starting.get(ref.id);
    if (!pending) {
      pending = (async () => {
        if (current) await current.exited;
        await this.exiting.get(ref.id);
        return this.start(ref);
      })();
      this.starting.set(ref.id, pending);
      const clear = () => { if (this.starting.get(ref.id) === pending) this.starting.delete(ref.id); };
      pending.then(clear, clear);
    }
    const started = await pending;
    started.lastUsedAt = Date.now();
    return started;
  }

  private async start(ref: WorkspaceRef): Promise<Running> {
    const failure = this.failures.get(ref.id);
    if (failure && failure.count >= 3 && Date.now() - failure.at < 60_000) {
      throw Object.assign(new Error(`workspace ${ref.id} failed to start ${failure.count} times; waiting before another try`), { status: 503 });
    }
    await this.makeRoom();
    const prepared = this.prepare(ref);
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const running = await this.launch(ref, prepared);
        this.failures.delete(ref.id);
        return running;
      } catch (error) {
        lastError = error;
        this.log(`workspace ${ref.id} did not start (attempt ${attempt + 1}): ${error instanceof Error ? error.message : String(error)}`);
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      }
    }
    const previous = this.failures.get(ref.id);
    this.failures.set(ref.id, { count: (previous && Date.now() - previous.at < 5 * 60_000 ? previous.count : 0) + 1, at: Date.now() });
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private openLog(root: string): number {
    const file = join(root, "logs", "server.log");
    try {
      if (statSync(file).size > 10 * 1024 * 1024) renameSync(file, `${file}.1`);
    } catch {
      // no log yet
    }
    return openSync(file, "a", 0o600);
  }

  private async launch(ref: WorkspaceRef, prepared: { root: string; runtimeDir: string | null; tools: WorkspaceTools }): Promise<Running> {
    const { root, runtimeDir, tools } = prepared;
    const port = await freePortPair();
    const key = randomBytes(32).toString("base64url");
    const command = this.options.command ?? ownServerCommand(this.env);
    const log = this.openLog(root);
    let child: ChildProcess;
    try {
      if (runtimeDir) ensurePrivateDirectory(runtimeDir);
      child = spawn(command.file, command.args, {
        cwd: command.cwd ?? process.cwd(),
        env: workspaceServerEnvironment(this.env, {
          root, port, workspaceId: ref.id, key, creditsDb: this.options.creditsDb, brandFile: this.options.brandFile?.() ?? null,
          runtimeDir, tools,
        }),
        stdio: ["ignore", log, log],
      });
    } finally {
      closeSync(log);
    }
    const exited = new Promise<void>((resolve) => {
      const gone = () => {
        // The workspace's browser processes and private directory end with it.
        if (runtimeDir) {
          try { tearDownWorkspaceRuntime(runtimeDir, this.log); } catch (error) {
            this.log(`workspace ${ref.id}: could not clear its runtime directory: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        resolve();
      };
      if (child.exitCode !== null || child.signalCode !== null) return gone();
      child.once("exit", gone);
      child.once("error", gone);
    });
    const stop = async () => {
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      await exited;
      clearTimeout(timer);
    };
    try {
      await this.waitReady(child, port, exited);
      const token = await this.mintSession(port, key, ref);
      const running: Running = { ref, child, port, key, token, startedAt: Date.now(), lastUsedAt: Date.now(), inflight: 0, exited, stopping: false };
      this.running.set(ref.id, running);
      void exited.then(() => {
        if (this.running.get(ref.id) === running) this.running.delete(ref.id);
        if (!running.stopping) this.log(`workspace ${ref.id} stopped unexpectedly (exit ${child.exitCode ?? child.signalCode}); it starts again on its next request`);
      });
      return running;
    } catch (error) {
      await stop();
      throw error;
    }
  }

  private async waitReady(child: ChildProcess, port: number, exited: Promise<void>): Promise<void> {
    const deadline = Date.now() + (this.options.startTimeoutMs ?? 45_000);
    let gone = false;
    void exited.then(() => { gone = true; });
    for (;;) {
      if (gone || child.exitCode !== null) throw new Error(`the workspace server exited while starting (exit ${child.exitCode ?? child.signalCode})`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1_000) });
        const body = response.ok ? await response.json() as { app?: string } : null;
        if (body?.app === "nation-team-chat") return;
      } catch {
        // still starting
      }
      if (Date.now() >= deadline) throw new Error("the workspace server did not become ready in time");
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  private async mintSession(port: number, key: string, ref: WorkspaceRef): Promise<string> {
    const response = await fetch(`http://127.0.0.1:${port}${WORKSPACE_SESSION_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", [WORKSPACE_KEY_HEADER]: key },
      body: JSON.stringify({ email: ref.email, userId: ref.userId }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.json().catch(() => ({})) as { token?: unknown; error?: unknown };
    if (!response.ok || typeof body.token !== "string") throw new Error(`the workspace server refused its session (${response.status} ${typeof body.error === "string" ? body.error : ""})`);
    return body.token;
  }

  private async activity(running: Running): Promise<{ busy: boolean; keepAlive: boolean } | null> {
    try {
      const response = await fetch(`http://127.0.0.1:${running.port}${WORKSPACE_ACTIVITY_PATH}`, {
        headers: { [WORKSPACE_KEY_HEADER]: running.key }, signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) return null;
      const body = await response.json() as { busy?: unknown; keepAlive?: unknown };
      return { busy: body.busy === true, keepAlive: body.keepAlive === true };
    } catch {
      return null;
    }
  }

  /** Stop the least recently used idle workspace when the running limit is reached. */
  private async makeRoom(): Promise<void> {
    if (this.running.size < this.maxRunning) return;
    const candidates = [...this.running.values()].filter((item) => item.inflight === 0 && !item.stopping).sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    for (const candidate of candidates) {
      const activity = await this.activity(candidate);
      if (activity && !activity.busy && !activity.keepAlive) {
        await this.stop(candidate.ref.id, "making room");
        return;
      }
    }
    throw Object.assign(new Error(`${this.running.size} workspaces are running, the limit`), { status: 503, public: WORKSPACE_BUSY });
  }

  /** Stop workspaces nobody has used for a while, unless a turn is running or a routine keeps them awake. */
  async sweep(now = Date.now()): Promise<void> {
    for (const running of this.running.values()) {
      if (running.stopping || running.inflight > 0 || now - running.lastUsedAt < this.idleMs) continue;
      const activity = await this.activity(running);
      if (!activity || activity.busy || activity.keepAlive) continue;
      await this.stop(running.ref.id, "idle");
    }
  }

  async stop(workspaceId: string, reason: string): Promise<void> {
    const running = this.running.get(workspaceId);
    if (!running) return;
    running.stopping = true;
    this.running.delete(workspaceId);
    this.exiting.set(workspaceId, running.exited);
    running.child.kill("SIGTERM");
    const timer = setTimeout(() => running.child.kill("SIGKILL"), 10_000);
    await running.exited;
    clearTimeout(timer);
    if (this.exiting.get(workspaceId) === running.exited) this.exiting.delete(workspaceId);
    this.log(`workspace ${workspaceId} stopped (${reason})`);
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.sweeper);
    await Promise.all([...this.running.keys()].map((id) => this.stop(id, "server shutting down")));
    this.agent.destroy();
  }

  /** Forward one request to the account's workspace server, streaming both ways. */
  async forward(req: IncomingMessage, res: ServerResponse, ref: WorkspaceRef, clientIp: string): Promise<void> {
    const send = (status: number, error: string) => {
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ error }));
    };
    let target: { port: number; token: string };
    try {
      target = await this.ensure(ref);
    } catch (error) {
      this.log(`workspace ${ref.id} unavailable: ${error instanceof Error ? error.message : String(error)}`);
      const busy = (error as { public?: unknown })?.public;
      return send(503, typeof busy === "string" ? busy : WORKSPACE_UNAVAILABLE);
    }
    const running = this.running.get(ref.id);
    if (running) running.inflight++;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (running) {
        running.inflight--;
        running.lastUsedAt = Date.now();
      }
    };
    await new Promise<void>((resolve) => {
      const upstream = httpRequest({
        host: "127.0.0.1",
        port: target.port,
        method: req.method,
        path: req.url,
        headers: forwardedRequestHeaders(req.headers, { token: target.token, port: target.port, clientIp }),
        agent: this.agent,
      });
      upstream.on("response", (response) => {
        // The session this server holds there was refused: never show a
        // member a sign-in error for our credential. Mint a new one next time.
        if (response.statusCode === 401 && running) {
          response.resume();
          void this.mintSession(running.port, running.key, ref)
            .then((token) => { running.token = token; })
            .catch(() => this.stop(ref.id, "its session was refused"));
          send(503, WORKSPACE_NO_ANSWER);
          finish();
          return resolve();
        }
        const headers = returnedResponseHeaders(response.headers);
        // writeHead would replace a cookie this server already set (the account cookie's renewal).
        const already = res.getHeader("set-cookie");
        if (already !== undefined && headers["set-cookie"]) {
          headers["set-cookie"] = [...(Array.isArray(already) ? already : [String(already)]), ...(headers["set-cookie"] as string[])];
        }
        res.writeHead(response.statusCode ?? 502, headers);
        if (String(response.headers["content-type"] ?? "").startsWith("text/event-stream")) res.flushHeaders();
        response.pipe(res);
        response.on("end", () => { finish(); resolve(); });
        response.on("error", () => { res.destroy(); finish(); resolve(); });
      });
      upstream.on("error", (error) => {
        this.log(`workspace ${ref.id} request failed: ${error.message}`);
        send(502, WORKSPACE_NO_ANSWER);
        finish();
        resolve();
      });
      res.on("close", () => {
        if (!finished) upstream.destroy();
        finish();
        resolve();
      });
      req.pipe(upstream);
    });
  }
}
