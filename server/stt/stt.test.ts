import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config.ts";

// Built by hand (not with the renderer encoder) so the server gate is tested
// against the byte layout, not against its own counterpart.
function wav({ rate = 16_000, channels = 1, bits = 16, ms = 1000 } = {}): Uint8Array {
  const data = Math.round((rate * ms) / 1000) * channels * (bits / 8);
  const out = new Uint8Array(44 + data);
  const view = new DataView(out.buffer);
  const ascii = (o: number, s: string) => [...s].forEach((c, i) => (out[o + i] = c.charCodeAt(0)));
  ascii(0, "RIFF");
  view.setUint32(4, 36 + data, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * channels * (bits / 8), true);
  view.setUint16(32, channels * (bits / 8), true);
  view.setUint16(34, bits, true);
  ascii(36, "data");
  view.setUint32(40, data, true);
  return out;
}

let server: Server;
let status = 200;
let reply: unknown = { text: " hello world " };
const seen: Array<{ url: string; authorization?: string; body: string }> = [];
const stt = () => import("./index.ts");

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({ url: req.url ?? "", authorization: req.headers.authorization, body: Buffer.concat(chunks).toString("latin1") });
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(status === 200 ? reply : { error: "secret-key-fixture echoed back" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP fixture");
  const base = `http://127.0.0.1:${address.port}/v1`;
  vi.stubEnv("OMB_OPENAI_STT_API", base);
  vi.stubEnv("OMB_GROQ_STT_API", base);
  vi.stubEnv("OMB_XAI_STT_API", base);
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.unstubAllEnvs();
});
beforeEach(() => {
  status = 200;
  reply = { text: " hello world " };
  seen.length = 0;
});

describe("parseUtteranceWav", () => {
  it("accepts exactly 16 kHz mono 16-bit PCM", async () => {
    const { parseUtteranceWav } = await stt();
    expect(parseUtteranceWav(wav({ ms: 1500 })).durationMs).toBe(1500);
  });

  it.each([
    ["48 kHz", { rate: 48_000 }],
    ["stereo", { channels: 2 }],
    ["8-bit", { bits: 8 }],
  ])("rejects %s", async (_name, options) => {
    const { parseUtteranceWav, InvalidAudio } = await stt();
    expect(() => parseUtteranceWav(wav(options))).toThrow(InvalidAudio);
  });

  it("rejects non-WAV bytes and oversized clips", async () => {
    const { parseUtteranceWav } = await stt();
    expect(() => parseUtteranceWav(new TextEncoder().encode("not a wav file at all, just text......................"))).toThrow(/WAV/);
    expect(() => parseUtteranceWav(wav({ ms: 40_000 }))).toThrow(/too long/);
  });
});

describe("configuration", () => {
  it("is off until a provider is chosen, even with an xAI key on file", async () => {
    const { sttReady, sttSetupProblem } = await stt();
    const cfg: AppConfig = { xai: { key: "x" } };
    expect(sttReady(cfg)).toBe(false);
    expect(sttSetupProblem(cfg)?.reason).toBe("provider");
  });

  it("reports readiness per provider", async () => {
    const { sttReady } = await stt();
    expect(sttReady({ stt: { provider: "openai" } })).toBe(false);
    expect(sttReady({ stt: { provider: "openai", openaiKey: "k" } })).toBe(true);
    expect(sttReady({ stt: { provider: "groq", groqKey: "k" } })).toBe(true);
    expect(sttReady({ stt: { provider: "xai" }, xai: { key: "k" } })).toBe(true);
    expect(sttReady({ stt: { provider: "local", baseUrl: "http://127.0.0.1:8000/v1" } })).toBe(true);
  });

  it("never describes a key value", async () => {
    const { describeStt } = await stt();
    const text = JSON.stringify(describeStt({ stt: { provider: "groq", groqKey: "gsk_secret", openaiKey: "sk-secret" }, xai: { key: "xai-secret" } }));
    expect(text).not.toMatch(/secret/);
    expect(JSON.parse(text)).toMatchObject({ provider: "groq", ready: true, groqConfigured: true, interim: false });
  });

  it("only offers interim transcripts for a local server", async () => {
    const { describeStt } = await stt();
    expect(describeStt({ stt: { provider: "local", baseUrl: "http://x" } }).interim).toBe(true);
  });
});

