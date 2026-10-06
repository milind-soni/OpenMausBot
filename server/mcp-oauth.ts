// OAuth sign-in for URL MCP servers, the way MCP clients do it: discover
// the authorization server from the MCP server's 401, sign in as the app
// the person registered for this server or else register as a public
// client when the server allows it, run PKCE through the person's browser
// with a loopback callback (or a URL pasted from another computer), then
// keep the tokens fresh.
// Engines never see this: they get an ordinary Authorization header.
//
// The loopback listener and callback checks follow
// drivers/chatgpt-plan-auth.ts: one pending sign-in per server, a state
// compared in constant time, single-valued parameters, and a listener that
// lives only until the sign-in settles.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";

import { MCP_OAUTH_CALLBACK_PATH, mcpOAuthRedirectPort, mcpOAuthRedirectUri } from "../shared/mcp-oauth-redirect.ts";
import type { McpServerSpec } from "./contracts.ts";
import { discoverMcpAuth, type McpAuthMetadata } from "./mcp-oauth-discovery.ts";
import { McpOAuthStore, type McpOAuthRecord, type McpOAuthTokens } from "./mcp-oauth-store.ts";
import type { McpOAuthClientConfig } from "./mcp-registry.ts";

export { mcpOAuthRedirectUri };

export type McpSignInPhase = "waiting" | "succeeded" | "failed" | "cancelled" | "expired";

export interface McpSignInStatus {
  phase: McpSignInPhase;
  flowId: string;
  authorizationUrl: string | null;
  expiresAt: string;
  message?: string;
}

export type McpOAuthFailure = "not-oauth" | "no-registration" | "port-busy";

export class McpOAuthError extends Error {
  readonly code: McpOAuthFailure;
  constructor(code: McpOAuthFailure, message: string) {
    super(message);
    this.name = "McpOAuthError";
    this.code = code;
  }
}

export type McpAuthState = "signed-in" | "needs-sign-in" | "none";

const DEFAULT_LIFETIME_MS = 5 * 60_000;
/** Refresh a token this close to expiry, so a turn never starts on one
 * that lapses mid-way. */
const REFRESH_MARGIN_MS = 2 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const CALLBACK_PATH = MCP_OAUTH_CALLBACK_PATH;
/** complete()'s answer for a flow that ended while its code was spent. */
const DISCARDED = "discarded";

interface Flow {
  owner: string;
  name: string;
  url: string;
  status: McpSignInStatus;
  state: string;
  verifier: string;
  redirectUri: string;
  client: ClientAuth;
  meta: McpAuthMetadata;
  server: Server;
  consumed: boolean;
  expiry: ReturnType<typeof setTimeout>;
}

interface StartingFlow {
  owner: string;
  url: string;
  cancelled: boolean;
  promise: Promise<McpSignInStatus>;
}

export class McpSignInError extends Error {
  readonly status: 400 | 404 | 409;
  constructor(message: string, status: 400 | 404 | 409) {
    super(message);
    this.status = status;
    this.name = "McpSignInError";
  }
}

/** A port derived from the server URL: the same redirect URI on every
 * attempt, so a registered client can be reused instead of re-registered. */
const preferredPort = mcpOAuthRedirectPort;

type TokenAuthMethod = "none" | "client_secret_post" | "client_secret_basic";

/** Who is asking at the token endpoint: a public client by its id, or an
 * app with a secret, sent the way the authorization server accepts it. */
interface ClientAuth {
  id: string;
  secret?: string;
  method: TokenAuthMethod;
}

/** RFC 8414 §2: an absent list means client_secret_basic. */
function tokenAuthMethod(meta: McpAuthMetadata, secret: string | undefined): TokenAuthMethod {
  if (!secret) return "none";
  const supported = meta.tokenEndpointAuthMethods;
  return !supported || supported.includes("client_secret_basic") || !supported.includes("client_secret_post")
    ? "client_secret_basic"
    : "client_secret_post";
}

