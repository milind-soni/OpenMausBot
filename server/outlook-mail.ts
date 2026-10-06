// Outlook mail on this computer. The person registers their own Microsoft
// Entra app and signs in with mail scopes only. Tokens and the client
// secret stay in outlook-oauth.json. Turns reach a loopback MCP server
// that calls Microsoft Graph with the mailbox token; the engine receives
// a process-local gate, never the Graph token.
//
// Microsoft Graph tokens are audience-bound by scope. The MCP OAuth
// manager always sends RFC 8707 `resource` set to the MCP URL, which would
// ask Microsoft for a token for the wrong audience, so this flow does not
// use that manager. Work IQ is not used: it is all of Microsoft 365.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

import {
  OUTLOOK_IDENTITY_URL,
  OUTLOOK_MCP_PATH,
  OUTLOOK_SCOPES,
  outlookTenant,
} from "../shared/direct-apps.ts";
import { mcpOAuthRedirectPort, mcpOAuthRedirectUri } from "../shared/mcp-oauth-redirect.ts";
import { writeFileAtomic } from "./atomic.ts";
import type { McpServerSpec } from "./contracts.ts";
import { isLoopbackHost } from "./request-auth.ts";

export type OutlookAuthState = "none" | "needs-sign-in" | "signed-in";

export interface OutlookPublicStatus {
  auth: OutlookAuthState;
  redirectUri: string;
  tenant: string;
}

export interface OutlookSignInStatus {
  phase: "waiting" | "succeeded" | "failed" | "cancelled" | "expired";
  flowId: string | null;
  authorizationUrl: string | null;
  expiresAt?: string;
  message?: string;
}

const BODY_CAP = 4_000;
const SEND_BODY_CAP = 20_000;
const DEFAULT_LIFETIME_MS = 5 * 60_000;
const REFRESH_MARGIN_MS = 2 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const LIST_SELECT = "id,subject,from,receivedDateTime,isRead,bodyPreview";
const MESSAGE_SELECT = "id,subject,from,toRecipients,ccRecipients,receivedDateTime,body,bodyPreview,isDraft,webLink";
const FOLDERS = new Set(["inbox", "drafts", "sentitems", "deleteditems", "junkemail", "archive"]);

const tokensSchema = z.object({
  access: z.string().min(1),
  refresh: z.string().min(1).optional(),
  expiresAt: z.number().optional(),
  scope: z.string().optional(),
});

const fileSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  tenant: z.string().min(1),
  tokens: tokensSchema.optional(),
});

type Stored = z.infer<typeof fileSchema>;
type Tokens = z.infer<typeof tokensSchema>;

interface Flow {
  owner: string;
  status: OutlookSignInStatus;
  state: string;
  verifier: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
  tenant: string;
  server: Server;
  consumed: boolean;
  expiry: ReturnType<typeof setTimeout>;
}

export interface OutlookGraphRequest {
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
}

/** The Graph call for one mail tool, or a sentence the model can read. */
export function outlookGraphCall(name: string, args: unknown): { ok: true; request: OutlookGraphRequest } | { ok: false; error: string } {
  const record = isRecord(args) ? args : {};
  if (name === "list_messages") return listCall(record);
  if (name === "get_message") return getCall(record);
  if (name === "create_draft") return draftCall(record);
  if (name === "send_mail") return sendCall(record);
  return { ok: false, error: "Unknown Outlook tool." };
}

