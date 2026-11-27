import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { IMAGE_DEFAULT_MODELS, IMAGE_MODEL_CHOICES } from "../../shared/image-generation.ts";
import type { ImageCredentials } from "../image-generation.ts";
import type { RequestAuth } from "../request-auth.ts";
import { createImageSettingsRoutes } from "./image-settings.ts";
import { PASS } from "./table.ts";

const entry = (id: string, outputs: string[]) => ({ id, name: `Name of ${id}`, architecture: { output_modalities: outputs } });
const catalog = (...models: unknown[]) => new Response(JSON.stringify({ data: models }), { status: 200 });
const listSchema = z.object({ source: z.string(), models: z.array(z.object({ id: z.string(), group: z.string() })) });
const verdictSchema = z.object({ ok: z.boolean(), reason: z.string().optional(), model: z.string().optional(), freeTier: z.boolean().optional(), check: z.string().optional(), status: z.number().optional() });

async function call(route: ReturnType<typeof createImageSettingsRoutes>, path: string, method: string, body?: unknown) {
  const req = new IncomingMessage(new Socket());
  const res = new ServerResponse(req);
  let answer: { status: number; body: unknown } | null = null;
  const out = await route({
    req, res, url: new URL(`http://localhost${path}`), path, method,
    readBody: async () => body,
    auth: { kind: "loopback", scopes: ["admin"] } as RequestAuth,
    json: (_res, status, sent) => { answer = { status, body: sent }; },
  });
  return { out, answer: answer as { status: number; body: unknown } | null };
}

const models = async (route: ReturnType<typeof createImageSettingsRoutes>) => listSchema.parse((await call(route, "/api/images/openrouter-models", "GET")).answer?.body);
const test = async (cfg: ImageCredentials, provider: string, fetchImpl: typeof fetch) => {
  const { answer } = await call(createImageSettingsRoutes({ config: () => cfg, fetch: fetchImpl }), "/api/images/test", "POST", { provider });
  return { status: answer?.status, verdict: verdictSchema.parse(answer?.body) };
};

describe("the OpenRouter image model list in Settings", () => {
  it("asks OpenRouter for image models only and lists the curated ones first, then the rest", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => catalog(
      entry("acme/painter-9", ["image"]),
      entry(IMAGE_DEFAULT_MODELS.openrouter, ["image", "text"]),
      entry("openrouter/auto", ["text", "image"]),
      entry("acme/chatty", ["text"]),
    ));
    const list = await models(createImageSettingsRoutes({ config: () => ({}), fetch: fetchImpl }));
    expect(String(fetchImpl.mock.calls[0]![0])).toBe("https://openrouter.ai/api/v1/models?output_modalities=image");
    expect(list.source).toBe("openrouter");
    expect(list.models.map((m) => [m.group, m.id])).toEqual([
      ["recommended", IMAGE_DEFAULT_MODELS.openrouter],
      ["more", "acme/painter-9"],
    ]);
  });

  it("falls back to the curated list, default first, when OpenRouter cannot be reached", async () => {
    const list = await models(createImageSettingsRoutes({ config: () => ({}), fetch: async () => { throw new TypeError("offline"); } }));
    expect(list.source).toBe("builtin");
    expect(list.models.map((m) => m.id)).toEqual(IMAGE_MODEL_CHOICES.openrouter.map((m) => m.id));
    expect(list.models[0]!.id).toBe(IMAGE_DEFAULT_MODELS.openrouter);
  });

  it("leaves other requests to the next route", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const route = createImageSettingsRoutes({ config: () => ({}), fetch: fetchImpl });
    expect((await call(route, "/api/images/openrouter-models", "POST")).out).toBe(PASS);
    expect((await call(route, "/api/decider/models", "GET")).out).toBe(PASS);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("previewing a bot avatar from Settings", () => {
  it("draws the avatar with the image provider and answers it as a data URL", async () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ data: [{ b64_json: png.toString("base64") }] }));
    const route = createImageSettingsRoutes({ config: () => ({ imageGen: { key: "openai-image-key", primary: { provider: "openai" } } }), fetch: fetchImpl });
    const { answer } = await call(route, "/api/bot-defaults/avatar", "POST", { profile: { name: "Scout" }, prompt: "a blue owl" });
    expect(answer).toEqual({ status: 200, body: { dataUrl: `data:image/png;base64,${png.toString("base64")}` } });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("https://api.openai.com/v1/images/generations");
    expect(String(fetchImpl.mock.calls[0]?.[1]?.body)).toContain("a blue owl");
  });
});

