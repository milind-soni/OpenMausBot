import { describe, expect, it, vi } from "vitest";

import {
  avatarGenerationStateMatches,
  avatarGenerationPrompt,
  avatarGenerationRequestSchema,
  avatarImageStatus,
  generateAvatarImage,
  snapshotAvatarGenerationState,
} from "./avatar-image.ts";

const BOT = { name: "Scout", title: "Research agent", description: "Finds evidence quickly." };
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const WEBP = Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64");
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const OPENAI = { imageGen: { key: "sk-image" } };
const ALL_KEYS = {
  imageGen: { key: "openai-secret", customApiKey: "custom-secret", customUrl: "http://127.0.0.1:20128/v1", customModel: "gateway/model" },
  xai: { key: "xai-secret" },
};

function imageResponse(bytes = PNG): Response {
  return new Response(JSON.stringify({ data: [{ b64_json: bytes.toString("base64") }] }), {
    status: 200, headers: { "content-type": "application/json" },
  });
}

describe("avatar image generation", () => {
  it("bounds free-form direction and keeps the crop brief", () => {
    expect(avatarGenerationRequestSchema.safeParse({ prompt: "x".repeat(401) }).success).toBe(false);
    const prompt = avatarGenerationPrompt(BOT, "navy owl with a brass compass");
    expect(prompt).toContain("center 70%");
    expect(prompt).toContain('"navy owl with a brass compass"');
    expect(prompt).toContain("No words");
  });

  it("detects an avatar edit made after generation starts", () => {
    const mutable = { avatarUrl: "/api/attachments/old.webp", avatarCrop: "circle" as const };
    const initial = snapshotAvatarGenerationState(mutable);

    mutable.avatarUrl = "/api/attachments/new.webp";

    expect(avatarGenerationStateMatches(initial, mutable)).toBe(false);
    expect(initial).toEqual({ avatarUrl: "/api/attachments/old.webp", avatarCrop: "circle" });
  });

  it("uses one low-quality square GPT Image 2 request and decodes WebP bytes", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => imageResponse(WEBP));

    const result = await generateAvatarImage(OPENAI, BOT, "blue robot", fetchMock);
    expect(result).toEqual({ bytes: WEBP, mime: "image/webp" });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/images/generations");
    expect(init?.headers).toMatchObject({ authorization: "Bearer sk-image" });
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "gpt-image-2",
      prompt: avatarGenerationPrompt(BOT, "blue robot"),
      size: "1024x1024",
      quality: "low",
      output_format: "webp",
    });
  });

  it("uses the xAI key only at the fixed Grok endpoint and recognizes JPEG", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => imageResponse(JPEG));
    const cfg = { ...ALL_KEYS, imageGen: { ...ALL_KEYS.imageGen, provider: "xai" as const } };

    await expect(generateAvatarImage(cfg, BOT, "owl", fetchMock)).resolves.toEqual({ bytes: JPEG, mime: "image/jpeg" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.x.ai/v1/images/generations");
    expect(init?.headers).toMatchObject({ authorization: "Bearer xai-secret" });
    expect(JSON.stringify(init)).not.toContain("openai-secret");
    expect(JSON.stringify(init)).not.toContain("custom-secret");
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "grok-imagine-image-2.0", prompt: avatarGenerationPrompt(BOT, "owl"),
      response_format: "b64_json", aspect_ratio: "1:1",
    });
  });

  it("uses only the custom key and model at a normalized gateway image endpoint", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => imageResponse());
    const cfg = {
      ...ALL_KEYS,
      imageGen: { ...ALL_KEYS.imageGen, provider: "custom" as const, customUrl: "http://127.0.0.1:20128/v1/images/generations/" },
    };

    await expect(generateAvatarImage(cfg, BOT, "owl", fetchMock)).resolves.toEqual({ bytes: PNG, mime: "image/png" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:20128/v1/images/generations");
    expect(init?.headers).toMatchObject({ authorization: "Bearer custom-secret" });
    expect(JSON.stringify(init)).not.toContain("openai-secret");
    expect(JSON.stringify(init)).not.toContain("xai-secret");
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "gateway/model", prompt: avatarGenerationPrompt(BOT, "owl"),
      response_format: "b64_json", size: "1024x1024", n: 1,
    });
  });

  it("supports a keyless local gateway without falling back to other provider keys", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => imageResponse());
    const cfg = { ...ALL_KEYS, imageGen: { ...ALL_KEYS.imageGen, provider: "custom" as const, customApiKey: " " } };

    await generateAvatarImage(cfg, BOT, "", fetchMock);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).not.toHaveProperty("authorization");
  });

  it("keeps OpenAI credentials on OpenAI when other providers are configured", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => imageResponse());

    await generateAvatarImage(ALL_KEYS, BOT, "", fetchMock);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/images/generations");
    expect(init?.headers).toMatchObject({ authorization: "Bearer openai-secret" });
    expect(JSON.stringify(init)).not.toContain("xai-secret");
    expect(JSON.stringify(init)).not.toContain("custom-secret");
  });

  it("reports the legacy OpenAI default and only the selected provider's readiness", () => {
    expect(avatarImageStatus({})).toEqual({
      provider: "openai", configured: false, model: "gpt-image-2", customUrl: "", customModel: "",
      openaiConfigured: false, xaiConfigured: false, customKeyConfigured: false,
    });
    expect(avatarImageStatus(OPENAI).configured).toBe(true);
    expect(avatarImageStatus({ xai: { key: "xai-secret" } }).configured).toBe(false);
    expect(avatarImageStatus({ imageGen: { provider: "xai", key: "openai-secret" } }).configured).toBe(false);
    expect(avatarImageStatus({ ...ALL_KEYS, imageGen: { ...ALL_KEYS.imageGen, provider: "xai" } })).toMatchObject({
      provider: "xai", configured: true, model: "grok-imagine-image-2.0",
    });
    expect(JSON.stringify(avatarImageStatus(ALL_KEYS))).not.toContain("secret");
  });

  it("requires a valid custom URL and model but does not require a gateway key", () => {
    const imageGen = { provider: "custom" as const, customUrl: "http://127.0.0.1:20128/v1", customModel: "gateway/model" };
    expect(avatarImageStatus({ imageGen })).toMatchObject({ configured: true, customKeyConfigured: false });
    expect(avatarImageStatus({ imageGen: { ...imageGen, customModel: " " } }).configured).toBe(false);
    expect(avatarImageStatus({ imageGen: { ...imageGen, customUrl: "" } }).configured).toBe(false);
  });

  it.each([
    "http://public.example.com/v1", "http://169.254.169.254/latest", "https://169.254.169.254/latest",
    "file:///tmp/image", "https://secret@example.com/v1", "https://example.com/v1?key=secret",
    "https://example.com/v1#secret",
  ])("rejects an invalid custom URL before any network call: %s", async (customUrl) => {
    const fetchMock = vi.fn<typeof fetch>();
    const cfg = { imageGen: { provider: "custom" as const, customUrl, customModel: "model", customApiKey: "secret" } };

    await expect(generateAvatarImage(cfg, BOT, "", fetchMock)).rejects.toMatchObject({ status: 409 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(avatarImageStatus(cfg)).toMatchObject({ configured: false, customUrl: "" });
  });

  it.each([
    { imageGen: { provider: "openai" as const }, xai: { key: "xai-secret" } },
    { imageGen: { provider: "xai" as const, key: "openai-secret", customApiKey: "custom-secret" } },
  ])("does not borrow another provider's credentials when the selected key is missing", async (cfg) => {
    const fetchMock = vi.fn<typeof fetch>();
    await expect(generateAvatarImage(cfg, BOT, "", fetchMock)).rejects.toMatchObject({ status: 409 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never exposes malformed upstream bodies as image data", async () => {
    const malformed = vi.fn<typeof fetch>(async () => new Response('{"data":[]}', { status: 200 }));
    await expect(generateAvatarImage(OPENAI, BOT, "", malformed))
      .rejects.toThrow("no generated image");
  });

  it.each(["%%%", "abcd=", "<svg></svg>", Buffer.from("<html>not an image</html>").toString("base64"), Buffer.from("GIF89a").toString("base64")])(
    "rejects malformed base64 and unsupported raster bytes: %s", async (b64_json) => {
      const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: [{ b64_json }] })));
      await expect(generateAvatarImage(OPENAI, BOT, "", fetchMock)).rejects.toMatchObject({ status: 502 });
    },
  );

  it.each(["http://169.254.169.254/latest", "http://127.0.0.1/private", "https://images.example.com/output.png?secret=token"]) (
    "does not download a provider's URL-only response: %s", async (url) => {
      const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: [{ url }] })));
      await expect(generateAvatarImage(ALL_KEYS, BOT, "", fetchMock)).rejects.toThrow("must return base64 image data");
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );

  it("rejects malformed JSON without echoing the upstream body", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("private gateway trace secret"));
    await expect(generateAvatarImage(OPENAI, BOT, "", fetchMock)).rejects.toMatchObject({
      message: "OpenAI returned an invalid image response", status: 502,
    });
  });

  it.each([401, 429, 500])("redacts provider error bodies for HTTP %s", async (status) => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      error: { message: "Bearer custom-secret https://private.example/token?key=secret" },
    }), { status }));
    const cfg = { ...ALL_KEYS, imageGen: { ...ALL_KEYS.imageGen, provider: "custom" as const } };
    await expect(generateAvatarImage(cfg, BOT, "", fetchMock)).rejects.toMatchObject({
      message: `Custom image generation failed (HTTP ${status})`, status: status === 401 ? 401 : 502,
    });
  });

  it("prevents provider redirects from forwarding authorization to another endpoint", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("", {
      status: 302, headers: { location: "http://169.254.169.254/latest" },
    }));
    await expect(generateAvatarImage(OPENAI, BOT, "", fetchMock)).rejects.toThrow("HTTP 302");
    expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe("error");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("redacts network failures without leaking endpoint credentials", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => { throw new Error("private gateway trace custom-secret"); });
    const cfg = { ...ALL_KEYS, imageGen: { ...ALL_KEYS.imageGen, provider: "custom" as const } };
    await expect(generateAvatarImage(cfg, BOT, "", fetchMock)).rejects.toMatchObject({
      message: "Could not reach Custom image generation", status: 502,
    });
  });

  it("rejects an oversized decoded image inside the response byte cap", async () => {
    const bytes = Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024)]);
    const fetchMock = vi.fn<typeof fetch>(async () => imageResponse(bytes));
    await expect(generateAvatarImage(OPENAI, BOT, "", fetchMock)).rejects.toThrow("oversized image data");
  });

  it("cancels a response whose advertised size exceeds the byte cap", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(body, { headers: { "content-length": String(16 * 1024 * 1024) } }));
    await expect(generateAvatarImage(OPENAI, BOT, "", fetchMock)).rejects.toThrow("exceeded the response limit");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cancels an upstream response as soon as it exceeds the byte cap", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(chunk);
        if (pulls === 20) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const oversized = vi.fn<typeof fetch>(async () => new Response(body, { status: 200 }));

    await expect(generateAvatarImage(OPENAI, BOT, "", oversized))
      .rejects.toThrow("exceeded the response limit");
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(20);
  });

  it("normalizes a timeout that fires while reading a hanging response body", async () => {
    const hanging = vi.fn<typeof fetch>(async (_url, init) => {
      const signal = init?.signal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true });
        },
      });
      return new Response(body, { status: 200 });
    });

    await expect(generateAvatarImage(OPENAI, BOT, "", hanging, 10)).rejects.toMatchObject({
      message: "Avatar generation timed out",
      status: 502,
    });
  });

  it("normalizes a timeout before response headers arrive", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    await expect(generateAvatarImage(OPENAI, BOT, "", fetchMock, 10)).rejects.toMatchObject({
      message: "Avatar generation timed out", status: 502,
    });
  });

  it("redacts stream failures without exposing the underlying error", async () => {
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("private gateway secret")); } });
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(body));
    await expect(generateAvatarImage(OPENAI, BOT, "", fetchMock)).rejects.toMatchObject({
      message: "Could not read the generated avatar response", status: 502,
    });
  });
});
