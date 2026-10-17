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