export function outlookAuthorizeUrl(input: {
  endpoint: string;
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
}): URL {
  const authorize = new URL(input.endpoint);
  authorize.searchParams.set("client_id", input.clientId);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("redirect_uri", input.redirectUri);
  authorize.searchParams.set("response_mode", "query");
  authorize.searchParams.set("scope", OUTLOOK_SCOPES.join(" "));
  authorize.searchParams.set("state", input.state);
  authorize.searchParams.set("code_challenge", input.challenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  authorize.searchParams.set("prompt", "select_account");
  return authorize;
}

/** Add the loopback Outlook server when this computer has a mailbox grant
 * and the person has not already configured an MCP server named outlook. */
export function mountOutlookMail(
  servers: Record<string, McpServerSpec>,
  spec: McpServerSpec | null,
  blocked: { restricted: boolean; userNamedOutlook: boolean },
): Record<string, McpServerSpec> {
  if (blocked.restricted || blocked.userNamedOutlook || !spec || Object.hasOwn(servers, "outlook")) return servers;
  return { ...servers, outlook: spec };
}

function microsoftAuthorize(tenant: string): string {
  return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`;
}

function microsoftToken(tenant: string): string {
  return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
}

export class OutlookMail {
  private readonly file: string;
  private readonly gate: string;
  private readonly fetchImpl: typeof fetch;
  private readonly authorizeEndpoint: (tenant: string) => string;
  private readonly tokenEndpoint: (tenant: string) => string;
  private readonly graphBase: string;
  private readonly lifetimeMs: number;
  private readonly isOwnerLive: (owner: string) => boolean;
  private flow: Flow | null = null;
  private refreshing: Promise<string | null> | null = null;
  /** The loopback callback port is fixed, so the next sign-in waits until the previous listener has released it. */
  private listenerClosed: Promise<void> = Promise.resolve();

  constructor(options: {
    file: string;
    fetch?: typeof fetch;
    authorizeEndpoint?: (tenant: string) => string;
    tokenEndpoint?: (tenant: string) => string;
    graphBase?: string;
    lifetimeMs?: number;
    isOwnerLive?: (owner: string) => boolean;
    gate?: string;
  }) {
    this.file = options.file;
    this.fetchImpl = options.fetch ?? fetch;
    this.authorizeEndpoint = options.authorizeEndpoint ?? microsoftAuthorize;
    this.tokenEndpoint = options.tokenEndpoint ?? microsoftToken;
    this.graphBase = options.graphBase ?? GRAPH_BASE;
    this.lifetimeMs = options.lifetimeMs ?? DEFAULT_LIFETIME_MS;
    this.isOwnerLive = options.isOwnerLive ?? (() => true);
    this.gate = options.gate ?? randomBytes(32).toString("base64url");
  }

  /** Process-local bearer for the loopback MCP route. Not the Graph token. */
  gateToken(): string {
    return this.gate;
  }

  redirectUri(): string {
    return mcpOAuthRedirectUri(OUTLOOK_IDENTITY_URL);
  }

  status(): OutlookPublicStatus {
    const stored = this.read();
    return {
      auth: !stored ? "none" : stored.tokens ? "signed-in" : "needs-sign-in",
      redirectUri: this.redirectUri(),
      tenant: stored?.tenant ?? "common",
    };
  }

  /** Remote MCP descriptor for a turn. Null until a mailbox is signed in. */
  engineSpec(port: number): McpServerSpec | null {
    if (this.status().auth !== "signed-in") return null;
    return {
      type: "http",
      url: `http://127.0.0.1:${port}${OUTLOOK_MCP_PATH}`,
      headers: { Authorization: `Bearer ${this.gate}` },
    };
  }

  /** Loopback plus the process gate. Anything else is treated as absent. */
  allowsMcp(req: IncomingMessage): boolean {
    const header = req.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
    if (!sameSecret(header.slice("Bearer ".length), this.gate)) return false;
    return loopbackPeer(req.socket?.remoteAddress);
  }

  async handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === "DELETE") {
      res.writeHead(202).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST" }).end();
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(await readRaw(req, 65_536));
    } catch {
      writeJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON." } });
      return;
    }
    const outcome = await this.dispatch(message);
    if (outcome.status === 202) {
      res.writeHead(202).end();
      return;
    }
    writeJson(res, outcome.status, outcome.body);
  }

  async dispatch(message: unknown): Promise<{ status: number; body?: unknown }> {
    if (!isRecord(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      return { status: 200, body: { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request." } } };
    }
    const id = message.id;
    if (id === undefined) return { status: 202 };
    if (message.method === "initialize") {
      return {
        status: 200,
        body: {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "outlook", version: "1" },
          },
        },
      };
    }
    if (message.method === "ping") return { status: 200, body: { jsonrpc: "2.0", id, result: {} } };
    if (message.method === "tools/list") {
      return { status: 200, body: { jsonrpc: "2.0", id, result: { tools: TOOLS } } };
    }
    if (message.method === "tools/call") {
      const params = isRecord(message.params) ? message.params : {};
      const name = typeof params.name === "string" ? params.name : "";
      const text = await this.callTool(name, params.arguments);
      const isError = text.ok === false;
      return {
        status: 200,
        body: {
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: text.text }], ...(isError ? { isError: true } : {}) },
        },
      };
    }
    return { status: 200, body: { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found." } } };
  }

  async route(input: {
    method: string;
    path: string;
    owner: string;
    body?: unknown;
    restricted: boolean;
  }): Promise<{ status: number; body: unknown } | null> {
    if (input.method === "GET" && input.path === "/api/outlook") return { status: 200, body: this.status() };
    if (input.method === "POST" && input.path === "/api/outlook/sign-out") {
      this.signOut();
      return { status: 200, body: this.status() };
    }
    const match = /^\/api\/outlook\/sign-in(?:\/([0-9a-f-]{36}))?$/.exec(input.path);
    if (!match) return null;
    const flowId = match[1];
    if (input.restricted && input.method === "POST" && !flowId) {
      return { status: 403, body: { error: "This workspace does not allow a direct Outlook mailbox." } };
    }
    if (input.method === "GET" && flowId) {
      const status = this.flowStatus(flowId, input.owner);
      return status
        ? { status: 200, body: { auth: status } }
        : { status: 404, body: { error: "This sign-in is no longer available in this browser. Start again." } };
    }
    if (input.method === "DELETE" && flowId) {
      this.cancelFlow(input.owner, flowId);
      return { status: 200, body: { ok: true } };
    }
    if (input.method === "POST" && flowId) {
      const callbackUrl = isRecord(input.body) && typeof input.body.callbackUrl === "string" ? input.body.callbackUrl : "";
      if (!callbackUrl.trim()) return { status: 400, body: { error: "A complete callbackUrl is required." } };
      return { status: 200, body: { auth: await this.completeCallback(flowId, callbackUrl, input.owner) } };
    }
    if (input.method === "POST" && !flowId) {
      const started = await this.start(input.body, input.owner);
      return { status: 200, body: { auth: started } };
    }
    return { status: 405, body: { error: "method not allowed" } };
  }

  cancel(owner: string): void {
    if (this.flow?.owner === owner) this.finish(this.flow, "cancelled", "Sign-in cancelled.");
  }

  dispose(): void {
    if (this.flow) this.finish(this.flow, "cancelled", "Sign-in cancelled.");
  }

  private async start(body: unknown, owner: string): Promise<OutlookSignInStatus> {
    const record = isRecord(body) ? body : {};
    const stored = this.read();
    const clientId = typeof record.clientId === "string" ? record.clientId.trim() : stored?.clientId ?? "";
    const clientSecret = typeof record.clientSecret === "string" ? record.clientSecret.trim() : stored?.clientSecret ?? "";
    const tenantInput = typeof record.tenant === "string" ? record.tenant : stored?.tenant;
    const tenant = outlookTenant(tenantInput);
    if (!clientId || clientId.length > 256 || /[\r\n]/.test(clientId)) throw new Error("Enter the client ID from the Microsoft app.");
    if (!clientSecret || clientSecret.length > 1024 || /[\r\n]/.test(clientSecret)) throw new Error("Enter the client secret from the Microsoft app.");
    if (!tenant) throw new Error("Use common, organizations, consumers, or a tenant ID.");
    if (this.flow?.status.phase === "waiting") this.finish(this.flow, "cancelled", "Sign-in cancelled.");
    await this.listenerClosed;
    const previous = this.read();
    const sameApp = previous?.clientId === clientId && previous.tenant === tenant;
    this.write({
      clientId,
      clientSecret,
      tenant,
      ...(sameApp && previous.tokens ? { tokens: previous.tokens } : {}),
    });
    const redirectUri = this.redirectUri();
    const server = createServer();
    try {
      await listen(server, mcpOAuthRedirectPort(OUTLOOK_IDENTITY_URL));
    } catch {
      server.close();
      throw new Error(`Port ${mcpOAuthRedirectPort(OUTLOOK_IDENTITY_URL)} on this computer is in use, and Outlook sign-in returns there. Close what is using it and try again.`);
    }
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    const authorize = outlookAuthorizeUrl({
      endpoint: this.authorizeEndpoint(tenant),
      clientId,
      redirectUri,
      state,
      challenge: createHash("sha256").update(verifier).digest("base64url"),
    });
    if ([...authorize.searchParams.keys()].includes("resource")) {
      server.close();
      throw new Error("Outlook sign-in was built with the wrong audience.");
    }
    const status: OutlookSignInStatus = {
      phase: "waiting",
      flowId: randomUUID(),
      authorizationUrl: authorize.toString(),
      expiresAt: new Date(Date.now() + this.lifetimeMs).toISOString(),
    };
    const flow: Flow = {
      owner, status, state, verifier, redirectUri, clientId, clientSecret, tenant, server, consumed: false,
      expiry: setTimeout(() => this.finish(flow, "expired", "Sign-in expired. Start again."), this.lifetimeMs),
    };
    flow.expiry.unref?.();
    server.on("request", (request, response) => void this.callback(flow, request, response));
    this.flow = flow;
    return { ...status };
  }

  private async callback(flow: Flow, request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.setHeader("Referrer-Policy", "no-referrer");
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
      if (request.method !== "GET") throw new Error("method");
      await this.acceptCallback(flow, callback);
      response.end(flow.status.phase === "failed"
        ? `${flow.status.message ?? "Sign-in failed."} You can close this tab.`
        : "Signed in. You can close this tab and return to OpenMausBot.");
    } catch {
      response.writeHead(400).end("Invalid or expired sign-in. Return to OpenMausBot and try again.");
    }
  }

  private async acceptCallback(flow: Flow, callback: URL): Promise<void> {
    if (!this.isOwnerLive(flow.owner)) this.finish(flow, "cancelled", "Your session ended. Start again.");
    if (flow.status.phase === "waiting" && !flow.consumed && flow.status.expiresAt && Date.now() >= Date.parse(flow.status.expiresAt)) {
      this.finish(flow, "expired", "Sign-in expired. Start again.");
    }
    if (flow.consumed || flow.status.phase !== "waiting" || this.flow !== flow) {
      throw new Error("ended");
    }
    const expected = new URL(flow.redirectUri);
    const params = callback.searchParams;
    const code = params.get("code");
    const error = params.get("error");
    if (callback.origin !== expected.origin || callback.pathname !== expected.pathname
      || callback.username || callback.password || callback.hash
      || [...params.keys()].some((key) => params.getAll(key).length !== 1)
      || !sameSecret(params.get("state") ?? "", flow.state)
      || !((code && !error && code.length <= 4096) || (error && !code))) {
      throw new Error("mismatch");
    }
    flow.consumed = true;
    clearTimeout(flow.expiry);
    const failure = error ? "Sign-in was not approved." : await this.exchange(flow, code!);
    this.finish(flow, failure ? "failed" : "succeeded", failure ?? undefined);
  }

  private async exchange(flow: Flow, code: string): Promise<string | null> {
    try {
      const body = await this.tokenRequest(flow.tenant, {
        grant_type: "authorization_code",
        code,
        redirect_uri: flow.redirectUri,
        client_id: flow.clientId,
        client_secret: flow.clientSecret,
        code_verifier: flow.verifier,
        scope: OUTLOOK_SCOPES.join(" "),
      });
      const tokens = tokensFrom(body);
      if (!tokens?.refresh) return "Microsoft did not return a refresh token. Include offline access on the app and start again.";
      if (!scopesAllowMail(tokens.scope)) return "Microsoft did not grant mail read and send. Start again.";
      if (!this.isOwnerLive(flow.owner) || this.flow !== flow || flow.status.phase !== "waiting") return "Your session ended. Start again.";
      this.write({ clientId: flow.clientId, clientSecret: flow.clientSecret, tenant: flow.tenant, tokens });
      return null;
    } catch {
      return "Could not reach Microsoft sign-in. Start again.";
    }
  }

  private async completeCallback(flowId: string, callbackUrl: string, owner: string): Promise<OutlookSignInStatus> {
    const flow = this.flow;
    if (!flow || flow.status.flowId !== flowId || flow.owner !== owner) {
      return { phase: "failed", flowId, authorizationUrl: null, message: "This sign-in is no longer available. Start again." };
    }
    let callback: URL;
    try {
      callback = new URL(callbackUrl.trim());
    } catch {
      return { phase: "failed", flowId, authorizationUrl: null, message: "That is not a callback URL." };
    }
    try {
      await this.acceptCallback(flow, callback);
    } catch {
      return { ...flow.status, message: flow.status.message ?? "This redirect URL does not belong to the current sign-in." };
    }
    return { ...flow.status };
  }

  private flowStatus(flowId: string, owner: string): OutlookSignInStatus | null {
    if (!this.flow || this.flow.status.flowId !== flowId || this.flow.owner !== owner) return null;
    return { ...this.flow.status };
  }

  private cancelFlow(owner: string, flowId?: string): void {
    if (!this.flow || this.flow.owner !== owner) return;
    if (flowId && this.flow.status.flowId !== flowId) return;
    this.finish(this.flow, "cancelled", "Sign-in cancelled.");
  }

  private finish(flow: Flow, phase: OutlookSignInStatus["phase"], message?: string): void {
    if (flow.status.phase !== "waiting") return;
    clearTimeout(flow.expiry);
    const server = flow.server;
    server.closeIdleConnections?.();
    this.listenerClosed = new Promise((resolve) => server.close(() => resolve()));
    flow.status = { ...flow.status, phase, authorizationUrl: null, ...(message ? { message } : {}) };
  }

  signOut(): void {
    const stored = this.read();
    if (!stored) return;
    this.write({ clientId: stored.clientId, clientSecret: stored.clientSecret, tenant: stored.tenant });
  }

  private async callTool(name: string, args: unknown): Promise<{ ok: boolean; text: string }> {
    const planned = outlookGraphCall(name, args);
    if (!planned.ok) return { ok: false, text: planned.error };
    if (this.status().auth !== "signed-in") return { ok: false, text: "Outlook is not signed in on this computer." };
    try {
      const response = await this.graph(planned.request);
      if (response.status === 401) return { ok: false, text: "Outlook sign-in expired. Sign in again in Plugins." };
      if (response.status === 403) return { ok: false, text: "Microsoft refused this mailbox call. The app needs Mail.ReadWrite and Mail.Send." };
      if (response.status < 200 || response.status >= 300) return { ok: false, text: graphError(response.json, response.status) };
      return { ok: true, text: renderTool(name, response.json) };
    } catch {
      return { ok: false, text: "Microsoft Graph did not answer." };
    }
  }

  private async graph(request: OutlookGraphRequest, retried = false): Promise<{ status: number; json: unknown }> {
    const token = await this.accessToken();
    if (!token) return { status: 401, json: null };
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      ...request.headers,
    };
    if (request.body !== undefined) headers["content-type"] = "application/json";
    const response = await this.fetchImpl(`${this.graphBase}${request.path}`, {
      method: request.method,
      headers,
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const json = await response.json().catch(() => null);
    if (response.status === 401 && !retried) {
      this.dropAccess();
      const refreshed = await this.accessToken();
      if (refreshed) return this.graph(request, true);
    }
    return { status: response.status, json };
  }

  private dropAccess(): void {
    const stored = this.read();
    if (!stored?.tokens) return;
    this.write({ ...stored, tokens: { ...stored.tokens, expiresAt: 0 } });
  }

  private async accessToken(): Promise<string | null> {
    const stored = this.read();
    if (!stored?.tokens) return null;
    if (stored.tokens.expiresAt === undefined || stored.tokens.expiresAt - Date.now() > REFRESH_MARGIN_MS) {
      return stored.tokens.access;
    }
    this.refreshing ??= this.refresh(stored).finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private async refresh(stored: Stored): Promise<string | null> {
    const refresh = stored.tokens?.refresh;
    if (!refresh) {
      this.write({ clientId: stored.clientId, clientSecret: stored.clientSecret, tenant: stored.tenant });
      return null;
    }
    try {
      const body = await this.tokenRequest(stored.tenant, {
        grant_type: "refresh_token",
        refresh_token: refresh,
        client_id: stored.clientId,
        client_secret: stored.clientSecret,
        scope: OUTLOOK_SCOPES.join(" "),
      });
      const tokens = tokensFrom(body, stored.tokens);
      if (!tokens?.refresh || !scopesAllowMail(tokens.scope)) {
        this.write({ clientId: stored.clientId, clientSecret: stored.clientSecret, tenant: stored.tenant });
        return null;
      }
      const current = this.read();
      if (!current || current.clientId !== stored.clientId) return null;
      this.write({ clientId: stored.clientId, clientSecret: stored.clientSecret, tenant: stored.tenant, tokens });
      return tokens.access;
    } catch {
      if (!stored.tokens?.expiresAt) {
        this.write({ clientId: stored.clientId, clientSecret: stored.clientSecret, tenant: stored.tenant });
      }
      return null;
    }
  }

  private async tokenRequest(tenant: string, fields: Record<string, string>): Promise<Record<string, unknown>> {
    if ("resource" in fields) throw new Error("resource");
    const response = await this.fetchImpl(this.tokenEndpoint(tenant), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(fields).toString(),
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const parsed: unknown = await response.json().catch(() => null);
    if (!response.ok || !isRecord(parsed)) throw new Error("token");
    return parsed;
  }

  private read(): Stored | null {
    try {
      const parsed = fileSchema.safeParse(JSON.parse(readFileSync(this.file, "utf8")));
      if (!parsed.success) return null;
      return outlookTenant(parsed.data.tenant) ? parsed.data : null;
    } catch {
      return null;
    }
  }

  private write(data: Stored): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileAtomic(this.file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  }
}

const TOOLS = [
  {
    name: "list_messages",
    description: "List recent messages in the signed-in Outlook mailbox. Does not send mail.",
    inputSchema: {
      type: "object",
      properties: {
        folder: { type: "string", description: "inbox, drafts, sentitems, deleteditems, junkemail, or archive. Default inbox." },
        top: { type: "integer", minimum: 1, maximum: 25 },
        query: { type: "string", description: "Optional search, such as from:alice subject:invoice." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_message",
    description: "Read one Outlook message by id. The body is truncated. Does not send mail.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "create_draft",
    description: "Save a draft in the signed-in Outlook mailbox. Does not send it.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient addresses, separated by commas." },
        cc: { type: "string" },
        subject: { type: "string" },
        body: { type: "string" },
      },
      required: ["to", "subject", "body"],
      additionalProperties: false,
    },
  },
  {
    name: "send_mail",
    description: "Send an email from the signed-in Outlook mailbox. This leaves the computer and waits for approval.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient addresses, separated by commas." },
        cc: { type: "string" },
        subject: { type: "string" },
        body: { type: "string" },
      },
      required: ["to", "subject", "body"],
      additionalProperties: false,
    },
  },
] as const;

