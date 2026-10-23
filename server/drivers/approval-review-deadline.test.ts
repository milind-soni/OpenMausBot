import { expect, it, vi } from "vitest";
import { PERMISSION_REVIEW_IDLE_TIMEOUT_MS } from "../contracts.ts";
import { OpenAICompatDriver } from "./openai-compat.ts";

it("returns a stalled reviewer to the host after its prefill deadline", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: RequestInit) => {
    if (!String(url).endsWith("/chat/completions")) return new Response('{"data":[]}');
    return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true }));
  }));
  const instance = await OpenAICompatDriver.create({ instanceId: "deadline", displayName: "Fixture", enabled: true,
    config: { url: "http://127.0.0.1:1/v1", apiKeyEnv: "K", model: "fixture" }, environment: { K: "fake" } });
  try {
    const request = instance.reviewPermission!("Review fixture", { model: "fixture" });
    const rejected = expect(request).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(PERMISSION_REVIEW_IDLE_TIMEOUT_MS);
    await rejected;
  } finally { await instance.dispose(); vi.unstubAllGlobals(); vi.useRealTimers(); }
});


it("retries a rejected compatible reasoning parameter without sacrificing Auto review", async () => {
  const requests: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: RequestInit) => {
    if (!String(url).endsWith("/chat/completions")) return new Response('{"data":[]}');
    const body = JSON.parse(String(init?.body)); requests.push(body);
    if ("reasoning_effort" in body) return new Response(JSON.stringify({ error: { message: "Unsupported parameter: reasoning_effort", param: "reasoning_effort" } }), { status: 400 });
    return new Response('data: {"choices":[{"delta":{"content":"allow"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
  }));
  const instance = await OpenAICompatDriver.create({ instanceId: "unsupported-effort", displayName: "Fixture", enabled: true,
    config: { url: "http://127.0.0.1:1/v1", apiKeyEnv: "K", model: "fixture" }, environment: { K: "fake" } });
  try {
    await expect(instance.reviewPermission!("Review fixture", { model: "fixture", effort: "none" })).resolves.toBe("allow");
    expect(requests).toHaveLength(2);
    expect(requests[0]).toHaveProperty("reasoning_effort", "none");
    expect(requests[1]).not.toHaveProperty("reasoning_effort");
  } finally { await instance.dispose(); vi.unstubAllGlobals(); }
});
