// User-managed Existing VM transport and readiness.
//
// This is deliberately not a LocalVmTarget. LocalVmTarget represents a
// container OpenMausBot owns; an Existing VM has no OpenMausBot lifecycle,
// filesystem, image, or isolation contract. The only persisted connection
// detail is a validated SSH config alias.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { CUA_DRIVER_VERSION, wholeScreenshot } from "./container-computer.ts";
import { isValidSshAlias, localVmSshAlias, type AppConfig } from "./config.ts";
import { augmentedPath } from "./env-path.ts";
import { SPAWNED_PROXIES } from "./proxy-paths.ts";
import { z } from "zod";

export const EXISTING_VM_LEASE_KEY = "existing-vm";
export const EXISTING_VM_REQUIRED_TOOLS = [
  "get_desktop_state",
  "list_apps",
  "click",
  "type_text",
  "press_key",
  "scroll",
] as const;

const SSH_COMMAND = "ssh";
const TEST_SSH_COMMAND = process.env.OMB_TEST_SSH_COMMAND;
const TEST_SSH_PREFIX = (() => {
  const raw = process.env.OMB_TEST_SSH_PREFIX;
  if (!raw) return [];
  try {
    const parsed = z.array(z.string()).safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
})();
const SSH_OPTIONS = [
  "-T",
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=10",
  "-o",
  "ServerAliveInterval=5",
  "-o",
  "ServerAliveCountMax=2",
] as const;
const PROBE_TIMEOUT_MS = 10_000;
const MCP_REQUEST_TIMEOUT_MS = 15_000;
const SCREENSHOT_TIMEOUT_MS = 20_000;
const SCREENSHOT_SESSION_IDLE_MS = 30_000;
const STATUS_CACHE_TTL_MS = 10_000;
const MAX_PROBE_OUTPUT = 64 * 1024;
const MAX_MCP_LINE_CHARS = 16 * 1024 * 1024;
const MCP_CLOSE_GRACE_MS = 1_500;

export type ExistingVmErrorCode =
  | "ssh-missing"
  | "ssh-unreachable"
  | "remote-os"
  | "cua-missing"
  | "cua-version"
  | "mcp"
  | "desktop"
  | "timeout";

export class ExistingVmError extends Error {
  readonly code: ExistingVmErrorCode;

  constructor(code: ExistingVmErrorCode, message: string) {
    super(message);
    this.name = "ExistingVmError";
    this.code = code;
  }
}

export type ExistingVmStatus = {
  source: "existing";
  configured: boolean;
  sshAlias: string | null;
  ssh: "not-configured" | "connected" | "unreachable";
  os: "unknown" | "linux" | "unsupported";
  driver: "unknown" | "compatible" | "missing" | "incompatible";
  mcp: "unknown" | "ready" | "failed";
  tools: string[];
  desktopReady: boolean;
  ready: boolean;
  problem: string | null;
  errorCode: ExistingVmErrorCode | "not-configured" | null;
  driver_version: string;
  viewer_url: "";
  watch_only: true;
};

export type ExistingVmOptions = {
  /** Test-only executable override; user config never supplies this. */
  sshCommand?: string;
  /** Test-only argv prefix for running a fake SSH executable. */
  sshCommandPrefix?: string[];
  /** Test-only command timeout override. */
  sshTimeoutMs?: number;
  /** Test-only MCP line limit override. */
  mcpLineLimit?: number;
  /** Test-only screenshot session idle timeout override. */
  screenshotSessionIdleMs?: number;
  /** Test-only status cache enablement for injected SSH commands. */
  cacheStatus?: boolean;
  /** Bypass the short status cache for an explicit user re-check. */
  force?: boolean;
};

type ExistingVmEnvironment = {
  ELECTRON_RUN_AS_NODE: string;
  OMB_CONTROL_URL?: string;
  OMB_CONTROL_TOKEN?: string;
};
type ExistingVmComputerMcp = { command: string; args: string[]; env: ExistingVmEnvironment };

type CommandResult = { stdout: string; stderr: string };

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };
type JsonRpcError = { message?: JsonValue };
type JsonRpcResponse = { id?: number; result?: JsonValue; error?: JsonRpcError };
type DesktopImage = { png: string; format: "png" | "jpeg" };

