import { describe, expect, it, vi } from "vitest";

import { IMAGE_DEFAULT_MODELS } from "../shared/image-generation.ts";
import { generateImage, imageGenerationReady, imageSlots } from "./image-generation.ts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const BOTH = {
  imageGen: { key: "openai-secret", primary: { provider: "openai" as const }, fallback: { provider: "xai" as const } },
  xai: { key: "xai-secret" },
};

function imageResponse(): Response {
  return new Response(JSON.stringify({ data: [{ b64_json: PNG.toString("base64") }] }), { status: 200 });
}

function hostOf(call: Parameters<typeof fetch>): string {
  return new URL(String(call[0])).host;
}

describe("image slots", () => {
  it("reads an older single-provider config as the base with no backup", () => {
    expect(imageSlots({ imageGen: { provider: "custom", customModel: "local/image" } })).toEqual({
      primary: { provider: "custom", model: "local/image" }, fallback: null,
    });
    expect(imageSlots({})).toEqual({ primary: { provider: "openai", model: "gpt-image-2" }, fallback: null });
  });

  it("prefers the saved base over the older provider field and fills each provider's default model", () => {
    expect(imageSlots({ imageGen: { provider: "custom", primary: { provider: "xai" }, fallback: { provider: "openai", model: "gpt-image-1" } } })).toEqual({
      primary: { provider: "xai", model: "grok-imagine-image-2.0" },
      fallback: { provider: "openai", model: "gpt-image-1" },
    });
  });

  it("ignores a backup identical to the base", () => {
    expect(imageSlots({ imageGen: { primary: { provider: "xai" }, fallback: { provider: "xai" } } }).fallback).toBeNull();
  });
});

describe("provider requests", () => {
  it("sends a Gemini key only to Google's OpenAI-compatible image route", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => imageResponse());
    const cfg = { ...BOTH, imageGen: { ...BOTH.imageGen, geminiKey: "gemini-secret", primary: { provider: "gemini" as const } } };
    await expect(generateImage(cfg, { prompt: "owl" }, { fetchImpl: fetchMock })).resolves.toMatchObject({ provider: "gemini", model: "gemini-2.5-flash-image" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/openai/images/generations");
    expect(init?.headers).toMatchObject({ authorization: "Bearer gemini-secret" });
    expect(JSON.stringify(init)).not.toMatch(/openai-secret|xai-secret/);
    expect(JSON.parse(String(init?.body))).toEqual({ model: "gemini-2.5-flash-image", prompt: "owl", response_format: "b64_json", size: "1024x1024", n: 1 });
  });

  it("reuses the OpenRouter key at OpenRouter's image endpoint with the chosen model and shape", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => imageResponse());
    const cfg = { ...BOTH, openrouter: { key: "or-secret" }, imageGen: { ...BOTH.imageGen, primary: { provider: "openrouter" as const, model: "black-forest-labs/flux.2-pro" } } };
    await generateImage(cfg, { prompt: "owl", aspect: "16:9" }, { fetchImpl: fetchMock });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://openrouter.ai/api/v1/images");
    expect(init?.headers).toMatchObject({ authorization: "Bearer or-secret" });
    expect(JSON.parse(String(init?.body))).toEqual({ model: "black-forest-labs/flux.2-pro", prompt: "owl", aspect_ratio: "16:9" });
  });

  it("maps a wide request to OpenAI's landscape size at the provider's normal quality", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => imageResponse());
    await generateImage(BOTH, { prompt: "owl", aspect: "16:9" }, { fetchImpl: fetchMock });
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toMatchObject({ size: "1536x1024", quality: "auto" });
  });

  it("accepts a Custom provider that sends url and revised_prompt as null next to the image", async () => {
    const body = { created: 1, data: [{ b64_json: PNG.toString("base64"), url: null, revised_prompt: null }] };
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status: 200 }));
    const cfg = { imageGen: { customUrl: "http://127.0.0.1:4711/v1/openai", customApiKey: "custom-secret", customModel: "vendor/image-model", primary: { provider: "custom" as const } } };
    await expect(generateImage(cfg, { prompt: "owl" }, { fetchImpl: fetchMock })).resolves.toMatchObject({ provider: "custom", model: "vendor/image-model" });
  });

  it("still asks for inline image data when a provider sends only a url", async () => {
    const body = { data: [{ b64_json: null, url: "https://images.example/owl.png" }] };
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status: 200 }));
    await expect(generateImage({ imageGen: { key: "openai-secret" } }, { prompt: "owl" }, { fetchImpl: fetchMock })).rejects.toThrow("must return base64 image data (b64_json)");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["gemini", "openrouter"] as const)("treats %s without its key as not set up, so the backup takes over", async (provider) => {
    const fetchMock = vi.fn<typeof fetch>(async () => imageResponse());
    const cfg = { ...BOTH, imageGen: { ...BOTH.imageGen, primary: { provider } } };
    await expect(generateImage(cfg, { prompt: "owl" }, { fetchImpl: fetchMock })).resolves.toMatchObject({ provider: "xai", usedFallback: true });
  });
});

