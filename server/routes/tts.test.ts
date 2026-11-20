import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../config.ts";
import { addHeldSecretScrubber } from "../redact.ts";
import { VOICE_FIRST_BLOCK_MAX_CHARS } from "../tts/speech-text.ts";
import { PASS } from "./table.ts";
import { createTtsRoutes, TRANSCRIBE_MAX_BYTES } from "./tts.ts";

async function call(method: string, path: string, body: unknown = {}, cfg = {} as AppConfig, req = {} as never) {
  const answers: Array<[number, unknown]> = [];
  const out = await createTtsRoutes({ config: () => cfg })({
    req, res: { on() {}, off() {}, writableEnded: false } as never, url: new URL(`http://x${path}`), path: new URL(`http://x${path}`).pathname, method,
    auth: { kind: "loopback", scopes: ["admin", "client"] },
    json: ((_res: unknown, status: number, value: unknown) => { answers.push([status, value]); }) as never, readBody: (async () => body) as never,
  });
  return { out, answers };
}

describe("voice routes", () => {
  it("leave every other path to the next route", async () => {
    expect((await call("GET", "/api/connectors/catalog")).out).toBe(PASS);
    expect((await call("DELETE", "/api/tts/voices")).out).toBe(PASS);
  });

  it("add a Voice Library voice only with an owner, a voice id and a name made of plain ids", async () => {
    for (const body of [{}, { publicOwnerId: "owner1", voiceId: "../voices", name: "x" }, { publicOwnerId: "owner1", voiceId: "v1", name: " " }]) {
      expect((await call("POST", "/api/tts/voices/add", body)).answers).toEqual([[400, { error: "publicOwnerId, voiceId and name required" }]]);
    }
  });

  it("keeps the 413 and English refusal above the utterance ceiling", async () => {
    expect((await call("POST", "/api/tts/speak", { text: "a".repeat(501) })).answers).toEqual([[413, {
      error: "voice utterances are limited to 500 characters", errorKey: "serverError.voice.utteranceTooLong",
    }]]);
  });

  it("prepare a reply with a short first block, and never a held secret", async () => {
    const remove = addHeldSecretScrubber((text) => text.replaceAll("correct-horse-battery", "••••••"));
    try {
      const text = `I logged in with correct-horse-battery and then ${Array.from({ length: 30 }, (_, i) => `checked item ${i}`).join(", ")}. Done.`;
      const { answers } = await call("POST", "/api/tts/prepare", { text });
      const { utterances } = answers[0]![1] as { utterances: string[] };
      expect(utterances[0]!.length).toBeLessThanOrEqual(VOICE_FIRST_BLOCK_MAX_CHARS);
      expect(utterances.length).toBeGreaterThan(2);
      expect(utterances.join(" ")).not.toContain("correct-horse-battery");
    } finally {
      remove();
    }
  });

  it("prepares configuration instructions without changing their literal names", async () => {
    const { answers } = await call("POST", "/api/tts/prepare", { text: "Set **API_KEY** and `API_URL` in my_config_file.json." });
    expect(answers[0]![0]).toBe(200);
    expect((answers[0]![1] as { utterances: string[] }).utterances).toEqual([
      "Set API_KEY and API_URL in my_config_file.json.",
    ]);
  });

  it("prepares image descriptions without speaking emphasis markers or changing identifiers", async () => {
    const { answers } = await call("POST", "/api/tts/prepare", { text: "See ![*diagram*](x.png) and ![API_KEY](key.png)." });
    expect(answers[0]![0]).toBe(200);
    expect((answers[0]![1] as { utterances: string[] }).utterances.join(" ")).toBe("See. (image: diagram) and. (image: API_KEY).");
  });

  it("list no voices, and say why, when no voice provider is set up", async () => {
    const { answers } = await call("GET", "/api/tts/voices?q=calm");
    expect(answers).toHaveLength(1);
    expect(answers[0]![0]).toBe(200);
    expect((answers[0]![1] as { voices: unknown[] }).voices).toEqual([]);
  });
});

