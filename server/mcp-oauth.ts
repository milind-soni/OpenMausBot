// OAuth sign-in for URL MCP servers, the way MCP clients do it: discover
// the authorization server from the MCP server's 401, register as a public
// client when the server allows it, run PKCE through the person's browser
// with a loopback callback on this machine, then keep the tokens fresh.
// Engines never see this: they get an ordinary Authorization header.
//
// The loopback listener and callback checks follow
// drivers/chatgpt-plan-auth.ts: one pending sign-in per server, a state
// compared in constant time, single-valued parameters, and a listener that
// lives only until the sign-in settles.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";

import type { McpServerSpec } from "./contracts.ts";
import { discoverMcpAuth, type McpAuthMetadata } from "./mcp-oauth-discovery.ts";
import { McpOAuthStore, type McpOAuthRecord, type McpOAuthTokens } from "./mcp-oauth-store.ts";

export type McpSignInPhase = "waiting" | "succeeded" | "failed" | "cancelled" | "expired";

export interface McpSignInStatus {
  phase: McpSignInPhase;
  flowId: string;
  authorizationUrl: string | null;
  expiresAt: string;
  message?: string;
}

export type McpOAuthFailure = "not-oauth" | "no-registration";

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
const CALLBACK_PATH = "/mcp-oauth/callback";
/** complete()'s answer for a flow that ended while its code was spent. */
const DISCARDED = "discarded";

interface Flow {
  name: string;
  url: string;
  status: McpSignInStatus;
  state: string;
  verifier: string;
  redirectUri: string;
  clientId: string;
  meta: McpAuthMetadata;
  server: Server;
  consumed: boolean;
  expiry: ReturnType<typeof setTimeout>;
}

/** A port derived from the server URL: the same redirect URI on every
 * attempt, so a registered client can be reused instead of re-registered. */
function preferredPort(url: string): number {
  let hash = 0x811c9dc5;
  for (const char of url) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return 20_000 + (hash % 20_000);
}

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

