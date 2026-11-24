// Engines never see this, only an Authorization header. Callbacks: one pending sign-in per server, state
// compared in constant time, single-valued parameters, and a listener that lives only until its last sign-in settles.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isDeepStrictEqual } from "node:util";

import type { McpServerSpec } from "./contracts.ts";
import { discoverMcpAuth, type McpAuthMetadata } from "./mcp-oauth-discovery.ts";
import { McpOAuthStore, type McpOAuthRecord, type McpOAuthTokens } from "./mcp-oauth-store.ts";
import type { McpOAuthClientConfig } from "./mcp-registry.ts";

export type McpSignInPhase = "waiting" | "succeeded" | "failed" | "cancelled" | "expired";

export interface McpSignInStatus {
  phase: McpSignInPhase;
  flowId: string;
  authorizationUrl: string | null;
  expiresAt: string;
  message?: string;
  pasteBack?: boolean;
}

export interface McpSignInBrowser {
  remote: boolean;
  origin?: string | null;
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

/** How a token refresh ended: a new token, refused for good (the sign-in ended), nothing could refresh an expired token, or
 * no answer from the authorization server. */
export type McpRefreshOutcome = "refreshed" | "rejected" | "expired" | "unreachable";
/** A server refused a sign-in's token on a real call: a refresh got a new one, the sign-in has ended, the server refused
 * a token renewed moments ago (the sign-in lacks something), or nothing could be learned. */
export type McpTokenRefusal = "refreshed" | "ended" | "again" | "unknown";

/** The owner of a sign-in started from a chat's Sign in card: any device that can see the card may follow it. */
export const cardOwner = (threadId: string, messageId: string) => `card:${threadId}:${messageId}`;

const DEFAULT_LIFETIME_MS = 5 * 60_000;
const REFRESH_MARGIN_MS = 2 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
/** A token a server refused is renewed at most this often: one refused right after a renewal is not an expired one. */
const REFUSED_RENEW_MS = 60_000;
export const MCP_OAUTH_CALLBACK_PATH = "/mcp-oauth/callback";
const CALLBACK_PATH = MCP_OAUTH_CALLBACK_PATH;
const DISCARDED = "discarded";

/** The address a sign-in returns to. The connections to one server share it: every callback carries its own state. */
interface Listener {
  server: Server;
  port: number;
  flows: Set<Flow>;
  reserved: number;
}

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
  listener: Listener | null;
  consumed: boolean;
  expiry: ReturnType<typeof setTimeout>;
}

interface StartingFlow {
  owner: string;
  url: string;
  browser: McpSignInBrowser;
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

function preferredPort(url: string): number {
  let hash = 0x811c9dc5;
  for (const char of url) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return 20_000 + (hash % 20_000);
}

export function mcpOAuthRedirectUri(url: string): string {
  return `http://127.0.0.1:${preferredPort(url)}${CALLBACK_PATH}`;
}

function httpsOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && value.replace(/\/+$/, "") === url.origin ? url.origin : null;
  } catch {
    return null;
  }
}

/** The browser's proven origin wins when it is configured or none is; never a Host header nobody vouched for. */
export function mcpCallbackOrigin(browserOrigin: string | null, configured: ReadonlyArray<string | null | undefined>): string | null {
  const known = configured.map(httpsOrigin).filter((origin): origin is string => origin !== null);
  const proven = httpsOrigin(browserOrigin);
  if (proven && (known.length === 0 || known.includes(proven))) return proven;
  return known[0] ?? null;
}

type TokenAuthMethod = "none" | "client_secret_post" | "client_secret_basic";

interface ClientAuth {
  id: string;
  secret?: string;
  method: TokenAuthMethod;
  /** Issued by the server's dynamic registration, not configured: kept with the sign-in so refreshes can prove it. */
  registered?: boolean;
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
  }
  return { status: response.status, body };
}

