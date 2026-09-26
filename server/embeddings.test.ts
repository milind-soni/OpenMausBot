import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createEmbeddingProvider,
  openAICompatEmbedder,
  resolveEmbeddingEndpoint,
  type EmbeddingEndpoint,
} from "./embeddings.ts";

// A local stand-in for an OpenAI-compatible /embeddings endpoint. It records
// what it saw and answers per the key it was given; no real provider is
// contacted anywhere in this file.
describe("embedding provider seam", () => {
  let server: Server;
  let base: string;
  let seen: Array<{ path: string; authorization: string | undefined; body: { model?: unknown; input?: unknown } | null }>;
  let behavior: "ok" | "wrong-count" | "non-finite" | "unauthorized";

  beforeEach(async () => {
    seen = [];
    behavior = "ok";
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        seen.push({
          path: req.url ?? "",
          authorization: req.headers.authorization,
          body: raw ? JSON.parse(raw) as { model?: unknown; input?: unknown } : null,
        });
        if (req.url?.startsWith("/hang")) return; // accepts, never answers
        if (req.url?.startsWith("/moved")) {
          res.writeHead(302, { location: "https://elsewhere.example.test/v1/embeddings" });
          res.end();
          return;
        }
        if (behavior === "unauthorized" || req.headers.authorization !== "Bearer good-key") {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "invalid api key" } }));
          return;
        }
        const input = (JSON.parse(raw) as { input: string[] }).input;
        const rows = input.map((_, index) => ({ embedding: [index * 0.5, 0.25, -1] }));
        if (behavior === "wrong-count") rows.pop();
        if (behavior === "non-finite") rows[0]!.embedding = [0.5, Number.NaN];
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: rows, model: "fixture-embed" }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const endpoint = (overrides: Partial<EmbeddingEndpoint> = {}): EmbeddingEndpoint =>
    ({ url: base, apiKey: "good-key", ...overrides });

  describe("source resolution", () => {
    it("resolves the app-level openaiCompat connection from config, then env, and throws when no key exists", () => {
      expect(resolveEmbeddingEndpoint("openaiCompat", { appConfig: { openaiCompat: { url: `${base}/`, key: "cfg-key" } } }))
        .toEqual({ url: base, apiKey: "cfg-key" });
      expect(resolveEmbeddingEndpoint("openaiCompat", { env: { OPENAI_COMPAT_API_KEY: "env-key", OPENAI_COMPAT_URL: base } }))
        .toEqual({ url: base, apiKey: "env-key" });
      expect(() => resolveEmbeddingEndpoint("openaiCompat", { env: {} })).toThrow(/no openai-compatible api key/i);
    });

    it("resolves an instance source through the openai-compat driver's own decoding and key chain", () => {
      const instances = {
        api: { driver: "openai-compat", config: { url: base, key: "inst-key" } },
        routed: { driver: "openai-compat", config: { url: base, apiKeyEnv: "MY_EMBED_KEY" }, environment: { MY_EMBED_KEY: "env-key" } },
        claude: { driver: "claudeAgent" },
      } as const;
      expect(resolveEmbeddingEndpoint({ instance: "api" }, { instances })).toEqual({ url: base, apiKey: "inst-key" });
      expect(resolveEmbeddingEndpoint({ instance: "routed" }, { instances })).toEqual({ url: base, apiKey: "env-key" });
      expect(() => resolveEmbeddingEndpoint({ instance: "missing" }, { instances })).toThrow(/no provider instance named "missing"/i);
      expect(() => resolveEmbeddingEndpoint({ instance: "claude" }, { instances })).toThrow(/does not speak the openai-compatible contract/i);
      expect(() => resolveEmbeddingEndpoint({ instance: "api" }, { instances: { api: { driver: "openai-compat", config: { url: base } } } }))
        .toThrow(/no api key is configured for provider instance "api"/i);
    });
  });

  describe("openai-compatible provider", () => {
    it("posts the model and texts with the bearer key and returns one vector per text", async () => {
      const provider = openAICompatEmbedder(endpoint(), { model: "text-embedding-fixture" });
      await expect(provider.embed(["alpha", "beta"])).resolves.toEqual([[0, 0.25, -1], [0.5, 0.25, -1]]);
      expect(seen[0]).toMatchObject({ path: "/embeddings", authorization: "Bearer good-key" });
      expect(seen[0]!.body).toEqual({ model: "text-embedding-fixture", input: ["alpha", "beta"] });
    });

    it("throws the provider's status on an unauthorized response", async () => {
      behavior = "unauthorized";
      const provider = openAICompatEmbedder(endpoint(), { model: "text-embedding-fixture" });
      await expect(provider.embed(["alpha"])).rejects.toThrow(/HTTP 401.*invalid api key/);
    });

    it("treats a vector-count mismatch as a protocol failure", async () => {
      behavior = "wrong-count";
      const provider = openAICompatEmbedder(endpoint(), { model: "m" });
      await expect(provider.embed(["alpha", "beta"])).rejects.toThrow(/returned 1 vectors for 2 texts/i);
    });

    it("rejects non-finite vector components", async () => {
      behavior = "non-finite";
      const provider = openAICompatEmbedder(endpoint(), { model: "m" });
      await expect(provider.embed(["alpha"])).rejects.toThrow(/malformed vector/i);
    });

    it("times out a hanging endpoint instead of waiting forever", async () => {
      const provider = openAICompatEmbedder(endpoint({ url: `${base}/hang` }), { model: "m" }, { timeoutMs: 150 });
      await expect(provider.embed(["alpha"])).rejects.toThrow(/timed out after 150ms/);
    });

    it("never follows a redirect with the key", async () => {
      const provider = openAICompatEmbedder(endpoint({ url: `${base}/moved` }), { model: "m" });
      await expect(provider.embed(["alpha"])).rejects.toThrow(/HTTP 302/);
      expect(seen.filter((request) => request.path.startsWith("/moved"))).toHaveLength(1);
    });

    it("fails closed when the endpoint is unreachable", async () => {
      const provider = openAICompatEmbedder(endpoint({ url: "http://127.0.0.1:1" }), { model: "m" }, { timeoutMs: 2_000 });
      await expect(provider.embed(["alpha"])).rejects.toThrow();
    });

    it("refuses to send a key in clear to anything but a loopback test double, and validates inputs", async () => {
      expect(() => openAICompatEmbedder({ url: "http://example.test/v1", apiKey: "k" }, { model: "m" }))
        .toThrow(/only over https/i);
      expect(() => openAICompatEmbedder(endpoint(), { model: "  " })).toThrow(/model id is required/i);
      const provider = openAICompatEmbedder(endpoint(), { model: "m" });
      await expect(provider.embed([])).rejects.toThrow(/at least one text/i);
      await expect(provider.embed([""])).rejects.toThrow(/non-empty string/i);
      await expect(provider.embed(Array.from({ length: 129 }, () => "x"))).rejects.toThrow(/at most 128 texts/i);
      await expect(provider.embed(["x".repeat(32_769)])).rejects.toThrow(/32,768-character cap/i);
    });
  });

  it("creates a working provider from app-level config", async () => {
    const provider = createEmbeddingProvider(
      { model: "text-embedding-fixture", source: "openaiCompat" },
      { appConfig: { openaiCompat: { url: base, key: "good-key" } } },
    );
    expect(provider.model).toBe("text-embedding-fixture");
    await expect(provider.embed(["alpha"])).resolves.toEqual([[0, 0.25, -1]]);
  });
});
