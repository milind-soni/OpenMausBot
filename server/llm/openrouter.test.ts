import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chatCompletion, openRouterKey, OPENROUTER_TIERS } from "./openrouter.ts";

let server: Server;
let status = 200;
let modelInBody = "";
let authInHeaders = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk; });
    req.on("end", () => {
      modelInBody = JSON.parse(body || "{}").model ?? "";
      authInHeaders = req.headers.authorization ?? "";
      if (status !== 200) {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "fixture-error" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "hello **there**" } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const address = () => {
  const found = server.address();
  if (!found || typeof found === "string") throw new Error("Expected TCP fixture");
  return `http://127.0.0.1:${found.port}/v1`;
};

const deps = () => ({ key: "fake-openrouter-key", baseUrl: address() });

describe("OpenRouter tiered routing", () => {
  it("tries the tier model first, then every fallback in order", async () => {
    status = 503;
    const error = await chatCompletion("brain", { messages: [{ role: "user", content: "hi" }] }, deps()).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.tried).toEqual(["z-ai/glm-5.3", "moonshotai/kimi-k3.1-pro"]);
    status = 200;
  });

  it("recovers when the first model refuses and the fallback answers", async () => {
    let calls = 0;
    const failingFirst = createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => { body += c; });
      req.on("end", () => {
        calls += 1;
        const model = JSON.parse(body).model;
        if (model === OPENROUTER_TIERS.live.model) {
          res.writeHead(429, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "rate limited" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "fallback reply" } }] }));
      });
    });
    await new Promise<void>((resolve) => failingFirst.listen(0, "127.0.0.1", resolve));
    const found = failingFirst.address();
    if (!found || typeof found === "string") throw new Error("Expected TCP fixture");
    const result = await chatCompletion(
      "live",
      { messages: [{ role: "user", content: "hello" }] },
      { key: "k", baseUrl: `http://127.0.0.1:${found.port}/v1` },
    );
    expect(result.model).toBe("qwen/qwen3.8-flash");
    expect(result.text).toBe("fallback reply");
    expect(calls).toBe(2);
    await new Promise<void>((resolve) => failingFirst.close(() => resolve()));
  });

  it("sends the bearer key and the tier model", async () => {
    status = 200;
    const result = await chatCompletion("specialist", { messages: [{ role: "user", content: "diagnose" }] }, deps());
    expect(result.model).toBe(OPENROUTER_TIERS.specialist.model);
    expect(modelInBody).toBe(OPENROUTER_TIERS.specialist.model);
    expect(authInHeaders).toBe("Bearer fake-openrouter-key");
  });

  it("does not fall back on an auth failure", async () => {
    status = 401;
    const error = await chatCompletion("live", { messages: [{ role: "user", content: "hi" }] }, deps()).catch((e) => e);
    expect(error.tried).toEqual([OPENROUTER_TIERS.live.model]);
    status = 200;
  });

  it("names the four tiers with their spec chains", () => {
    expect(OPENROUTER_TIERS.live).toEqual({
      model: "openai/gpt-6-luna",
      reasoning: "none",
      fallbacks: ["qwen/qwen3.8-flash"],
    });
    expect(OPENROUTER_TIERS.background.model).toBe("deepseek/deepseek-v4.1-flash");
    expect(OPENROUTER_TIERS.brain.model).toBe("z-ai/glm-5.3");
    expect(OPENROUTER_TIERS.specialist.fallbacks).toEqual(["minimax/minimax-3.1-flash", "z-ai/glm-5.3"]);
  });

  it("prefers the OMB key name", () => {
    expect(openRouterKey({ OPENROUTER_API_KEY: "plain", OMB_OPENROUTER_API_KEY: "omb" })).toBe("omb");
    expect(openRouterKey({ OPENROUTER_API_KEY: "plain" })).toBe("plain");
    expect(openRouterKey({})).toBeUndefined();
  });
});