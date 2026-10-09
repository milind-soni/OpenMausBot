// The trial's Claude credit engine on a Cloud home: what it is made of, when
// it loads, and that a refusal from the relay ends it until another token
// comes. OpenMausBot's own chat engine against a stand-in relay (an
// OpenAI-compatible API); no CLI, no network.
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLOUD_CREDIT_INSTANCE, CloudCreditProvider, cloudCreditInstanceConfig, parseCreditModels } from "./cloud-credit-provider.ts";
import type { InstanceConfigMap, ProviderInstance, RuntimeEvent } from "./contracts.ts";
import { OpenAICompatDriver } from "./drivers/openai-compat.ts";
import { ProviderRegistry } from "./harness/registry.ts";
import { recordEvents } from "./testing/events.ts";
import { TRIAL_CREDIT_REFUSED } from "./trial-credit.ts";

const TOKEN = `omb_ai_${"t".repeat(43)}`;
/** OMB_CLOUD_AI_URL exactly as the Admin sets it (cloud-credit.ts `env`): an OpenAI base URL, its `/v1` included. */
const RELAY = "https://cloud.example.test/api/cloud/services/ai/v1";
const credential = { token: TOKEN, api: RELAY, included: true };
const MODELS = { object: "list", data: [
  { object: "model", id: "claude-haiku-4-5", display_name: "Claude Haiku 4.5", owned_by: "anthropic" },
  { object: "model", id: "claude-sonnet-5", name: "Claude Sonnet 5", owned_by: "anthropic" },
] };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
/** The relay's refusals, as the Admin writes them: its own code first. */
const CODES: Record<number, string> = { 401: "invalid_api_key", 429: "trial_credit_paused" };
const refusal = (status: number, message: string, code = CODES[status] ?? (/isn't available/.test(message) ? "trial_credit_ended" : "trial_credit_used_up")) =>
  json(status, { error: { code, type: status === 429 ? "rate_limit_error" : "insufficient_quota", message, param: null } });

describe("what the credit's engine is made of", () => {
  it("reads the relay's models in its order (cheapest first), and nothing that is not a model id", () => {
    expect(parseCreditModels(MODELS)).toEqual([{ id: "claude-haiku-4-5", label: "Claude Haiku 4.5" }, { id: "claude-sonnet-5", label: "Claude Sonnet 5" }]);
    // The Admin's OpenRouter upstream lists provider/model ids (and OpenRouter's ":variant" ones).
    expect(parseCreditModels({ object: "list", data: [{ id: "anthropic/claude-haiku-4.5" }, { id: "anthropic/claude-sonnet-4.5:beta" }] }).map(model => model.id))
      .toEqual(["anthropic/claude-haiku-4.5", "anthropic/claude-sonnet-4.5:beta"]);
    expect(parseCreditModels({ data: [{ id: "claude-x" }, { id: "claude-x" }, { id: "../etc" }, { id: "a b" }, { id: 4 }, null, { id: "claude-y", display_name: "x".repeat(81) }] }))
      .toEqual([{ id: "claude-x", label: "claude-x" }, { id: "claude-y", label: "claude-y" }]);
    expect(parseCreditModels({ data: Array.from({ length: 30 }, (_, index) => ({ id: `claude-${index}` })) })).toHaveLength(20);
    for (const body of [null, "models", { data: "x" }, { models: [] }]) expect(parseCreditModels(body)).toEqual([]);
  });

  it("is OpenMausBot's own chat engine on the relay, with this machine's token as its own key: never Claude Code, Codex or an Anthropic route", () => {
    const configs = cloudCreditInstanceConfig(credential, parseCreditModels(MODELS));
    expect(Object.keys(configs)).toEqual([CLOUD_CREDIT_INSTANCE]);
    const entry = configs[CLOUD_CREDIT_INSTANCE]!;
    expect(entry).toEqual({ driver: "openai-compat", displayName: "Trial credit · Claude",
      config: { url: RELAY, apiKeyEnv: "OPENMAUSBOT_TRIAL_CREDIT_KEY", provider: "", model: "claude-haiku-4-5", managedModels: ["claude-haiku-4-5", "claude-sonnet-5"] },
      environment: { OPENMAUSBOT_TRIAL_CREDIT_KEY: TOKEN } });
    expect(JSON.stringify(configs)).not.toMatch(/ANTHROPIC|claudeAgent|codex|\/messages/);
    // The driver reads it as its own connection: none of the workspace's key, address, model or routing.
    expect(OpenAICompatDriver.decodeConfig(entry.config)).toEqual({ url: RELAY, apiKeyEnv: "OPENMAUSBOT_TRIAL_CREDIT_KEY",
      model: "claude-haiku-4-5", managedModels: ["claude-haiku-4-5", "claude-sonnet-5"], key: undefined, provider: undefined });
  });
});

/** A registry that makes each loaded engine without a relay. */
function fakeRegistry() {
  const loaded: Array<{ configs: InstanceConfigMap; instance: ProviderInstance; emit: (event: RuntimeEvent) => void; base: ProviderInstance }> = [];
  const registry = {
    load: vi.fn(async (configs: InstanceConfigMap, decorate?: (instance: ProviderInstance) => ProviderInstance) => {
      const listeners = new Set<(event: RuntimeEvent) => void>();
      const base = {
        instanceId: CLOUD_CREDIT_INSTANCE, driverKind: "openai-compat", displayName: "Trial credit · Claude", enabled: true,
        models: { default: "claude-sonnet-5", options: [] },
        startAuthentication: vi.fn(), signOut: vi.fn(), installRuntime: vi.fn(),
        snapshot: vi.fn(async () => ({ state: "available" as const, authenticated: true, version: null, billing: "metered" as const })),
        adapter: { sendTurn: vi.fn(async () => ({ turnId: "turn-1" })), onEvent: (listener: (event: RuntimeEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener); } },
        generateText: vi.fn(async () => "a title"),
        dispose: vi.fn(async () => {}),
      } as unknown as ProviderInstance;
      const instance = decorate ? decorate(base) : base;
      loaded.push({ configs, instance, base, emit: event => { for (const listener of listeners) listener(event); } });
    }),
  };
  return { registry: registry as unknown as ProviderRegistry, loaded, load: registry.load };
}

const relay = (status: number, body: unknown) => vi.fn(async () => json(status, body));
const runtimeError = (message: string) => ({ type: "runtime.error", message, threadId: "t", eventId: "e", provider: "openai-compat",
  createdAt: new Date(0).toISOString() }) as unknown as RuntimeEvent;
/** The chat engine's failure line for a relay refusal: the first 200 characters of its body. */
const upstream = (status: number, message: string, code = CODES[status] ?? (/isn't available/.test(message) ? "trial_credit_ended" : "trial_credit_used_up")) =>
  `upstream HTTP ${status}: ${JSON.stringify({ error: { code, type: "insufficient_quota", message, param: null } }).slice(0, 200)}`;

describe("the credit's engine on a Cloud home", () => {
  let data: string;
  const providers: CloudCreditProvider[] = [];
  const make = (options: Partial<ConstructorParameters<typeof CloudCreditProvider>[0]> & { registry: ProviderRegistry }) => {
    const provider = new CloudCreditProvider({ dataDirectory: data, credential, ...options });
    providers.push(provider);
    return provider;
  };
  beforeEach(() => { data = mkdtempSync(join(tmpdir(), "omb-trial-credit-")); });
  afterEach(() => {
    for (const provider of providers.splice(0)) provider.close();
    vi.useRealTimers(); vi.unstubAllGlobals();
    rmSync(data, { recursive: true, force: true });
  });

  it("is nothing without a token: no engine, nothing asked", async () => {
    const { registry, load } = fakeRegistry(), fetch = relay(200, MODELS);
    await make({ registry, credential: null, fetch }).start();
    expect(load).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it("loads once the relay lists its models, with no sign-in of its own, and keeps the list (never the token) for the next start", async () => {
    const { registry, loaded } = fakeRegistry(), fetch = relay(200, MODELS), onChange = vi.fn(), log = vi.fn();
    const provider = make({ registry, fetch, onChange, log });
    await provider.start();
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${RELAY}/models`);
    expect(init.headers).toEqual({ authorization: `Bearer ${TOKEN}`, accept: "application/json" });
    expect(init.redirect).toBe("error");
    expect(loaded).toHaveLength(1);
    const { instance } = loaded[0]!;
    expect(instance.models).toEqual({ default: "claude-haiku-4-5", options: [{ id: "claude-haiku-4-5", label: "Claude Haiku 4.5" }, { id: "claude-sonnet-5", label: "Claude Sonnet 5" }] });
    expect(instance.startAuthentication).toBeUndefined(); expect(instance.signOut).toBeUndefined(); expect(instance.installRuntime).toBeUndefined();
    expect(await instance.snapshot()).toEqual({ state: "available", authenticated: true, version: null, billing: "metered", account: undefined });
    expect(onChange).toHaveBeenCalledWith([CLOUD_CREDIT_INSTANCE]);
    expect(provider.status()).toBe("active"); expect(provider.owns(CLOUD_CREDIT_INSTANCE)).toBe(true); expect(provider.owns("claude")).toBe(false);
    const saved = readFileSync(join(data, "providers", "trial-credit", "state.json"), "utf8");
    expect(saved).not.toContain(TOKEN);
    expect(JSON.parse(saved)).toMatchObject({ models: [{ id: "claude-haiku-4-5" }, { id: "claude-sonnet-5" }] });
    expect(statSync(join(data, "providers", "trial-credit")).mode & 0o777).toBe(0o700);
    expect(statSync(join(data, "providers", "trial-credit", "state.json")).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(log.mock.calls)).not.toContain(TOKEN);
  });

  it("starts at once on last time's list, and only refreshes it behind", async () => {
    await make({ registry: fakeRegistry().registry, fetch: relay(200, MODELS) }).start();
    const { registry, loaded } = fakeRegistry();
    let answer!: (response: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>(resolve => { answer = resolve; }));
    await make({ registry, fetch }).start();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.instance.models.default).toBe("claude-haiku-4-5");
    // The relay now lists another model first: the engine is loaded again with it.
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    answer(json(200, { data: [{ id: "claude-haiku-5" }] }));
    await vi.waitFor(() => expect(loaded).toHaveLength(2));
    expect(loaded[1]!.instance.models.default).toBe("claude-haiku-5");
  });

  it("asks again, more and more slowly, while the relay cannot answer or is paused, and never logs what it sent", async () => {
    vi.useFakeTimers();
    const { registry, loaded } = fakeRegistry(), log = vi.fn();
    const fetch = vi.fn().mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(refusal(429, "Trial Claude credit is paused for now."))
      .mockResolvedValue(json(200, MODELS));
    const provider = make({ registry, fetch, log });
    await provider.start();
    expect(loaded).toHaveLength(0); expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15_000); expect(fetch).toHaveBeenCalledTimes(2); expect(loaded).toHaveLength(0);
    expect(provider.status()).toBe("active");
    await vi.advanceTimersByTimeAsync(29_999); expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1); await vi.waitFor(() => expect(loaded).toHaveLength(1));
    expect(log.mock.calls.map(([line]) => line)).toEqual([
      "[trial credit] could not list its models yet (TypeError); trying again", "[trial credit] could not list its models yet (Error); trying again"]);
  });

  it("used up, it says so and runs nothing more, across a restart, until another token arrives", async () => {
    const { registry, loaded } = fakeRegistry(), onChange = vi.fn();
    const provider = make({ registry, fetch: relay(200, MODELS), onChange });
    await provider.start();
    const { instance, emit, base } = loaded[0]!;
    const seen: RuntimeEvent[] = [];
    instance.adapter.onEvent(event => seen.push(event));
    // A paused relay, or any other failure, is not the end of the credit.
    emit(runtimeError(upstream(429, "Trial Claude credit is paused for now."))); emit(runtimeError("upstream HTTP 503")); emit(runtimeError("fetch failed"));
    // Too little left for one long chat, or a 402 that isn't the relay's own (a proxy's page): not the end of it either.
    emit(runtimeError(upstream(400, "Your Claude credit has $0.20 left, too little for this request. Start a new chat.", "trial_credit_too_low")));
    emit(runtimeError("upstream HTTP 402: <html><body>Payment Required</body></html>"));
    expect(provider.status()).toBe("active");
    expect(seen.map(event => (event as { message: string }).message)).toEqual([TRIAL_CREDIT_REFUSED.paused, "upstream HTTP 503", "fetch failed", TRIAL_CREDIT_REFUSED.too_low,
      "upstream HTTP 402: <html><body>Payment Required</body></html>"]);
    expect(seen[3]).toMatchObject({ trialCredit: "too_low", setup: true });
    expect(seen[0]).toMatchObject({ trialCredit: "paused" }); expect(seen[0]).not.toHaveProperty("setup");
    emit(runtimeError(upstream(402, "Your $5 trial Claude credit is used up.")));
    expect(seen.at(-1)).toMatchObject({ type: "runtime.error", message: TRIAL_CREDIT_REFUSED.used_up, setup: true, trialCredit: "used_up" });
    await vi.waitFor(() => expect(provider.status()).toBe("used_up"));
    expect(await instance.snapshot()).toEqual({ state: "unavailable", reason: TRIAL_CREDIT_REFUSED.used_up });
    await expect(instance.adapter.sendTurn({ threadId: "t", text: "hi" } as never)).rejects.toThrow(TRIAL_CREDIT_REFUSED.used_up);
    await expect(instance.generateText!("a title, please")).rejects.toThrow(TRIAL_CREDIT_REFUSED.used_up);
    expect(base.adapter.sendTurn).not.toHaveBeenCalled(); expect(base.generateText).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenLastCalledWith([CLOUD_CREDIT_INSTANCE]);
    // The next start remembers, and does not ask the relay.
    const again = fakeRegistry(), fetch = relay(200, MODELS);
    const restarted = make({ registry: again.registry, fetch });
    await restarted.start();
    expect(restarted.status()).toBe("used_up"); expect(fetch).not.toHaveBeenCalled();
    expect(await again.loaded[0]!.instance.snapshot()).toMatchObject({ state: "unavailable" });
    // Another token is another credit.
    const other = fakeRegistry();
    const fresh = make({ registry: other.registry, fetch: relay(200, MODELS), credential: { ...credential, token: `omb_ai_${"n".repeat(43)}` } });
    await fresh.start();
    expect(fresh.status()).toBe("active");
  });

  it("a background call the relay refuses ends the credit too, and says it plainly", async () => {
    const { registry, loaded } = fakeRegistry();
    const provider = make({ registry, fetch: relay(200, MODELS) });
    await provider.start();
    const { instance, base } = loaded[0]!;
    vi.mocked(base.generateText!).mockRejectedValueOnce(new Error(upstream(402, "Trial Claude credit isn't available on this Cloud.")));
    await expect(instance.generateText!("a title")).rejects.toThrow(TRIAL_CREDIT_REFUSED.ended);
    await vi.waitFor(() => expect(provider.status()).toBe("ended"));
  });

  it("refused by the relay before it ever listed a model, it is listed anyway, to say why", async () => {
    for (const [status, message, reason] of [
      [402, "Your $5 trial Claude credit is used up. Connect your own.", "used_up"],
      [402, "Trial Claude credit isn't available on this Cloud.", "ended"],
      [401, "This trial Claude credit key isn't valid.", "ended"],
    ] as const) {
      rmSync(join(data, "providers", "trial-credit", "state.json"), { force: true });
      const { registry, loaded } = fakeRegistry();
      const provider = make({ registry, fetch: vi.fn(async () => refusal(status, message)) });
      await provider.start();
      expect(provider.status()).toBe(reason);
      expect(loaded).toHaveLength(1);
      expect(await loaded[0]!.instance.snapshot()).toEqual({ state: "unavailable", reason: TRIAL_CREDIT_REFUSED[reason] });
    }
  });

  it("through the real chat engine: a turn goes to the relay's chat completions with the token as a Bearer key, and the relay's 402 reads as one plain sentence", async () => {
    const requests: Array<{ url: string; method: string; authorization: string | null; body: string }> = [];
    let usedUp = false;
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input), headers = new Headers(init?.headers);
      requests.push({ url, method: init?.method ?? "GET", authorization: headers.get("authorization"), body: String(init?.body ?? "") });
      if (url === `${RELAY}/models`) return json(200, MODELS);
      if (url === `${RELAY}/chat/completions`) return usedUp ? refusal(402, "Your $5 of Claude credit is used up. To keep your bots working, connect your own Claude or ChatGPT account, or an API key, on your Cloud.")
        : json(200, { id: "c1", object: "chat.completion", model: "claude-haiku-4-5", choices: [{ index: 0, message: { role: "assistant", content: "Hello from the credit" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 12, completion_tokens: 4 } });
      return json(404, { error: { message: "Not found" } });
    });
    vi.stubGlobal("fetch", fetch);
    const registry = new ProviderRegistry([OpenAICompatDriver]);
    const provider = make({ registry, fetch });
    await provider.start();
    const instance = registry.get(CLOUD_CREDIT_INSTANCE)!;
    expect(instance.driverKind).toBe("openai-compat");
    expect(instance.models.default).toBe("claude-haiku-4-5");
    expect(await instance.snapshot()).toMatchObject({ state: "available", authenticated: true, billing: "metered" });
    const recorder = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ threadId: "credit-thread", text: "hi", model: "claude-haiku-4-5" });
    expect(await recorder.until(event => event.type === "turn.completed")).toMatchObject({ ok: true });
    const turn = requests.find(request => request.url === `${RELAY}/chat/completions`)!;
    expect(turn).toMatchObject({ method: "POST", authorization: `Bearer ${TOKEN}` });
    expect(JSON.parse(turn.body)).toMatchObject({ model: "claude-haiku-4-5" });
    expect(JSON.parse(turn.body)).not.toHaveProperty("provider");
    // Only the relay's OpenAI-compatible routes, once each under its base (never `/v1/v1`), and never an Anthropic-shaped one.
    expect(requests.map(request => request.url.slice(RELAY.length)).every(path => ["/models", "/chat/completions"].includes(path))).toBe(true);
    expect(requests.every(request => !request.url.includes("/v1/v1") && !request.url.includes("/messages"))).toBe(true);
    usedUp = true;
    recorder.events.length = 0;
    await instance.adapter.sendTurn({ threadId: "credit-thread-2", text: "more", model: "claude-haiku-4-5" });
    await recorder.until(event => event.type === "turn.completed");
    const failed = recorder.events.find(event => event.type === "runtime.error")!;
    expect(failed).toMatchObject({ message: TRIAL_CREDIT_REFUSED.used_up, setup: true, trialCredit: "used_up" });
    expect(JSON.stringify(recorder.events)).not.toMatch(/insufficient_quota|HTTP 402/);
    expect(JSON.stringify(recorder.events)).not.toContain(TOKEN);
    await vi.waitFor(() => expect(provider.status()).toBe("used_up"));
    expect(await registry.get(CLOUD_CREDIT_INSTANCE)!.snapshot()).toEqual({ state: "unavailable", reason: TRIAL_CREDIT_REFUSED.used_up });
    recorder.stop();
    await registry.dispose(CLOUD_CREDIT_INSTANCE);
  });
});
