import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderGateway, type ProviderId } from "../server/gateway.ts";
import { PortalStore, digest } from "../server/store.ts";

// All authority and streams are fixture-owned. No provider network call,
// customer database or production credential is used by this suite.
describe("managed OpenRouter gateway", () => {
  let db: DatabaseSync;
  let store: PortalStore;
  let gateway: ProviderGateway;
  let key: string;
  let licensed: boolean;
  const upstream = vi.fn<typeof fetch>();
  const model = "anthropic/fixture-sonnet";
  const otherModel = "openai/fixture-coder";
  const body = { model, messages: [{ role: "user", content: "fixture prompt" }] };
  const request = (input: unknown = body, token = key, signal?: AbortSignal) => new Request("https://portal.example.test/gateway/alpha/openrouter/v1/chat/completions", {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-api-key-extra": "tenant-private-header", "anthropic-beta": "tenant-beta" },
    body: JSON.stringify(input), signal,
  });
  const handle = (input: unknown = body) => gateway.handle(request(input), "alpha", "/v1/chat/completions", "openrouter");
  const list = (token = key) => gateway.handle(new Request("https://portal.example.test/models", { headers: { authorization: `Bearer ${token}` } }), "alpha", "/v1/models", "openrouter");

  beforeEach(() => {
    db = new DatabaseSync(":memory:"); store = new PortalStore(db); licensed = true;
    upstream.mockReset().mockResolvedValue(Response.json({ choices: [{ message: { role: "assistant", content: "fixture response" } }] }));
    gateway = new ProviderGateway(store, "fixture-encryption-secret", upstream, () => licensed);
    gateway.save({ key: "fixture-anthropic-key", models: ["fixture-claude"] });
    gateway.save({ key: "fixture-openrouter-key", models: [model, otherModel] }, "openrouter");
    for (const slug of ["alpha", "beta"]) db.prepare("INSERT INTO portal_workspace VALUES (?,?,?,?,?,NULL)").run(slug, slug, `${slug}.example.test`, "running", Date.now());
    key = gateway.issue("alpha", ["fixture-claude"], [model]);
  });
  afterEach(() => { gateway.close(); db.close(); vi.useRealTimers(); });

  it("keeps encrypted provider keys and grants separate while retaining one workspace credential", () => {
    expect(gateway.status()).toEqual({ id: "anthropic", configured: true, models: ["fixture-claude"] });
    expect(gateway.status("openrouter")).toEqual({ id: "openrouter", configured: true, models: [model, otherModel] });
    const rows = db.prepare("SELECT * FROM portal_provider").all();
    expect(JSON.stringify(rows)).not.toContain("fixture-anthropic-key");
    expect(JSON.stringify(rows)).not.toContain("fixture-openrouter-key");
    expect(gateway.access("alpha")).toEqual(["fixture-claude"]);
    expect(gateway.access("alpha", "openrouter")).toEqual([model]);
    gateway.assign("alpha", [otherModel], "openrouter");
    expect(gateway.access("alpha")).toEqual(["fixture-claude"]);
    expect(gateway.access("alpha", "openrouter")).toEqual([otherModel]);
    expect(db.prepare("SELECT hash FROM portal_provider_access WHERE workspace = 'alpha'").get()!.hash).toBe(digest(key));
    expect(() => gateway.validateModels(["fixture-claude"], "openrouter")).toThrow();
    expect(() => gateway.validateModels([otherModel])).toThrow("Choose models enabled");
    expect(() => gateway.validateModels([otherModel])).toThrow(expect.objectContaining({ status: 400 }));
  });

  it("reads legacy Anthropic arrays and normalizes the next grant write without rotating the key", () => {
    db.prepare("UPDATE portal_provider_access SET models = ? WHERE workspace = 'alpha'").run(JSON.stringify(["fixture-claude"]));
    expect(gateway.access("alpha")).toEqual(["fixture-claude"]);
    expect(gateway.access("alpha", "openrouter")).toEqual([]);
    gateway.assign("alpha", [model], "openrouter");
    const row = db.prepare("SELECT hash, models FROM portal_provider_access WHERE workspace = 'alpha'").get()!;
    expect(row.hash).toBe(digest(key));
    expect(JSON.parse(String(row.models))).toEqual({ anthropic: ["fixture-claude"], openrouter: [model] });
    gateway.assign("alpha", []);
    expect(gateway.access("alpha", "openrouter")).toEqual([model]);
  });

  it.each(["openrouter/auto", "openrouter/free", "openrouter/bodybuilder", "@preset/private", "@router/private", "~anthropic/claude-latest", "anthropic/model@preset/private", "auto"])("refuses routing alias %s both in setup and in requests", async (alias) => {
    expect(() => gateway.save({ models: [alias] }, "openrouter")).toThrow("concrete OpenRouter");
    expect(() => gateway.save({ models: [alias] }, "openrouter")).toThrow(expect.objectContaining({ status: 400 }));
    expect((await handle({ ...body, model: alias })).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each(["models", "fallbacks", "preset", "route", "provider", "plugins", "extra_body", "router", "transforms"])("refuses the unapproved routing option %s instead of silently dropping it", async (field) => {
    const response = await handle({ ...body, [field]: ["unapproved/model"] });
    expect(response.status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("forwards exact tool payloads and SSE bytes only to the fixed upstream using its own Bearer key", async () => {
    const sse = 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"read_file","arguments":"{}"}}]}}]}\n\ndata: [DONE]\n\n';
    upstream.mockResolvedValueOnce(new Response(sse, { headers: { "content-type": "text/event-stream", "x-provider-secret": "hidden" } }));
    const input = { ...body, stream: true, stream_options: { include_usage: true }, tools: [{ type: "function", function: { name: "read_file", description: "fixture tool", parameters: { type: "object", properties: { path: { type: "string" } } } } }], tool_choice: "auto", parallel_tool_calls: true, reasoning: { effort: "high" } };
    const response = await handle(input);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(sse);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("x-provider-secret")).toBeNull();
    const [url, init] = upstream.mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(init).toMatchObject({ method: "POST", redirect: "error", body: JSON.stringify(input) });
    expect(Object.fromEntries(new Headers(init!.headers))).toEqual({ authorization: "Bearer fixture-openrouter-key", "content-type": "application/json" });
  });

  it("lists only currently granted models locally, never querying the paid upstream", async () => {
    expect(await (await list()).json()).toEqual({ object: "list", data: [{ id: model, object: "model", created: 0, owned_by: "openrouter" }] });
    gateway.save({ models: [otherModel] }, "openrouter");
    expect(await (await list()).json()).toEqual({ object: "list", data: [] });
    expect((await list("incorrect-key")).status).toBe(403);
    licensed = false;
    expect((await list()).status).toBe(403);
    licensed = true; gateway.close();
    expect((await list()).status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("rejects cross-workspace keys, cross-provider grants and arbitrary operations before forwarding", async () => {
    const betaKey = gateway.issue("beta", [], [otherModel]);
    expect((await gateway.handle(request(body, betaKey), "alpha", "/v1/chat/completions", "openrouter")).status).toBe(403);
    expect((await handle({ ...body, model: otherModel })).status).toBe(403);
    expect((await gateway.handle(request({ model: "fixture-claude" }), "alpha", "/v1/chat/completions")).status).toBe(404);
    for (const path of ["/v1/messages", "/v1/keys", "/v1/credits", "/v1/chat/completions?provider=other", "/v1/presets/private/chat/completions", "https://other.example.test/v1/chat/completions"]) {
      expect((await gateway.handle(request(), "alpha", path, "openrouter")).status).toBe(404);
    }
    expect(upstream).not.toHaveBeenCalled();
  });

  it("revokes only the affected provider while another provider stream remains usable", async () => {
    const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
    upstream.mockImplementation(async () => new Response(new ReadableStream({ start(controller) { controllers.push(controller); } })));
    const openrouter = await handle({ ...body, stream: true });
    const anthropic = await gateway.handle(request({ model: "fixture-claude", stream: true }), "alpha", "/v1/messages");
    gateway.assign("alpha", [], "openrouter");
    await expect(openrouter.text()).rejects.toThrow("access ended");
    expect(upstream.mock.calls[0][1]!.signal!.aborted).toBe(true);
    expect(upstream.mock.calls[1][1]!.signal!.aborted).toBe(false);
    controllers[1].enqueue(new TextEncoder().encode("still-authorized")); controllers[1].close();
    expect(await anthropic.text()).toBe("still-authorized");
  });

  it.each(["provider models", "workspace state", "license", "shared key"])("aborts quiet OpenRouter streams after revoking %s", async (change) => {
    const cancelled = vi.fn();
    upstream.mockImplementationOnce(async () => new Response(new ReadableStream({ cancel: cancelled })));
    const response = await handle({ ...body, stream: true });
    const rejected = expect(response.text()).rejects.toThrow("access ended");
    if (change === "provider models") gateway.save({ models: [] }, "openrouter");
    if (change === "workspace state") db.prepare("UPDATE portal_workspace SET status = 'suspended' WHERE slug = 'alpha'").run();
    if (change === "license") licensed = false;
    if (change === "shared key") db.prepare("UPDATE portal_provider_access SET hash = 'revoked' WHERE workspace = 'alpha'").run();
    gateway.revalidate();
    await rejected;
    expect(upstream.mock.calls[0][1]!.signal!.aborted).toBe(true);
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it("counts Anthropic and OpenRouter together toward the workspace concurrency limit", async () => {
    upstream.mockImplementation(async () => new Response(new ReadableStream()));
    for (let index = 0; index < 8; index++) {
      const provider: ProviderId = index % 2 ? "openrouter" : "anthropic";
      const response = await gateway.handle(request({ model: provider === "openrouter" ? model : "fixture-claude" }), "alpha", provider === "openrouter" ? "/v1/chat/completions" : "/v1/messages", provider);
      expect(response.status).toBe(200);
    }
    expect((await handle()).status).toBe(429);
    expect(upstream).toHaveBeenCalledTimes(8);
    gateway.assign("alpha", []);
    expect((await handle()).status).toBe(200);
  });

  it("rechecks OpenRouter grants after a delayed request body", async () => {
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const incoming = new Request("https://portal.example.test/gateway", { method: "POST", headers: { authorization: `Bearer ${key}` }, body: new ReadableStream({ start(controller) { source = controller; } }), duplex: "half" } as RequestInit);
    const pending = gateway.handle(incoming, "alpha", "/v1/chat/completions", "openrouter");
    gateway.assign("alpha", [], "openrouter");
    source.enqueue(new TextEncoder().encode(JSON.stringify(body))); source.close();
    expect((await pending).status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("retains quiet-stream deadlines and client cancellation", async () => {
    vi.useFakeTimers();
    upstream.mockImplementation(async () => new Response(new ReadableStream()));
    const response = await handle();
    const expired = expect(response.text()).rejects.toThrow("access ended");
    await vi.advanceTimersByTimeAsync(300_000); await expired;
    const controller = new AbortController();
    const next = await gateway.handle(request(body, key, controller.signal), "alpha", "/v1/chat/completions", "openrouter");
    const cancelled = expect(next.text()).rejects.toThrow("access ended");
    controller.abort(); await cancelled;
    expect(upstream.mock.calls.every(([, init]) => init!.signal!.aborted)).toBe(true);
  });

  it("redacts upstream errors and never follows redirects", async () => {
    upstream.mockResolvedValueOnce(new Response("fixture-openrouter-key private provider detail", { status: 401 }));
    const response = await handle();
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain("fixture-openrouter-key");
    expect(upstream.mock.calls[0][1]!.redirect).toBe("error");
  });
});