async function postForm(url: string, form: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(form).toString(),
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
  private readonly flows = new Map<string, Flow>();
  private readonly starting = new Map<string, Promise<McpSignInStatus>>();
  private readonly refreshing = new Map<string, Promise<string | null>>();

  constructor(options: { file: string; lifetimeMs?: number }) {
    this.store = new McpOAuthStore(options.file);
    this.lifetimeMs = options.lifetimeMs ?? DEFAULT_LIFETIME_MS;
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

  start(name: string, url: string, wwwAuthenticate?: string | null): Promise<McpSignInStatus> {
    const current = this.flows.get(name);
    if (current && current.url === url && current.status.phase === "waiting") return Promise.resolve({ ...current.status });
    const pending = this.starting.get(name);
    if (pending) return pending;
    const begun = this.begin(name, url, wwwAuthenticate).finally(() => this.starting.delete(name));
    this.starting.set(name, begun);
    return begun;
  }

  status(name: string, flowId: string): McpSignInStatus | undefined {
    const flow = this.flows.get(name);
    return flow && flow.status.flowId === flowId ? { ...flow.status } : undefined;
  }

  cancel(name: string): void {
    const flow = this.flows.get(name);
    if (flow) this.finish(flow, "cancelled", "Sign-in cancelled.");
  }

  /** Revoke with the server when it offers that (best effort), then forget. */
  async signOut(name: string, url: string): Promise<void> {
    this.cancel(name);
    const record = this.store.get(name, url);
    const token = record?.tokens?.refresh ?? record?.tokens?.access;
    if (record?.revocationEndpoint && token) {
      await postForm(record.revocationEndpoint, { token, ...(record.clientId ? { client_id: record.clientId } : {}) }).catch(() => undefined);
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
    for (const flow of this.flows.values()) this.finish(flow, "cancelled", "Sign-in cancelled.");
    this.flows.clear();
  }

  private async refresh(name: string, record: McpOAuthRecord): Promise<string | null> {
    const tokens = record.tokens!;
    const stillValid = tokens.expiresAt !== undefined && tokens.expiresAt > Date.now();
    if (!tokens.refresh || !record.tokenEndpoint || !record.clientId) {
      if (stillValid) return tokens.access;
      this.markNeedsSignIn(name, record.url);
      return null;
    }
    let answer: Awaited<ReturnType<typeof postForm>>;
    try {
      answer = await postForm(record.tokenEndpoint, {
        grant_type: "refresh_token",
        refresh_token: tokens.refresh,
        client_id: record.clientId,
        resource: record.url,
      });
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
      throw new McpOAuthError("no-registration", "This server needs an app registration OpenMausBot doesn't have yet.");
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

  private async begin(name: string, url: string, wwwAuthenticate?: string | null): Promise<McpSignInStatus> {
    const previous = this.flows.get(name);
    if (previous) this.finish(previous, "cancelled", "Sign-in cancelled.");
    const meta = await discoverMcpAuth(url, wwwAuthenticate ?? await this.challenge(url));
    if (!meta) throw new McpOAuthError("not-oauth", "This server does not offer an OAuth sign-in. Add its token as a header instead.");

    const server = createServer();
    try {
      await listen(server, preferredPort(url));
    } catch {
      await listen(server, 0);
    }
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("The sign-in listener could not start.");
      const redirectUri = `http://127.0.0.1:${address.port}${CALLBACK_PATH}`;
      const clientId = await this.register(meta, redirectUri);
      const state = randomBytes(32).toString("base64url");
      const verifier = randomBytes(32).toString("base64url");
      const authorize = new URL(meta.authorizationEndpoint);
      authorize.searchParams.set("response_type", "code");
      authorize.searchParams.set("client_id", clientId);
      authorize.searchParams.set("redirect_uri", redirectUri);
      authorize.searchParams.set("state", state);
      authorize.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
      authorize.searchParams.set("code_challenge_method", "S256");
      authorize.searchParams.set("resource", meta.resource);
      if (meta.scopes?.length) authorize.searchParams.set("scope", meta.scopes.join(" "));

      const status: McpSignInStatus = {
        phase: "waiting",
        flowId: randomUUID(),
        authorizationUrl: authorize.toString(),
        expiresAt: new Date(Date.now() + this.lifetimeMs).toISOString(),
      };
      const flow: Flow = {
        name, url, status, state, verifier, redirectUri, clientId, meta, server, consumed: false,
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
    const params = callback.searchParams;
    if (request.method !== "GET" || callback.pathname !== CALLBACK_PATH || flow.consumed || flow.status.phase !== "waiting"
      || this.flows.get(flow.name) !== flow
      || [...params.keys()].some((key) => params.getAll(key).length !== 1)
      || !sameSecret(params.get("state") ?? "", flow.state)) {
      response.writeHead(400).end("Invalid or expired sign-in. Return to OpenMausBot and try again.");
      return;
    }
    flow.consumed = true;
    // the code is being spent: the lifetime no longer applies
    clearTimeout(flow.expiry);
    const failure = await this.complete(flow, params);
    if (failure === DISCARDED) {
      response.writeHead(409).end("This sign-in was cancelled in OpenMausBot. You can close this tab.");
      return;
    }
    if (failure) {
      this.finish(flow, "failed", failure);
      response.writeHead(400).end(`${failure} You can close this tab.`);
      return;
    }
    this.finish(flow, "succeeded");
    response.end("Signed in. You can close this tab and return to OpenMausBot.");
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
        client_id: flow.clientId,
        code_verifier: flow.verifier,
        resource: flow.meta.resource,
      });
      const tokens = answer.status >= 200 && answer.status < 300 ? tokensFrom(answer.body) : null;
      if (!tokens) return "The server did not accept this sign-in. Start again.";
      // Cancelled, signed out or removed while the code was being spent:
      // hand the tokens back rather than resurrect a sign-in.
      if (this.flows.get(flow.name) !== flow || flow.status.phase !== "waiting") {
        if (flow.meta.revocationEndpoint) {
          void postForm(flow.meta.revocationEndpoint, { token: tokens.refresh ?? tokens.access, client_id: flow.clientId }).catch(() => undefined);
        }
        return DISCARDED;
      }
      this.store.put(flow.name, {
        url: flow.url,
        state: "signed-in",
        issuer: flow.meta.issuer,
        clientId: flow.clientId,
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
