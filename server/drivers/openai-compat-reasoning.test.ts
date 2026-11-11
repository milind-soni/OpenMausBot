import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProviderInstance } from "../contracts.ts";
import { recordEvents } from "../testing/events.ts";
import { OpenAICompatDriver } from "./openai-compat.ts";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Serves `rows` as the model list, records what each chat asked for. */
function server(rows: unknown[]) {
  const chats: Array<Record<string, unknown>> = [];
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/models")) return json({ data: rows });
    if (path.endsWith("/chat/completions")) {
      chats.push(JSON.parse(String(init!.body)) as Record<string, unknown>);
      return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Hi." }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    }
    return json({ error: "not found" }, 404);
  }));
  return chats;
}

const create = async (config: Record<string, unknown>) => {
  const instance = await OpenAICompatDriver.create({
    instanceId: randomUUID(), displayName: undefined, enabled: true,
    config: OpenAICompatDriver.decodeConfig({ apiKeyEnv: "OMB_FIXTURE_KEY", ...config }), environment: { OMB_FIXTURE_KEY: "fixture-key" },
  });
  await instance.refreshModels?.();
  return instance;
};

async function turn(instance: ProviderInstance, model: string, variant?: string) {
  const recorder = recordEvents(instance.adapter);
  const threadId = randomUUID();
  await instance.adapter.sendTurn({ threadId, text: "hi", model, ...(variant ? { variant } : {}) });
  await recorder.until((event) => event.type === "turn.completed" && event.threadId === threadId);
  recorder.stop();
}

const variantsOf = (instance: ProviderInstance) => Object.fromEntries(instance.models.options.map((option) => [option.id, option.variants?.map((choice) => choice.id)]));

afterEach(() => vi.unstubAllGlobals());

describe("reasoning effort on an API key", () => {
  it("offers OpenAI's reasoning models the levels, and sends the one picked as reasoning_effort", async () => {
    const chats = server([{ id: "gpt-6.1-sol", created: 5 }, { id: "gpt-5.1-chat-latest", created: 4 }, { id: "gpt-5.2", created: 3 }, { id: "gpt-5-chat-latest", created: 2 }, { id: "gpt-4.1", created: 1 }, { id: "o1-mini", created: 0 }]);
    const instance = await create({ url: "https://llm.example.test/v1", catalog: "openai" });
    try {
      expect(instance.adapter.capabilities.modelVariants).toBe(true);
      expect(variantsOf(instance)).toEqual({
        "gpt-6.1-sol": ["low", "medium", "high"], "gpt-5.1-chat-latest": undefined,
        "gpt-5.2": ["low", "medium", "high"], "gpt-5-chat-latest": undefined, "gpt-4.1": undefined, "o1-mini": undefined,
      });
      await turn(instance, "gpt-5.2", "low");
      await turn(instance, "gpt-5.2");
      await turn(instance, "gpt-4.1", "low");
      expect(chats.map((chat) => chat.reasoning_effort)).toEqual(["low", undefined, undefined]);
    } finally { await instance.dispose(); }
  });

  it("offers an OpenRouter model the levels only when it says it reasons, and sends OpenRouter's own field", async () => {
    const chats = server([{ id: "acme/thinker", supported_parameters: ["tools", "reasoning"] }, { id: "acme/plain", supported_parameters: ["tools"] }]);
    const instance = await create({ url: "https://openrouter.ai/api/v1" });
    try {
      expect(instance.adapter.capabilities.modelVariants).toBe(true);
      expect(variantsOf(instance)).toMatchObject({ "acme/thinker": ["low", "medium", "high"], "acme/plain": undefined });
      await turn(instance, "acme/thinker", "high");
      await turn(instance, "acme/plain", "high");
      expect(chats.map((chat) => chat.reasoning)).toEqual([{ effort: "high" }, undefined]);
      expect(chats.every((chat) => chat.reasoning_effort === undefined)).toBe(true);
    } finally { await instance.dispose(); }
  });

  it("sends nothing to any other server, and offers it no control", async () => {
    const chats = server([{ id: "gpt-5.2", supported_parameters: ["reasoning"] }]);
    const instance = await create({ url: "https://llm.example.test/v1" });
    try {
      expect(instance.adapter.capabilities.modelVariants).toBeUndefined();
      await turn(instance, "gpt-5.2", "high");
      expect(chats[0]).not.toHaveProperty("reasoning_effort");
      expect(chats[0]).not.toHaveProperty("reasoning");
    } finally { await instance.dispose(); }
  });
});
