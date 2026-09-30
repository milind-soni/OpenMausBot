import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import { writeFileAtomic } from "../atomic.ts";
import type { ModelCatalog, ProviderAuthenticationStart, ProviderAuthenticationStatus, ProviderSnapshot } from "../contracts.ts";

const ISSUER = "https://auth.openai.com";
const RESOURCE = "https://api.openai.com/v1";
const DIRECT_SCOPE = "chatgpt.tokens.use.direct";
const SCOPES = `openid profile email offline_access resource.invoke ${DIRECT_SCOPE}`;
const LIFETIME = 15 * 60_000;
const TERMINAL_REFRESH = new Set(["invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused"]);
const SIGN_IN = "Continue with ChatGPT in Settings to use your ChatGPT plan.";
const CONSENT = "ChatGPT plan usage is not enabled. Continue with ChatGPT in Settings and allow plan usage, or explicitly choose another provider.";

type Credentials = {
  clientId: string; subject: string; email?: string; hostId: string;
  tokens?: { access: string; refresh: string; id: string; scopes: string[]; expiresAt: number; earliestRefreshAt?: number };
};
type Flow = {
  status: ProviderAuthenticationStatus; state: string; nonce: string; verifier: string;
  redirectUri: string; previous: Credentials | null; clientId: string | null; hostId: string; consumed: boolean;
  server: Server; expiry: NodeJS.Timeout; abort: AbortController;
};

interface Options {
  /** A private per-instance directory. Its parent is shared by this host's ChatGPT accounts. */
  directory: string;
  onAuthenticated?: () => Promise<void>;
  /** Synthetic loopback endpoints only; never read from provider configuration. */
  testServerUrl?: string;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid ChatGPT response.");
  return value as Record<string, unknown>;
}
function string(value: unknown, max = 65_536): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}
function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) throw new Error("ChatGPT credential storage must be a private directory.");
  chmodSync(path, 0o700);
}
function readJson(path: string): unknown | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512_000) throw new Error("Invalid credential storage.");
    chmodSync(path, 0o600);
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("ChatGPT credential storage could not be read safely. Check its permissions before signing in.");
  }
}

// A file lock protects rotating refresh tokens across processes as well as instances.
// Fail closed on an abandoned lock: never risk reusing a refresh token while its
// previous owner might still be exchanging it. The safe recovery is reauthorization
// after an administrator confirms the old process has stopped and removes the lock.
async function locked<T>(directory: string, operation: () => Promise<T>): Promise<T> {
  const path = join(directory, ".credentials.lock");
  const deadline = Date.now() + 30_000;
  let fd: number;
  for (;;) {
    try { fd = openSync(path, "wx", 0o600); break; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new Error("ChatGPT credentials could not be locked safely.");
      if (Date.now() >= deadline) throw new Error("ChatGPT credentials are busy. If another app process crashed, stop it and remove its abandoned credential lock before trying again.");
      await delay(50);
    }
  }
  try {
    writeFileSync(fd, String(process.pid));
    return await operation();
  } finally { closeSync(fd); unlinkSync(path); }
}

/** Server-owned OAuth credentials. Only safe status and the one-time authorization URL reach the renderer. */
export class ChatGptPlanAuthController {
  private readonly options: Options;
  private readonly issuer: string;
  private readonly resource: string;
  private flow: Flow | null = null;
  private disposed = false;
  private starting: Promise<ProviderAuthenticationStart> | null = null;
  private retryClientId: string | null = null;

