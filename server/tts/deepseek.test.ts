import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config.ts";

const KEY = "fixture-deepseek-key";

function wav(seconds: number, rate = 16_000, bits = 16): Buffer {
  const data = Math.round(seconds * rate) * (bits / 8);
  const out = Buffer.alloc(44 + data);
  out.write("RIFF", 0);
  out.writeUInt32LE(36 + data, 4);
  out.write("WAVEfmt ", 8);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * (bits / 8), 28);
  out.writeUInt16LE(bits / 8, 32);
  out.writeUInt16LE(bits, 34);
  out.write("data", 36);
  out.writeUInt32LE(data, 40);
  return out;
}

let server: Server;
let status = 200;
let contentType = "audio/wav";
let reply: Buffer = wav(0.5, 24_000);
let hang = false;
const seen: Array<{ url: string; method?: string; authorization?: string; type?: string; body: Buffer }> = [];
const deepseek = () => import("./deepseek.ts");
const voice = () => import("./index.ts");

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({ url: req.url ?? "", method: req.method, authorization: req.headers.authorization, type: req.headers["content-type"], body: Buffer.concat(chunks) });
      if (hang) return;
      if (status !== 200) {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: `${KEY} private spoken text` } }));
        return;
      }
      res.writeHead(200, { "content-type": contentType });
      res.end(reply);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP fixture");
  vi.stubEnv("OMB_DEEPSEEK_SPEECH_API", `http://127.0.0.1:${address.port}/v1`);
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.unstubAllEnvs();
});
beforeEach(() => {
  status = 200;
  contentType = "audio/wav";
  reply = wav(0.5, 24_000);
  hang = false;
  seen.length = 0;
});

