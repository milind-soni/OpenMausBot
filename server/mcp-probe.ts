import { APP_EXTENSION_KEY } from "../shared/app.ts";
import { augmentedPath } from "./env-path.ts";
import {
  PROVIDER_CREDENTIAL_ENV,
  stripWorkspaceCredentialEnv,
} from "./config.ts";
import { createLineSplitter } from "./mcp-bridge.ts";
import { UI_EXTENSION, withUiExtension } from "./mcp-app-observer.ts";
import { MAX_REMOTE_MCP_BYTES, McpHttpError, McpRpcError, REMOTE_MCP_STARTUP_MS, RemoteMcpClient } from "./mcp-http.ts";
import { discoverMcpAuth } from "./mcp-oauth-discovery.ts";
import { isRemoteMcpServer, type StoredMcpServer, type StoredRemoteMcpServer, type StoredStdioMcpServer } from "./mcp-registry.ts";
import { killCliTree, spawnCli } from "./procs.ts";

export interface McpProbeTool {
  name: string;
  description?: string;
}

/** Why a test failed, when the person can act on it: `keys` the server refused the headers it was sent (HTTP 401 or 403
 * with no sign-in to offer, or an MCP "unauthorized" error); `unreachable` and `timeout` may pass on a second try. */
export type McpProbeFailure = "keys" | "unreachable" | "timeout";

export type McpProbeResult =
  | { ok: true; tools: McpProbeTool[]; total?: number }
  /** `auth: "required"`: the server wants a sign-in. Either it refused initialize or tools/list with HTTP 401 and offers
   * OAuth, or it listed tools for a caller with no credentials and refused a tool call with HTTP 401 from behind an
   * RFC 9728 protected-resource document. */
  | { ok: false; error: string; auth?: "required"; reason?: McpProbeFailure; status?: number };

export const SIGN_IN_REQUIRED = "This server needs you to sign in.";
/** A tool name no server defines, so calling it runs nothing and the answer says only whether tool calls need a sign-in.
 * Observed 2026-10-31: mcp.agentcard.sh answers it HTTP 401 with `resource_metadata`; huggingface.co/mcp, whose sign-in is
 * optional and which also serves an RFC 9728 document, answers JSON-RPC -32602 "not found". Observed 2026-11-09:
 * gmailmcp.googleapis.com lists its tools to anyone and answers this name -32602 as well, but refuses every real tool with
 * HTTP 401, so a server that answers this name is asked again with one of its own tools (`harmlessListedTool`). */
export const SIGN_IN_CHECK_TOOL = "openmausbot.sign-in-check";
const SIGN_IN_CHECK_MS = 5_000;
const DISCOVERY_MS = 5_000;
/** How MCP servers word a refused key in a JSON-RPC error when they answer it with HTTP 200. */
const UNAUTHORIZED = /unauthori[sz]ed|forbidden|not authenticated|authentication (?:failed|required)|invalid (?:api[ _-]?)?(?:key|token|credentials)/i;

export interface McpProbeOptions {
  extension?: boolean;
  observe?(info: { tools: unknown[]; uiExtension: "ok" | "refused" | "unknown" }): void;
  /** Start a command server as a bot's turn would: in the bot box where turns are boxed, its configured environment
   * passing the box's allow-list, from the bot's own folder when the server is one bot's (`id`). */
  asBot?: { id?: string; cwd?: string };
  /** Reach a URL server as a bot's turn does: at `url` with `fetch` and no headers of its own (the credential broker adds
   * them, server/bot-box/broker-probe.ts). A sign-in is still looked for at the server's own address. */
  via?: { url: string; fetch: typeof fetch };
  /** Someone asked for this test: a server that answers the unknown tool may be asked once more with a real read-only tool.
   * Background checks never call a real tool. */
  tryReadOnlyTool?: boolean;
}

const MAX_STDOUT_BYTES = MAX_REMOTE_MCP_BYTES;
const MAX_TOOLS = 100;
export const STDIO_PROBE_TIMEOUT_MS = 8_000;
export const REMOTE_PROBE_TIMEOUT_MS = REMOTE_MCP_STARTUP_MS;