const jsonObjectSchema = z.record(z.string(), z.json());
const jsonNumberSchema = z.number();
const jsonStringSchema = z.string();

class CommandFailure extends Error {
  readonly code?: string;
  readonly stderr?: string;

  constructor(message: string, code?: string, stderr?: string) {
    super(message);
    this.name = "CommandFailure";
    this.code = code;
    this.stderr = stderr;
  }
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return jsonObjectSchema.safeParse(value).success;
}

function isJsonNumber(value: JsonValue | undefined): value is number {
  return jsonNumberSchema.safeParse(value).success;
}

function isJsonString(value: JsonValue | undefined): value is string {
  return jsonStringSchema.safeParse(value).success;
}

function spawnErrorCode(error: Error): string | undefined {
  if (!("code" in error)) return undefined;
  return error.code === "ENOENT" ? "ENOENT" : undefined;
}

function commandFailure(message: string, code?: string, stderr?: string): CommandFailure {
  return new CommandFailure(message, code, stderr);
}

/** The only SSH argv used by the Existing VM path. No user-provided options
 * or remote command fragments can reach this function. */
function sshArgs(alias: string, remote: readonly string[]): string[] {
  if (!isValidSshAlias(alias)) throw new Error("invalid Existing VM SSH config alias");
  return [...SSH_OPTIONS, alias, ...remote];
}

function spawnedSshArgs(alias: string, remote: readonly string[], options: ExistingVmOptions): string[] {
  return [...(options.sshCommandPrefix ?? TEST_SSH_PREFIX), ...sshArgs(alias, remote)];
}

export function existingVmMcpArgs(alias: string): string[] {
  return sshArgs(alias, ["cua-driver", "mcp"]);
}

export function existingVmLivenessArgs(alias: string): string[] {
  return sshArgs(alias, ["true"]);
}

function collectBounded(target: { value: string; size: number }, chunk: string): void {
  target.size += Buffer.byteLength(chunk, "utf8");
  if (target.size > MAX_PROBE_OUTPUT) throw new Error("SSH probe output exceeded its limit");
  target.value += chunk;
}

function runSshCommand(
  alias: string,
  remote: readonly string[],
  options: ExistingVmOptions = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const { sshCommand = TEST_SSH_COMMAND ?? SSH_COMMAND } = options;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(sshCommand, spawnedSshArgs(alias, remote, options), {
        shell: false,
        windowsHide: true,
        env: { ...process.env, PATH: augmentedPath() },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error));
      reject(commandFailure(`SSH could not start: ${cause.message}`, spawnErrorCode(cause)));
      return;
    }

    const stdout = { value: "", size: 0 };
    const stderr = { value: "", size: 0 };
    let settled = false;
    let timedOut = false;
    let outputExceeded = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {}
      killTimer = setTimeout(() => {
        if (settled) return;
        try {
          child.kill("SIGKILL");
        } catch {}
        settleReject(new ExistingVmError("timeout", "SSH command timed out"));
      }, MCP_CLOSE_GRACE_MS);
      killTimer.unref?.();
    }, options.sshTimeoutMs ?? PROBE_TIMEOUT_MS);
    timeout.unref?.();

    const clearTimers = () => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
    };
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      clearTimers();
      finish();
    };
    const settleReject = (error: Error) => settle(() => reject(error));

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (settled || outputExceeded) return;
      try {
        collectBounded(stdout, chunk);
      } catch {
        outputExceeded = true;
        settleReject(new ExistingVmError("mcp", "SSH probe output exceeded its limit"));
        try {
          child.kill("SIGKILL");
        } catch {}
      }
    });
    child.stderr.on("data", (chunk: string) => {
      if (settled || outputExceeded) return;
      try {
        collectBounded(stderr, chunk);
      } catch {
        outputExceeded = true;
        settleReject(new ExistingVmError("mcp", "SSH probe output exceeded its limit"));
        try {
          child.kill("SIGKILL");
        } catch {}
      }
    });
    child.stdin.on("error", () => {});
    child.on("error", (error) => {
      settleReject(commandFailure(`SSH could not start: ${error.message}`, spawnErrorCode(error)));
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      if (timedOut) {
        settleReject(new ExistingVmError("timeout", "SSH command timed out"));
        return;
      }
      if (code !== 0) {
        const detail = stderr.value.trim().slice(-800);
        settleReject(commandFailure(detail || `SSH exited ${code ?? signal ?? "without a status"}`, "SSH_EXIT", stderr.value));
        return;
      }
      settle(() => resolve({ stdout: stdout.value, stderr: stderr.value }));
    });
    try {
      child.stdin.end();
    } catch (error) {
      settleReject(commandFailure(`SSH stdin failed: ${error instanceof Error ? error.message : String(error)}`));
    }
  });
}

class ExistingVmMcpClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, { resolve: (value: JsonValue) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly exited: Promise<void>;
  private buffer = "";
  private nextId = 1;
  private closed = false;
  private stderr = "";
  private closePromise: Promise<void> | null = null;

  constructor(alias: string, options: ExistingVmOptions = {}) {
    const { sshCommand = TEST_SSH_COMMAND ?? SSH_COMMAND } = options;
    this.child = spawn(sshCommand, spawnedSshArgs(alias, ["cua-driver", "mcp"], options), {
      shell: false,
      windowsHide: true,
      env: { ...process.env, PATH: augmentedPath() },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.exited = new Promise((resolve) => this.child.once("close", () => resolve()));
    this.child.stdin.on("error", () => {});
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.read(chunk, options.mcpLineLimit ?? MAX_MCP_LINE_CHARS));
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-4_096);
    });
    this.child.on("error", (error) => this.fail(new ExistingVmError(
      spawnErrorCode(error) === "ENOENT" ? "ssh-missing" : "mcp",
      spawnErrorCode(error) === "ENOENT"
        ? "OpenSSH (ssh) is not installed or is not available in PATH on the computer running OpenMausBot"
        : `SSH MCP transport could not start: ${error.message}`,
    )));
    this.child.on("close", (code, signal) => {
      this.closed = true;
      const detail = this.stderr.trim();
      this.fail(
        new ExistingVmError(
          "mcp",
          detail || `SSH MCP transport exited ${code ?? signal ?? "without a status"}`,
        ),
      );
    });
  }

  isClosed(): boolean {
    return this.closed;
  }

  private read(chunk: string, lineLimit: number): void {
    if (this.closed) return;
    this.buffer += chunk;
    const failOutputLimit = () => {
      this.buffer = "";
      this.closed = true;
      this.fail(new ExistingVmError("mcp", "CUA MCP response exceeded its output limit"));
      void this.close().catch(() => {});
    };
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      const rawLine = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (rawLine.length > lineLimit) {
        failOutputLimit();
        return;
      }
      const line = rawLine.trim();
      if (!line) continue;
      let message: JsonRpcResponse;
      try {
        const parsed: JsonValue = JSON.parse(line);
        if (!isJsonObject(parsed)) throw new Error("not an object");
        message = {};
        if (isJsonNumber(parsed.id)) message.id = parsed.id;
        if (parsed.result !== undefined) message.result = parsed.result;
        if (isJsonObject(parsed.error)) message.error = { message: parsed.error.message };
      } catch {
        this.fail(new ExistingVmError("mcp", "CUA MCP returned invalid JSON"));
        return;
      }
      if (message.id === undefined) continue;
      const waiting = this.pending.get(message.id);
      if (!waiting) continue;
      this.pending.delete(message.id);
      clearTimeout(waiting.timer);
      if (message.error) {
        waiting.reject(new ExistingVmError("mcp", String(message.error.message ?? "CUA MCP request failed")));
      } else {
        waiting.resolve(message.result ?? null);
      }
    }
    if (this.buffer.length > lineLimit) failOutputLimit();
  }

  private fail(error: Error): void {
    for (const [id, waiting] of this.pending) {
      this.pending.delete(id);
      clearTimeout(waiting.timer);
      waiting.reject(error);
    }
  }

  request(method: string, params: JsonObject, timeoutMs = MCP_REQUEST_TIMEOUT_MS): Promise<JsonValue> {
    if (this.closed) return Promise.reject(new ExistingVmError("mcp", "CUA MCP transport is closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ExistingVmError("timeout", `CUA MCP ${method} timed out`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new ExistingVmError("mcp", `CUA MCP request failed: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  }

  notify(method: string, params: JsonObject = {}): void {
    if (this.closed) return;
    try {
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    } catch {
      // The request that follows reports the closed transport to the caller.
    }
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      if (!this.closed) {
        try {
          this.child.stdin.end();
        } catch {}
        await Promise.race([this.exited, delay(MCP_CLOSE_GRACE_MS)]);
      }
      if (this.child.exitCode === null && this.child.signalCode === null) {
        try {
          this.child.kill("SIGTERM");
        } catch {}
        await Promise.race([this.exited, delay(500)]);
      }
      if (this.child.exitCode === null && this.child.signalCode === null) {
        try {
          this.child.kill("SIGKILL");
        } catch {}
      }
      this.closed = true;
      this.fail(new ExistingVmError("mcp", "CUA MCP transport closed"));
    })();
    return this.closePromise;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function isImageContent(value: JsonValue): value is { type: "image"; data: string; mimeType?: string } {
  return isJsonObject(value) && value.type === "image" && isJsonString(value.data) &&
    (value.mimeType === undefined || isJsonString(value.mimeType));
}

function desktopImage(result: JsonValue): DesktopImage {
  const content = isJsonObject(result) && Array.isArray(result.content) ? result.content : [];
  if (isJsonObject(result) && result.isError === true) {
    const first = content[0];
    const message = isJsonObject(first) && isJsonString(first.text)
      ? first.text
      : "get_desktop_state reported an error";
    throw new ExistingVmError("desktop", message);
  }
  const image = content.find(isImageContent);
  if (!image) throw new ExistingVmError("desktop", "get_desktop_state returned no desktop image");
  const bytes = Buffer.from(image.data, "base64");
  const checked = wholeScreenshot(bytes);
  if (!checked.ok) throw new ExistingVmError("desktop", "get_desktop_state returned an incomplete desktop image");
  return { png: image.data, format: checked.mime === "image/jpeg" ? "jpeg" : "png" };
}

async function runMcpProbe(
  alias: string,
  options: ExistingVmOptions,
): Promise<{ tools: string[]; screenshot: { png: string; format: "png" | "jpeg" } }> {
  const client = new ExistingVmMcpClient(alias, options);
  try {
    const tools = await initializeMcpClient(client);
    const result = await client.request(
      "tools/call",
      { name: "get_desktop_state", arguments: {} },
      SCREENSHOT_TIMEOUT_MS,
    );
    return { tools, screenshot: desktopImage(result) };
  } finally {
    await client.close();
  }
}

async function initializeMcpClient(client: ExistingVmMcpClient): Promise<string[]> {
  const initialized = await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "openmausbot-existing-vm", version: "1" },
    });
  if (!isJsonObject(initialized) || !isJsonString(initialized.protocolVersion)) {
    throw new ExistingVmError("mcp", "CUA MCP initialize returned an invalid response");
  }
  client.notify("notifications/initialized");
  const listed = await client.request("tools/list", {});
  const tools = isJsonObject(listed) && Array.isArray(listed.tools)
    ? listed.tools.flatMap((tool) => isJsonObject(tool) && isJsonString(tool.name) ? [tool.name] : [])
    : [];
  const missing = EXISTING_VM_REQUIRED_TOOLS.filter((name) => !tools.includes(name));
  if (missing.length) throw new ExistingVmError("mcp", `CUA MCP is missing required tools: ${missing.join(", ")}`);
  return tools;
}

