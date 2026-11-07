// The OpenConnector runtime-api client. One injectable fetch keeps every call mockable in tests and
// no test ever binds a port. Contract: https://github.com/oomol-lab/open-connector/blob/main/docs/runtime-api.md
// (/v1 runtime surface + /api admin surface, uniform {success, message, data, meta} envelope).
import { z } from "zod";

export const OPENCONNECTOR_REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export class OpenConnectorError extends Error {
  readonly status: number | undefined;
  /** The runtime's errorCode (unknown_action, connection_not_allowed, ...), when it reported one. */
  readonly code: string | undefined;
  /** Retry-After parsed to milliseconds, when a throttled response carried it. */
  readonly retryAfterMs: number | undefined;
  constructor(message: string, options: { status?: number; code?: string; retryAfterMs?: number } = {}) {
    super(message);
    this.name = "OpenConnectorError";
    this.status = options.status;
    this.code = options.code;
    this.retryAfterMs = options.retryAfterMs;
  }
}

/** Same rule as the managed Composio broker: no credentials in the URL, HTTPS anywhere, HTTP only on loopback. */
export function normalizeOpenConnectorBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("The OpenConnector URL must not include credentials, a query, or a fragment");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("The OpenConnector runtime must use HTTPS, or HTTP on loopback only");
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

