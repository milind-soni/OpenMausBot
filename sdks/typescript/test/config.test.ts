import { describe, expect, it, vi } from "vitest";
import { AuthenticationError, Bot, MausBotError } from "../src/index.js";

const replied = () => new Response(JSON.stringify({ reply: "hi", thread: "t1" }), { status: 200, headers: { "content-type": "application/json" } });
const recorder = (make: () => Response = replied) => {
  const calls: { url: string; auth: string | null }[] = [];
  const fetch = vi.fn(async (url: URL | string, init?: RequestInit) => {
    calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
    return make();
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
};

describe("Bot config", () => {
  it("rewrites the card's address to /v1, including a local desktop address and a trailing slash", async () => {
    const { calls, fetch } = recorder();
    await new Bot({ endpoint: "http://127.0.0.1:8799/hooks/api/bots/b1/messages/", key: "k", fetch }).send("x");
    expect(calls[0].url).toBe("http://127.0.0.1:8799/hooks/api/v1/bots/b1/messages");
  });

  it("keeps an address that already has /v1", async () => {
    const { calls, fetch } = recorder();
    await new Bot({ endpoint: "https://x.example/hooks/api/v1/bots/b1/messages", key: "k", fetch }).send("x");
    expect(calls[0].url).toBe("https://x.example/hooks/api/v1/bots/b1/messages");
  });

  it("reads MAUSBOT_BOT_URL and MAUSBOT_BOT_KEY, trimmed", async () => {
    vi.stubEnv("MAUSBOT_BOT_URL", " https://x.example/hooks/api/bots/b1/messages\n");
    vi.stubEnv("MAUSBOT_BOT_KEY", "k_test\n");
    try {
      const { calls, fetch } = recorder();
      await new Bot({ fetch }).send("x");
      expect(calls[0]).toEqual({ url: "https://x.example/hooks/api/v1/bots/b1/messages", auth: "Bearer k_test" });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("refuses a missing key or an address that isn't a Bot API address, at construction", () => {
    vi.stubEnv("MAUSBOT_BOT_KEY", "");
    try {
      expect(() => new Bot({ endpoint: "https://x.example/hooks/api/bots/b1/messages" })).toThrow(MausBotError);
    } finally {
      vi.unstubAllEnvs();
    }
    for (const endpoint of ["https://x.example/other", "not a url", undefined]) {
      const make = () => new Bot({ endpoint, key: "k_secret_123" });
      expect(make).toThrow(MausBotError);
      expect(make).not.toThrow(/k_secret_123/);
    }
  });

  it("never puts the key in an error message", async () => {
    const { fetch } = recorder(() => new Response(JSON.stringify({ error: "Invalid key" }), { status: 401 }));
    const error = await new Bot({ endpoint: "https://x.example/hooks/api/bots/b1/messages", key: "k_secret_123", fetch }).send("x").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuthenticationError);
    expect(String(error)).not.toContain("k_secret_123");
    expect(JSON.stringify(error)).not.toContain("k_secret_123");
  });
});