type ExistingVmScreenshotSession = {
  client: ExistingVmMcpClient;
  initialized: Promise<string[]>;
  tail: Promise<void>;
  idleTimer: ReturnType<typeof setTimeout> | null;
};

const screenshotSessions = new Map<string, ExistingVmScreenshotSession>();

function discardScreenshotSession(alias: string, session: ExistingVmScreenshotSession): void {
  if (screenshotSessions.get(alias) !== session) return;
  screenshotSessions.delete(alias);
  if (session.idleTimer) clearTimeout(session.idleTimer);
  void session.client.close().catch(() => {});
}

function armScreenshotSessionIdle(alias: string, session: ExistingVmScreenshotSession, idleMs: number): void {
  if (session.idleTimer) clearTimeout(session.idleTimer);
  session.idleTimer = setTimeout(() => {
    if (screenshotSessions.get(alias) !== session) return;
    discardScreenshotSession(alias, session);
  }, idleMs);
  session.idleTimer.unref?.();
}

function screenshotSessionFor(alias: string, options: ExistingVmOptions): ExistingVmScreenshotSession {
  const current = screenshotSessions.get(alias);
  if (current && !current.client.isClosed()) return current;
  if (current) discardScreenshotSession(alias, current);
  const client = new ExistingVmMcpClient(alias, options);
  const session = {
    client,
    initialized: Promise.resolve<string[]>([]),
    tail: Promise.resolve(),
    idleTimer: null,
  } satisfies ExistingVmScreenshotSession;
  session.initialized = initializeMcpClient(client).catch((error) => {
    discardScreenshotSession(alias, session);
    throw error;
  });
  screenshotSessions.set(alias, session);
  return session;
}