export function probeEnvironment(server: Pick<StoredStdioMcpServer, "env">): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: augmentedPath() };
  stripWorkspaceCredentialEnv(env);
  for (const key of PROVIDER_CREDENTIAL_ENV) delete env[key];
  Object.assign(env, server.env);
  return env;
}

function publicProbeError(kind: "spawn" | "timeout" | "protocol" | "closed" | "cancelled"): string {
  if (kind === "spawn") return "Could not start this command. Check that it is installed and executable.";
  if (kind === "timeout") return "The server did not answer in time.";
  if (kind === "closed") return "The server stopped before the MCP handshake finished.";
  if (kind === "cancelled") return "Connection test was cancelled.";
  return "The command did not return a valid MCP tools list.";
}

function redactConfiguredValues(value: string, secrets: Record<string, string>): string {
  const alternatives = [...new Set(Object.values(secrets))].filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .map((secret) => secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return alternatives.length ? value.replace(new RegExp(alternatives.join("|"), "g"), "[redacted]") : value;
}

/** Bounded and redacted: `secrets` are configured values a careless server might echo. */
function publicTools(raw: unknown[], secrets: Record<string, string>): { tools: McpProbeTool[]; total?: number } {
  const named = raw.filter((entry): entry is Record<string, unknown> =>
    !!entry && typeof entry === "object" && typeof (entry as { name?: unknown }).name === "string" && !!(entry as { name: string }).name.trim());
  const tools = named.slice(0, MAX_TOOLS).map((candidate) => ({
    name: redactConfiguredValues(candidate.name as string, secrets).slice(0, 200),
    ...(typeof candidate.description === "string"
      ? { description: redactConfiguredValues(candidate.description, secrets).slice(0, 500) }
      : {}),
  }));
  return named.length > tools.length ? { tools, total: named.length } : { tools };
}

/** Never returns what the renderer must not see: child stderr, environment values, header values. */
export function probeMcpServer(
  server: StoredMcpServer,
  timeoutMs?: number,
  signal?: AbortSignal,
  options: McpProbeOptions = {},
): Promise<McpProbeResult> {
  return isRemoteMcpServer(server)
    ? probeRemoteMcpServer(server, timeoutMs ?? REMOTE_PROBE_TIMEOUT_MS, signal, options)
    : probeStdioMcpServer(server, timeoutMs ?? STDIO_PROBE_TIMEOUT_MS, signal, options);
}

function observeProbe(options: McpProbeOptions, tools: unknown[], uiExtension: "ok" | "refused" | "unknown"): void {
  try { options.observe?.({ tools, uiExtension }); } catch {}
}

/** True when the probe carries any header value. On the `via` path the broker adds exactly these headers. Personal entries
 * store "" placeholders, so an empty value is no credential. */
export function sendsCredentials(server: Pick<StoredRemoteMcpServer, "headers">): boolean {
  return Object.values(server.headers).some((value) => value !== "");
}

/** Which request the server refused with HTTP 401. */
type RefusedAt = "connect" | "call";

/** Whether a 401 asks for a sign-in rather than for keys. `connect`: any OAuth metadata counts (a server that refuses
 * initialize is unusable without a sign-in). `call`: only metadata an RFC 9728 protected-resource document led to, since
 * discovery's origin fallback would flag any host that merely serves openid-configuration. `url` is the server's own
 * address, never the broker's. */
async function asksForSignIn(url: string, refusal: McpHttpError, at: RefusedAt, signal?: AbortSignal): Promise<boolean> {
  const bound = AbortSignal.timeout(DISCOVERY_MS);
  const meta = await discoverMcpAuth(url, refusal.wwwAuthenticate ?? null, { signal: signal ? AbortSignal.any([signal, bound]) : bound })
    .catch(() => null);
  return meta !== null && (at === "connect" || meta.source === "protected-resource");
}

/** A tool the server itself marks read-only and not destructive, and that cannot run without arguments: called with none, so
 * a server that checks arguments before it runs anything runs nothing, and any other at worst does one read. */
export function harmlessListedTool(listed: unknown[]): string | undefined {
  for (const entry of listed) {
    const tool = entry as { name?: unknown; annotations?: { readOnlyHint?: unknown; destructiveHint?: unknown }; inputSchema?: { required?: unknown } } | null;
    if (typeof tool?.name !== "string" || !tool.name || tool.annotations?.readOnlyHint !== true || tool.annotations.destructiveHint === true) continue;
    if (Array.isArray(tool.inputSchema?.required) && tool.inputSchema.required.length > 0) return tool.name;
  }
  return undefined;
}

/** `sign-in`: an HTTP 401 behind a protected-resource document. `answered`: the server replied at the MCP level, without
 * asking who was calling. `unclear`: anything else (another status, a timeout, a network failure). */
async function signInCheck(client: RemoteMcpClient, url: string, name: string, signal: AbortSignal): Promise<"sign-in" | "answered" | "unclear"> {
  try {
    await client.request("tools/call", { name, arguments: {} }, AbortSignal.any([signal, AbortSignal.timeout(SIGN_IN_CHECK_MS)]));
    return "answered";
  } catch (error) {
    if (error instanceof McpRpcError) return "answered";
    return error instanceof McpHttpError && error.kind === "status" && error.status === 401 && await asksForSignIn(url, error, "call", signal) ? "sign-in" : "unclear";
  }
}

/** After a tools/list that carried no credentials: do tool calls need a sign-in? One call of SIGN_IN_CHECK_TOOL through the
 * same client, and when the server answers that without asking who is calling and `tryReadOnly` is set, one call of a
 * harmless tool of its own. Only HTTP 401 behind a protected-resource document means yes; any other answer, a timeout or a
 * network failure keeps the verdict Connected. A server that really lists the check's name is never called. */
async function callsNeedSignIn(client: RemoteMcpClient, url: string, listed: unknown[], signal: AbortSignal, tryReadOnly: boolean): Promise<boolean> {
  if (listed.some((tool) => (tool as { name?: unknown } | null)?.name === SIGN_IN_CHECK_TOOL)) return false;
  const unknownTool = await signInCheck(client, url, SIGN_IN_CHECK_TOOL, signal);
  if (unknownTool !== "answered" || !tryReadOnly) return unknownTool === "sign-in";
  const real = harmlessListedTool(listed);
  return real !== undefined && await signInCheck(client, url, real, signal) === "sign-in";
}

async function probeRemoteMcpServer(
  server: StoredRemoteMcpServer,
  timeoutMs: number,
  signal?: AbortSignal,
  options: McpProbeOptions = {},
): Promise<McpProbeResult> {
  if (signal?.aborted) return { ok: false, error: publicProbeError("cancelled") };
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
  const client = options.via
    ? new RemoteMcpClient({ ...server, url: options.via.url, headers: {} }, { maxBytes: MAX_REMOTE_MCP_BYTES, fetch: options.via.fetch })
    : new RemoteMcpClient(server, { maxBytes: MAX_REMOTE_MCP_BYTES });
  try {
    await client.initialize("OpenMausBot", combined, options.extension ? { extensions: { [APP_EXTENSION_KEY]: UI_EXTENSION } } : {});
    const result = await client.request("tools/list", {}, combined);
    const tools = result && typeof result === "object" ? (result as { tools?: unknown }).tools : undefined;
    if (!Array.isArray(tools)) return { ok: false, error: "The server did not return a valid MCP tools list." };
    observeProbe(options, tools, client.extensions ?? "unknown");
    if (!sendsCredentials(server) && await callsNeedSignIn(client, server.url, tools, combined, options.tryReadOnlyTool === true)) {
      return { ok: false, auth: "required", error: SIGN_IN_REQUIRED };
    }
    const secrets = server.oauth?.clientSecret ? { ...server.headers, "oauth.clientSecret": server.oauth.clientSecret } : server.headers;
    return { ok: true, ...publicTools(tools, secrets) };
  } catch (error) {
    if (signal?.aborted) return { ok: false, error: publicProbeError("cancelled") };
    if (timeout.signal.aborted) return { ok: false, error: publicProbeError("timeout"), reason: "timeout" };
    if (error instanceof McpHttpError && error.status === 401 && await asksForSignIn(server.url, error, "connect", signal)) {
      return { ok: false, auth: "required", error: SIGN_IN_REQUIRED };
    }
    if (error instanceof McpHttpError && error.kind === "status" && (error.status === 401 || error.status === 403)) {
      return { ok: false, error: `The server didn't accept the keys (HTTP ${error.status}). Check the header values.`, reason: "keys", status: error.status };
    }
    if (error instanceof McpRpcError && UNAUTHORIZED.test(error.detail)) {
      return { ok: false, error: "The server didn't accept the keys. Check the header values.", reason: "keys" };
    }
    if (error instanceof McpHttpError && error.kind === "status") {
      return { ok: false, error: `The server answered HTTP ${error.status}. Check the address and headers.`, ...(error.status !== undefined && error.status >= 500 ? { reason: "unreachable" as const } : {}) };
    }
    if (error instanceof McpHttpError && error.kind === "protocol") {
      return { ok: false, error: "The server did not return a valid MCP tools list." };
    }
    return { ok: false, error: "Could not reach this address. Check the URL and your network.", reason: "unreachable" };
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => {});
  }
}