describe("DeepSeek speech", () => {
  it("offers exactly Stella and Tide without asking the network", async () => {
    expect((await deepseek()).listVoices()).toEqual([
      { id: "stella", label: "Stella (female)" },
      { id: "tide", label: "Tide (male)" },
    ]);
    expect(seen).toEqual([]);
  });

  it("synthesizes WAV with only the documented fields and the bearer key", async () => {
    const audio = await (await deepseek()).synthesize("Hello there", "tide", KEY);
    expect(audio.mime).toBe("audio/wav");
    expect(Buffer.from(audio.bytes).equals(reply)).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ url: "/v1/tools/tts", method: "POST", authorization: `Bearer ${KEY}` });
    expect(JSON.parse(seen[0]!.body.toString())).toEqual({ text: "Hello there", voice_id: "tide", format: "wav", filter_markdown: true });
  });

  it("repairs unknown streaming WAV lengths after the full response is read", async () => {
    const expected = wav(0.5, 24_000);
    reply = Buffer.from(expected);
    reply.writeUInt32LE(0xffffffff, 4);
    reply.writeUInt32LE(0xffffffff, 40);
    const audio = await (await deepseek()).synthesize("hello", "stella", KEY);
    expect(Buffer.from(audio.bytes)).toEqual(expected);
    await expect((await deepseek()).transcribe(reply, KEY)).rejects.toThrow("16-bit PCM WAV");
  });

  it("handles an extra padded chunk before streaming audio", async () => {
    const source = wav(0.5, 24_000);
    const extra = Buffer.from([0x4a, 0x55, 0x4e, 0x4b, 1, 0, 0, 0, 7, 0]);
    const expected = Buffer.concat([source.subarray(0, 36), extra, source.subarray(36)]);
    expected.writeUInt32LE(expected.length - 8, 4);
    reply = Buffer.from(expected);
    reply.writeUInt32LE(0xffffffff, 4);
    reply.writeUInt32LE(0xffffffff, 50);
    expect(Buffer.from((await (await deepseek()).synthesize("hello", "stella", KEY)).bytes)).toEqual(expected);
  });

  it("rejects malformed streaming WAV headers and incomplete frames", async () => {
    const { synthesize } = await deepseek();
    const streaming = wav(0.5, 24_000);
    streaming.writeUInt32LE(0xffffffff, 4);
    streaming.writeUInt32LE(0xffffffff, 40);
    for (const invalid of [streaming.subarray(0, 44), streaming.subarray(0, 45)]) {
      reply = invalid;
      await expect(synthesize("hi", "stella", KEY)).rejects.toThrow("incomplete audio");
    }
    reply = Buffer.from(streaming);
    reply.writeUInt32LE(100_000, 16);
    await expect(synthesize("hi", "stella", KEY)).rejects.toThrow("incomplete audio");
  });

  it("refuses bad input before any request", async () => {
    const { synthesize, transcribe, TTS_MAX_CHARS } = await deepseek();
    await expect(synthesize("hi", "alloy", KEY)).rejects.toThrow("Stella or Tide");
    await expect(synthesize("   ", "stella", KEY)).rejects.toThrow("no text");
    await expect(synthesize("a".repeat(TTS_MAX_CHARS + 1), "stella", KEY)).rejects.toMatchObject({ status: 413 });
    await expect(synthesize("hi", "stella", "")).rejects.toMatchObject({ status: 409 });
    await expect(transcribe(Buffer.from("not a wav"), KEY)).rejects.toThrow("16-bit PCM WAV");
    await expect(transcribe(wav(1, 16_000, 8), KEY)).rejects.toThrow("16-bit PCM WAV");
    await expect(transcribe(wav(121), KEY)).rejects.toMatchObject({ status: 413 });
    await expect(transcribe(Buffer.alloc(8 * 1024 * 1024 + 1), KEY)).rejects.toMatchObject({ status: 413 });
    expect(seen).toEqual([]);
  });

  it("rejects unexpected, empty and truncated audio", async () => {
    const { synthesize } = await deepseek();
    contentType = "audio/mpeg";
    await expect(synthesize("hi", "stella", KEY)).rejects.toThrow("unexpected audio format");
    contentType = "audio/wav";
    reply = Buffer.alloc(0);
    await expect(synthesize("hi", "stella", KEY)).rejects.toThrow("empty audio");
    reply = wav(0.5, 24_000).subarray(0, 1000);
    await expect(synthesize("hi", "stella", KEY)).rejects.toThrow("incomplete audio");
  });

  it("never repeats a provider's error body, key or text", async () => {
    const { synthesize, transcribe } = await deepseek();
    for (const [code, expected] of [[401, 409], [402, 502], [429, 502], [400, 400], [503, 502]] as const) {
      status = code;
      const error = (await synthesize("private spoken text", "stella", KEY).then(() => null, (e: unknown) => e)) as Error & { status: number };
      expect(error.status).toBe(expected);
      expect(error.message).not.toContain(KEY);
      expect(error.message).not.toContain("private spoken text");
      const heard = (await transcribe(wav(1), KEY).then(() => null, (e: unknown) => e)) as Error;
      expect(heard.message).not.toContain(KEY);
    }
  });

  it("stops when the caller cancels", async () => {
    hang = true;
    const controller = new AbortController();
    const pending = (await deepseek()).synthesize("hi", "stella", KEY, controller.signal);
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ status: 499 });
  });

  it("sends the recording as the multipart file and returns the transcript", async () => {
    contentType = "application/json";
    reply = Buffer.from(JSON.stringify({ text: " hello world ", request_id: "r1", duration_ms: 1000 }));
    const recording = wav(1);
    expect(await (await deepseek()).transcribe(recording, KEY)).toBe("hello world");
    expect(seen[0]).toMatchObject({ url: "/v1/tools/asr", method: "POST", authorization: `Bearer ${KEY}` });
    expect(seen[0]!.type).toMatch(/^multipart\/form-data/);
    const body = seen[0]!.body.toString("latin1");
    expect(body).toContain('name="file"; filename="speech.wav"');
    expect(body).not.toContain('name="language"');
    expect(body).not.toContain('name="model"');
  });

  it("rejects a malformed transcript", async () => {
    contentType = "application/json";
    reply = Buffer.from(JSON.stringify({ transcript: "no" }));
    await expect((await deepseek()).transcribe(wav(1), KEY)).rejects.toThrow("unexpected transcription");
    reply = Buffer.from("{");
    await expect((await deepseek()).transcribe(wav(1), KEY)).rejects.toThrow("unexpected transcription");
  });
});

describe("DeepSeek as the voice provider", () => {
  const cfg: AppConfig = { deepseek: { key: KEY }, tts: { provider: "deepseek", voice: "stella" } };

  it("is ready with the saved DeepSeek key and never shows it", async () => {
    const tts = await voice();
    expect(tts.describeVoice(cfg)).toMatchObject({ provider: "deepseek", configured: true, ready: true, voice: "stella" });
    expect(JSON.stringify(tts.describeVoice(cfg))).not.toContain(KEY);
    expect(tts.providerConfigured({ tts: { provider: "deepseek" } })).toBe(false);
    expect(tts.voiceConfigured({ ...cfg, tts: { provider: "deepseek", voice: "alloy" } })).toBe(false);
  });

  it("speaks in the bot's DeepSeek voice, or the workspace's for a voice from another catalog", async () => {
    const tts = await voice();
    await tts.speak(cfg, "one", "tide");
    await tts.speak(cfg, "two", "21m00Tcm4TlvDq8ikWAM");
    expect(seen.map((request) => JSON.parse(request.body.toString()).voice_id)).toEqual(["tide", "stella"]);
    expect(tts.voiceReady(cfg, "21m00Tcm4TlvDq8ikWAM")).toBe(true);
  });
});