async function screenshotFromSession(alias: string, options: ExistingVmOptions): Promise<{ png: string; format: "png" | "jpeg" }> {
  const session = screenshotSessionFor(alias, options);
  const operation = session.tail.then(async () => {
    await session.initialized;
    const result = await session.client.request(
      "tools/call",
      { name: "get_desktop_state", arguments: {} },
      SCREENSHOT_TIMEOUT_MS,
    );
    armScreenshotSessionIdle(alias, session, options.screenshotSessionIdleMs ?? SCREENSHOT_SESSION_IDLE_MS);
    return desktopImage(result);
  });
  session.tail = operation.then(() => undefined, () => undefined);
  try {
    return await operation;
  } catch (error) {
    discardScreenshotSession(alias, session);
    throw error;
  }
}

export function closeExistingVmScreenshotSessions(): void {
  for (const [alias, session] of screenshotSessions) discardScreenshotSession(alias, session);
}

function emptyStatus(alias: string | null): ExistingVmStatus {
  return {
    source: "existing",
    configured: Boolean(alias),
    sshAlias: alias,
    ssh: alias ? "unreachable" : "not-configured",
    os: "unknown",
    driver: "unknown",
    mcp: "unknown",
    tools: [],
    desktopReady: false,
    ready: false,
    problem: alias
      ? "SSH could not reach the Existing VM"
      : "Configure an SSH config alias for the Existing VM in App Settings → Local VM",
    errorCode: alias ? "ssh-unreachable" : "not-configured",
    driver_version: CUA_DRIVER_VERSION,
    viewer_url: "",
    watch_only: true,
  };
}