const INITIALIZE = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "OpenMausBot", version: "probe" } };

/** Always reaped, never inherits OpenMaus credentials. */
function probeStdioMcpServer(
  server: StoredStdioMcpServer,
  timeoutMs: number,
  signal?: AbortSignal,
  options: McpProbeOptions = {},
): Promise<McpProbeResult> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ ok: false, error: publicProbeError("cancelled") });
      return;
    }

    let child: ReturnType<typeof spawnCli>;
    try {
      child = spawnCli(server.command, server.args, {
        ...(options.asBot ? (options.asBot.cwd ? { cwd: options.asBot.cwd } : {}) : { cwd: process.cwd() }),
        env: probeEnvironment(server),
        stdio: ["pipe", "pipe", "pipe"],
        ...(options.asBot ? { box: { ...(options.asBot.id ? { botId: options.asBot.id } : {}), allowEnv: Object.keys(server.env), configured: true } } : {}),
      });
    } catch {
      resolve({ ok: false, error: publicProbeError("spawn") });
      return;
    }

    let settled = false;
    let stdoutBytes = 0;
    let initialized = false;
    let uiExtension: "ok" | "refused" | "unknown" = options.extension ? "ok" : "unknown";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => finish({ ok: false, error: publicProbeError("cancelled") });
    const finish = (result: McpProbeResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      killCliTree(child);
      resolve(result);
    };
    const write = (frame: unknown) => {
      try {
        child.stdin.write(`${JSON.stringify(frame)}\n`);
      } catch {
        finish({ ok: false, error: publicProbeError("closed") });
      }
    };
    const splitter = createLineSplitter((line) => {
      if (settled || !line.trim()) return;
      let frame: unknown;
      try {
        frame = JSON.parse(line);
      } catch {
        return;
      }
      if (!frame || typeof frame !== "object") return;
      const value = frame as Record<string, unknown>;
      if (value.id === 1 && value.error !== undefined && options.extension && !initialized && uiExtension === "ok") {
        uiExtension = "refused";
        write({ jsonrpc: "2.0", id: 3, method: "initialize", params: INITIALIZE });
        return;
      }
      if ((value.id === 1 || (value.id === 3 && uiExtension === "refused")) && value.result && !initialized) {
        initialized = true;
        write({ jsonrpc: "2.0", method: "notifications/initialized" });
        write({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
        return;
      }
      if (value.id !== 2) return;
      const result = value.result as { tools?: unknown } | undefined;
      if (!Array.isArray(result?.tools)) {
        finish({ ok: false, error: publicProbeError("protocol") });
        return;
      }
      observeProbe(options, result.tools, uiExtension);
      finish({ ok: true, ...publicTools(result.tools, server.env) });
    });

    timer = setTimeout(() => {
      finish({ ok: false, error: publicProbeError("timeout"), reason: "timeout" });
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        finish({ ok: false, error: publicProbeError("protocol") });
        return;
      }
      splitter.push(chunk);
    });
    // Drain without retaining: child stderr often contains secrets.
    child.stderr.resume();
    child.once("error", () => finish({ ok: false, error: publicProbeError("spawn") }));
    child.once("close", () => finish({ ok: false, error: publicProbeError("closed") }));

    if (signal?.aborted) {
      onAbort();
      return;
    }

    write({ jsonrpc: "2.0", id: 1, method: "initialize", params: options.extension ? withUiExtension(INITIALIZE) : INITIALIZE });
  });
}