/** RFC 6749 §2.3.1: Basic credentials are form-encoded first. */
const formEncoded = (value: string) => new URLSearchParams({ v: value }).toString().slice(2);

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function sameSecret(actual: string, expected: string): boolean {
  return Buffer.byteLength(actual) === Buffer.byteLength(expected) && timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

async function postForm(
  url: string,
  form: Record<string, string>,
  client?: ClientAuth,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  const fields = { ...form };
  if (client?.method === "client_secret_basic" && client.secret) {
    headers.authorization = `Basic ${Buffer.from(`${formEncoded(client.id)}:${formEncoded(client.secret)}`).toString("base64")}`;
  } else if (client) {
    fields.client_id = client.id;
    if (client.method === "client_secret_post" && client.secret) fields.client_secret = client.secret;
  }
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: new URLSearchParams(fields).toString(),
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await response.json();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch {
    // an empty or non-JSON body is judged by its status alone
  }
  return { status: response.status, body };
}

function tokensFrom(body: Record<string, unknown>, previous?: McpOAuthTokens): McpOAuthTokens | null {
  if (typeof body.access_token !== "string" || !body.access_token) return null;
  const refresh = typeof body.refresh_token === "string" && body.refresh_token ? body.refresh_token : previous?.refresh;
  return {
    access: body.access_token,
    ...(refresh ? { refresh } : {}),
    ...(typeof body.expires_in === "number" && body.expires_in > 0 ? { expiresAt: Date.now() + body.expires_in * 1000 } : {}),
    ...(typeof body.scope === "string" ? { scope: body.scope } : {}),
  };
}

export class McpOAuthManager {
  private readonly store: McpOAuthStore;
  private readonly lifetimeMs: number;
  private readonly isOwnerLive: (owner: string) => boolean;
  private readonly flows = new Map<string, Flow>();
  private readonly starting = new Map<string, StartingFlow>();
  private readonly refreshing = new Map<string, Promise<string | null>>();
  private readonly clients: (name: string, url: string) => McpOAuthClientConfig | undefined;

  /** `clients` reads the app registered for a server from its config, at
   * the moment it is needed: its secret is never copied into this store. */
  constructor(options: { file: string; lifetimeMs?: number; clients?: (name: string, url: string) => McpOAuthClientConfig | undefined; isOwnerLive?: (owner: string) => boolean }) {
    this.store = new McpOAuthStore(options.file);
    this.isOwnerLive = options.isOwnerLive ?? (() => true);
    this.lifetimeMs = options.lifetimeMs ?? DEFAULT_LIFETIME_MS;
    this.clients = options.clients ?? (() => undefined);
  }

  /** How to authenticate as the client a record was signed in with; null
   * when its app (or the app's secret) is no longer configured. */
  private recordClient(name: string, record: McpOAuthRecord): ClientAuth | null {
    if (!record.clientId) return null;
    if (!record.tokenAuth) return { id: record.clientId, method: "none" };
    const configured = this.clients(name, record.url);
    return configured?.clientId === record.clientId && configured.clientSecret
      ? { id: record.clientId, secret: configured.clientSecret, method: record.tokenAuth }
      : null;
  }

  authState(name: string, url: string): McpAuthState {
    const record = this.store.get(name, url);
    if (!record) return "none";
    return record.state === "signed-in" && record.tokens ? "signed-in" : "needs-sign-in";
  }

  /** The server answered 401 asking for OAuth: stop mounting it and show
   * Sign in. Any tokens it had are no longer accepted, so they go. */
  markNeedsSignIn(name: string, url: string): void {
    const { tokens: _dropped, ...rest } = this.store.get(name, url) ?? { url };
    this.store.put(name, { ...rest, url, state: "needs-sign-in" });
  }

  start(name: string, url: string, wwwAuthenticate?: string | null, owner = "loopback"): Promise<McpSignInStatus> {
    const current = this.flows.get(name);
    if (current?.status.phase === "waiting" && !this.isOwnerLive(current.owner)) {
      this.finish(current, "cancelled", "Your session ended. Start again.");
    }
    if (current?.status.phase === "waiting") {
      if (current.owner !== owner) return Promise.reject(new McpSignInError("A sign-in is already in progress in another browser.", 409));
      if (current.url === url) return Promise.resolve({ ...current.status });
    }
    const pending = this.starting.get(name);
    if (pending) {
      if (pending.owner !== owner || pending.url !== url || pending.cancelled) {
        return Promise.reject(new McpSignInError("A sign-in is still starting. Try again shortly.", 409));
      }
      return pending.promise;
    }
    const starting: StartingFlow = { owner, url, cancelled: false, promise: undefined! };
    starting.promise = this.begin(name, url, starting, wwwAuthenticate).finally(() => this.starting.delete(name));
    this.starting.set(name, starting);
    return starting.promise;
  }

  status(name: string, flowId: string, owner = "loopback"): McpSignInStatus | undefined {
    const flow = this.flows.get(name);
    return flow && flow.owner === owner && flow.status.flowId === flowId ? { ...flow.status } : undefined;
  }

  cancelFlow(name: string, owner: string, flowId?: string): void {
    const flow = this.flows.get(name);
    if (!flow || flow.owner !== owner || (flowId && flow.status.flowId !== flowId)) {
      throw new McpSignInError("This sign-in is no longer available in this browser. Start again.", 404);
    }
    this.finish(flow, "cancelled", "Sign-in cancelled.");
  }

  cancel(name: string): void {
    const pending = this.starting.get(name);
    if (pending) pending.cancelled = true;
    const flow = this.flows.get(name);
    if (flow) this.finish(flow, "cancelled", "Sign-in cancelled.");
  }

  revokeOwner(owner: string): void {
    for (const pending of this.starting.values()) if (pending.owner === owner) pending.cancelled = true;
    for (const flow of this.flows.values()) {
      if (flow.owner === owner) this.finish(flow, "cancelled", "Sign-in cancelled because your session ended.");
    }
  }

  /** Parse the pasted URL locally; never request a user-supplied address. */
  async completeCallback(name: string, flowId: string, callbackUrl: string, owner = "loopback"): Promise<McpSignInStatus> {
    const flow = this.flows.get(name);
    if (!flow || flow.owner !== owner || flow.status.flowId !== flowId) {
      throw new McpSignInError("This sign-in is no longer available in this browser. Start again.", 404);
    }
    let callback: URL;
    try {
      if (callbackUrl.length > 16_384) throw new Error("length");
      callback = new URL(callbackUrl);
    } catch {
      throw new McpSignInError("Paste the complete redirect URL from your browser's address bar.", 400);
    }
    await this.acceptCallback(flow, callback);
    return { ...flow.status };
  }

  /** Revoke with the server when it offers that (best effort), then forget. */
  async signOut(name: string, url: string): Promise<void> {
    this.cancel(name);
    const record = this.store.get(name, url);
    const token = record?.tokens?.refresh ?? record?.tokens?.access;
    if (record?.revocationEndpoint && token) {
      await postForm(record.revocationEndpoint, { token }, this.recordClient(name, record) ?? undefined).catch(() => undefined);
    }
    this.store.delete(name);
  }

  /** Drop everything for a server that was removed or pointed elsewhere. */
  forget(name: string): void {
    this.cancel(name);
    this.flows.delete(name);
    this.store.delete(name);
  }

  /** A usable access token for this server at this URL, refreshed when it
   * is close to expiry; null when the server needs a (new) sign-in. */
  accessToken(name: string, url: string): Promise<string | null> {
    const record = this.store.get(name, url);
    if (!record || record.state !== "signed-in" || !record.tokens) return Promise.resolve(null);
    const { tokens } = record;
    if (!tokens.expiresAt || tokens.expiresAt > Date.now() + REFRESH_MARGIN_MS) return Promise.resolve(tokens.access);
    const pending = this.refreshing.get(name);
    if (pending) return pending;
    const refreshed = this.refresh(name, record).finally(() => this.refreshing.delete(name));
    this.refreshing.set(name, refreshed);
    return refreshed;
  }

  dispose(): void {
    for (const pending of this.starting.values()) pending.cancelled = true;
    for (const flow of this.flows.values()) this.finish(flow, "cancelled", "Sign-in cancelled.");
    this.flows.clear();
  }

  private async refresh(name: string, record: McpOAuthRecord): Promise<string | null> {
    const tokens = record.tokens!;
    const stillValid = tokens.expiresAt !== undefined && tokens.expiresAt > Date.now();
    const client = this.recordClient(name, record);
    if (!tokens.refresh || !record.tokenEndpoint || !client) {
      if (stillValid) return tokens.access;
      this.markNeedsSignIn(name, record.url);
      return null;
    }
    let answer: Awaited<ReturnType<typeof postForm>>;
    try {
      answer = await postForm(record.tokenEndpoint, {
        grant_type: "refresh_token",
        refresh_token: tokens.refresh,
        resource: record.url,
      }, client);
    } catch {
      // offline or the server is down: keep what still works, retry next turn
      return stillValid ? tokens.access : null;
    }
    const next = answer.status >= 200 && answer.status < 300 ? tokensFrom(answer.body, tokens) : null;
    if (!next) {
      // Only a refused grant or client means the sign-in is over; a rate
      // limit, a proxy page or an outage keeps what still works.
      const dead = (answer.status === 400 || answer.status === 401)
        && (answer.body.error === "invalid_grant" || answer.body.error === "invalid_client");
      if (!dead) return stillValid ? tokens.access : null;
      this.markNeedsSignIn(name, record.url);
      return null;
    }
    // the entry may have been removed or re-pointed while this was in flight
    if (!this.store.get(name, record.url)) return null;
    this.store.put(name, { ...record, state: "signed-in", tokens: next });
    return next.access;
  }

  /** The WWW-Authenticate challenge of an unauthenticated request, if any. */
  private async challenge(url: string): Promise<string | null> {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "OpenMausBot", version: "1" } } }),
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      void response.body?.cancel().catch(() => {});
      return response.status === 401 ? response.headers.get("www-authenticate") : null;
    } catch {
      return null;
    }
  }

  /** A fresh public client per sign-in. Sign-ins are rare, and a cached id
   * goes stale when an authorization server prunes idle clients, after
   * which every sign-in would fail at its authorize page. */
  private async register(meta: McpAuthMetadata, redirectUri: string): Promise<string> {
    if (!meta.registrationEndpoint) {
      throw new McpOAuthError("no-registration", "This server only signs in apps registered with it in advance. Edit the server and add that app's client ID under Sign-in app.");
    }
    const response = await fetch(meta.registrationEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        client_name: "OpenMausBot",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = await response.json().catch(() => ({})) as { client_id?: unknown };
    if (!response.ok || typeof body.client_id !== "string" || !body.client_id) {
      throw new Error("This server would not register OpenMausBot for sign-in. Try again later.");
    }
    return body.client_id;
  }

  private async begin(name: string, url: string, starting: StartingFlow, wwwAuthenticate?: string | null): Promise<McpSignInStatus> {
    const previous = this.flows.get(name);
    if (previous) this.finish(previous, "cancelled", "Sign-in cancelled.");
    const meta = await discoverMcpAuth(url, wwwAuthenticate ?? await this.challenge(url));
    if (!meta) throw new McpOAuthError("not-oauth", "This server does not offer an OAuth sign-in. Add its token as a header instead.");
    const registered = this.clients(name, url);

    const server = createServer();
    try {
      await listen(server, preferredPort(url));
    } catch {
      // An app registered in advance was given this exact redirect URI.
      if (registered) {
        throw new McpOAuthError("port-busy", `Port ${preferredPort(url)} on this computer is in use, and sign-ins for this server's app return there. Close what is using it and try again.`);
      }
      await listen(server, 0);
    }
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("The sign-in listener could not start.");
      const redirectUri = `http://127.0.0.1:${address.port}${CALLBACK_PATH}`;
      const client: ClientAuth = registered
        ? { id: registered.clientId, ...(registered.clientSecret ? { secret: registered.clientSecret } : {}), method: tokenAuthMethod(meta, registered.clientSecret) }
        : { id: await this.register(meta, redirectUri), method: "none" };
      const scopes = registered?.scopes?.length ? registered.scopes : meta.scopes;
      if (starting.cancelled || !this.isOwnerLive(starting.owner)) throw new McpSignInError("Sign-in cancelled because the session or server changed.", 409);
      const state = randomBytes(32).toString("base64url");
      const verifier = randomBytes(32).toString("base64url");
      const authorize = new URL(meta.authorizationEndpoint);
      authorize.searchParams.set("response_type", "code");
      authorize.searchParams.set("client_id", client.id);
      authorize.searchParams.set("redirect_uri", redirectUri);
      authorize.searchParams.set("state", state);
      authorize.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
      authorize.searchParams.set("code_challenge_method", "S256");
      authorize.searchParams.set("resource", meta.resource);
      if (scopes?.length) authorize.searchParams.set("scope", scopes.join(" "));

      const status: McpSignInStatus = {
        phase: "waiting",
        flowId: randomUUID(),
        authorizationUrl: authorize.toString(),
        expiresAt: new Date(Date.now() + this.lifetimeMs).toISOString(),
      };
      const flow: Flow = {
        owner: starting.owner, name, url, status, state, verifier, redirectUri, client, meta, server, consumed: false,
        expiry: setTimeout(() => this.finish(flow, "expired", "Sign-in expired. Start again."), this.lifetimeMs),
      };
      flow.expiry.unref();
      server.on("request", (request, response) => void this.callback(flow, request, response));
      this.flows.set(name, flow);
      return { ...status };
    } catch (error) {
      server.close();
      throw error;
    }
  }

  private async callback(flow: Flow, request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse): Promise<void> {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.setHeader("Referrer-Policy", "no-referrer");
    // A kept-alive browser connection would carry the next sign-in's
    // callback to this listener after it has closed to new connections.
    response.setHeader("Connection", "close");
    let callback: URL;
    try {
      const expected = new URL(flow.redirectUri);
      if (request.headers.host !== expected.host || !request.url?.startsWith("/")) throw new Error("host");
      callback = new URL(request.url, flow.redirectUri);
    } catch {
      response.writeHead(400).end("Invalid sign-in callback. Return to OpenMausBot and try again.");
      return;
    }
    try {
      if (request.method !== "GET") throw new McpSignInError("Invalid sign-in callback.", 400);
      await this.acceptCallback(flow, callback);
      if (flow.status.phase === "failed") {
        response.writeHead(400).end(`${flow.status.message} You can close this tab.`);
      } else {
        response.end("Signed in. You can close this tab and return to OpenMausBot.");
      }
    } catch (error) {
      response.writeHead(error instanceof McpSignInError ? error.status : 400)
        .end("Invalid or expired sign-in. Return to OpenMausBot and try again.");
    }
  }

  /** Both the listener and authenticated paste-back use the same one-shot checks. */
  private async acceptCallback(flow: Flow, callback: URL): Promise<void> {
    if (!this.isOwnerLive(flow.owner)) this.finish(flow, "cancelled", "Your session ended. Start again.");
    if (flow.status.phase === "waiting" && !flow.consumed && Date.now() >= Date.parse(flow.status.expiresAt)) {
      this.finish(flow, "expired", "Sign-in expired. Start again.");
    }
    if (flow.consumed || flow.status.phase !== "waiting" || this.flows.get(flow.name) !== flow) {
      throw new McpSignInError("This sign-in has ended or is already being completed. Start again if needed.", 409);
    }
    const expected = new URL(flow.redirectUri);
    const params = callback.searchParams;
    if (callback.origin !== expected.origin || callback.pathname !== expected.pathname
      || callback.username || callback.password || callback.hash
      || [...params.keys()].some((key) => params.getAll(key).length !== 1)
      || !sameSecret(params.get("state") ?? "", flow.state)
      || (params.has("iss") && params.get("iss") !== flow.meta.issuer)
      || !((params.get("code") && !params.has("error") && params.get("code")!.length <= 4096)
        || (params.get("error") && !params.has("code")))) {
      throw new McpSignInError("This redirect URL does not belong to the current sign-in. Copy the complete URL and try again.", 400);
    }
    flow.consumed = true;
    clearTimeout(flow.expiry);
    const failure = await this.complete(flow, params);
    if (failure === DISCARDED) throw new McpSignInError("This sign-in was cancelled. Start again.", 409);
    this.finish(flow, failure ? "failed" : "succeeded", failure ?? undefined);
  }

  /** Spend the code; the error message on failure, null on success. */
  private async complete(flow: Flow, params: URLSearchParams): Promise<string | null> {
    if (params.has("error")) return "Sign-in was not approved.";
    const code = params.get("code");
    if (!code || code.length > 4096) return "The sign-in did not return a code. Start again.";
    try {
      const answer = await postForm(flow.meta.tokenEndpoint, {
        grant_type: "authorization_code",
        code,
        redirect_uri: flow.redirectUri,
        code_verifier: flow.verifier,
        resource: flow.meta.resource,
      }, flow.client);
      const tokens = answer.status >= 200 && answer.status < 300 ? tokensFrom(answer.body) : null;
      if (!tokens) return "The server did not accept this sign-in. Start again.";
      // Cancelled, signed out or removed while the code was being spent:
      // hand the tokens back rather than resurrect a sign-in.
      if (!this.isOwnerLive(flow.owner)) this.finish(flow, "cancelled", "Your session ended. Start again.");
      if (this.flows.get(flow.name) !== flow || flow.status.phase !== "waiting") {
        if (flow.meta.revocationEndpoint) {
          void postForm(flow.meta.revocationEndpoint, { token: tokens.refresh ?? tokens.access }, flow.client).catch(() => undefined);
        }
        return DISCARDED;
      }
      this.store.put(flow.name, {
        url: flow.url,
        state: "signed-in",
        issuer: flow.meta.issuer,
        clientId: flow.client.id,
        ...(flow.client.method !== "none" ? { tokenAuth: flow.client.method } : {}),
        redirectUri: flow.redirectUri,
        tokenEndpoint: flow.meta.tokenEndpoint,
        ...(flow.meta.revocationEndpoint ? { revocationEndpoint: flow.meta.revocationEndpoint } : {}),
        tokens,
      });
      return null;
    } catch {
      return "Could not reach the sign-in server. Start again.";
    }
  }

  private finish(flow: Flow, phase: McpSignInPhase, message?: string): void {
    if (flow.status.phase !== "waiting") return;
    clearTimeout(flow.expiry);
    flow.server.close();
    flow.server.closeIdleConnections();
    flow.status = { ...flow.status, phase, authorizationUrl: null, ...(message ? { message } : {}) };
  }
}

