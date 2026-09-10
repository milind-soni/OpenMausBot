import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkProviderKey, providerModelsUrl } from "./provider-key-check.ts";

// A local stand-in for a provider's models endpoint. It records the
// headers it saw and answers per the key it was given; no real provider
// is contacted anywhere in this file.
describe("provider key check", () => {
  let server: Server;
  let base: string;
  let seen: Array<{ path: string; headers: Record<string, string | string[] | undefined> }>;

  beforeEach(async () => {
    seen = [];
    server = createServer((req, res) => {
      seen.push({ path: req.url ?? "", headers: req.headers });
      const key = req.headers["x-api-key"] ?? req.headers.authorization?.replace(/^Bearer /, "");
      if (req.url?.startsWith("/hang")) return;
      if (req.url?.startsWith("/moved")) {
        res.writeHead(302, { location: "https://elsewhere.example.test/v1/models" });
        res.end();
        return;
      }
      if (key === "good-key") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "model-a" }, { id: "model-b" }, { name: "named-c" }, { id: 7 }] }));
        return;
      }
      if (key === "broken-key") {
        res.writeHead(500);
        res.end("boom");
        return;
      }
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "invalid x-api-key" } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("builds each provider's models endpoint from its base URL or the default", () => {
    expect(providerModelsUrl("anthropic")).toBe("https://api.anthropic.com/v1/models");
    expect(providerModelsUrl("anthropic", "https://proxy.example.test/v1/")).toBe("https://proxy.example.test/v1/models");
    expect(providerModelsUrl("openaiCompat")).toBe("https://openrouter.ai/api/v1/models");
    expect(providerModelsUrl("openaiCompat", "https://api.openai.com/v1")).toBe("https://api.openai.com/v1/models");
    expect(providerModelsUrl("xai", "")).toBe("https://api.x.ai/v1/models");
  });

  it("sends the provider's own header shape and returns a few model ids on success", async () => {
    const anthropic = await checkProviderKey({ provider: "anthropic", key: "good-key", url: base });
    expect(anthropic).toEqual({ ok: true, models: ["model-a", "model-b", "named-c"] });
    expect(seen[0]).toMatchObject({ path: "/v1/models", headers: { "x-api-key": "good-key", "anthropic-version": "2023-06-01" } });
    expect(seen[0]!.headers.authorization).toBeUndefined();

    const openai = await checkProviderKey({ provider: "openaiCompat", key: "good-key", url: `${base}/v1` });
    expect(openai.ok).toBe(true);
    expect(seen[1]).toMatchObject({ path: "/v1/models", headers: { authorization: "Bearer good-key" } });
    expect(seen[1]!.headers["x-api-key"]).toBeUndefined();
  });

  it("tells a rejected key from a broken provider and from an unreachable one", async () => {
    expect(await checkProviderKey({ provider: "xai", key: "bad-key", url: base })).toEqual({ ok: false, reason: "rejected", status: 401 });
    expect(await checkProviderKey({ provider: "xai", key: "broken-key", url: base })).toEqual({ ok: false, reason: "unexpected", status: 500 });
    expect(await checkProviderKey({ provider: "xai", key: "good-key", url: "http://127.0.0.1:1" })).toEqual({ ok: false, reason: "unreachable" });
  });

  it("gives up on a hanging provider and never follows a redirect with the key", async () => {
    expect(await checkProviderKey({ provider: "openaiCompat", key: "good-key", url: `${base}/hang` }, fetch, 200)).toEqual({ ok: false, reason: "unreachable" });
    expect(await checkProviderKey({ provider: "openaiCompat", key: "good-key", url: `${base}/moved` })).toEqual({ ok: false, reason: "unexpected", status: 302 });
    expect(seen.filter((request) => request.path.startsWith("/moved"))).toHaveLength(1);
  });

  it("refuses to send a key in clear to anything but a loopback test double", async () => {
    let called = false;
    const spy: typeof fetch = async () => { called = true; return new Response("{}"); };
    expect(await checkProviderKey({ provider: "openaiCompat", key: "good-key", url: "http://models.example.test/v1" }, spy)).toEqual({ ok: false, reason: "unexpected" });
    expect(await checkProviderKey({ provider: "openaiCompat", key: "good-key", url: "not a url" }, spy)).toEqual({ ok: false, reason: "unexpected" });
    expect(called).toBe(false);
  });
});
