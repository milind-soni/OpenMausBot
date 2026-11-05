import { afterEach, describe, expect, it, vi } from "vitest";
import { describeVoice, listVoices, providerConfigured, speak, voiceConfigured, voiceReady } from "./index.ts";
import type { AppConfig } from "../config.ts";

const cfg: AppConfig = { tts: { provider: "gemini", geminiKey: "private-gemini-key", voice: "Kore" } };
const wav = Buffer.alloc(46);
wav.write("RIFF");
wav.writeUInt32LE(38, 4);
wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(24000, 24);
wav.writeUInt32LE(48000, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36);
wav.writeUInt32LE(2, 40);
const result = (data = wav.toString("base64"), mime_type = "audio/wav") => ({ steps: [{ type: "model_output", content: [{ type: "audio", data, mime_type }] }] });
afterEach(() => vi.unstubAllGlobals());

describe("Gemini speech", () => {
  it.each([
    { saved: "Kore", override: undefined, key: "key", configured: true, ready: true },
    { saved: "invalid", override: undefined, key: "key", configured: false, ready: false },
    { saved: "", override: undefined, key: "key", configured: false, ready: false },
    { saved: undefined, override: undefined, key: "key", configured: false, ready: false },
    { saved: "invalid", override: "Puck", key: "key", configured: false, ready: true },
    { saved: "Kore", override: "invalid", key: "key", configured: true, ready: false },
    { saved: "Kore", override: "", key: "key", configured: true, ready: true },
    { saved: "Kore", override: "Puck", key: "", configured: false, ready: false },
    { saved: "kore", override: undefined, key: "key", configured: false, ready: false },
  ])("checks catalog membership and voice precedence: $saved / $override / $key", ({ saved, override, key, configured, ready }) => {
    const config: AppConfig = { tts: { provider: "gemini", geminiKey: key, voice: saved } };
    expect(voiceConfigured(config)).toBe(configured);
    expect(voiceReady(config, override)).toBe(ready);
  });

  it("requires its own credential and keeps it out of status", async () => {
    const missing: AppConfig = { tts: { provider: "gemini", key: "eleven", fishKey: "fish" }, xai: { key: "xai" } };
    expect(providerConfigured(missing)).toBe(false);
    expect(voiceReady(missing, "Kore")).toBe(false);
    expect(() => speak(missing, "hello")).toThrow("Gemini API key");
    expect(await listVoices(missing)).toEqual([]);
    expect(JSON.stringify(describeVoice(cfg))).not.toContain("private-gemini-key");
    expect(describeVoice(cfg)).toMatchObject({ configured: true, ready: true, model: "gemini-3.8-flash-lite-tts" });
    expect(await listVoices(cfg)).toEqual(expect.arrayContaining([{ id: "Puck", label: "Puck" }, { id: "Kore", label: "Kore" }]));
  });

  it("uses the documented Interactions contract and honors the bot voice and selected model", async () => {
    const request = vi.fn().mockResolvedValue(Response.json(result()));
    vi.stubGlobal("fetch", request);
    const audio = await speak({ tts: { ...cfg.tts, model: "gemini-3.8-flash-tts" } }, "Hello, नमस्ते!", "Puck");
    expect(audio).toEqual({ bytes: wav, mime: "audio/wav" });
    const [url, init] = request.mock.calls[0];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
    expect(init.headers).toEqual({ "x-goog-api-key": "private-gemini-key", "content-type": "application/json" });
    expect(init.redirect).toBe("error");
    expect(JSON.parse(init.body)).toEqual({ model: "gemini-3.8-flash-tts", input: [{ type: "user_input", content: [{ type: "text", text: "Hello, नमस्ते!" }] }], response_format: { type: "audio" }, generation_config: { speech_config: [{ voice: "Puck" }] } });
  });

  it.each([400, 401, 403, 404, 429, 500])("sanitizes HTTP %i failures", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("private-gemini-key private transcript", { status })));
    await expect(speak(cfg, "private transcript")).rejects.toThrow(/Gemini/);
    await expect(speak(cfg, "private transcript")).rejects.not.toThrow(/private/);
  });

  it.each([{}, result(""), result("invalid"), result(Buffer.from("not audio").toString("base64")), result(wav.toString("base64"), "text/plain")])("rejects invalid audio", async (body) => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => Response.json(body)));
    await expect(speak(cfg, "hello")).rejects.toThrow(/Gemini/);
  });
});
