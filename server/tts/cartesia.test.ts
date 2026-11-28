import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config.ts";
import { nestedKeyStatus } from "../key-hint.ts";
import { describeVoice, listVoices, speak, verifyKey, voiceReady } from "./index.ts";

const key = "fixture-cartesia-key";
const config: AppConfig = { tts: { provider: "cartesia", cartesiaKey: key, fishKey: "fish-only", voice: "workspace-voice" } };
const mp3 = new Uint8Array([0x49, 0x44, 0x33]);
afterEach(() => vi.unstubAllGlobals());

describe("Cartesia speech", () => {
  it("sends the bot's voice, model and language to the bytes endpoint and returns MP3", async () => {
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) => new Response(mp3, { headers: { "content-type": "audio/mpeg" } }));
    vi.stubGlobal("fetch", fetcher);
    expect(describeVoice(config)).toMatchObject({ configured: true, ready: true, provider: "cartesia", voice: "workspace-voice" });
    expect(JSON.stringify([describeVoice(config), nestedKeyStatus(config).cartesiaTtsKey])).not.toContain(key);
    expect(nestedKeyStatus(config).cartesiaTtsKey).toEqual({ configured: true });
    const alternate: AppConfig = { tts: { ...config.tts, cartesiaModel: "sonic-3.5", cartesiaLanguage: "nl" } };
    const audio = await speak(alternate, "Hallo allemaal", "bot-voice");
    expect(audio.mime).toBe("audio/mpeg");
    expect(Array.from(audio.bytes)).toEqual(Array.from(mp3));
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://api.cartesia.ai/tts/bytes");
    expect(init).toMatchObject({ method: "POST", redirect: "error" });
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${key}`);
    expect(new Headers(init.headers).get("cartesia-version")).toBe("2026-08-14");
    expect(JSON.parse(String(init.body))).toEqual({
      model_id: "sonic-3.5", transcript: "Hallo allemaal", voice: "bot-voice", language: "nl",
      output_format: { container: "mp3", sample_rate: 44_100, bit_rate: 64_000 },
    });
    await speak(config, "Hello");
    expect(JSON.parse(String(fetcher.mock.calls[1]![1].body))).toMatchObject({ model_id: "sonic-3.6", voice: "workspace-voice" });
    expect(voiceReady({ tts: { provider: "cartesia", fishKey: "fish-only" } }, "bot-voice")).toBe(false);
  });

  it("finds owned clones past the first page and supports the voice picker's search", async () => {
    const fetcher = vi.fn(async (url: string, _init: RequestInit) => {
      const { searchParams } = new URL(url);
      const data = searchParams.has("starting_after") || searchParams.has("q") ? [{ id: "clone", name: "Dutch clone" }]
        : searchParams.has("is_owner") ? [{ id: "owned", name: "My voice" }] : [{ id: "stock", name: "Stock voice" }];
      const more = searchParams.has("is_owner") && !searchParams.has("starting_after");
      return Response.json({ data, has_more: more, next_page: more ? "owned" : null });
    });
    vi.stubGlobal("fetch", fetcher);
    expect(await listVoices(config)).toEqual([
      { id: "stock", label: "Stock voice" }, { id: "owned", label: "My voice" }, { id: "clone", label: "Dutch clone" },
    ]);
    expect(await listVoices(config, undefined, { query: "Dutch clone" })).toEqual([{ id: "clone", label: "Dutch clone" }]);
    expect(fetcher.mock.calls.every(([url, options]) => new URL(url).origin === "https://api.cartesia.ai" && new Headers(options.headers).get("authorization") === `Bearer ${key}`)).toBe(true);
  });

  it("checks the key against an owned catalog and keeps remote error details private", async () => {
    const fetcher = vi.fn(async (_url: string) => new Response(`Do not echo ${key}`, { status: 401 }));
    vi.stubGlobal("fetch", fetcher);
    const checked = await verifyKey("cartesia", key);
    expect(fetcher.mock.calls[0]![0]).toBe("https://api.cartesia.ai/voices?limit=1&is_owner=true");
    expect(checked).toEqual({ ok: false, message: expect.stringContaining("Cartesia rejected the API key") });
    expect(JSON.stringify(checked)).not.toContain(key);
    await expect(speak(config, "private transcript")).rejects.toThrow("Cartesia rejected the API key");
    fetcher.mockResolvedValueOnce(Response.json({ data: [], has_more: false }));
    expect(await verifyKey("cartesia", key)).toEqual({ ok: true });
  });

  it("rejects non-audio success responses and cancels synthesis when playback stops", async () => {
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ error: "not audio" }));
    vi.stubGlobal("fetch", fetcher);
    await expect(speak(config, "Hello")).rejects.toThrow("unexpected audio format");
    const controller = new AbortController();
    fetcher.mockImplementationOnce(async (_url, init) => new Promise((_, reject) => {
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    }));
    const speaking = speak(config, "Hello", undefined, undefined, controller.signal);
    controller.abort();
    await expect(speaking).rejects.toThrow("Cartesia speech was cancelled");
  });
});
