import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { z } from "zod";
import { digest, type PortalStore } from "./store.ts";

const modelList = z.array(z.string().trim().min(1).max(160)).max(100);
const setupSchema = z.object({ key: z.string().trim().max(1024).optional(), models: modelList });
export type ProviderId = "anthropic" | "openrouter";
type ModelGrants = Record<ProviderId, string[]>;
const openRouterFields = new Set(["model", "messages", "max_tokens", "max_completion_tokens", "temperature", "top_p", "stop", "stream", "stream_options", "tools", "tool_choice", "parallel_tool_calls", "reasoning", "include_reasoning", "frequency_penalty", "presence_penalty", "seed", "response_format", "logprobs", "top_logprobs", "logit_bias", "user", "verbosity", "store", "metadata", "prediction", "service_tier", "modalities", "audio"]);
function concreteModels(input: unknown, provider: ProviderId): string[] {
  const models = [...new Set(modelList.parse(input))];
  if (provider === "openrouter" && models.some((model) => !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._:/+-]*$/.test(model) || model.toLowerCase().startsWith("openrouter/"))) {
    throw Object.assign(new Error("Choose concrete OpenRouter provider/model IDs, not routers, presets or aliases."), { status: 400 });
  }
  return models;
}
function grants(text: string): ModelGrants {
  const value: unknown = JSON.parse(text);
  if (Array.isArray(value)) return { anthropic: modelList.parse(value), openrouter: [] };
  const parsed = z.object({ anthropic: modelList, openrouter: modelList }).parse(value);
  return { anthropic: parsed.anthropic, openrouter: parsed.openrouter };
}
const MAX_ACTIVE = 32;
const MAX_WORKSPACE_ACTIVE = 8;
const REQUEST_DEADLINE_MS = 5 * 60_000;

/** Fixed-provider gateway. A tenant holds only its own revocable key,
 * never the operator key. It cannot choose an upstream host or an arbitrary API. */