/** Failures before the connection opened: the request never left, so nothing was presented. */
const NOT_CONNECTED = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "ENETDOWN", "UND_ERR_CONNECT_TIMEOUT"]);
function neverSent(error: unknown): boolean {
  const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof code === "string" && NOT_CONNECTED.has(code);
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

class RegistrationRefused extends Error {}

function registrationRefusal(response: Response, description: unknown): string {
  const reason = typeof description === "string" ? description.replace(/\s+/g, " ").trim().slice(0, 300) : "";
  const retryAfter = response.headers.get("retry-after")?.trim().slice(0, 40);
  const wait = retryAfter ? ` It asked to wait: Retry-After ${/^\d+$/.test(retryAfter) ? `${retryAfter} seconds` : retryAfter}.` : "";
  if (!reason && !wait) return "This server would not register OpenMausBot for sign-in. Try again later.";
  return `This server would not register OpenMausBot for sign-in (HTTP ${response.status})${reason ? `: ${reason}` : "."}${wait} Try again later.`;
}

export class McpOAuthManager {
  private readonly store: McpOAuthStore;
  private readonly lifetimeMs: number;
  private readonly isOwnerLive: (owner: string) => boolean;
  private readonly flows = new Map<string, Flow>();
  private readonly listeners = new Map<number, Promise<Listener>>();
  private readonly starting = new Map<string, StartingFlow>();
  private readonly refreshing = new Map<string, Promise<{ token: string | null; outcome: McpRefreshOutcome | null }>>();
  private readonly renewedAfterRefusal = new Map<string, number>();
  private readonly clients: (name: string, url: string) => McpOAuthClientConfig | undefined;
  private readonly onSettled: (name: string, phase: McpSignInPhase, owner: string) => void;
  private readonly onRefresh: (name: string, outcome: McpRefreshOutcome) => void;
  private disposed = false;

  /** `clients` is read when needed: an app's secret is never copied into this store. `onSettled` hears each sign-in end
   * once, except when the server shuts down. `onRefresh` hears how each refresh ended. */
  constructor(options: {
    file: string; lifetimeMs?: number; clients?: (name: string, url: string) => McpOAuthClientConfig | undefined; isOwnerLive?: (owner: string) => boolean;
    onSettled?(name: string, phase: McpSignInPhase, owner: string): void;
    onRefresh?(name: string, outcome: McpRefreshOutcome): void;
  }) {
    this.store = new McpOAuthStore(options.file);
    this.isOwnerLive = options.isOwnerLive ?? (() => true);
    this.onSettled = options.onSettled ?? (() => {});
    this.onRefresh = options.onRefresh ?? (() => {});
    this.lifetimeMs = options.lifetimeMs ?? DEFAULT_LIFETIME_MS;
    this.clients = options.clients ?? (() => undefined);
  }

  private recordClient(name: string, record: McpOAuthRecord): ClientAuth | null {
    if (!record.clientId) return null;
    if (!record.tokenAuth) return { id: record.clientId, method: "none" };
    if (record.clientSecret) return { id: record.clientId, secret: record.clientSecret, method: record.tokenAuth };
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

  /** The sign-in kept for an entry, with its tokens: only for moving it to the person's own Cloud, never for a route. */
  signInRecord(name: string, url: string): McpOAuthRecord | undefined {
    return this.store.get(name, url);
  }

  /** A sign-in moved here from the person's own computer, for the entry at this address. A sign-in this server already
   * has is kept, unless `replaces` says it is the one that computer moved here before (it refreshed there since). The
   * app's secret, when it has one, came with the entry itself. */
  adopt(name: string, url: string, record: McpOAuthRecord, replaces?: (current: McpOAuthRecord) => boolean): "adopted" | "kept" {
    const current = this.store.get(name, url);
    if (current && this.authState(name, url) === "signed-in" && !replaces?.(current)) return "kept";
    this.cancel(name);
    this.store.put(name, { ...record, url, state: record.tokens ? "signed-in" : "needs-sign-in" });
    // The sign-in that was replaced brought its own token: the mark of the old one no longer means anything.
    this.store.forgetSpentRefresh(name);
    return "adopted";
  }

  markNeedsSignIn(name: string, url: string): void {
    const { tokens: _dropped, ...rest } = this.store.get(name, url) ?? { url };
    this.store.put(name, { ...rest, url, state: "needs-sign-in" });
  }

  /** A probe that sent no credentials found that the server wants a sign-in this entry doesn't hold. Never touches a
   * sign-in (one may have landed while the probe ran), so unlike markNeedsSignIn it has no tokens to drop. Idempotent. */
  requireSignIn(name: string, url: string): void {
    if (this.authState(name, url) === "signed-in") return;
    const current = this.store.get(name, url);
    if (current?.state === "needs-sign-in") return;
    this.store.put(name, { ...current, url, state: "needs-sign-in" });
  }

  start(name: string, url: string, wwwAuthenticate?: string | null, owner = "loopback", browser: McpSignInBrowser = { remote: false }): Promise<McpSignInStatus> {
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
    const starting: StartingFlow = { owner, url, browser, cancelled: false, promise: undefined! };
    starting.promise = this.begin(name, url, starting, wwwAuthenticate).finally(() => this.starting.delete(name));
    this.starting.set(name, starting);
    return starting.promise;
  }

  /** The sign-in this owner is waiting on for a server, and whether it comes back to this computer's loopback listener. */
  waiting(name: string, owner: string): { loopback: boolean } | null {
    const flow = this.flows.get(name);
    return flow?.owner === owner && flow.status.phase === "waiting" ? { loopback: flow.listener !== null } : null;
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

  /** The scheme is the redirect URI's: a proxy in front of this server may end TLS. */
  async publicCallback(host: string | undefined, search: string): Promise<{ status: number; text: string }> {
    const state = new URLSearchParams(search).get("state") ?? "";
    let match: Flow | undefined;
    for (const flow of this.flows.values()) {
      const expected = new URL(flow.redirectUri);
      if (!flow.listener && expected.host === host?.trim().toLowerCase() && sameSecret(state, flow.state)) match = flow;
    }
    if (!match) return { status: 400, text: "Invalid sign-in callback. Return to OpenMausBot and try again." };
    return this.answer(match, new URL(`${new URL(match.redirectUri).origin}${CALLBACK_PATH}${search.startsWith("?") ? search : ""}`));
  }

  async signOut(name: string, url: string): Promise<void> {
    this.cancel(name);
    const record = this.store.get(name, url);
    this.store.delete(name);
    const token = record?.tokens?.refresh ?? record?.tokens?.access;
    if (record?.revocationEndpoint && token) {
      await postForm(record.revocationEndpoint, { token }, this.recordClient(name, record) ?? undefined).catch(() => undefined);
    }
  }

  forget(name: string): void {
    this.cancel(name);
    this.flows.delete(name);
    this.store.delete(name);
  }

  accessToken(name: string, url: string): Promise<string | null> {
    const record = this.store.get(name, url);
    if (!record || record.state !== "signed-in" || !record.tokens) return Promise.resolve(null);
    const { tokens } = record;
    if (!tokens.expiresAt || tokens.expiresAt > Date.now() + REFRESH_MARGIN_MS) return Promise.resolve(tokens.access);
    return this.renew(name, record, false).then((renewed) => renewed.token);
  }

  /** When this sign-in ends for good: its token's expiry, when nothing can refresh it; null otherwise. */
  endsAt(name: string, url: string): number | null {
    const record = this.store.get(name, url);
    if (!record || record.state !== "signed-in" || !record.tokens?.expiresAt) return null;
    return this.renewable(name, record) ? null : record.tokens.expiresAt;
  }

  /** The server refused this sign-in's token on a real call (HTTP 401): it is refreshed now, or, when nothing can refresh
   * it, the sign-in has ended. A token refused again right after a refresh is left as it is. */
  async tokenRefused(name: string, url: string): Promise<McpTokenRefusal> {
    const record = this.store.get(name, url);
    if (!record || record.state !== "signed-in" || !record.tokens) return record?.state === "needs-sign-in" ? "ended" : "unknown";
    const renewed = this.renewedAfterRefusal.get(name);
    if (renewed !== undefined && Date.now() - renewed < REFUSED_RENEW_MS) return "again";
    this.renewedAfterRefusal.set(name, Date.now());
    const { outcome } = await this.renew(name, record, true);
    return outcome === "refreshed" ? "refreshed" : outcome === "rejected" || outcome === "expired" ? "ended" : "unknown";
  }

  dispose(): void {
    this.disposed = true;
    for (const pending of this.starting.values()) pending.cancelled = true;
    for (const flow of this.flows.values()) this.finish(flow, "cancelled", "Sign-in cancelled.");
    this.flows.clear();
    for (const opening of this.listeners.values()) {
      void opening.then((listener) => {
        listener.server.close();
        listener.server.closeIdleConnections();
      }).catch(() => undefined);
    }
    this.listeners.clear();
  }

  private renewable(name: string, record: McpOAuthRecord): boolean {
    return Boolean(record.tokens?.refresh && record.tokenEndpoint && this.recordClient(name, record));
  }

  /** One refresh at a time per server. `forced`: a server refused the token, so it is renewed whatever its expiry says, and
   * a token nothing can renew has ended. */
  private renew(name: string, record: McpOAuthRecord, forced: boolean): Promise<{ token: string | null; outcome: McpRefreshOutcome | null }> {
    const key = JSON.stringify([name, record]);
    const pending = this.refreshing.get(key);
    if (pending) return pending;
    const renewed = this.refresh(name, record, forced).then((result) => {
      if (result.outcome) {
        try { this.onRefresh(name, result.outcome); } catch (error) { console.error("mcp sign-in: onRefresh failed", error); }
      }
      return result;
    }).finally(() => this.refreshing.delete(key));
    this.refreshing.set(key, renewed);
    return renewed;
  }

  private async refresh(name: string, record: McpOAuthRecord, forced: boolean): Promise<{ token: string | null; outcome: McpRefreshOutcome | null }> {
    const tokens = record.tokens!;
    const stillValid = !forced && tokens.expiresAt !== undefined && tokens.expiresAt > Date.now();
    const client = this.recordClient(name, record);
    if (!tokens.refresh || !record.tokenEndpoint || !client) {
      if (stillValid) return { token: tokens.access, outcome: null };
      this.markNeedsSignIn(name, record.url);
      return { token: null, outcome: "expired" };
    }
    // A refresh token the server may already have rotated must never be presented again: such a server revokes the
    // whole grant when it sees one of them a second time. A token this server already sent is therefore spent, whatever
    // the answer was, and the sign-in ends rather than being refreshed a second time with it.
    // The mark lives in the store, not in memory: a restart must not present the token either.
    if (this.store.spentRefreshFor(name) === tokens.refresh) {
      this.markNeedsSignIn(name, record.url);
      return { token: null, outcome: "expired" };
    }
    // Remember it before the request leaves: if the answer is lost the server may have rotated it, and the next
    // attempt must not send it again.
    const sent = tokens.refresh;
    this.store.markSpentRefresh(name, sent);
    let answer: Awaited<ReturnType<typeof postForm>>;
    try {
      answer = await postForm(record.tokenEndpoint, {
        grant_type: "refresh_token",
        refresh_token: tokens.refresh,
        resource: record.url,
      }, client);
    } catch (error) {
      // A connection that never opened sent nothing, so the token is still good. Any other lost answer keeps it spent,
      // because the server may have rotated it.
      if (neverSent(error)) this.store.clearSpentRefresh(name, sent);
      if (!isDeepStrictEqual(this.store.get(name, record.url), record)) return { token: null, outcome: null };
      return { token: stillValid ? tokens.access : null, outcome: "unreachable" };
    }
    if (!isDeepStrictEqual(this.store.get(name, record.url), record)) return { token: null, outcome: null };
    const next = answer.status >= 200 && answer.status < 300 ? tokensFrom(answer.body, tokens) : null;
    if (!next) {
      const dead = (answer.status === 400 || answer.status === 401)
        && (answer.body.error === "invalid_grant" || answer.body.error === "invalid_client");
      // The server answered without a token (busy, rate-limited, down for a moment): it issued nothing, so the token is
      // still good and the next attempt may present it.
      if (!dead) {
        this.store.clearSpentRefresh(name, sent);
        return { token: stillValid ? tokens.access : null, outcome: "unreachable" };
      }
      this.markNeedsSignIn(name, record.url);
      return { token: null, outcome: "rejected" };
    }
    // The server answered and kept the same refresh token: it is still valid (RFC 6749 section 6), so it may be
    // presented again later. A rotated token leaves its mark: the one that was sent is dead for good.
    if (next.refresh === sent) this.store.clearSpentRefresh(name, sent);
    this.store.put(name, { ...record, state: "signed-in", tokens: next });
    return { token: next.access, outcome: "refreshed" };
  }

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

  /** A fresh client per sign-in: authorization servers prune idle clients, so a cached id goes stale. It asks to be
   * public; a server that issues a secret anyway (Supabase) gets it back on every token request. */
  private async register(meta: McpAuthMetadata, redirectUri: string): Promise<ClientAuth> {
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
    const parsed: unknown = await response.json().catch(() => null);
    const body = (parsed && typeof parsed === "object" ? parsed : {}) as {
      client_id?: unknown;
      client_secret?: unknown;
      token_endpoint_auth_method?: unknown;
      error_description?: unknown;
    };
    if (!response.ok || typeof body.client_id !== "string" || !body.client_id) {
      throw new RegistrationRefused(registrationRefusal(response, body.error_description));
    }
    if (typeof body.client_secret !== "string" || !body.client_secret) return { id: body.client_id, method: "none" };
    const issued = body.token_endpoint_auth_method;
    const method = issued === "client_secret_basic" || issued === "client_secret_post" ? issued : tokenAuthMethod(meta, body.client_secret);
    return { id: body.client_id, secret: body.client_secret, method, registered: true };
  }

  private async begin(name: string, url: string, starting: StartingFlow, wwwAuthenticate?: string | null): Promise<McpSignInStatus> {
    const previous = this.flows.get(name);
    if (previous) this.finish(previous, "cancelled", "Sign-in cancelled.");
    const meta = await discoverMcpAuth(url, wwwAuthenticate ?? await this.challenge(url));
    if (!meta) throw new McpOAuthError("not-oauth", "This server does not offer an OAuth sign-in. Add its token as a header instead.");
    const registered = this.clients(name, url);

    /** An app with a configured return address always returns there: it is the one address the provider has registered,
     * and the only one a browser on another computer can reach. The public route completes it, so no listener runs. */
    if (registered?.redirectUri) {
      const client: ClientAuth = {
        id: registered.clientId,
        ...(registered.clientSecret ? { secret: registered.clientSecret } : {}),
        method: tokenAuthMethod(meta, registered.clientSecret),
      };
      const scopes = registered.scopes?.length ? registered.scopes : meta.scopes;
      return { ...this.open(name, url, starting, meta, registered.redirectUri, client, null, scopes).status };
    }

    if (!registered && starting.browser.remote && starting.browser.origin) {
      const redirectUri = `${starting.browser.origin}${CALLBACK_PATH}`;
      let client: ClientAuth | null = null;
      try {
        client = await this.register(meta, redirectUri);
      } catch (error) {
        if (!(error instanceof RegistrationRefused)) throw error;
      }
      if (client) return { ...this.open(name, url, starting, meta, redirectUri, client, null, meta.scopes).status };
    }

    const listener = await this.listener(preferredPort(url), registered !== undefined);
    try {
      const redirectUri = `http://127.0.0.1:${listener.port}${CALLBACK_PATH}`;
      const client: ClientAuth = registered
        ? { id: registered.clientId, ...(registered.clientSecret ? { secret: registered.clientSecret } : {}), method: tokenAuthMethod(meta, registered.clientSecret) }
        : await this.register(meta, redirectUri);
      const scopes = registered?.scopes?.length ? registered.scopes : meta.scopes;
      const flow = this.open(name, url, starting, meta, redirectUri, client, listener, scopes);
      listener.reserved -= 1;
      listener.flows.add(flow);
      return { ...flow.status };
    } catch (error) {
      listener.reserved -= 1;
      this.closeListener(listener);
      throw error;
    }
  }

  /** The address a sign-in returns to. The connections to one server share it: every callback carries its own state. */
  private async listener(port: number, registered: boolean): Promise<Listener> {
    const pending = this.listeners.get(port);
    if (pending) {
      const listener = await pending;
      listener.reserved += 1;
      return listener;
    }
    const opening = this.openListener(port);
    this.listeners.set(port, opening);
    let listener: Listener;
    try {
      listener = await opening;
    } catch {
      this.listeners.delete(port);
      if (registered) {
        throw new McpOAuthError("port-busy", `Port ${port} on this computer is in use, and sign-ins for this server's app return there. Close what is using it and try again.`);
      }
      listener = await this.openListener(0);
      this.listeners.set(listener.port, Promise.resolve(listener));
    }
    listener.reserved += 1;
    return listener;
  }

  private async openListener(port: number): Promise<Listener> {
    const server = createServer();
    try {
      await listen(server, port);
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("The sign-in listener could not start.");
      const listener: Listener = { server, port: address.port, flows: new Set(), reserved: 0 };
      server.on("request", (request, response) => void this.dispatch(listener, request, response));
      return listener;
    } catch (error) {
      server.close();
      throw error;
    }
  }

  /** The callback belongs to the sign-in whose state it carries. */
  private dispatch(listener: Listener, request: IncomingMessage, response: ServerResponse): void {
    const state = new URL(request.url ?? "/", "http://127.0.0.1").searchParams.get("state") ?? "";
    let match: Flow | undefined;
    for (const flow of listener.flows) if (sameSecret(state, flow.state)) match = flow;
    if (!match) {
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Content-Type", "text/plain; charset=utf-8");
      response.writeHead(400).end("Invalid sign-in callback. Return to OpenMausBot and try again.");
      return;
    }
    void this.callback(match, request, response);
  }

  /** A listener lives while a sign-in waits on it. */
  private release(flow: Flow): void {
    const listener = flow.listener;
    if (!listener) return;
    listener.flows.delete(flow);
    this.closeListener(listener);
  }

  private closeListener(listener: Listener): void {
    if (listener.flows.size || listener.reserved) return;
    this.listeners.delete(listener.port);
    listener.server.close();
    listener.server.closeIdleConnections();
  }

  private open(
    name: string, url: string, starting: StartingFlow, meta: McpAuthMetadata, redirectUri: string,
    client: ClientAuth, listener: Listener | null, scopes: string[] | undefined,
  ): Flow {
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
      ...(listener && starting.browser.remote ? { pasteBack: true } : {}),
    };
    const flow: Flow = {
      owner: starting.owner, name, url, status, state, verifier, redirectUri, client, meta, listener, consumed: false,
      expiry: setTimeout(() => this.finish(flow, "expired", "Sign-in expired. Start again."), this.lifetimeMs),
    };
    flow.expiry.unref();
    this.flows.set(name, flow);
    return flow;
  }

  private async callback(flow: Flow, request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse): Promise<void> {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.setHeader("Referrer-Policy", "no-referrer");
    // A kept-alive connection would carry the next sign-in's callback here after the listener stopped accepting.
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
    const answer = request.method === "GET"
      ? await this.answer(flow, callback)
      : { status: 400, text: "Invalid or expired sign-in. Return to OpenMausBot and try again." };
    response.writeHead(answer.status).end(answer.text);
  }

  /** Words fit for a plain page: never the code or the server's own text. */
  private async answer(flow: Flow, callback: URL): Promise<{ status: number; text: string }> {
    try {
      await this.acceptCallback(flow, callback);
      return flow.status.phase === "failed"
        ? { status: 400, text: `${flow.status.message} You can close this tab.` }
        : { status: 200, text: "Signed in. You can close this tab and return to OpenMausBot." };
    } catch (error) {
      return { status: error instanceof McpSignInError ? error.status : 400, text: "Invalid or expired sign-in. Return to OpenMausBot and try again." };
    }
  }

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
      // Ended while the code was being spent: hand the tokens back rather than resurrect a sign-in.
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
        ...(flow.client.registered && flow.client.secret ? { clientSecret: flow.client.secret } : {}),
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
    this.release(flow);
    flow.status = { ...flow.status, phase, authorizationUrl: null, ...(message ? { message } : {}) };
    if (this.disposed) return;
    // A listener's fault must neither escape the expiry timer nor turn a sign-in already stored into a failed callback.
    try {
      this.onSettled(flow.name, phase, flow.owner);
    } catch (error) {
      console.error("mcp sign-in: onSettled failed", error);
    }
  }
}

const isUrlServer = (server: McpServerSpec): server is Extract<McpServerSpec, { url: string }> => "url" in server;

export function withoutPendingSignIn(
  servers: Record<string, McpServerSpec>,
  manager: McpOAuthManager,
): Record<string, McpServerSpec> {
  return Object.fromEntries(Object.entries(servers).filter(([name, server]) =>
    !isUrlServer(server) || manager.authState(name, server.url) !== "needs-sign-in"));
}

export async function withMcpSignIn(
  servers: Record<string, McpServerSpec>,
  manager: McpOAuthManager,
): Promise<Record<string, McpServerSpec>> {
  const entries = await Promise.all(Object.entries(withoutPendingSignIn(servers, manager)).map(
    async ([name, server]): Promise<[string, McpServerSpec] | null> => {
      if (!isUrlServer(server) || manager.authState(name, server.url) !== "signed-in") return [name, server];
      const token = await manager.accessToken(name, server.url);
      if (!token) return null;
      const headers = Object.fromEntries(Object.entries(server.headers).filter(([key]) => key.toLowerCase() !== "authorization"));
      return [name, { ...server, headers: { ...headers, Authorization: `Bearer ${token}` } }];
    },
  ));
  const out: Record<string, McpServerSpec> = {};
  for (const entry of entries) if (entry) out[entry[0]] = entry[1];
  return out;
}