function safeDetail(error: Error, alias: string): string {
  const message = error.message;
  return message
    .replaceAll(alias, "the configured SSH host")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

async function computeStatus(cfg: AppConfig, options: ExistingVmOptions): Promise<ExistingVmStatus> {
  const alias = localVmSshAlias(cfg);
  const status = emptyStatus(alias);
  if (!alias) return status;

  try {
    const os = await runSshCommand(alias, ["uname", "-s"], options);
    status.ssh = "connected";
    if (os.stdout.trim() !== "Linux") {
      status.os = "unsupported";
      status.errorCode = "remote-os";
      status.problem = `Existing VM requires a Linux guest; SSH reported ${os.stdout.trim().slice(0, 80) || "an unknown OS"}`;
      return status;
    }
    status.os = "linux";
  } catch (error) {
    const cause = error instanceof Error ? error : new Error(String(error));
    const missingSsh = spawnErrorCode(cause) === "ENOENT";
    const timedOut = cause instanceof ExistingVmError && cause.code === "timeout";
    status.ssh = "unreachable";
    status.errorCode = timedOut ? "timeout" : missingSsh ? "ssh-missing" : "ssh-unreachable";
    status.problem = timedOut
      ? "SSH timed out while reaching the Existing VM"
      : missingSsh
        ? "OpenSSH (ssh) is not installed or is not available in PATH on the computer running OpenMausBot"
        : "SSH could not reach the Existing VM; check the alias, host key, and SSH agent";
    return status;
  }

  let version: CommandResult;
  try {
    version = await runSshCommand(alias, ["cua-driver", "--version"], options);
  } catch (error) {
    const cause = error instanceof Error ? error : new Error(String(error));
    const detail = safeDetail(cause, alias);
    status.driver = "missing";
    status.errorCode = "cua-missing";
    status.problem = `CUA Driver is missing or unavailable on the Existing VM${detail ? `: ${detail}` : ""}`;
    return status;
  }
  const match = /^cua-driver\s+([^\s]+)$/m.exec(version.stdout.trim());
  if (!match || match[1] !== CUA_DRIVER_VERSION) {
    status.driver = "incompatible";
    status.errorCode = "cua-version";
    status.problem = `Existing VM needs CUA Driver ${CUA_DRIVER_VERSION}; found ${match?.[1] ?? "an unknown version"}`;
    return status;
  }
  status.driver = "compatible";

  try {
    const probe = await runMcpProbe(alias, options);
    status.mcp = "ready";
    status.tools = probe.tools;
    status.desktopReady = true;
    status.ready = true;
    status.problem = null;
    status.errorCode = null;
  } catch (error) {
    const code = error instanceof ExistingVmError ? error.code : "mcp";
    const detail = error instanceof Error ? safeDetail(error, alias) : "";
    status.mcp = "failed";
    status.errorCode = code;
    status.problem = code === "desktop"
      ? `SSH reached CUA Driver, but it could not reach the graphical desktop${detail ? `: ${detail}` : ""}`
      : `SSH-launched CUA MCP transport failed${detail ? `: ${detail}` : ""}`;
  }
  return status;
}

const statusCache = new Map<string, { status: ExistingVmStatus; expiresAt: number }>();
const statusInFlight = new Map<string, Promise<ExistingVmStatus>>();

export async function existingVmStatus(
  cfg: AppConfig,
  options: ExistingVmOptions = {},
): Promise<ExistingVmStatus> {
  const alias = localVmSshAlias(cfg);
  if (!alias) return emptyStatus(null);
  const cacheable = !options.sshCommand || options.cacheStatus === true;
  if (options.force) statusCache.delete(alias);
  if (cacheable) {
    const inFlight = statusInFlight.get(alias);
    if (inFlight) return inFlight;
    if (!options.force) {
      const cached = statusCache.get(alias);
      if (cached && cached.expiresAt > Date.now()) return cached.status;
    }
  }
  const promise = computeStatus(cfg, options);
  if (!cacheable) return promise;
  statusInFlight.set(alias, promise);
  try {
    const status = await promise;
    statusCache.set(alias, { status, expiresAt: Date.now() + STATUS_CACHE_TTL_MS });
    return status;
  } finally {
    if (statusInFlight.get(alias) === promise) statusInFlight.delete(alias);
  }
}

export async function existingVmScreenshot(
  cfg: AppConfig,
  options: ExistingVmOptions = {},
): Promise<{ png: string; format: "png" | "jpeg" }> {
  const status = await existingVmStatus(cfg, options);
  const alias = status.sshAlias;
  if (!alias || !status.ready) {
    throw Object.assign(new Error(status.problem ?? "The Existing VM is not ready"), { status: 409 });
  }
  try {
    return await screenshotFromSession(alias, options);
  } catch (error) {
    if (!options.sshCommand) statusCache.delete(alias);
    const detail = error instanceof Error ? safeDetail(error, alias) : "";
    throw Object.assign(new Error(detail || "The Existing VM did not return a valid desktop image"), {
      status: error instanceof ExistingVmError && error.code === "timeout" ? 504 : 502,
    });
  }
}

export function existingVmComputerMcp(
  cfg: AppConfig,
  control?: { url: string; token: string },
): ExistingVmComputerMcp {
  const alias = localVmSshAlias(cfg);
  if (!alias) throw new Error("Existing VM is not configured — add an SSH config alias first");
  const env: ExistingVmEnvironment = { ELECTRON_RUN_AS_NODE: "1" };
  if (control) {
    env.OMB_CONTROL_URL = control.url;
    env.OMB_CONTROL_TOKEN = control.token;
  }
  return {
    command: process.execPath,
    args: [SPAWNED_PROXIES.existingVmMcp, alias],
    env,
  };
}