describe("providers", () => {
  it("sends OpenAI a multipart request with the key, model and language", async () => {
    const { transcribe, parseUtteranceWav } = await stt();
    const result = await transcribe(
      { stt: { provider: "openai", openaiKey: "sk-fixture", language: "en-IN" } },
      parseUtteranceWav(wav()),
    );
    expect(result.text).toBe("hello world");
    expect(seen[0]?.url).toBe("/v1/audio/transcriptions");
    expect(seen[0]?.authorization).toBe("Bearer sk-fixture");
    expect(seen[0]?.body).toContain("gpt-4o-mini-transcribe");
    expect(seen[0]?.body).toMatch(/name="language"\r\n\r\nen\r\n/);
  });

  it("uses the Groq default model", async () => {
    const { transcribe, parseUtteranceWav } = await stt();
    await transcribe({ stt: { provider: "groq", groqKey: "gsk" } }, parseUtteranceWav(wav()));
    expect(seen[0]?.body).toContain("whisper-large-v3-turbo");
  });

  it("calls a local server without any credential", async () => {
    const { transcribe, parseUtteranceWav } = await stt();
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture");
    await transcribe({ stt: { provider: "local", baseUrl: `http://127.0.0.1:${address.port}/v1/`, model: "small" } }, parseUtteranceWav(wav()));
    expect(seen[0]?.authorization).toBeUndefined();
    expect(seen[0]?.body).toContain("small");
  });

  it("sends xAI the workspace key with the file as the last field", async () => {
    const { transcribe, parseUtteranceWav } = await stt();
    await transcribe({ stt: { provider: "xai" }, xai: { key: "xai-fixture" } }, parseUtteranceWav(wav()));
    expect(seen[0]?.url).toBe("/v1/stt");
    expect(seen[0]?.authorization).toBe("Bearer xai-fixture");
    const body = seen[0]!.body;
    expect(body.indexOf('name="format"')).toBeLessThan(body.indexOf('name="file"'));
  });

  it("preserves supported three-letter language codes like fil for xAI", async () => {
    const { transcribe, parseUtteranceWav } = await stt();
    await transcribe({ stt: { provider: "xai", language: "fil" }, xai: { key: "xai-fixture" } }, parseUtteranceWav(wav()));
    expect(seen[0]?.body).toMatch(/name="language"\r\n\r\nfil\r\n/);
  });

  it("normalizes locale subtags while preserving language code for xAI", async () => {
    const { transcribe, parseUtteranceWav } = await stt();
    await transcribe({ stt: { provider: "xai", language: "fil-PH" }, xai: { key: "xai-fixture" } }, parseUtteranceWav(wav()));
    expect(seen[0]?.body).toMatch(/name="language"\r\n\r\nfil\r\n/);

    seen.length = 0;
    await transcribe({ stt: { provider: "xai", language: "en-US" }, xai: { key: "xai-fixture" } }, parseUtteranceWav(wav()));
    expect(seen[0]?.body).toMatch(/name="language"\r\n\r\nen\r\n/);
  });

  it("rejects non-loopback HTTP override for xAI STT", async () => {
    vi.stubEnv("OMB_XAI_STT_API", "http://speech.x.ai/v1");
    try {
      const { transcribe, parseUtteranceWav } = await stt();
      await expect(
        transcribe({ stt: { provider: "xai" }, xai: { key: "xai-fixture" } }, parseUtteranceWav(wav())),
      ).rejects.toThrow(/OMB_XAI_STT_API requires HTTPS/);
    } finally {
      const address = server.address();
      if (address && typeof address !== "string") {
        vi.stubEnv("OMB_XAI_STT_API", `http://127.0.0.1:${address.port}/v1`);
      }
    }
  });

  it("never surfaces a provider's error body", async () => {
    status = 401;
    const { transcribe, parseUtteranceWav } = await stt();
    const attempt = transcribe({ stt: { provider: "openai", openaiKey: "k" } }, parseUtteranceWav(wav()));
    await expect(attempt).rejects.toThrow(/rejected the key/);
    await expect(attempt).rejects.not.toThrow(/secret-key-fixture/);
  });
});

describe("POST /api/stt/transcribe", () => {
  async function call(cfg: AppConfig, body: Uint8Array, type = "audio/wav") {
    const { createSttRoutes } = await import("../routes/stt.ts");
    const { json, readBody } = await import("../harness/http.ts");
    const transcribe = vi.fn(async () => ({ text: "routed" }));
    const handler = createSttRoutes({ config: () => cfg, transcribe });
    const route = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      await handler({ req, res, url, path: url.pathname, method: req.method ?? "GET", auth: {} as never, json, readBody });
    });
    await new Promise<void>((resolve) => route.listen(0, "127.0.0.1", resolve));
    const address = route.address();
    if (!address || typeof address === "string") throw new Error("fixture");
    try {
      const res = await fetch(`http://127.0.0.1:${address.port}/api/stt/transcribe`, {
        method: "POST",
        headers: { "content-type": type },
        body: new Blob([body.slice()]),
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown>, transcribe };
    } finally {
      await new Promise<void>((resolve) => route.close(() => resolve()));
    }
  }
  const ready: AppConfig = { stt: { provider: "groq", groqKey: "gsk" } };

  it("transcribes a valid utterance", async () => {
    const out = await call(ready, wav());
    expect(out).toMatchObject({ status: 200, body: { text: "routed" } });
  });

  it("answers 409 with a reason before reading audio when not set up", async () => {
    const out = await call({}, wav());
    expect(out.status).toBe(409);
    expect(out.body.reason).toBe("provider");
    expect(out.transcribe).not.toHaveBeenCalled();
  });

  it("rejects other content types and formats", async () => {
    expect((await call(ready, wav(), "application/octet-stream")).status).toBe(415);
    expect((await call(ready, wav({ rate: 44_100 }))).status).toBe(415);
  });

  it("returns empty text for a clip too short to be speech, without billing it", async () => {
    const out = await call(ready, wav({ ms: 60 }));
    expect(out.body).toEqual({ text: "" });
    expect(out.transcribe).not.toHaveBeenCalled();
  });

  it("refuses an oversized upload", async () => {
    expect((await call(ready, wav({ ms: 45_000 }))).status).toBe(413);
  });
});
