// Server: --url, --port, OPENMAUSBOT_URL or OMB_PORT, else the desktop ports. A credential never travels while a server
// is being looked for; it comes from OPENMAUSBOT_TOKEN or --token-file only (a command line leaks).
import { readFileSync } from "node:fs";

import { EXIT, flag, HeadlessError, usageError, type Flags } from "./args.ts";
import { BOT_SHELL_HINT } from "./bot-shell.ts";
import type { SavedServers } from "./saved-servers.ts";

type McpModule = typeof import("../../scripts/mcp-server.ts");
export type ToolCaller = McpModule["handleToolCall"];
export type Requester = McpModule["request"];
export type ToolHooks = Parameters<ToolCaller>[4];

export interface ClientDeps {
  env: NodeJS.ProcessEnv;
  /** control-omb: a verb that changes something never runs on a server it merely found. */
  requireExplicitForMutations?: boolean;
  callTool?: ToolCaller;
  request?: Requester;
  /** What `openmausbot login` saved; absent in a bot's shell, which never uses the person's sign-in. */
  saved?: SavedServers;
}

const DISCOVERY_PORTS = [8799, 18799, 28799];

let mcpModule: Promise<McpModule> | undefined;

export async function loadMcp(): Promise<McpModule> {
  mcpModule ??= import("../../scripts/mcp-server.ts");
  try {
    return await mcpModule;
  } catch (error) {
    mcpModule = undefined;
    throw usageError(`OPENMAUSBOT_URL is not usable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Who the requests go as: a token given for this command, a saved sign-in, or none (this computer, unsigned). */
export type ClientIdentity = { kind: "token" } | { kind: "saved"; name: string; label: string; scopes: string[]; expiresAt: number } | { kind: "none" };

export interface HeadlessClient {
  baseUrl: string;
  explicit: boolean;
  identity: ClientIdentity;
  json<T = any>(path: string, init?: RequestInit): Promise<T>;
  /** `stream` lifts the request timeout. */
  raw(path: string, init?: RequestInit & { stream?: boolean }): Promise<Response>;
  tool(name: string, args: Record<string, unknown>, hooks?: ToolHooks, signal?: AbortSignal): Promise<any>;
}

/** Never printed. */
export function readToken(flags: Flags, env: NodeJS.ProcessEnv): string | undefined {
  const file = flag(flags, "token-file");
  if (file !== undefined) {
    let token: string;
    try {
      token = readFileSync(file, "utf8").trim();
    } catch (error) {
      throw usageError(`--token-file ${file} could not be read (${(error as NodeJS.ErrnoException).code ?? "error"})`);
    }
    if (!token) throw usageError(`--token-file ${file} is empty`);
    return token;
  }
  return env.OPENMAUSBOT_TOKEN?.trim() || undefined;
}

export function namedServer(flags: Flags, env: NodeJS.ProcessEnv): { url: string } | { port: string } | undefined {
  const url = flag(flags, "url")?.trim();
  if (url) return { url };
  const port = flag(flags, "port")?.trim();
  if (port) return { port };
  if (env.OPENMAUSBOT_URL?.trim()) return { url: env.OPENMAUSBOT_URL.trim() };
  return env.OMB_PORT?.trim() ? { port: env.OMB_PORT.trim() } : undefined;
}

export async function openClient(flags: Flags, deps: ClientDeps, mutating: boolean): Promise<HeadlessClient> {
  const mcp = await loadMcp();
  let token = readToken(flags, deps.env);
  let identity: ClientIdentity = token ? { kind: "token" } : { kind: "none" };
  const named = namedServer(flags, deps.env);
  const current = !named && !token ? deps.saved?.current() ?? null : null;
  let baseUrl: string;
  if (current) {
    baseUrl = current.url;
  } else if (named && "url" in named) {
    try {
      baseUrl = mcp.validateBaseUrl(named.url);
    } catch (error) {
      throw usageError(error instanceof Error ? error.message : String(error));
    }
  } else if (named) {
    const port = Number(named.port);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw usageError("--port must be 1-65535");
    baseUrl = `http://127.0.0.1:${port}`;
  } else {
    if (mutating && deps.requireExplicitForMutations) {
      throw usageError("mutating commands require an explicit OpenMausBot instance", "start `control-omb launch`, then pass its URL with --url");
    }
    if (token) {
      throw usageError("a token needs a named server, so it is never sent while looking for one",
        "pass --url (or --port), or set OPENMAUSBOT_URL or OMB_PORT");
    }
    try {
      baseUrl = await mcp.probeBaseUrls(DISCOVERY_PORTS.map((port) => `http://127.0.0.1:${port}`));
    } catch {
      throw new HeadlessError(`no OpenMausBot server answered on 127.0.0.1 ports ${DISCOVERY_PORTS.join(", ")}`, EXIT.unreachable,
        "start one with `openmausbot serve`, or name one with --url or OPENMAUSBOT_URL");
    }
  }
  // A saved sign-in goes only to the exact address it was made at: the current server, or a named one that is the same.
  const signedIn = !token ? current ?? (named ? deps.saved?.at(baseUrl) ?? null : null) : null;
  const savedToken = signedIn ? deps.saved!.token(signedIn.name) : null;
  const request = deps.request ?? mcp.request;
  if (signedIn && savedToken) {
    // Another server can take the same port later (the app closed, `serve` started): the sign-in is not for it.
    const live = await request("/.well-known/openmausbot/environment", {}, baseUrl).catch(() => null) as { environmentId?: unknown } | null;
    if (typeof live?.environmentId === "string" && live.environmentId !== signedIn.environmentId) {
      throw new HeadlessError(`the server at ${baseUrl} is not "${signedIn.label}", the one you signed in to`, EXIT.needsLogin,
        "sign in to it with openmausbot login, or name another server with --url");
    }
    token = savedToken;
    identity = { kind: "saved", name: signedIn.name, label: signedIn.label, scopes: signedIn.scopes, expiresAt: signedIn.expiresAt };
  }
  const callTool = deps.callTool ?? mcp.handleToolCall;
  const withAuth = (init: RequestInit = {}): RequestInit => {
    if (!token) return init;
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    return { ...init, headers };
  };
  const fetcher = (path: string, init: RequestInit = {}) => request(path, withAuth(init), baseUrl);
  return {
    baseUrl,
    explicit: named !== undefined || current !== null,
    identity,
    json: (path, init) => fetcher(path, init),
    async raw(path, init = {}) {
      const { stream, ...rest } = init;
      const timeout = stream ? undefined : AbortSignal.timeout(60_000);
      const signal = rest.signal && timeout ? AbortSignal.any([rest.signal, timeout]) : rest.signal ?? timeout;
      return fetch(`${baseUrl}${path}`, { ...withAuth(rest), ...(signal ? { signal } : {}) });
    },
    tool: (name, args, hooks, signal) => callTool(name, args, fetcher, signal, hooks),
  };
}

export function serverWords(message: string): string {
  const body = /^OpenMausBot API error \(\d+\): ([\s\S]*)$/.exec(message)?.[1];
  if (body === undefined) return message;
  try {
    const said = (JSON.parse(body) as { error?: unknown }).error;
    return typeof said === "string" && said.trim() ? said.trim() : message;
  } catch {
    return message;
  }
}

/** What the command knew when the server refused it, for a hint that leads somewhere. */
export interface RefusalContext {
  botShell?: boolean;
  identity?: ClientIdentity;
}

function signInHint(context: RefusalContext): string {
  if (context.botShell) return BOT_SHELL_HINT;
  if (context.identity?.kind === "token") return "the token given was not accepted, or lacks the scope: make a new one with openmausbot token create";
  if (context.identity?.kind === "saved" && !context.identity.scopes.includes("admin")) {
    return "this sign-in is chat only: run openmausbot login again without --scope chat";
  }
  return "sign in once with `openmausbot login` (the app shows a card to allow it)";
}

export async function explain(error: unknown, baseUrl?: string, context: RefusalContext = {}): Promise<HeadlessError> {
  if (error instanceof HeadlessError) return error;
  const mcp = await loadMcp().catch(() => undefined);
  const raw = error instanceof Error ? error.message : String(error);
  const message = serverWords(raw);
  if (mcp && error instanceof mcp.ToolInputError) return usageError(message);
  const status = typeof (error as { status?: unknown })?.status === "number" ? (error as { status: number }).status : undefined;
  if (status === 401) {
    const said = context.identity?.kind === "saved" ? "your sign-in to this server ended" : context.identity?.kind === "token" ? "this server did not accept the token given" : "this server needs you signed in";
    return new HeadlessError(said, EXIT.needsLogin,
      context.botShell ? BOT_SHELL_HINT : context.identity?.kind === "token" ? signInHint(context) : "run `openmausbot login`");
  }
  if (status === 403) {
    const said = message === raw && /paired session token/.test(raw) ? "a change from a program on this computer needs you signed in" : message;
    const unsigned = !context.botShell && (context.identity === undefined || context.identity.kind === "none");
    return new HeadlessError(`not allowed: ${said.replace(/^forbidden: /, "")}`, unsigned ? EXIT.needsLogin : EXIT.notAllowed, signInHint(context));
  }
  if (status === 404 && /^no such (bot|channel|conversation|task|message)\b/i.test(message)) {
    return new HeadlessError(message, EXIT.notFound, "openmausbot bots and openmausbot channels list the ids");
  }
  if (status === 409) return new HeadlessError(message, EXIT.conflict, "it is busy: stop it first (openmausbot stop BOT), or try again when it finishes");
  if (/cannot report a conversation's job/.test(message)) return new HeadlessError(message, EXIT.unreachable, "update OpenMausBot on the server");
  const cause = (error as { cause?: { code?: unknown } })?.cause?.code;
  if ((error instanceof TypeError && /fetch failed/i.test(message)) || cause === "ECONNREFUSED" || cause === "ENOTFOUND"
    || (error instanceof Error && (error.name === "TimeoutError" || /timed out|aborted due to timeout/i.test(message)))) {
    return new HeadlessError(`cannot reach OpenMausBot${baseUrl ? ` at ${baseUrl}` : ""}`, EXIT.unreachable,
      "check the server is running and the address is right (openmausbot doctor)");
  }
  if (error instanceof Error && error.name === "AbortError") return new HeadlessError("stopped", EXIT.interrupted);
  return new HeadlessError(message, EXIT.failed);
}

export async function readJob(client: HeadlessClient, threadId: string, query: Record<string, string> = {}): Promise<Record<string, any>> {
  try {
    return await client.json(`/api/threads/${encodeURIComponent(threadId)}/job?${new URLSearchParams(query).toString()}`);
  } catch (error) {
    const status = (error as { status?: number }).status;
    const message = error instanceof Error ? error.message : String(error);
    if (status === 404 && !/no such conversation/.test(message)) {
      throw new HeadlessError("this OpenMausBot server cannot report a conversation's job", EXIT.unreachable, "update OpenMausBot on the server");
    }
    throw error;
  }
}