const isUrlServer = (server: McpServerSpec): server is Extract<McpServerSpec, { url: string }> => "url" in server;

/** The servers a turn may mount: a URL server waiting for sign-in would
 * only answer 401 mid-turn, so it stays out until someone signs in. */
export function withoutPendingSignIn(
  servers: Record<string, McpServerSpec>,
  manager: McpOAuthManager,
): Record<string, McpServerSpec> {
  return Object.fromEntries(Object.entries(servers).filter(([name, server]) =>
    !isUrlServer(server) || manager.authState(name, server.url) !== "needs-sign-in"));
}

/** Give each signed-in URL server a fresh bearer token, replacing any
 * Authorization header it was configured with. A server whose token can
 * no longer be had is left out. The input is not modified. */
export async function withMcpSignIn(
  servers: Record<string, McpServerSpec>,
  manager: McpOAuthManager,
): Promise<Record<string, McpServerSpec>> {
  const out: Record<string, McpServerSpec> = {};
  for (const [name, server] of Object.entries(withoutPendingSignIn(servers, manager))) {
    if (!isUrlServer(server) || manager.authState(name, server.url) !== "signed-in") {
      out[name] = server;
      continue;
    }
    const token = await manager.accessToken(name, server.url);
    if (!token) continue;
    const headers = Object.fromEntries(Object.entries(server.headers).filter(([key]) => key.toLowerCase() !== "authorization"));
    out[name] = { ...server, headers: { ...headers, Authorization: `Bearer ${token}` } };
  }
  return out;
}