function listCall(args: Record<string, unknown>): { ok: true; request: OutlookGraphRequest } | { ok: false; error: string } {
  const folder = args.folder === undefined ? "inbox" : typeof args.folder === "string" ? args.folder.trim().toLowerCase() : "";
  if (!FOLDERS.has(folder)) return { ok: false, error: "Folder must be inbox, drafts, sentitems, deleteditems, junkemail, or archive." };
  const top = boundedInt(args.top, 15);
  if (top === null) return { ok: false, error: "top must be an integer from 1 to 25." };
  const query = searchQuery(args.query);
  if (query === null) return { ok: false, error: "query must be plain text, at most 200 characters, without quotes." };
  if (query) {
    const params = new URLSearchParams();
    params.set("$search", `"${query}"`);
    params.set("$top", String(top));
    params.set("$select", LIST_SELECT);
    return { ok: true, request: { method: "GET", path: `/me/messages?${params}`, headers: { ConsistencyLevel: "eventual" } } };
  }
  const params = new URLSearchParams();
  params.set("$top", String(top));
  params.set("$select", LIST_SELECT);
  params.set("$orderby", "receivedDateTime desc");
  return { ok: true, request: { method: "GET", path: `/me/mailFolders/${folder}/messages?${params}` } };
}

function getCall(args: Record<string, unknown>): { ok: true; request: OutlookGraphRequest } | { ok: false; error: string } {
  const id = messageId(args.id);
  if (!id) return { ok: false, error: "A message id is required." };
  const params = new URLSearchParams();
  params.set("$select", MESSAGE_SELECT);
  return { ok: true, request: { method: "GET", path: `/me/messages/${encodeURIComponent(id)}?${params}` } };
}