const envelopeSchema = z.object({
  success: z.boolean().optional(),
  message: z.string().optional(),
  errorCode: z.string().optional(),
  data: z.unknown().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

const providerItemSchema = z.object({
  id: z.string().optional(),
  service: z.string().optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  categories: z.array(z.unknown()).optional(),
});

const actionItemSchema = z.object({
  id: z.string().optional(),
  service: z.string().optional(),
  description: z.string().optional(),
});

export interface OpenConnectorProviderItem {
  service: string;
  name?: string;
  description?: string;
  raw: Record<string, unknown>;
}

export interface OpenConnectorActionItem {
  id: string;
  description?: string;
  raw: Record<string, unknown>;
}

export interface OpenConnectorClientOptions {
  baseUrl: string;
  /** Bearer for /v1 and /api. Only ever held in memory, resolved from a reference by the caller. */
  adminToken?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class OpenConnectorClient {
  readonly baseUrl: string;
  private readonly adminToken?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: OpenConnectorClientOptions) {
    this.baseUrl = normalizeOpenConnectorBaseUrl(options.baseUrl);
    this.adminToken = options.adminToken?.trim() || undefined;
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? OPENCONNECTOR_REQUEST_TIMEOUT_MS;
  }

  private async request(path: string, init: RequestInit = {}): Promise<{ data: unknown; retryAfterMs?: number }> {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    if (this.adminToken) headers.set("authorization", `Bearer ${this.adminToken}`);
    if (init.body) headers.set("content-type", "application/json");
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      redirect: "error",
      headers,
      signal: init.signal ?? AbortSignal.timeout(this.timeoutMs),
    });
    const retryAfterMs = retryAfterMsOf(response.headers.get("retry-after"));
    const raw = await response.text();
    if (raw.length > MAX_RESPONSE_BYTES) throw new OpenConnectorError("OpenConnector response exceeded 4 MB", { status: response.status });
    let body: unknown = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      throw new OpenConnectorError(`OpenConnector answered HTTP ${response.status} with non-JSON`, { status: response.status });
    }
    if (!response.ok) {
      const envelope = envelopeSchema.safeParse(body);
      throw new OpenConnectorError(
        (envelope.success && envelope.data.message) || `OpenConnector: HTTP ${response.status}`,
        { status: response.status, code: envelope.success ? envelope.data.errorCode : undefined, retryAfterMs },
      );
    }
    const envelope = envelopeSchema.safeParse(body);
    if (envelope.success && envelope.data.success === false) {
      throw new OpenConnectorError(envelope.data.message || "OpenConnector request failed", {
        status: response.status,
        code: envelope.data.errorCode,
        retryAfterMs,
      });
    }
    return { data: envelope.success ? envelope.data.data : body, retryAfterMs };
  }

  /** GET /v1/providers — the app catalog. */
  async providers(): Promise<OpenConnectorProviderItem[]> {
    const { data } = await this.request("/v1/providers");
    const items = Array.isArray(data) ? data : data && typeof data === "object" ? (data as { items?: unknown }).items : undefined;
    if (!Array.isArray(items)) throw new OpenConnectorError("OpenConnector /v1/providers returned no provider list");
    const out: OpenConnectorProviderItem[] = [];
    for (const item of items) {
      const parsed = providerItemSchema.safeParse(item);
      const service = parsed.success ? (parsed.data.id ?? parsed.data.service) : undefined;
      if (!service) continue;
      out.push({
        service,
        name: parsed.success ? parsed.data.name : undefined,
        description: parsed.success ? parsed.data.description : undefined,
        raw: parsed.success ? (item as Record<string, unknown>) : { id: service },
      });
    }
    return out;
  }

  /** GET /v1/actions/:actionId — one action, including its input schema. */
  async action(actionId: string): Promise<OpenConnectorActionItem> {
    const { data } = await this.request(`/v1/actions/${encodeURIComponent(actionId)}`);
    const parsed = actionItemSchema.safeParse(data);
    if (!parsed.success || !parsed.data.id) throw new OpenConnectorError("OpenConnector returned an action without an id");
    return { id: parsed.data.id, description: parsed.data.description, raw: data as Record<string, unknown> };
  }

  /** Detail reads are capped so a large catalog cannot fan out an unbounded request burst. */
  async actionDetails(actions: ReadonlyArray<OpenConnectorActionItem>, concurrency = 8): Promise<OpenConnectorActionItem[]> {
    const detailed = [...actions];
    for (let offset = 0; offset < detailed.length; offset += concurrency) {
      const batch = detailed.slice(offset, offset + concurrency);
      const schemas = await Promise.all(batch.map((action) => this.action(action.id)));
      detailed.splice(offset, batch.length, ...schemas);
    }
    return detailed;
  }

  /** GET /v1/actions — every action summary, optionally for one service. */
  async actions(service?: string): Promise<OpenConnectorActionItem[]> {
    const { data } = await this.request(service ? `/v1/actions?service=${encodeURIComponent(service)}` : "/v1/actions");
    const items = Array.isArray(data) ? data : data && typeof data === "object" ? (data as { items?: unknown }).items : undefined;
    if (!Array.isArray(items)) throw new OpenConnectorError("OpenConnector /v1/actions returned no action list");
    const out: OpenConnectorActionItem[] = [];
    for (const item of items) {
      const parsed = actionItemSchema.safeParse(item);
      if (!parsed.success || !parsed.data.id) continue;
      out.push({ id: parsed.data.id, description: parsed.data.description, raw: item as Record<string, unknown> });
    }
    return out;
  }

  /** POST /v1/actions/:actionId — run one action; `alias` selects a named connection. */
  async execute(actionId: string, input: unknown, alias?: string, signal?: AbortSignal): Promise<unknown> {
    const selector = alias ? `?alias=${encodeURIComponent(alias)}` : "";
    const { data } = await this.request(`/v1/actions/${encodeURIComponent(actionId)}${selector}`, {
      method: "POST",
      body: JSON.stringify({ input }),
      ...(signal ? { signal } : {}),
    });
    return data;
  }

  /** GET /v1/apps/authenticated — the authenticated subset of the candidate services. */
  async authenticatedServices(candidates: string[]): Promise<string[]> {
    if (!candidates.length) return [];
    const query = candidates.map((service) => `service=${encodeURIComponent(service)}`).join("&");
    const { data } = await this.request(`/v1/apps/authenticated?${query}`);
    const items = Array.isArray(data) ? data : data && typeof data === "object" ? (data as { services?: unknown }).services : undefined;
    if (!Array.isArray(items)) throw new OpenConnectorError("OpenConnector /v1/apps/authenticated returned no service list");
    return items.filter((item): item is string => typeof item === "string");
  }

  /** GET /api/oauth/configs — the per-app OAuth setup, including the runtime's expectedRedirectUri. */
  async oauthConfigs(): Promise<{ data: unknown; expectedRedirectUri?: string }> {
    const { data } = await this.request("/api/oauth/configs");
    const doc = data && typeof data === "object" ? data as Record<string, unknown> : {};
    const expected = typeof doc.expectedRedirectUri === "string" ? doc.expectedRedirectUri : undefined;
    return { data, expectedRedirectUri: expected };
  }

  /** PUT /api/oauth/configs/:service — store one app's OAuth client on the runtime. */
  async putOauthConfig(service: string, config: { clientId: string; clientSecret: string; scopes?: string[] }): Promise<void> {
    await this.request(`/api/oauth/configs/${encodeURIComponent(service)}`, {
      method: "PUT",
      body: JSON.stringify(config),
    });
  }

  /** POST /v1/connections/:service/connect — start an authorization request. */
  async beginConnect(service: string, alias?: string): Promise<{ connectionRequestId?: string; authorizationUrl?: string }> {
    const { data } = await this.request(`/v1/connections/${encodeURIComponent(service)}/connect`, {
      method: "POST",
      body: JSON.stringify(alias ? { connectionName: alias } : {}),
    });
    const doc = data && typeof data === "object" ? data as Record<string, unknown> : {};
    return {
      connectionRequestId: typeof doc.connectionRequestId === "string" ? doc.connectionRequestId : undefined,
      authorizationUrl: typeof doc.authorizationUrl === "string" ? doc.authorizationUrl
        : typeof doc.authUrl === "string" ? doc.authUrl
          : typeof doc.url === "string" ? doc.url : undefined,
    };
  }

  /** GET /v1/connection-requests/:id — one authorization request's current state. */
  async connectionRequest(id: string): Promise<{ state: Record<string, unknown>; retryAfterMs?: number }> {
    const { data, retryAfterMs } = await this.request(`/v1/connection-requests/${encodeURIComponent(id)}`);
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new OpenConnectorError("OpenConnector returned a connection request without a state object");
    }
    return { state: data as Record<string, unknown>, retryAfterMs };
  }

  /** DELETE /api/connections/:service — drop the stored credential. Ordinary disconnects do not revoke upstream. */
  async disconnect(service: string, alias?: string): Promise<void> {
    await this.request(`/api/connections/${encodeURIComponent(service)}${alias ? `?alias=${encodeURIComponent(alias)}` : ""}`, {
      method: "DELETE",
    });
  }
}

function retryAfterMsOf(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}