describe("transcribe route", () => {
  afterEach(() => vi.unstubAllGlobals());
  const withKey = { tts: { fishKey: "fish-key" } } as AppConfig;
  const upload = (bytes: Buffer, type = "audio/wav") =>
    Object.assign(Readable.from([bytes]), { headers: { "content-type": type, "content-length": String(bytes.byteLength) } }) as never;

  it("refuses anything but WAV audio", async () => {
    const { answers } = await call("POST", "/api/tts/transcribe", {}, withKey, upload(Buffer.from("x"), "application/json"));
    expect(answers).toEqual([[400, { error: "content-type must be audio/wav" }]]);
  });

  it("asks for a Fish Audio or ElevenLabs key when neither is saved", async () => {
    const { answers } = await call("POST", "/api/tts/transcribe", {}, {} as AppConfig, upload(Buffer.from("x")));
    expect(answers[0]![0]).toBe(409);
    expect((answers[0]![1] as { error: string }).error).toContain("Fish Audio or ElevenLabs key");
  });

  it("hears through ElevenLabs Scribe with the person's own key when no Fish key is saved", async () => {
    const seen: Array<{ url: string; key: string | null; model: unknown; file: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      const form = init.body as FormData;
      seen.push({ url, key: new Headers(init.headers).get("xi-api-key"), model: form.get("model_id"), file: form.get("file") });
      return new Response(JSON.stringify({ text: " สวัสดีครับ ", language_code: "tha" }), { status: 200 });
    }));
    const { answers } = await call("POST", "/api/tts/transcribe", {}, { tts: { key: "el-own" } } as AppConfig, upload(Buffer.from("RIFF")));
    expect(answers).toEqual([[200, { text: "สวัสดีครับ" }]]);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toMatch(/\/v1\/speech-to-text$/);
    expect(seen[0]!.key).toBe("el-own");
    expect(seen[0]!.model).toBe("scribe_v2");
    expect(seen[0]!.file).toBeInstanceOf(Blob);
  });

  it("keeps Fish Audio first when both keys are saved", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ text: "from fish" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { answers } = await call("POST", "/api/tts/transcribe", {}, { tts: { fishKey: "fish-key", key: "el-own" } } as AppConfig, upload(Buffer.from("RIFF")));
    expect(answers).toEqual([[200, { text: "from fish" }]]);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain("/v1/asr");
  });

  it("names the Speech to Text permission when ElevenLabs refuses the key", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ detail: { message: "missing_permissions" } }), { status: 401 })));
    const { answers } = await call("POST", "/api/tts/transcribe", {}, { tts: { key: "el-own" } } as AppConfig, upload(Buffer.from("RIFF")));
    expect(answers[0]![0]).toBe(502);
    expect((answers[0]![1] as { error: string }).error).toContain("Speech to Text permissions");
  });

  it("hears through DeepSeek alone while DeepSeek is the voice, even with a Fish key saved", async () => {
    const recording = Buffer.alloc(44 + 32_000);
    recording.write("RIFF", 0); recording.writeUInt32LE(36 + 32_000, 4); recording.write("WAVEfmt ", 8);
    recording.writeUInt32LE(16, 16); recording.writeUInt16LE(1, 20); recording.writeUInt16LE(1, 22);
    recording.writeUInt32LE(16_000, 24); recording.writeUInt32LE(32_000, 28); recording.writeUInt16LE(2, 32); recording.writeUInt16LE(16, 34);
    recording.write("data", 36); recording.writeUInt32LE(32_000, 40);
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ text: "from deepseek" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const cfg = { deepseek: { key: "ds-key" }, tts: { provider: "deepseek", fishKey: "fish-key" } } as AppConfig;
    const { answers } = await call("POST", "/api/tts/transcribe", {}, cfg, upload(recording));
    expect(answers).toEqual([[200, { text: "from deepseek" }]]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toMatch(/\/v1\/tools\/asr$/);
    expect(new Headers(fetchMock.mock.calls[0]![1].headers).get("authorization")).toBe("Bearer ds-key");
  });

  it("asks for a DeepSeek key, and tries no other provider, while DeepSeek is the voice without one", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const cfg = { tts: { provider: "deepseek", fishKey: "fish-key" } } as AppConfig;
    const { answers } = await call("POST", "/api/tts/transcribe", {}, cfg, upload(Buffer.from("RIFF")));
    expect(answers).toEqual([[409, { error: expect.stringContaining("DeepSeek API key"), errorKey: "serverError.voice.deepseekKeyRequired" }]]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses DeepSeek audio over its 8 MiB limit", async () => {
    const cfg = { deepseek: { key: "ds-key" }, tts: { provider: "deepseek" } } as AppConfig;
    const { answers } = await call("POST", "/api/tts/transcribe", {}, cfg, upload(Buffer.alloc(8 * 1024 * 1024 + 1)));
    expect(answers[0]![0]).toBe(413);
  });

  it("refuses audio over the cap", async () => {
    const { answers } = await call("POST", "/api/tts/transcribe", {}, withKey, upload(Buffer.alloc(TRANSCRIBE_MAX_BYTES + 1)));
    expect(answers[0]![0]).toBe(413);
  });

  it("returns the text Fish heard", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ text: "hi bot" }), { status: 200 })));
    const { answers } = await call("POST", "/api/tts/transcribe", {}, withKey, upload(Buffer.from("RIFF")));
    expect(answers).toEqual([[200, { text: "hi bot" }]]);
  });

  it("answers 502 with Fish's message when Fish fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "nope" }), { status: 401 })));
    const { answers } = await call("POST", "/api/tts/transcribe", {}, withKey, upload(Buffer.from("RIFF")));
    expect(answers[0]![0]).toBe(502);
    expect((answers[0]![1] as { error: string }).error).toContain("rejected that API key");
  });
});

it("keeps the English network refusal and its translation fields", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
  try {
    const req = Object.assign(Readable.from([Buffer.from("RIFF")]), { headers: { "content-type": "audio/wav", "content-length": "4" } });
    const { answers } = await call("POST", "/api/tts/transcribe", {}, { tts: { fishKey: "fish-key" } } as AppConfig, req as never);
    expect(answers).toEqual([[502, {
      error: "Couldn't reach Fish Audio to hear you — check your connection.",
      errorKey: "serverError.voice.fishTranscribeConnection",
    }]]);
  } finally { vi.unstubAllGlobals(); }
});

it("keeps the English ElevenLabs network refusal and its translation fields", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
  try {
    const req = Object.assign(Readable.from([Buffer.from("RIFF")]), { headers: { "content-type": "audio/wav", "content-length": "4" } });
    const { answers } = await call("POST", "/api/tts/transcribe", {}, { tts: { key: "el-own" } } as AppConfig, req as never);
    expect(answers).toEqual([[502, {
      error: "Couldn't reach ElevenLabs to hear you — check your connection.",
      errorKey: "serverError.voice.elevenLabsTranscribeConnection",
    }]]);
  } finally { vi.unstubAllGlobals(); }
});