function draftCall(args: Record<string, unknown>): { ok: true; request: OutlookGraphRequest } | { ok: false; error: string } {
  const message = mailMessage(args);
  if (!message.ok) return message;
  return { ok: true, request: { method: "POST", path: "/me/messages", body: message.message } };
}

function sendCall(args: Record<string, unknown>): { ok: true; request: OutlookGraphRequest } | { ok: false; error: string } {
  const message = mailMessage(args);
  if (!message.ok) return message;
  return { ok: true, request: { method: "POST", path: "/me/sendMail", body: { message: message.message, saveToSentItems: true } } };
}

function mailMessage(args: Record<string, unknown>): { ok: true; message: Record<string, unknown> } | { ok: false; error: string } {
  const to = addresses(args.to);
  if ("error" in to) return { ok: false, error: to.error };
  const cc = args.cc === undefined || args.cc === "" ? [] : addresses(args.cc);
  if ("error" in cc) return { ok: false, error: cc.error };
  if (typeof args.subject !== "string" || !args.subject.trim() || args.subject.length > 255 || /[\r\n]/.test(args.subject)) {
    return { ok: false, error: "Subject must be one line, at most 255 characters." };
  }
  if (typeof args.body !== "string" || args.body.length > SEND_BODY_CAP) {
    return { ok: false, error: "Body must be text, at most 20000 characters." };
  }
  return { ok: true, message: {
    subject: args.subject.trim(),
    body: { contentType: "Text", content: args.body },
    toRecipients: to.map(recipient),
    ...(cc.length ? { ccRecipients: cc.map(recipient) } : {}),
  } };
}

