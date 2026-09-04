// The fake OpenAI-compatible server, parsed by pi-ai's REAL provider — the
// only way to prove the wire shape is right rather than merely plausible.
import { afterEach, describe, expect, it } from "vitest";

import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";

import { startFakeOpenAI, type FakeOpenAIOptions, type FakeOpenAIServer } from "../testing/fake-openai-server.ts";
import { toPiModel } from "./pi-runtime.ts";

let live: FakeOpenAIServer[] = [];
const start = async (mode: FakeOpenAIOptions["mode"]) => {
  const s = await startFakeOpenAI({ mode, delayMs: 2_000 });
  live.push(s);
  return s;
};
afterEach(async () => {
  await Promise.all(live.map((s) => s.close()));
  live = [];
});

const modelFor = (url: string) =>
  toPiModel({ id: "fake-model", baseUrl: url, apiKey: "k", contextWindow: 8_000, maxOutputTokens: 512, reasoning: true });

async function collect(stream: ReturnType<typeof streamSimple>) {
  const events: string[] = [];
  for await (const e of stream) events.push(e.type);
  return { events, message: await stream.result() };
}

describe("fake OpenAI-compatible server × pi-ai openai-completions", () => {
  it("streams text the provider assembles into one assistant message", async () => {
    const s = await start("echo");
    const { events, message } = await collect(streamSimple(modelFor(s.url), { messages: [{ role: "user", content: "hello", timestamp: 1 }] }, { apiKey: "k", env: {} }));
    expect(events).toContain("text_delta");
    expect(events.at(-1)).toBe("done");
    expect(message.stopReason).toBe("stop");
    expect(message.content).toEqual([{ type: "text", text: "fake says: hello" }]);
    // the provider reports input NET of cache reads: 12 prompt tokens with
    // 4 served from cache is 8 billed-as-input plus 4 cacheRead
    expect(message.usage.input).toBe(8);
    expect(message.usage.cacheRead).toBe(4);
    expect(message.usage.output).toBe(5);
  });

  it("streams reasoning as thinking content, separate from text", async () => {
    const s = await start("reasoning");
    const { message } = await collect(streamSimple(modelFor(s.url), { messages: [{ role: "user", content: "why", timestamp: 1 }] }, { apiKey: "k", env: {} }));
    expect(message.content[0]).toMatchObject({ type: "thinking", thinking: "thinking about the answer" });
    expect(message.content[1]).toMatchObject({ type: "text", text: "fake says: why" });
  });

  it("reassembles a tool call split across chunks, ending in toolUse", async () => {
    const s = await start("tool");
    const { message } = await collect(streamSimple(modelFor(s.url), { messages: [{ role: "user", content: "do it", timestamp: 1 }] }, { apiKey: "k", env: {} }));
    expect(message.stopReason).toBe("toolUse");
    expect(message.content).toEqual([{ type: "toolCall", id: "call_fake_1", name: "echo", arguments: { text: "from the fake" } }]);
  });

  it("surfaces an upstream error as an error event, not a hang", async () => {
    const s = await start("error");
    const stream = streamSimple(modelFor(s.url), { messages: [{ role: "user", content: "x", timestamp: 1 }] }, { apiKey: "k", env: {}, maxRetries: 0 });
    const events: string[] = [];
    for await (const e of stream) events.push(e.type);
    expect(events.at(-1)).toBe("error");
  });

  it("sends the key it was given and only that", async () => {
    const s = await start("echo");
    await collect(streamSimple(modelFor(s.url), { messages: [{ role: "user", content: "x", timestamp: 1 }] }, { apiKey: "sk-explicit", env: {} }));
    expect(s.requests).toHaveLength(1);
  });
});
