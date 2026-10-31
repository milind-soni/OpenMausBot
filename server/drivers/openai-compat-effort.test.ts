import { afterEach, expect, it, vi } from "vitest";

import type { RuntimeEvent } from "../contracts.ts";
import { OpenAICompatDriver } from "./openai-compat.ts";

afterEach(() => vi.unstubAllGlobals());

const models = {
  data: [
    { id: "deepseek-v4.1-flash", reasoning_effort_levels: ["low", "medium", "high"] },
    { id: "router-model", supported_parameters: ["tools", "reasoning_effort"] },
    { id: "openrouter-model", supported_parameters: ["reasoning_effort"], reasoning: { supported_efforts: ["max", "high", "low", "none"] } },
    { id: "nested-model", reasoning_effort_levels: [], reasoning: { supported_efforts: ["max"] } },
    { id: "any-effort-model", reasoning: { supported_efforts: null } },
    { id: "xhigh-model", reasoning_effort_levels: ["high", "xhigh"] },
    { id: "plain-model" },
  ],
};
const reply = 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';

async function fixture(url = "https://api.example.test/v1", { loaded = true, provider }: { loaded?: boolean; provider?: string } = {}) {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    if (String(input).endsWith("/models")) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return Response.json(models);
    }
    if (!String(input).endsWith("/chat/completions")) return new Response("", { status: 404 });
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(reply, { headers: { "content-type": "text/event-stream" } });
  }));
  const instance = await OpenAICompatDriver.create({
    instanceId: "openai-compat-1", displayName: "Flatt", enabled: true,
    config: OpenAICompatDriver.decodeConfig({ url, apiKeyEnv: "K", ...(provider ? { provider } : {}) }),
    environment: { K: "fixture-key" },
  });
  if (loaded) await instance.refreshModels?.();
  const turn = async (model: string, variant?: string) => {
    const events: RuntimeEvent[] = [];
    const off = instance.adapter.onEvent((event) => events.push(event));
    await instance.adapter.sendTurn({ threadId: `t-${bodies.length}`, text: "hi", model, ...(variant ? { variant } : {}) });
    await vi.waitFor(() => { if (!events.some((event) => event.type === "turn.completed")) throw new Error("running"); });
    off();
    return bodies.at(-1)!;
  };
  return { instance, turn };
}

it("offers the reasoning efforts a model advertises on /models", async () => {
  const { instance } = await fixture();
  expect(instance.adapter.capabilities.modelVariants).toBe(true);
  const variants = Object.fromEntries(instance.models.options.map((option) => [option.id, option.variants?.map((variant) => variant.id)]));
  expect(variants).toEqual({
    "deepseek-v4.1-flash": ["low", "medium", "high"],
    "router-model": ["low", "medium", "high"],
    "openrouter-model": ["max", "high", "low", "none"],
    "nested-model": ["max"],
    "any-effort-model": undefined,
    "xhigh-model": ["high", "xhigh"],
    "plain-model": undefined,
  });
  expect(instance.models.options.find((option) => option.id === "xhigh-model")?.variants?.map((variant) => variant.label)).toEqual(["High", "X-High"]);
  await instance.dispose();
});

it("offers OpenRouter's published efforts, the common three for a null list, and never a guess from supported_parameters", async () => {
  const { instance } = await fixture("https://openrouter.ai/api/v1");
  const variants = Object.fromEntries(instance.models.options.map((option) => [option.id, option.variants?.map((variant) => variant.id)]));
  expect(variants["router-model"]).toBeUndefined();
  expect(variants["openrouter-model"]).toEqual(["max", "high", "low", "none"]);
  expect(variants["any-effort-model"]).toEqual(["low", "medium", "high"]);
  await instance.dispose();
});

it("sends a saved effort as chosen while /models has not answered yet", async () => {
  const { instance, turn } = await fixture(undefined, { loaded: false });
  expect((await turn("deepseek-v4.1-flash", "high")).reasoning_effort).toBe("high");
  await instance.dispose();
});

it("sends the chosen effort as reasoning_effort, and nothing the model does not advertise", async () => {
  const { instance, turn } = await fixture();
  expect((await turn("deepseek-v4.1-flash", "high")).reasoning_effort).toBe("high");
  expect(await turn("deepseek-v4.1-flash")).not.toHaveProperty("reasoning_effort");
  expect(await turn("deepseek-v4.1-flash", "turbo")).not.toHaveProperty("reasoning_effort");
  expect(await turn("plain-model", "high")).not.toHaveProperty("reasoning_effort");
  await instance.dispose();
});

it("asks OpenRouter for a provider that applies the chosen effort, and leaves routing alone otherwise", async () => {
  const { instance, turn } = await fixture("https://openrouter.ai/api/v1");
  expect(await turn("openrouter-model", "max")).toMatchObject({ reasoning_effort: "max", provider: { require_parameters: true } });
  expect(await turn("openrouter-model")).not.toHaveProperty("provider");
  await instance.dispose();
});

it("keeps a pinned OpenRouter provider when it asks for one that applies the effort", async () => {
  const { instance, turn } = await fixture("https://openrouter.ai/api/v1", { provider: "deepinfra" });
  expect((await turn("openrouter-model", "high")).provider).toEqual({ order: ["deepinfra"], allow_fallbacks: false, require_parameters: true });
  expect((await turn("openrouter-model")).provider).toEqual({ order: ["deepinfra"], allow_fallbacks: false });
  await instance.dispose();
});