function recipient(address: string): { emailAddress: { address: string } } {
  return { emailAddress: { address } };
}

function addresses(value: unknown): string[] | { error: string } {
  if (typeof value !== "string") return { error: "Enter recipient email addresses." };
  const parts = value.split(/[,;]/).map((part) => part.trim()).filter(Boolean);
  if (!parts.length || parts.length > 20) return { error: "Enter between 1 and 20 email addresses." };
  if (parts.some((part) => part.length > 320 || /[\r\n\s]/.test(part) || !/^[^@]+@[^@]+\.[^@]+$/.test(part))) {
    return { error: "Each recipient must be an email address." };
  }
  return parts;
}

function messageId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  if (!id || id.length > 1024 || /[\r\n\0?#\\]/.test(id) || id.includes("..") || id.startsWith("/")) return null;
  return id;
}

function searchQuery(value: unknown): string | null | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") return null;
  const query = value.trim();
  if (!query || query.length > 200 || /[\r\n\0"]/.test(query)) return null;
  return query;
}

function boundedInt(value: unknown, fallback: number): number | null {
  if (value === undefined) return fallback;
  const number = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof number !== "number" || !Number.isInteger(number) || number < 1 || number > 25) return null;
  return number;
}

function renderTool(name: string, json: unknown): string {
  if (name === "list_messages") return renderList(json);
  if (name === "get_message") return renderMessage(json);
  if (name === "create_draft") {
    const id = isRecord(json) && typeof json.id === "string" ? json.id : "";
    return id ? `Draft saved. id: ${id}` : "Draft saved.";
  }
  if (name === "send_mail") return "Sent.";
  return "Done.";
}

function renderList(json: unknown): string {
  const value = isRecord(json) && Array.isArray(json.value) ? json.value : [];
  if (!value.length) return "No messages.";
  return value.slice(0, 25).map((item) => {
    if (!isRecord(item)) return "";
    return [
      `id: ${text(item.id)}`,
      `from: ${emailText(item.from)}`,
      `date: ${text(item.receivedDateTime)}`,
      `unread: ${item.isRead === false ? "yes" : "no"}`,
      `subject: ${text(item.subject)}`,
      `preview: ${text(item.bodyPreview).slice(0, 200)}`,
    ].join("\n");
  }).filter(Boolean).join("\n\n").slice(0, 8_000);
}

function renderMessage(json: unknown): string {
  if (!isRecord(json)) return "Message was empty.";
  const body = isRecord(json.body) ? plainBody(json.body) : text(json.bodyPreview);
  return [
    `id: ${text(json.id)}`,
    `from: ${emailText(json.from)}`,
    `to: ${recipientText(json.toRecipients)}`,
    `cc: ${recipientText(json.ccRecipients)}`,
    `date: ${text(json.receivedDateTime)}`,
    `draft: ${json.isDraft === true ? "yes" : "no"}`,
    `subject: ${text(json.subject)}`,
    "",
    body.length > BODY_CAP ? `${body.slice(0, BODY_CAP)}\n[truncated]` : body,
  ].join("\n");
}

function plainBody(body: Record<string, unknown>): string {
  const content = text(body.content);
  if (body.contentType === "html" || body.contentType === "HTML") {
    return content
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/\s+/g, " ")
      .trim();
  }
  return content;
}