describe("testing an image provider from Settings, without making an image", () => {
  const openrouter = (model?: string): ImageCredentials => ({ openrouter: { key: "or-key" }, imageGen: { primary: { provider: "openrouter", ...(model ? { model } : {}) } } });
  const answers = (routes: Record<string, () => Response>) => vi.fn<typeof fetch>(async (url) => {
    const found = Object.entries(routes).find(([prefix]) => String(url).startsWith(prefix));
    if (!found) throw new Error(`unexpected request to ${String(url)}`);
    return found[1]();
  });

  it("checks the OpenRouter key and that the chosen model exists, and reports an account without credit", async () => {
    const fetchImpl = answers({
      "https://openrouter.ai/api/v1/key": () => Response.json({ data: { is_free_tier: true } }),
      "https://openrouter.ai/api/v1/models/google/gemini-2.5-flash-image/endpoints": () => Response.json({ data: {} }),
    });
    expect(await test(openrouter(), "openrouter", fetchImpl)).toEqual({ status: 200, verdict: { ok: true, check: "authentication", freeTier: true } });
    expect(fetchImpl.mock.calls.find(([url]) => String(url).endsWith("/endpoints"))?.[1]?.headers).not.toHaveProperty("authorization");
  });

  it("names a model OpenRouter does not have", async () => {
    const fetchImpl = answers({
      "https://openrouter.ai/api/v1/key": () => Response.json({ data: { is_free_tier: false } }),
      "https://openrouter.ai/api/v1/models/acme/nope-9/endpoints": () => new Response("{}", { status: 404 }),
    });
    expect((await test(openrouter("acme/nope-9"), "openrouter", fetchImpl)).verdict).toEqual({ ok: false, reason: "model_missing", model: "acme/nope-9" });
  });

  it("says OpenRouter was unreachable when the model check gets no answer, never that the model is there", async () => {
    for (const endpoints of [() => new Response("{}", { status: 503 }), () => { throw new TypeError("fetch failed"); }]) {
      const fetchImpl = answers({
        "https://openrouter.ai/api/v1/key": () => Response.json({ data: { is_free_tier: false } }),
        "https://openrouter.ai/api/v1/models/google/gemini-2.5-flash-image/endpoints": endpoints,
      });
      expect((await test(openrouter(), "openrouter", fetchImpl)).verdict).toEqual({ ok: false, reason: "unreachable" });
    }
  });

  it("reports a refused key, and a missing key without calling anyone", async () => {
    const refused = answers({ "https://api.openai.com/v1/models": () => new Response("{}", { status: 401 }) });
    expect((await test({ imageGen: { key: "sk-wrong" } }, "openai", refused)).verdict).toEqual({ ok: false, reason: "rejected", status: 401 });
    const none = vi.fn<typeof fetch>();
    expect((await test({}, "gemini", none)).verdict).toEqual({ ok: false, reason: "no_key" });
    expect(none).not.toHaveBeenCalled();
  });

  it("sends a Gemini key to Google's OpenAI-compatible model list", async () => {
    const fetchImpl = answers({ "https://generativelanguage.googleapis.com/v1beta/openai/models": () => Response.json({ data: [{ id: "gemini-2.5-flash-image" }] }) });
    expect((await test({ imageGen: { geminiKey: "AIza-key" } }, "gemini", fetchImpl)).verdict).toEqual({ ok: true, check: "models" });
  });

  it("never sends a Custom key anywhere while Custom has no usable URL", async () => {
    const none = vi.fn<typeof fetch>();
    for (const customUrl of [undefined, "not a url"]) {
      const cfg: ImageCredentials = { imageGen: { customApiKey: "private-gateway-key", customUrl, primary: { provider: "custom", model: "local/image" } } };
      expect((await test(cfg, "custom", none)).verdict).toEqual({ ok: false, reason: "no_url" });
    }
    expect(none).not.toHaveBeenCalled();
  });

  it("refuses a request that names no known provider", async () => {
    const { answer } = await call(createImageSettingsRoutes({ config: () => ({}), fetch: vi.fn<typeof fetch>() }), "/api/images/test", "POST", { provider: "acme" });
    expect(answer?.status).toBe(400);
  });
});
