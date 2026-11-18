import { inspect } from "node:util";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import * as sdk from "../src/index.js";
import { AuthenticationError, Bot, MausBotError, WaitTimeoutError } from "../src/index.js";

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

  it("keeps the key out of inspect and JSON output", () => {
    const bot = new Bot({ endpoint: "https://x.example/hooks/api/bots/b1/messages", key: "k_secret_123" });
    expect(inspect(bot, { depth: 5, showHidden: true })).not.toContain("k_secret_123");
    expect(JSON.stringify(bot)).not.toContain("k_secret_123");
  });

  it("stops a wait on a server that never answers once the timeout passes", async () => {
    const server = createServer(() => {});
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const bot = new Bot({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, botId: "b1", key: "k" });
      const started = Date.now();
      await expect(bot.wait("t1", { timeout: 0.2 })).rejects.toBeInstanceOf(WaitTimeoutError);
      expect(Date.now() - started).toBeLessThan(1000);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("refuses bad construction input with a MausBotError, never the key", () => {
    const card = "https://x.example/hooks/api/bots/b1/messages";
    const bad: [string, () => Bot][] = [
      ["bad escape", () => new Bot({ endpoint: "https://x.example/hooks/api/bots/b%ZZ/messages", key: "k" })],
      ["bot id with a dot", () => new Bot({ endpoint: "https://x.example/hooks/api/bots/a.b/messages", key: "k" })],
      ["bot id too long", () => new Bot({ baseUrl: "https://x.example", botId: "a".repeat(129), key: "k" })],
      ["baseUrl", () => new Bot({ baseUrl: "not a url", botId: "b1", key: "k" })],
      ["key with a space", () => new Bot({ endpoint: card, key: "k_secret 123" })],
      ["key not ascii", () => new Bot({ endpoint: card, key: "k_secret_é" })],
      ["maxRetries", () => new Bot({ endpoint: card, key: "k", maxRetries: -1 })],
      ["retryDelay", () => new Bot({ endpoint: card, key: "k", retryDelay: -1 })],
    ];
    for (const [, make] of bad) {
      expect(make).toThrow(MausBotError);
      expect(make).not.toThrow(/k_secret/);
    }
    expect(() => new Bot({ endpoint: card, key: "k_secret 123" })).toThrow("The key has characters a MausBot key never has.");
  });

  it("exports the public names only", () => {
    expect(Object.keys(sdk).sort()).toEqual([
      "APIConnectionError", "APIStatusError", "AuthenticationError", "BadRequestError", "Bot", "ConflictError", "JobFailedError", "MausBotError",
      "NotFoundError", "NotSentError", "PermissionDeniedError", "RateLimitError", "ServerError", "ServerTooOldError", "WaitTimeoutError",
    ]);
  });

  it("says a POST that dropped after connecting may have been sent, but a refused connection was not", async () => {
    const make = (cause: unknown) => (async () => { throw Object.assign(new TypeError("fetch failed"), { cause }); }) as unknown as typeof globalThis.fetch;
    const card = "https://x.example/hooks/api/bots/b1/messages";
    const dropped = await new Bot({ endpoint: card, key: "k", fetch: make({ code: "UND_ERR_SOCKET" }) }).send("x").catch((e: unknown) => e);
    expect(String(dropped)).toContain("may have been sent");
    const refused = await new Bot({ endpoint: card, key: "k", fetch: make({ code: "ECONNREFUSED" }) }).send("x").catch((e: unknown) => e);
    expect(String(refused)).toContain("Could not reach");
  });
});