export class ProviderGateway {
  private readonly encryptionKey: Buffer;
  private readonly store: PortalStore;
  private readonly upstreamFetch: typeof fetch;
  private readonly licensed: () => boolean;
  private readonly active = new Map<AbortController, { workspace: string; hash: string; model: string; provider: ProviderId }>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private closed = false;
  constructor(store: PortalStore, secret: string, upstreamFetch: typeof fetch = fetch, licensed: () => boolean = () => true) {
    this.store = store; this.upstreamFetch = upstreamFetch; this.licensed = licensed;
    this.encryptionKey = Buffer.from(hkdfSync("sha256", secret, "omb-admin", "provider-keys", 32));
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS portal_provider (id TEXT PRIMARY KEY, secret TEXT NOT NULL, models TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS portal_provider_access (
        workspace TEXT PRIMARY KEY REFERENCES portal_workspace(slug), hash TEXT NOT NULL, models TEXT NOT NULL
      );
    `);
  }
  private encrypt(value: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url");
  }
  private decrypt(value: string) {
    const bytes = Buffer.from(value, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", this.encryptionKey, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
  }
  private provider(provider: ProviderId) {
    return this.store.db.prepare("SELECT * FROM portal_provider WHERE id = ?").get(provider) as { secret: string; models: string } | undefined;
  }
  status(provider: ProviderId = "anthropic") { const row = this.provider(provider); return { id: provider, configured: Boolean(row), models: row ? JSON.parse(row.models) as string[] : [] }; }
  save(input: unknown, provider: ProviderId = "anthropic") {
    const body = setupSchema.parse(input);
    const models = concreteModels(body.models, provider);
    const previous = this.provider(provider);
    if (!body.key && !previous) throw Object.assign(new Error(`Enter an ${provider === "anthropic" ? "Anthropic" : "OpenRouter"} API key.`), { status: 400 });
    this.store.db.prepare("INSERT INTO portal_provider VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET secret=excluded.secret, models=excluded.models")
      .run(provider, body.key ? this.encrypt(body.key) : previous!.secret, JSON.stringify(models));
    this.revalidate();
    return this.status(provider);
  }
  access(workspace: string, provider: ProviderId = "anthropic"): string[] {
    const row = this.store.db.prepare("SELECT models FROM portal_provider_access WHERE workspace = ?").get(workspace) as { models: string } | undefined;
    return row ? grants(row.models)[provider] : [];
  }
  validateModels(input: unknown, provider: ProviderId = "anthropic") {
    const models = concreteModels(input, provider);
    const allowed = this.status(provider).models;
    if (models.some((model) => !allowed.includes(model))) throw Object.assign(new Error("Choose models enabled by the administrator."), { status: 400 });
    return models;
  }
  issue(workspace: string, models: string[], openrouterModels: string[] = []): string {
    const key = `omb_workspace_${randomBytes(32).toString("base64url")}`;
    this.store.db.prepare("INSERT INTO portal_provider_access VALUES (?,?,?)")
      .run(workspace, digest(key), JSON.stringify({ anthropic: this.validateModels(models), openrouter: this.validateModels(openrouterModels, "openrouter") }));
    return key;
  }
  assign(workspace: string, models: unknown, provider: ProviderId = "anthropic") {
    const next = { anthropic: this.access(workspace), openrouter: this.access(workspace, "openrouter"), [provider]: this.validateModels(models, provider) };
    this.store.db.prepare("UPDATE portal_provider_access SET models = ? WHERE workspace = ?")
      .run(JSON.stringify(next), workspace);
    this.revalidate();
  }
  private authorized(workspace: string, hash: string, model: string, providerId: ProviderId) {
    const access = this.store.db.prepare("SELECT models FROM portal_provider_access WHERE workspace = ? AND hash = ?")
      .get(workspace, hash) as { models: string } | undefined;
    const provider = this.provider(providerId);
    return !this.closed && this.licensed() && access && provider && this.store.workspace(workspace)?.status === "running"
      && grants(access.models)[providerId].includes(model) && (JSON.parse(provider.models) as string[]).includes(model) ? provider : null;
  }
  /** Called synchronously after authority changes, before fleet operations can
   * yield. The timer also catches licence expiry while a response is quiet. */
  revalidate() {
    for (const [controller, entry] of this.active) {
      if (!this.authorized(entry.workspace, entry.hash, entry.model, entry.provider)) controller.abort();
    }
  }
  close() {
    this.closed = true;
    for (const controller of this.active.keys()) controller.abort();
    clearInterval(this.timer); this.timer = undefined;
  }
  async handle(request: Request, workspace: string, path: string, providerId: ProviderId = "anthropic"): Promise<Response> {
    const token = request.headers.get("x-api-key") || request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
    const hash = digest(token);
    const access = this.store.db.prepare("SELECT models FROM portal_provider_access WHERE workspace = ? AND hash = ?")
      .get(workspace, hash) as { models: string } | undefined;
    if (this.closed || !this.licensed() || !access || this.store.workspace(workspace)?.status !== "running") return Response.json({ error: "Workspace provider access is unavailable." }, { status: 403 });
    if (providerId === "openrouter" && request.method === "GET" && path === "/v1/models") {
      const models = this.access(workspace, providerId).filter((model) => this.authorized(workspace, hash, model, providerId));
      return Response.json({ object: "list", data: models.map((id) => ({ id, object: "model", created: 0, owned_by: "openrouter" })) }, { headers: { "cache-control": "no-store" } });
    }
    if (request.method !== "POST" || !(providerId === "openrouter" ? path === "/v1/chat/completions" : ["/v1/messages", "/v1/messages/count_tokens"].includes(path))) return Response.json({ error: "Unsupported provider operation." }, { status: 404 });
    const input: unknown = await request.json().catch(() => null);
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return Response.json({ error: "Send a JSON object describing the provider request." }, { status: 400 });
    }
    const body = input as Record<string, unknown>;
    const model = typeof body.model === "string" ? body.model : "";
    if (providerId === "openrouter") {
      // Presets, fallback arrays, routers and future routing fields must not
      // replace an approved model. Tool/message payloads remain unchanged.
      if (Object.keys(body).some((key) => !openRouterFields.has(key))) return Response.json({ error: "Unsupported managed OpenRouter request option." }, { status: 400 });
      try { concreteModels([model], providerId); } catch { return Response.json({ error: "Choose a concrete enabled OpenRouter model." }, { status: 400 }); }
    }
    // The body await is an authority boundary: use current workspace/model
    // state, not the access row captured when the request first arrived.
    const provider = this.authorized(workspace, hash, model, providerId);
    if (!provider) return Response.json({ error: "This model is not enabled for this workspace." }, { status: 403 });
    if (this.active.size >= MAX_ACTIVE || [...this.active.values()].filter((entry) => entry.workspace === workspace).length >= MAX_WORKSPACE_ACTIVE) {
      return Response.json({ error: "Too many managed provider requests are active. Wait for one to finish." }, { status: 429 });
    }
    const controller = new AbortController();
    const signal = AbortSignal.any([request.signal, controller.signal]);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let output: ReadableStreamDefaultController<Uint8Array> | undefined;
    let streaming = false;
    const deadline = setTimeout(() => controller.abort(), REQUEST_DEADLINE_MS);
    deadline.unref();
    const cleanup = () => {
      clearTimeout(deadline); signal.removeEventListener("abort", onAbort);
      this.active.delete(controller);
      if (!this.active.size) { clearInterval(this.timer); this.timer = undefined; }
    };
    const onAbort = () => {
      try { output?.error(new Error("Managed provider access ended.")); } catch { /* already closed */ }
      void reader?.cancel().catch(() => undefined);
      cleanup();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    this.active.set(controller, { workspace, hash, model, provider: providerId });
    this.timer ??= setInterval(() => this.revalidate(), 10_000);
    this.timer.unref();
    try {
      if (signal.aborted) throw new Error("request ended");
      const response = await this.upstreamFetch(providerId === "openrouter" ? "https://openrouter.ai/api/v1/chat/completions" : `https://api.anthropic.com${path}`, {
        method: "POST", redirect: "error", signal,
        headers: providerId === "openrouter" ? { "content-type": "application/json", authorization: `Bearer ${this.decrypt(provider.secret)}` } : { "content-type": "application/json", "x-api-key": this.decrypt(provider.secret), "anthropic-version": "2023-06-01",
          ...(request.headers.get("anthropic-beta") && request.headers.get("anthropic-beta")!.length <= 1024 ? { "anthropic-beta": request.headers.get("anthropic-beta")! } : {}),
        },
        body: JSON.stringify(body),
      });
      if (signal.aborted || !this.authorized(workspace, hash, model, providerId)) {
        void response.body?.cancel().catch(() => undefined);
        return Response.json({ error: "Workspace provider access ended." }, { status: 403 });
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        return Response.json({ error: "The managed provider could not complete this request. Contact your administrator." }, { status: response.status >= 500 ? 502 : response.status });
      }
      if (!response.body) return new Response(null, { status: response.status });
      reader = response.body.getReader();
      const relay = new ReadableStream<Uint8Array>({
        start(value) { output = value; },
        async pull(value) {
          try {
            const result = await reader!.read();
            if (signal.aborted) return;
            if (result.done) { cleanup(); value.close(); } else value.enqueue(result.value);
          } catch { cleanup(); value.error(new Error("Managed provider stream ended.")); }
        },
        cancel() { controller.abort(); },
      });
      streaming = true;
      return new Response(relay, { status: response.status, headers: { "content-type": response.headers.get("content-type") ?? "application/json", "cache-control": "no-store" } });
    } catch {
      return Response.json({ error: "The managed provider is temporarily unavailable." }, { status: 502 });
    } finally { if (!streaming) cleanup(); }
  }
}