  constructor(options: Options) {
    if (!isAbsolute(options.directory)) throw new Error("ChatGPT credential storage must use an absolute path.");
    if (options.testServerUrl) {
      const url = new URL(options.testServerUrl);
      if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
        throw new Error("ChatGPT test endpoints must be a loopback origin.");
      }
      this.issuer = url.origin;
      this.resource = `${url.origin}/v1`;
    } else { this.issuer = ISSUER; this.resource = RESOURCE; }
    this.options = options;
  }

  private prepare(): void {
    privateDirectory(dirname(this.options.directory));
    privateDirectory(this.options.directory);
  }
  private read(): Credentials | null {
    const raw = readJson(join(this.options.directory, "credentials.json"));
    if (raw === null) return null;
    const record = object(raw);
    if (!string(record.clientId, 256) || record.clientId === "dynamic_agent_client" || !string(record.subject, 512) || !string(record.hostId, 128)
      || (record.email !== undefined && !string(record.email, 320))) throw new Error("Saved ChatGPT registration is invalid. Check credential storage before signing in.");
    if (record.tokens !== undefined) {
      const tokens = object(record.tokens);
      if (!string(tokens.access) || typeof tokens.refresh !== "string" || tokens.refresh.length > 65_536 || !string(tokens.id) || !Array.isArray(tokens.scopes)
        || !tokens.scopes.every((scope) => string(scope, 256)) || typeof tokens.expiresAt !== "number" || !Number.isFinite(tokens.expiresAt)
        || (tokens.scopes.includes(DIRECT_SCOPE) && !tokens.refresh)
        || (tokens.earliestRefreshAt !== undefined && (typeof tokens.earliestRefreshAt !== "number" || !Number.isFinite(tokens.earliestRefreshAt)))) {
        throw new Error("Saved ChatGPT credentials are invalid. Continue with ChatGPT again.");
      }
    }
    return record as Credentials;
  }
  private save(record: Credentials): void {
    writeFileAtomic(join(this.options.directory, "credentials.json"), JSON.stringify(record), { mode: 0o600 });
  }
  private async hostId(): Promise<string> {
    const parent = dirname(this.options.directory);
    return locked(parent, async () => {
      const path = join(parent, "host-id.json");
      const saved = readJson(path);
      if (saved !== null) {
        const value = object(saved).hostId;
        if (!string(value) || !/^urn:uuid:[0-9a-f-]{36}$/i.test(value)) throw new Error("Saved ChatGPT host identity is invalid.");
        return value;
      }
      const value = `urn:uuid:${randomUUID()}`;
      writeFileAtomic(path, JSON.stringify({ hostId: value }), { mode: 0o600 });
      return value;
    });
  }
  private async request(url: string, init: RequestInit = {}): Promise<{ response: Response; body: Record<string, unknown> }> {
    try {
      const response = await fetch(url, { ...init, redirect: "error", signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) });
      if (Number(response.headers.get("content-length")) > 1_048_576) throw new Error("Oversized response.");
      const reader = response.body?.getReader();
      let size = 0;
      const chunks: Uint8Array[] = [];
      if (reader) {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 1_048_576) { await reader.cancel(); throw new Error("Oversized response."); }
          chunks.push(value);
        }
      }
      const text = Buffer.concat(chunks).toString("utf8");
      return { response, body: text ? object(JSON.parse(text)) : {} };
    } catch {
      throw new Error("Could not securely contact ChatGPT. Check your connection and try again; your saved account has not been removed.");
    }
  }
  private async exchange(params: URLSearchParams, signal?: AbortSignal) {
    return this.request(`${this.issuer}/api/accounts/oauth/token`, { method: "POST", body: params, signal });
  }
  private tokenSet(body: Record<string, unknown>, previous?: Credentials["tokens"]): NonNullable<Credentials["tokens"]> {
    if (!string(body.access_token) || typeof body.token_type !== "string" || body.token_type.toLowerCase() !== "bearer"
      || typeof body.expires_in !== "number" || !Number.isFinite(body.expires_in) || body.expires_in <= 0 || body.expires_in > 86_400
      || (body.scope !== undefined && typeof body.scope !== "string")
      || (body.id_token !== undefined && !string(body.id_token))) throw new Error("ChatGPT returned incomplete credentials. Continue with ChatGPT again.");
    const id = string(body.id_token) ? body.id_token : previous?.id;
    if (!id) throw new Error("ChatGPT did not return a verifiable identity. Continue with ChatGPT again.");
    const scopes = typeof body.scope === "string" ? body.scope.split(/\s+/).filter(Boolean) : previous?.scopes;
    if (!scopes) throw new Error("ChatGPT did not confirm granted permissions. Continue with ChatGPT again.");
    if (scopes.includes(DIRECT_SCOPE) && !string(body.refresh_token)) throw new Error("ChatGPT did not provide renewable plan access. Continue with ChatGPT again.");
    return { access: body.access_token, refresh: string(body.refresh_token) ? body.refresh_token : "", id, scopes, expiresAt: Date.now() + body.expires_in * 1000,
      ...(typeof body.earliest_refresh_at === "number" && Number.isFinite(body.earliest_refresh_at) ? { earliestRefreshAt: body.earliest_refresh_at * 1000 } : {}) };
  }
  private async identityKeys(signal?: AbortSignal) {
    const { response, body } = await this.request(`${this.issuer}/.well-known/jwks.json`, { signal });
    if (!response.ok) throw new Error("ChatGPT identity keys are unavailable. Try signing in again later.");
    try {
      if (!Array.isArray(body.keys) || body.keys.length === 0) throw new Error("Empty identity keys.");
      return createLocalJWKSet(body as unknown as JSONWebKeySet);
    }
    catch { throw new Error("ChatGPT identity keys could not be verified. Try signing in again later."); }
  }
  private async identity(id: string, clientId: string, keys: ReturnType<typeof createLocalJWKSet>, nonce?: string) {
    try {
      const { payload } = await jwtVerify(id, keys, {
        issuer: this.issuer, audience: clientId, algorithms: ["RS256", "ES256"], requiredClaims: ["sub", "exp", "iat"], clockTolerance: 30,
      });
      if (!string(payload.sub, 512) || typeof payload.iat !== "number" || payload.iat > Date.now() / 1000 + 30
        || (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId)
        || (nonce !== undefined && payload.nonce !== nonce)) throw new Error("Identity mismatch.");
      return { subject: payload.sub, ...(string(payload.email, 320) ? { email: payload.email } : {}) };
    } catch { throw new Error("ChatGPT identity could not be verified. No account was replaced. Start sign-in again."); }
  }

  async start(): Promise<ProviderAuthenticationStart> {
    if (this.starting) return this.starting;
    this.starting = this.begin();
    try { return await this.starting; } finally { this.starting = null; }
  }
  private async begin(): Promise<ProviderAuthenticationStart> {
    if (this.disposed) throw new Error("This provider was removed. Refresh Settings before signing in.");
    if (this.flow?.status.phase === "waiting") return { ...this.flow.status, phase: "waiting" };
    this.prepare();
    const previous = this.read();
    const clientId = previous?.clientId ?? this.retryClientId;
    const hostId = await this.hostId();
    if (previous && previous.hostId !== hostId) throw new Error("This ChatGPT registration belongs to another host. Sign in using a new account entry on this host.");
    const state = randomBytes(32).toString("base64url");
    const nonce = randomBytes(32).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    const server = createServer((request, response) => {
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Content-Type", "text/plain; charset=utf-8");
      response.setHeader("Referrer-Policy", "no-referrer");
      const flow = this.flow;
      let callback: URL;
      try {
        if (!flow || request.headers.host !== new URL(flow.redirectUri).host || !request.url?.startsWith("/")) throw new Error("Unexpected callback host.");
        callback = new URL(request.url, flow.redirectUri);
        if (callback.origin !== new URL(flow.redirectUri).origin) throw new Error("Unexpected callback origin.");
      } catch {
        response.writeHead(400).end("Invalid sign-in callback. Return to OpenMausBot and try again."); return;
      }
      const actual = callback.searchParams.get("state") ?? "";
      if (request.method !== "GET" || callback.pathname !== "/auth/callback" || !flow || flow.server !== server || flow.consumed || flow.status.phase !== "waiting"
        || Buffer.byteLength(actual) !== Buffer.byteLength(flow.state) || !timingSafeEqual(Buffer.from(actual), Buffer.from(flow.state))
        || [...callback.searchParams.keys()].some((key) => callback.searchParams.getAll(key).length !== 1)) {
        response.writeHead(400).end("Invalid or expired sign-in. Return to OpenMausBot and try again."); return;
      }
      flow.consumed = true;
      response.end("Finishing sign-in. You can return to OpenMausBot.");
      server.close();
      void this.complete(flow, callback.searchParams);
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    if (this.disposed) { server.close(); throw new Error("This provider was removed."); }
    const address = server.address();
    if (!address || typeof address === "string") { server.close(); throw new Error("ChatGPT sign-in listener could not start."); }
    const redirectUri = `http://127.0.0.1:${address.port}/auth/callback`;
    const url = new URL(`${this.issuer}/api/accounts/authorize`);
    url.search = new URLSearchParams({ client_id: clientId ?? "dynamic_agent_client", ext_agent_host_id: hostId,
      ...(clientId ? {} : { agent_name_hint: "openmausbot" }), ...(previous?.email ? { login_hint: previous.email } : {}),
      ...(previous?.tokens && !previous.tokens.scopes.includes(DIRECT_SCOPE) ? { prompt: "consent" } : {}),
      response_type: "code", redirect_uri: redirectUri, scope: SCOPES, resource: this.resource, state, nonce,
      code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    }).toString();
    const status: ProviderAuthenticationStatus = { phase: "waiting", flowId: randomUUID(), authorizationUrl: url.href, expiresAt: new Date(Date.now() + LIFETIME).toISOString() };
    const flow: Flow = { status, state, nonce, verifier, redirectUri, previous, clientId, hostId, consumed: false, server, abort: new AbortController(),
      expiry: setTimeout(() => this.finish(flow, "expired", "ChatGPT sign-in expired. Start again."), LIFETIME) };
    flow.expiry.unref();
    this.flow = flow;
    return { ...status, phase: "waiting" };
  }
  private finish(flow: Flow, phase: ProviderAuthenticationStatus["phase"], message?: string): void {
    if (flow.status.phase !== "waiting") return;
    clearTimeout(flow.expiry);
    flow.server.close();
    flow.abort.abort();
    flow.status = { ...flow.status, phase, authorizationUrl: null, ...(message ? { message } : {}) };
  }
  private async complete(flow: Flow, params: URLSearchParams): Promise<void> {
    try {
      if (params.has("error")) throw new Error("ChatGPT sign-in was not approved. You can try again in Settings.");
      const clientId = params.get("client_id") ?? flow.clientId;
      const code = params.get("code");
      if (!string(clientId, 256) || clientId === "dynamic_agent_client" || (flow.clientId && flow.clientId !== clientId) || !string(code, 4096)) {
        throw new Error("ChatGPT registration was incomplete or did not match the selected account. Start sign-in again.");
      }
      const keys = await this.identityKeys(flow.abort.signal);
      const { response, body } = await this.exchange(new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, code,
        code_verifier: flow.verifier, redirect_uri: flow.redirectUri, resource: this.resource }), flow.abort.signal);
      if (!response.ok) {
        // A used/expired code must not create another client on retry. Keep
        // this issued ID only in the pending attempt until identity is verified.
        if (!flow.previous && body.error === "invalid_grant") this.retryClientId = clientId;
        throw new Error("ChatGPT could not finish this sign-in. Start again with a fresh authorization.");
      }
      const tokens = this.tokenSet(body);
      const identity = await this.identity(tokens.id, clientId, keys, flow.nonce);
      if (flow.previous && identity.subject !== flow.previous.subject) throw new Error("ChatGPT returned a different account. Use a separate account entry; the saved account was not replaced.");
      await locked(this.options.directory, async () => {
        if (this.disposed || flow.status.phase !== "waiting" || flow.abort.signal.aborted) return;
        if (JSON.stringify(this.read()) !== JSON.stringify(flow.previous)) throw new Error("The selected ChatGPT account changed during sign-in. Start again.");
        this.save({ clientId, hostId: flow.hostId, ...identity, tokens });
        this.retryClientId = null;
        this.finish(flow, tokens.scopes.includes(DIRECT_SCOPE) ? "succeeded" : "failed", tokens.scopes.includes(DIRECT_SCOPE) ? undefined : CONSENT);
      });
      if (flow.status.phase === "succeeded") await this.options.onAuthenticated?.().catch(() => {});
    } catch (error) {
      this.finish(flow, "failed", error instanceof Error ? error.message : "ChatGPT sign-in could not finish. Try again.");
    }
  }
  async get(flowId: string): Promise<ProviderAuthenticationStatus> {
    if (!flowId || this.flow?.status.flowId !== flowId) throw new Error("This sign-in is no longer available. Start again.");
    return { ...this.flow.status };
  }
  async cancel(): Promise<void> {
    await this.starting?.catch(() => {});
    if (this.flow) this.finish(this.flow, "cancelled", "ChatGPT sign-in cancelled.");
  }
  async dispose(): Promise<void> { this.disposed = true; await this.cancel(); this.flow = null; }
  async snapshot(): Promise<{ authenticated: boolean; account?: ProviderSnapshot["account"]; reason?: string }> {
    const record = this.read();
    return { authenticated: !!record?.tokens?.scopes.includes(DIRECT_SCOPE),
      ...(record ? { account: { method: "login" as const, ...(record.email ? { email: record.email } : {}), organization: `ChatGPT · ${record.clientId.slice(-8)}` } } : {}),
      ...(!record?.tokens ? { reason: SIGN_IN } : !record.tokens.scopes.includes(DIRECT_SCOPE) ? { reason: CONSENT } : {}),
    };
  }
  async accessToken(): Promise<string> {
    if (this.disposed) throw new Error("This ChatGPT provider was removed.");
    this.prepare();
    return locked(this.options.directory, async () => {
      if (this.disposed) throw new Error("This ChatGPT provider was removed.");
      const record = this.read();
      if (!record?.tokens) throw new Error(SIGN_IN);
      if (!record.tokens.scopes.includes(DIRECT_SCOPE)) throw new Error(CONSENT);
      if (record.tokens.expiresAt > Date.now() + 60_000) return record.tokens.access;
      if ((record.tokens.earliestRefreshAt ?? 0) > Date.now()) {
        if (record.tokens.expiresAt > Date.now()) return record.tokens.access;
        throw new Error("ChatGPT credentials cannot refresh yet. Please try again shortly.");
      }
      // Fetch validation keys before consuming a rotating refresh token. There
      // must be no fallible network dependency between receiving and saving its successor.
      const keys = await this.identityKeys();
      const { response, body } = await this.exchange(new URLSearchParams({ grant_type: "refresh_token", client_id: record.clientId,
        refresh_token: record.tokens.refresh, resource: this.resource }));
      if (!response.ok) {
        const code = typeof body.error === "string" ? body.error : (body.error && typeof body.error === "object" ? (body.error as Record<string, unknown>).code : undefined);
        if (typeof code === "string" && TERMINAL_REFRESH.has(code)) { delete record.tokens; this.save(record); throw new Error(SIGN_IN); }
        if (code === "invalid_client") throw new Error("ChatGPT did not accept this app registration. Check the integration configuration before trying again.");
        throw new Error("ChatGPT could not renew access right now. Try again later; your saved account has not been removed.");
      }
      let tokens: NonNullable<Credentials["tokens"]>;
      try {
        tokens = this.tokenSet(body, record.tokens);
        if (body.id_token !== undefined) {
          const identity = await this.identity(tokens.id, record.clientId, keys);
          if (identity.subject !== record.subject) throw new Error("ChatGPT returned a different account during renewal.");
        }
      } catch {
        // The old refresh token was consumed. Never retry it after an invalid
        // successor, even though the selected account/client mapping is retained.
        delete record.tokens;
        this.save(record);
        throw new Error("ChatGPT renewal could not be verified. Continue with ChatGPT again in Settings.");
      }
      this.save({ ...record, tokens });
      if (this.disposed) throw new Error("This ChatGPT provider was removed.");
      if (!tokens.scopes.includes(DIRECT_SCOPE)) throw new Error(CONSENT);
      return tokens.access;
    });
  }
  async models(): Promise<ModelCatalog> {
    if (!this.read()?.tokens?.scopes.includes(DIRECT_SCOPE)) return { default: "", options: [] };
    const token = await this.accessToken();
    const { response, body } = await this.request(`${this.resource}/models`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403
      ? "ChatGPT did not authorize model access. Check this account's plan permissions in ChatGPT Settings."
      : "ChatGPT models are unavailable right now. Try refreshing later.");
    if (!Array.isArray(body.models)) throw new Error("ChatGPT returned an invalid model catalog. No fallback models were selected.");
    const options: ModelCatalog["options"] = [];
    for (const entry of body.models) {
      if (!entry || typeof entry !== "object") continue;
      const row = entry as Record<string, unknown>;
      if (row.visibility !== "list" || !string(row.slug, 256) || /[\s\p{Cc}]/u.test(row.slug) || !string(row.display_name, 256) || options.some((item) => item.id === row.slug)) continue;
      options.push({ id: row.slug, label: row.display_name });
    }
    return { default: options[0]?.id ?? "", options };
  }
  async signOut(): Promise<void> {
    if (this.disposed) throw new Error("This provider was removed.");
    await this.cancel();
    this.prepare();
    await locked(this.options.directory, async () => {
      const record = this.read();
      if (!record?.tokens) return;
      let revoked = !record.tokens.refresh;
      try {
        if (!record.tokens.refresh) { delete record.tokens; this.save(record); return; }
        const discovery = await this.request(`${this.issuer}/.well-known/openid-configuration`);
        const endpoint = discovery.body.revocation_endpoint;
        if (discovery.response.ok && discovery.body.issuer === this.issuer && typeof endpoint === "string" && new URL(endpoint).origin === this.issuer) {
          for (let attempt = 0; attempt < 2 && !revoked; attempt++) {
            try {
              const result = await this.request(endpoint, { method: "POST", body: new URLSearchParams({ token: record.tokens.refresh, token_type_hint: "refresh_token", client_id: record.clientId }) });
              revoked = result.response.status === 200;
              if (result.response.status < 500) break;
            } catch { /* A network failure still clears local credentials below. */ }
            if (!revoked && attempt === 0) await delay(250);
          }
        }
      } catch { /* Sign-out is local even if OpenAI is temporarily unavailable. */ }
      delete record.tokens;
      this.save(record);
      if (!revoked) throw Object.assign(new Error("Signed out locally, but remote revocation was not confirmed. Disconnect OpenMausBot in ChatGPT Settings → Usage to end access there."), { code: "chatgpt_revocation_unconfirmed" });
    });
  }
}