describe("generateImage with a backup", () => {
  it("uses only the base when it succeeds", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => imageResponse());
    await expect(generateImage(BOTH, { prompt: "owl" }, { fetchImpl: fetchMock })).resolves.toMatchObject({
      mime: "image/png", provider: "openai", model: "gpt-image-2", usedFallback: false,
    });
    expect(fetchMock.mock.calls.map(hostOf)).toEqual(["api.openai.com"]);
  });

  it("moves to the backup when the base has no key, without calling the base", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => imageResponse());
    const cfg = { ...BOTH, imageGen: { ...BOTH.imageGen, key: "" } };
    await expect(generateImage(cfg, { prompt: "owl" }, { fetchImpl: fetchMock })).resolves.toMatchObject({ provider: "xai", usedFallback: true });
    expect(fetchMock.mock.calls.map(hostOf)).toEqual(["api.x.ai"]);
  });

  it.each([401, 402, 403, 429])("moves to the backup when the base answers HTTP %s", async (status) => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("{}", { status }))
      .mockResolvedValueOnce(imageResponse());
    await expect(generateImage(BOTH, { prompt: "owl" }, { fetchImpl: fetchMock })).resolves.toMatchObject({ provider: "xai", usedFallback: true });
    expect(fetchMock.mock.calls.map(hostOf)).toEqual(["api.openai.com", "api.x.ai"]);
  });

  it("moves to the backup when the base refuses with a body that breaks mid-stream", async () => {
    const broken = new ReadableStream<Uint8Array>({ pull: (controller) => controller.error(new Error("socket hang up")) });
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(broken, { status: 429 }))
      .mockResolvedValueOnce(imageResponse());
    await expect(generateImage(BOTH, { prompt: "owl" }, { fetchImpl: fetchMock })).resolves.toMatchObject({ provider: "xai", usedFallback: true });
  });

  it("moves to the backup when the base refuses the connection", async () => {
    const refused = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect"), { code: "ECONNREFUSED" }) });
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValueOnce(refused).mockResolvedValueOnce(imageResponse());
    await expect(generateImage(BOTH, { prompt: "owl" }, { fetchImpl: fetchMock })).resolves.toMatchObject({ provider: "xai" });
  });

  it.each([
    ["a server error, which may already have produced and billed an image", 500],
    ["a refused request, such as a moderation block", 400],
  ])("stays on the base after %s", async (_why, status) => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("{}", { status }));
    await expect(generateImage(BOTH, { prompt: "owl" }, { fetchImpl: fetchMock })).rejects.toThrow(`OpenAI image generation failed (HTTP ${status}, model gpt-image-2)`);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("stays on the base after a timeout", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    await expect(generateImage(BOTH, { prompt: "owl" }, { fetchImpl: fetchMock, timeoutMs: 10 })).rejects.toThrow("timed out");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("reports the base's own error when there is no backup", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("{}", { status: 429 }));
    await expect(generateImage({ imageGen: { key: "openai-secret" } }, { prompt: "owl" }, { fetchImpl: fetchMock }))
      .rejects.toThrow("OpenAI image generation failed (HTTP 429, model gpt-image-2)");
  });

  it("uses only the backup when the caller asks for it", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => imageResponse());
    await expect(generateImage(BOTH, { prompt: "owl" }, { slot: "fallback", fetchImpl: fetchMock })).resolves.toMatchObject({ provider: "xai", usedFallback: true });
    expect(fetchMock.mock.calls.map(hostOf)).toEqual(["api.x.ai"]);
  });

  it("says so when the caller asks for a backup that is not set", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    await expect(generateImage({ imageGen: { key: "k" } }, { prompt: "owl" }, { slot: "fallback", fetchImpl: fetchMock }))
      .rejects.toMatchObject({ status: 409, message: "No backup image provider is set" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("what the person learns when a provider fails", () => {
  it("passes a wide Gemini request on as Google's landscape size", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => imageResponse());
    const cfg = { imageGen: { geminiKey: "gemini-secret", primary: { provider: "gemini" as const } } };
    await generateImage(cfg, { prompt: "owl", aspect: "16:9" }, { fetchImpl: fetchMock });
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toMatchObject({ size: "1536x1024" });
  });

  it("names the model a provider refused, so a wrong model ID is visible", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("{}", { status: 404 }));
    const cfg = { openrouter: { key: "or-secret" }, imageGen: { primary: { provider: "openrouter" as const, model: "google/not-a-model" } } };
    await expect(generateImage(cfg, { prompt: "owl" }, { fetchImpl: fetchMock })).rejects.toThrow("OpenRouter image generation failed (HTTP 404, model google/not-a-model)");
  });

  it("keeps the base's reason when the backup made the image", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => new URL(String(input)).host === "api.openai.com" ? new Response("{}", { status: 401 }) : imageResponse());
    const made = await generateImage(BOTH, { prompt: "owl" }, { fetchImpl: fetchMock });
    expect(made).toMatchObject({ provider: "xai", usedFallback: true, baseError: "OpenAI image generation failed (HTTP 401, model gpt-image-2)" });
  });

  it("reports both reasons when the base and the backup fail", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => new Response("{}", { status: new URL(String(input)).host === "api.openai.com" ? 402 : 429 }));
    await expect(generateImage(BOTH, { prompt: "owl" }, { fetchImpl: fetchMock })).rejects.toThrow(
      "xAI image generation failed (HTTP 429, model grok-imagine-image-2.0); the base first failed: OpenAI image generation failed (HTTP 402, model gpt-image-2)",
    );
  });

  it("stops the provider call when the caller cancels, and does not try the backup", async () => {
    const seen: AbortSignal[] = [];
    const fetchMock = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      seen.push(init!.signal!);
      init!.signal!.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }));
    const cancel = new AbortController();
    const pending = generateImage(BOTH, { prompt: "owl" }, { fetchImpl: fetchMock, signal: cancel.signal });
    cancel.abort();
    await expect(pending).rejects.toThrow("Image generation was cancelled");
    expect(seen[0]!.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("brings back the last model typed for Custom when the base or the backup goes back to Custom", () => {
    expect(imageSlots({ imageGen: { customModel: "local/image", primary: { provider: "custom" } } }).primary).toEqual({ provider: "custom", model: "local/image" });
    expect(imageSlots({ imageGen: { customModel: "local/image", primary: { provider: "openai" }, fallback: { provider: "custom" } } }).fallback).toEqual({ provider: "custom", model: "local/image" });
    expect(imageSlots({ imageGen: { customModel: "local/image", primary: { provider: "custom", model: "other/image" } } }).primary.model).toBe("other/image");
  });

  it("never uses an API key that was saved as a model, so it is never sent or shown as one", () => {
    const gateway = { customUrl: "http://127.0.0.1:4000/v1", customApiKey: "my-private-gateway-key" };
    const pasted = imageSlots({ imageGen: { ...gateway, customModel: "my-private-gateway-key", primary: { provider: "custom" } } });
    expect(pasted.primary).toEqual({ provider: "custom", model: "" });
    expect(imageGenerationReady({ imageGen: { ...gateway, customModel: "my-private-gateway-key", primary: { provider: "custom" } } })).toBe(false);
    expect(imageSlots({ imageGen: { ...gateway, primary: { provider: "custom", model: "sk-proj-abcdefghijklmnop" } } }).primary.model).toBe("");
    expect(imageSlots({ openrouter: { key: "or-key" }, imageGen: { primary: { provider: "openrouter", model: "or-key" } } }).primary.model).toBe(IMAGE_DEFAULT_MODELS.openrouter);
  });
});