function emailText(value: unknown): string {
  if (!isRecord(value) || !isRecord(value.emailAddress)) return "";
  const name = text(value.emailAddress.name);
  const address = text(value.emailAddress.address);
  return name && address ? `${name} <${address}>` : address || name;
}

function recipientText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value.map(emailText).filter(Boolean).join(", ");
}

function graphError(json: unknown, status: number): string {
  const message = isRecord(json) && isRecord(json.error) && typeof json.error.message === "string" ? json.error.message : "";
  const clean = message.replace(/\s+/g, " ").slice(0, 180);
  return clean ? `Microsoft Graph returned ${status}: ${clean}` : `Microsoft Graph returned ${status}.`;
}

function tokensFrom(body: Record<string, unknown>, previous?: Tokens): Tokens | null {
  if (typeof body.access_token !== "string" || !body.access_token) return null;
  const refresh = typeof body.refresh_token === "string" && body.refresh_token ? body.refresh_token : previous?.refresh;
  return {
    access: body.access_token,
    ...(refresh ? { refresh } : {}),
    ...(typeof body.expires_in === "number" && body.expires_in > 0 ? { expiresAt: Date.now() + body.expires_in * 1000 } : {}),
    ...(typeof body.scope === "string" ? { scope: body.scope } : {}),
  };
}

function scopesAllowMail(scope: string | undefined): boolean {
  if (!scope) return true;
  return scope.includes("Mail.ReadWrite") && scope.includes("Mail.Send");
}

function sameSecret(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function loopbackPeer(address: string | undefined): boolean {
  if (!address) return false;
  if (isLoopbackHost(address)) return true;
  return address.startsWith("::ffff:") && isLoopbackHost(address.slice("::ffff:".length));
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

function readRaw(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    let bytes = 0;
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > limit) {
        reject(new Error("large"));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.replace(/[\r\n]+/g, " ").trim() : "";
}
