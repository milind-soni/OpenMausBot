import { afterEach, expect, it, vi } from "vitest";
import { OpenAICompatDriver, advertisedContextWindow } from "./openai-compat.ts";
import { recordEvents } from "../testing/events.ts";
import { compactBudget, contextWindowFor } from "../context-budget.ts";

const KEY = "fixture-key";
const MODEL = "local-qwen";
afterEach(() => { vi.unstubAllGlobals(); });

it.each(["context_length", "context_window", "max_model_len", "max_context_length", "contextWindow"])("accepts advertised %s but ignores output budgets and malformed limits", key => {
  expect(advertisedContextWindow({ [key]: 262144 })).toBe(262144);
  for (const value of [0, -1, 3.2, "262144", null, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    expect(advertisedContextWindow({ [key]: value, max_tokens: 1000 })).toBeUndefined();
  }
  expect(advertisedContextWindow({ top_provider: { context_length: 32768 } })).toBe(32768);
  expect(advertisedContextWindow({ context_length: 131072, top_provider: { context_length: 32768 } })).toBe(32768);
  expect(advertisedContextWindow({ meta: { n_ctx_train: 131072 } })).toBeUndefined();
});

async function instance(rows: unknown[]) {
  vi.stubGlobal("fetch", vi.fn(async input => {
    if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: rows }));
    return new Response('data: {"choices":[{"delta":{"content":"OK"}}],"usage":{"prompt_tokens":100,"completion_tokens":2}}\n\ndata: [DONE]\n\n');
  }));
  const inst = await OpenAICompatDriver.create({ instanceId: "test", displayName: "Fixture", enabled: true,
    config: { url: "https://endpoint.invalid/v1", apiKeyEnv: "TEST_KEY", model: MODEL }, environment: { TEST_KEY: KEY } });
  await inst.refreshModels!();
  return inst;
}

it("carries discovered capacity into compaction and reported turn usage", async () => {
  const inst = await instance([{ id: MODEL, context_length: 262144 }, { id: "small", max_model_len: 8192 }]);
  const recorder = recordEvents(inst.adapter);
  try {
    const window = contextWindowFor(MODEL, inst.models);
    expect(window).toBe(262144);
    expect(compactBudget(window)).toBe(Math.floor(window * 0.8));
    await inst.adapter.sendTurn({ threadId: "window", text: "hello", model: MODEL });
    await recorder.until(event => event.type === "turn.completed");
    expect(recorder.events.find(event => event.type === "thread.token-usage.updated")).toMatchObject({ contextWindow: window, contextTokens: 102 });
    expect(contextWindowFor("small", inst.models)).toBe(8192);
  } finally { recorder.stop(); await inst.dispose(); }
});

it("uses llama.cpp's slot size rather than its training window, without autoload", async () => {
  const calls: URL[] = [];
  vi.stubGlobal("fetch", vi.fn(async input => {
    const url = new URL(String(input)); calls.push(url);
    return new Response(JSON.stringify(url.pathname.endsWith("/models")
      ? { data: [{ id: MODEL, owned_by: "llamacpp", context_length: 131072, meta: { n_ctx_train: 131072 } }] }
      : { default_generation_settings: { n_ctx: 8192 } }));
  }));
  const inst = await OpenAICompatDriver.create({ instanceId: "llama", displayName: "Fixture", enabled: true,
    config: { url: "http://127.0.0.1:9999/prefix/v1", apiKeyEnv: "TEST_KEY", model: MODEL }, environment: { TEST_KEY: KEY } });
  try {
    await inst.refreshModels!();
    expect(contextWindowFor(MODEL, inst.models)).toBe(8192);
    const props = calls.find(url => url.pathname.endsWith("/props"))!;
    expect(props.pathname).toBe("/prefix/props");
    expect(props.searchParams.get("model")).toBe(MODEL);
    expect(props.searchParams.get("autoload")).toBe("false");
  } finally { await inst.dispose(); }
});

it("keeps unknown limits unknown and does not reuse another model's limit", async () => {
  const inst = await instance([{ id: MODEL, context_length: -1 }, { id: "other", context_length: 262144 }]);
  try {
    expect(inst.models.options.find(option => option.id === MODEL)).not.toHaveProperty("contextWindow");
    expect(contextWindowFor(MODEL, inst.models)).not.toBe(contextWindowFor("other", inst.models));
  } finally { await inst.dispose(); }
});


it.each([new Response("", { status: 404 }), new Response(JSON.stringify({ default_generation_settings: { n_ctx: -1 } }))])("retains catalog capacity when optional runtime props are unavailable or invalid", async response => {
  vi.stubGlobal("fetch", vi.fn(async input => String(input).endsWith("/models")
    ? new Response(JSON.stringify({ data: [{ id: MODEL, owned_by: "llamacpp", context_length: 32768 }] })) : response.clone()));
  const inst = await OpenAICompatDriver.create({ instanceId: "props-fallback", displayName: "Fixture", enabled: true,
    config: OpenAICompatDriver.decodeConfig({ url: "https://endpoint.invalid/v1", apiKeyEnv: "TEST_KEY", model: MODEL }), environment: { TEST_KEY: KEY } });
  try { await inst.refreshModels!(); expect(contextWindowFor(MODEL, inst.models)).toBe(32768); }
  finally { await inst.dispose(); }
});

it("discovers each llama.cpp model's serving capacity without autoloading", async () => {
  const selected: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/models")) return new Response(JSON.stringify({ data: [MODEL, "second-model"].map(id => ({ id, owned_by: "llamacpp", context_length: 131072 })) }));
    expect(url.searchParams.get("autoload")).toBe("false");
    const model = url.searchParams.get("model")!; selected.push(model);
    return new Response(JSON.stringify({ default_generation_settings: { n_ctx: model === MODEL ? 8192 : 16384 } }));
  }));
  const inst = await OpenAICompatDriver.create({ instanceId: "multi-llama", displayName: "Fixture", enabled: true,
    config: { url: "http://127.0.0.1:9999/v1", apiKeyEnv: "TEST_KEY", model: MODEL }, environment: { TEST_KEY: KEY } });
  try { await inst.refreshModels!(); expect(selected).toContain("second-model"); expect(contextWindowFor("second-model", inst.models)).toBe(16384); }
  finally { await inst.dispose(); }
});
