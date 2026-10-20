import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../config.ts";
import * as elevenlabs from "./elevenlabs.ts";

// tsconfig.server.json targets ES2023: Promise.withResolvers is ES2024.
function withResolvers<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

let server: Server;
const seen: Array<{ method: string; url: string; headers: Record<string, string>; body: string }> = [];
let refuse: { status: number; body: unknown } | null = null;

const MP3 = Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x11, 0x22, 0x33, 0x44]);
const WAV = Buffer.from("RIFF....WAVEfmt ");
let modelsFail = false;
let modelsDrop = false;
let audioVoicesFail = false;
let stubBase = "";
// The streamed-response case: the first chunk goes out at once, the rest only when the test releases them.
let speakStreamed: { first: Buffer; rest: Buffer; release: Promise<void> } | null = null;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers as Record<string, string>,
        body,
      });
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (refuse) return send(refuse.status, refuse.body);
      // /relay plays Cloud Pro's voice relay: same routes, another base URL
      const path = (req.url ?? "").split("?")[0].replace(/^\/relay\//, "/");
      // A restricted key (the common real case) has no user_read: verifying against /user would reject it.
      if (path === "/v1/user") return send(401, { detail: { status: "missing_permissions" } });
      if (path === "/v1/voices") {
        return send(200, {
          voices: [{ voice_id: "v-1", name: "Rachel", labels: { accent: "american", description: "calm" } }],
        });
      }
      if (/^\/v1\/text-to-speech\/[^/]+\/stream$/.test(path)) {
        if (speakStreamed) {
          const { first, rest, release } = speakStreamed;
          speakStreamed = null;
          res.writeHead(200, { "content-type": "audio/mpeg" });
          res.write(first);
          void release.then(() => res.end(rest));
          return;
        }
        res.writeHead(200, { "content-type": "audio/mpeg" });
        return res.end(MP3);
      }
      if (path === "/model") {
        const query = new URL(req.url ?? "/", "http://stub").searchParams;
        if (query.get("self") === "true" && req.headers.authorization !== "Bearer fish-key") {
          return send(401, { message: "unauthorized" });
        }
        if (query.get("self") === "true" && query.get("page_number") === "1") {
          return send(200, {
            total: 3,
            has_more: true,
            items: [
              { _id: "fish-1", type: "tts", state: "trained", title: "Narrator", description: "Warm and measured" },
              { _id: "svc-1", type: "svc", state: "trained", title: "Not a TTS voice" },
              { _id: "fish-training", type: "tts", state: "training", title: "Not ready" },
            ],
          });
        }
        if (query.get("self") === "true" && query.get("page_number") === "2") {
          return send(200, {
            total: 3,
            has_more: false,
            items: [{ _id: "fish-2", type: "tts", state: "trained", title: "Studio Voice", description: "" }],
          });
        }
        return send(200, {
          total: 1,
          has_more: false,
          items: [
            { _id: "fish-1", type: "tts", state: "trained", title: "Narrator", description: "Warm and measured" },
            { _id: "fish-failed", type: "tts", state: "failed", title: "Failed" },
          ],
        });
      }
      if (path === "/v1/tts") {
        res.writeHead(200, { "content-type": "audio/mpeg" });
        return res.end(MP3);
      }
      if (path === "/v1/audio/speech") {
        res.writeHead(200, { "content-type": "audio/wav" });
        return res.end(WAV);
      }
      if (path === "/v1/audio/voices") {
        if (audioVoicesFail) return send(404, { detail: "no audio voices route" });
        return send(200, {
          status: "ok",
          voices: [
            { filename: "Emily.wav", display_name: "Emily" },
            { filename: "Gianna.wav", display_name: "Gianna" },
          ],
        });
      }
      if (path === "/v1/models") {
        if (modelsDrop) {
          req.socket?.destroy();
          return;
        }
        if (modelsFail) return send(404, { detail: "no models route" });
        return send(200, { data: [{ id: "alex" }, { id: "turbo-en" }] });
      }
      send(404, { detail: "no such stub route" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  stubBase = `http://127.0.0.1:${port}`;
  process.env.OMB_ELEVENLABS_API = `${stubBase}/v1`;
  process.env.OMB_FISH_AUDIO_API = stubBase;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

/** The module reads its base URL at import time, so tests import after the stub is listening. */
const voice = () => import("./index.ts");
const fish = () => import("./fish.ts");

const cfg = (tts: AppConfig["tts"]): AppConfig => ({ tts });

describe("configuration", () => {
  it("needs both a key and a voice before it can speak", async () => {
    const { voiceConfigured, voiceReady } = await voice();
    expect(voiceConfigured({})).toBe(false);
    expect(voiceConfigured(cfg({ key: "k" }))).toBe(false);
    expect(voiceConfigured(cfg({ voice: "v-1" }))).toBe(false);
    expect(voiceConfigured(cfg({ key: "k", voice: "v-1" }))).toBe(true);
    expect(voiceReady(cfg({ key: "k" }), "v-per-bot")).toBe(true);
    expect(voiceReady({}, "v-per-bot")).toBe(false);
  });

  it("never reports the key itself", async () => {
    const { describeVoice } = await voice();
    const described = describeVoice(cfg({ key: "sk-secret", voice: "v-1" }));
    expect(described).toEqual({ configured: true, ready: true, voice: "v-1", provider: "elevenlabs", baseUrl: "", model: "" });
    expect(JSON.stringify(described)).not.toContain("sk-secret");
  });

  it("distinguishes 'no key' from 'no voice picked'", async () => {
    const { speak, NoVoiceConfigured } = await voice();
    expect(() => speak({}, "hi")).toThrow(NoVoiceConfigured);
    expect(() => speak({}, "hi")).toThrow(
      "Add an ElevenLabs key in Settings on the computer to turn on voice.",
    );
    expect(() => speak(cfg({ key: "k" }), "hi")).toThrow(
      "Pick a voice in the agent profile.",
    );
  });

  it("lists no voices without a key, rather than calling out", async () => {
    seen.length = 0;
    const { listVoices } = await voice();
    expect(await listVoices({})).toEqual([]);
    expect(seen).toHaveLength(0);
  });
});

describe("ElevenLabs", () => {
  const ready = { key: "el-key", voice: "v-1" };

  it("accepts a restricted key that can read voices and speak", async () => {
    refuse = null;
    seen.length = 0;
    const { verifyKey } = await voice();
    expect(await verifyKey("elevenlabs", "el-key")).toEqual({ ok: true });
    expect(seen.map((r) => r.url.split("?")[0])).not.toContain("/v1/user");
  });

  it("says what to do when the key is genuinely refused", async () => {
    refuse = { status: 401, body: { detail: "invalid api key" } };
    const { verifyKey } = await voice();
    const result = await verifyKey("elevenlabs", "nope");
    refuse = null;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/permission|restricted/i);
  });

  it("lists voices with their labels", async () => {
    const { listVoices } = await voice();
    expect(await listVoices(cfg(ready))).toEqual([
      { id: "v-1", label: "Rachel", description: "american · calm" },
    ]);
  });

  it("asks for mp3 and sends the key as a header, never in the URL", async () => {
    seen.length = 0;
    const { speak } = await voice();
    const audio = await speak(cfg(ready), "hello there");
    expect(audio.mime).toBe("audio/mpeg");
    expect(Buffer.from(audio.bytes)).toEqual(MP3);

    const call = seen.at(-1)!;
    expect(call.method).toBe("POST");
    expect(call.url).toContain("/v1/text-to-speech/v-1/stream");
    expect(call.url).toContain("output_format=mp3");
    expect(call.headers["xi-api-key"]).toBe("el-key");
    expect(call.url).not.toContain("el-key");
    expect(JSON.parse(call.body)).toMatchObject({ text: "hello there", model_id: "eleven_flash_v2_5" });
  });

  it("lets a caller override the voice per bot", async () => {
    seen.length = 0;
    const { speak } = await voice();
    await speak(cfg(ready), "hello", "v-other");
    expect(seen.at(-1)!.url).toContain("/v1/text-to-speech/v-other/stream");
  });

  it("requests streamed delivery from ElevenLabs", async () => {
    seen.length = 0;
    const { speak } = await voice();
    const audio = await speak(cfg(ready), "hello there");
    expect(Buffer.from(audio.bytes)).toEqual(MP3);
    expect(new URL(seen.at(-1)!.url, "http://stub").pathname).toBe("/v1/text-to-speech/v-1/stream");
  });

  it("returns first audio before the clip completes", async () => {
    const release = withResolvers<void>();
    speakStreamed = { first: MP3.subarray(0, 4), rest: MP3.subarray(4), release: release.promise };
    const clip = elevenlabs.synthesize("hello there", "v-1", "el-key", `${stubBase}/v1`);

    const first = await clip.firstAudio;
    expect(first.mime).toBe("audio/mpeg");
    expect(Buffer.from(first.bytes)).toEqual(MP3.subarray(0, 4));
    // The stub still holds the final chunk, so completion cannot have happened yet.
    let settled = false;
    void clip.audio.then(() => (settled = true));
    const flushed = withResolvers<void>();
    setImmediate(flushed.resolve);
    await flushed.promise;
    expect(settled).toBe(false);

    release.resolve();
    const whole = await clip.audio;
    expect(Buffer.from(whole.bytes)).toEqual(MP3);
  });

  it("surfaces the service's own refusal rather than a bare status", async () => {
    refuse = { status: 429, body: { detail: "You have exceeded your quota." } };
    const { speak } = await voice();
    const message = await speak(cfg(ready), "hi").catch((e: Error) => e.message);
    refuse = null;
    expect(message).toContain("exceeded your quota");
  });
});

describe("Fish Audio", () => {
  const ready = { provider: "fish" as const, fishKey: "fish-key", voice: "fish-1" };

  it("keeps its setup and key separate from ElevenLabs", async () => {
    const { describeVoice, providerConfigured, voiceConfigured, voiceReady } = await voice();
    expect(providerConfigured(cfg({ provider: "fish", key: "eleven-key" }))).toBe(false);
    expect(providerConfigured(cfg({ provider: "fish", fishKey: "fish-key" }))).toBe(true);
    expect(voiceConfigured(cfg({ provider: "fish", fishKey: "fish-key" }))).toBe(false);
    expect(voiceConfigured(cfg(ready))).toBe(true);
    expect(voiceReady(cfg({ provider: "fish", fishKey: "fish-key" }), "fish-per-agent")).toBe(true);
    const described = describeVoice(cfg(ready));
    expect(described).toEqual({
      configured: true,
      ready: true,
      voice: "fish-1",
      provider: "fish",
      baseUrl: "",
      model: "",
      fishModel: "s2.1-pro",
    });
    expect(JSON.stringify(described)).not.toContain("fish-key");
  });

  it("verifies the key against accessible voice models", async () => {
    refuse = null;
    seen.length = 0;
    const { verifyKey } = await voice();
    expect(await verifyKey("fish", "fish-key")).toEqual({ ok: true });
    const call = seen.at(-1)!;
    expect(call.method).toBe("GET");
    expect(call.url).toBe("/model?page_size=1&self=true");
    expect(call.headers.authorization).toBe("Bearer fish-key");
    expect(call.url).not.toContain("fish-key");
  });

  it("lists only trained TTS voices using Fish model ids", async () => {
    seen.length = 0;
    const { listVoices } = await voice();
    expect(await listVoices(cfg(ready))).toEqual([
      { id: "fish-1", label: "Narrator", description: "Warm and measured" },
      { id: "fish-2", label: "Studio Voice", description: undefined },
    ]);
    // The public page and the owned-page walk run concurrently, so only the owned walk's own order is asserted.
    const urls = seen.slice(-3).map((call) => call.url);
    expect([...urls].sort()).toEqual([
      "/model?page_size=100&self=true&sort_by=created_at&page_number=1",
      "/model?page_size=100&self=true&sort_by=created_at&page_number=2",
      "/model?page_size=100&sort_by=task_count",
    ]);
    expect(urls.indexOf("/model?page_size=100&self=true&sort_by=created_at&page_number=1"))
      .toBeLessThan(urls.indexOf("/model?page_size=100&self=true&sort_by=created_at&page_number=2"));
  });

  it("requests s2.1-pro mp3 speech and returns its raw audio", async () => {
    seen.length = 0;
    const { speak } = await voice();
    const audio = await speak(cfg(ready), "hello there");
    expect(audio.mime).toBe("audio/mpeg");
    expect(Buffer.from(audio.bytes)).toEqual(MP3);

    const call = seen.at(-1)!;
    expect(call.method).toBe("POST");
    expect(call.url).toBe("/v1/tts");
    expect(call.headers.authorization).toBe("Bearer fish-key");
    expect(call.headers.model).toBe("s2.1-pro");
    expect(JSON.parse(call.body)).toEqual({
      text: "hello there",
      reference_id: "fish-1",
      format: "mp3",
      sample_rate: 44_100,
      mp3_bitrate: 64,
      latency: "normal",
    });
  });

  it("speaks with the saved Fish model and reports it to settings", async () => {
    seen.length = 0;
    const { describeVoice, speak } = await voice();
    const free = cfg({ ...ready, fishModel: "s2.1-pro-free" });
    expect(describeVoice(free)).toMatchObject({ provider: "fish", fishModel: "s2.1-pro-free" });
    await speak(free, "hello there");
    expect(seen.at(-1)!.headers.model).toBe("s2.1-pro-free");
    expect(describeVoice(cfg({ ...ready, provider: "elevenlabs", fishModel: "s2.1-pro-free" })))
      .not.toHaveProperty("fishModel");
  });

  it("returns a useful bounded error without echoing arbitrary response bodies", async () => {
    refuse = { status: 422, body: { detail: "x".repeat(500) } };
    const { synthesize } = await fish();
    const message = await synthesize("hello", "fish-1", "fish-key").catch((error: Error) => error.message);
    refuse = null;
    if (typeof message !== "string") throw new Error("Fish Audio unexpectedly accepted the stubbed refusal");
    expect(message).toMatch(/^speaking failed: x+$/);
    expect(message.length).toBeLessThan(270);
  });

  it("explains rejected keys without exposing them", async () => {
    const { verifyKey } = await fish();
    const result = await verifyKey("not-a-real-key");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/rejected|access/i);
      expect(result.message).not.toContain("not-a-real-key");
    }
  });
});

describe("built-in macOS voices", () => {
  // The header above `say -v ?`'s table is localized, and some voice names contain spaces.
  const LISTING = [
    "Stimmen, die mit „say“ gesprochen werden können:",
    "Albert              en_US    # Hello! My name is Albert.",
    "Bad News            en_US    # The things I could tell you…",
    "Amélie              fr_CA    # Bonjour! Je m’appelle Amélie.",
    "",
  ].join("\n");

  const fakeSay = (record: string[][]) => async (_file: string, args: string[]) => {
    record.push(args);
    if (args[0] === "-v" && args[1] === "?") return { stdout: LISTING };
    const out = args[args.indexOf("-o") + 1];
    const { writeFile, mkdir } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, Buffer.from("RIFF....WAVEfmt "));
    return { stdout: "" };
  };

  const system = { provider: "system" as const, voice: "Albert" };
  const onMac = process.platform === "darwin";

  it("needs no key — only a picked voice — once selected", async () => {
    const { voiceConfigured, voiceReady, describeVoice } = await voice();
    expect(voiceConfigured(cfg(system))).toBe(onMac);
    expect(voiceReady(cfg({ provider: "system" }), "Albert")).toBe(onMac);
    expect(voiceReady(cfg(system))).toBe(onMac);
    const described = describeVoice(cfg(system));
    expect(described).toEqual({
      configured: onMac,
      ready: onMac,
      voice: "Albert",
      provider: "system",
      baseUrl: "",
      model: "",
    });
  });

  it("parses the say voice table, header junk and all", async () => {
    const { listVoices } = await voice();
    const record: string[][] = [];
    expect(await listVoices(cfg({ provider: "system" }), fakeSay(record))).toEqual([
      { id: "Albert", label: "Albert", description: "en_US — Hello! My name is Albert." },
      { id: "Bad News", label: "Bad News", description: "en_US — The things I could tell you…" },
      { id: "Amélie", label: "Amélie", description: "fr_CA — Bonjour! Je m’appelle Amélie." },
    ]);
    expect(record[0].slice(0, 2)).toEqual(["-v", "?"]);
  });

  it("synthesizes to a WAV without any key or network", async () => {
    const { speak } = await voice();
    const record: string[][] = [];
    const audio = await speak(cfg({ provider: "system" }), "hello there", "Albert", fakeSay(record));
    expect(audio.mime).toBe("audio/wav");
    expect(Buffer.from(audio.bytes).toString()).toContain("WAVE");

    const args = record.find((argv) => argv[0] === "-o")!;
    expect(args).toContain("--data-format=LEI16@22050");
    expect(args[args.indexOf("-v") + 1]).toBe("Albert");
    expect(args.at(-1)).toBe("hello there");

    const { access } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await expect(access(dirname(args[1]))).rejects.toThrow();
  });

  it("still demands a picked voice, and says so", async () => {
    const { speak, NoVoiceConfigured } = await voice();
    expect(() => speak(cfg({ provider: "system" }), "hi", undefined, fakeSay([]))).toThrow(NoVoiceConfigured);
    expect(() => speak(cfg({ provider: "system" }), "hi", undefined, fakeSay([]))).toThrow(
      "Pick a voice in the agent profile.",
    );
  });
});

describe("Chatterbox (local server)", () => {
  const chatCfg = (extra: Partial<AppConfig["tts"]> = {}) => ({ provider: "chatterbox" as const, ...extra });

  it("is configured by a server address, never a key", async () => {
    const { providerConfigured, voiceConfigured, voiceReady, describeVoice } = await voice();
    expect(providerConfigured(cfg(chatCfg()))).toBe(false);
    expect(providerConfigured(cfg(chatCfg({ baseUrl: stubBase })))).toBe(true);
    expect(voiceConfigured(cfg(chatCfg({ baseUrl: stubBase })))).toBe(false);
    expect(voiceConfigured(cfg(chatCfg({ baseUrl: stubBase, voice: "alex" })))).toBe(true);
    expect(voiceReady(cfg(chatCfg({ baseUrl: stubBase })), "alex")).toBe(true);
    expect(voiceReady(cfg(chatCfg({ voice: "alex" })), "alex")).toBe(false);
    const described = describeVoice(cfg(chatCfg({ baseUrl: stubBase, model: "turbo-en", voice: "alex" })));
    expect(described).toEqual({
      configured: true,
      ready: true,
      voice: "alex",
      provider: "chatterbox",
      baseUrl: stubBase,
      model: "turbo-en",
    });
  });

  it("speaks with the OpenAI audio-speech shape and no key header", async () => {
    refuse = null;
    seen.length = 0;
    const { speak } = await voice();
    const audio = await speak(cfg(chatCfg({ baseUrl: stubBase, voice: "alex" })), "hello there");
    expect(audio.mime).toBe("audio/wav");
    expect(Buffer.from(audio.bytes)).toEqual(WAV);

    const call = seen.at(-1)!;
    expect(call.method).toBe("POST");
    expect(call.url).toBe("/v1/audio/speech");
    expect(JSON.parse(call.body)).toEqual({
      model: "chatterbox-turbo",
      input: "hello there",
      voice: "alex",
      response_format: "wav",
    });
    expect(call.headers["xi-api-key"]).toBeUndefined();
    expect(call.url).not.toContain("key");
  });

  it("accepts a base that already ends in /v1, and honors the model setting", async () => {
    refuse = null;
    seen.length = 0;
    const { speak } = await voice();
    await speak(cfg(chatCfg({ baseUrl: `${stubBase}/v1`, model: "chatterbox-multilingual", voice: "alex" })), "hi", "will");

    const call = seen.at(-1)!;
    expect(call.url).toBe("/v1/audio/speech");
    expect(JSON.parse(call.body)).toMatchObject({ model: "chatterbox-multilingual", voice: "will" });
  });

  it("surfaces the server's own refusal rather than a bare status", async () => {
    refuse = { status: 500, body: { error: "model chatterbox-turbo is not loaded" } };
    const { speak } = await voice();
    const message = await speak(cfg(chatCfg({ baseUrl: stubBase, voice: "alex" })), "hi").catch((e: Error) => e.message);
    refuse = null;
    expect(message).toContain("not loaded");
  });

  it("says when the server is unreachable, instead of hanging", async () => {
    // a port that was just closed: nothing listens, so connect fails fast
    const gone = createServer();
    await new Promise<void>((r) => gone.listen(0, "127.0.0.1", () => r()));
    const port = (gone.address() as { port: number }).port;
    await new Promise<void>((r) => gone.close(() => r()));

    const { speak } = await voice();
    const message = await speak(cfg(chatCfg({ baseUrl: `http://127.0.0.1:${port}`, voice: "alex" })), "hi").catch(
      (e: Error) => e.message,
    );
    expect(message).toMatch(/couldn't reach the Chatterbox server/i);
  });

  it("lists the server's models as voices, with audio/voices and Default as fallbacks", async () => {
    refuse = null;
    modelsFail = false;
    modelsDrop = false;
    audioVoicesFail = false;
    const { listVoices } = await voice();
    expect(await listVoices(cfg(chatCfg({ baseUrl: stubBase })))).toEqual([
      { id: "alex", label: "alex" },
      { id: "turbo-en", label: "turbo-en" },
    ]);
    modelsFail = true;
    expect(await listVoices(cfg(chatCfg({ baseUrl: stubBase })))).toEqual([
      { id: "Emily.wav", label: "Emily" },
      { id: "Gianna.wav", label: "Gianna" },
    ]);
    modelsFail = false;
    modelsDrop = true;
    expect(await listVoices(cfg(chatCfg({ baseUrl: stubBase })))).toEqual([
      { id: "Emily.wav", label: "Emily" },
      { id: "Gianna.wav", label: "Gianna" },
    ]);
    modelsDrop = false;
    modelsFail = true;
    audioVoicesFail = true;
    expect(await listVoices(cfg(chatCfg({ baseUrl: stubBase })))).toEqual([
      { id: "default", label: "Default", description: "the server's built-in Chatterbox voice" },
    ]);
    modelsFail = false;
    audioVoicesFail = false;
  });

  it("lists no voices without a server address, rather than calling out", async () => {
    seen.length = 0;
    const { listVoices } = await voice();
    expect(await listVoices(cfg(chatCfg()))).toEqual([]);
    expect(seen).toHaveLength(0);
  });

  it("names the missing setup step in its own words", async () => {
    const { speak, NoVoiceConfigured } = await voice();
    expect(() => speak(cfg(chatCfg()), "hi")).toThrow(NoVoiceConfigured);
    expect(() => speak(cfg(chatCfg()), "hi")).toThrow(
      "Add the address of your Chatterbox server in Settings on the computer to turn on voice.",
    );
    expect(() => speak(cfg(chatCfg({ baseUrl: stubBase })), "hi")).toThrow("Pick a voice in the agent profile.");
  });
});

describe("included voice", () => {
  const INCLUDED = "omb_voice_included-relay-token";
  const relayed = () => seen.filter((request) => request.url.startsWith("/relay/"));
  const direct = () => seen.filter((request) => !request.url.startsWith("/relay/"));

  afterEach(() => vi.unstubAllEnvs());
  const include = () => {
    refuse = null;
    seen.length = 0;
    vi.stubEnv("OMB_TTS_KEY", undefined);
    vi.stubEnv("OMB_CLOUD_VOICE_URL", `${stubBase}/relay/v1`);
    vi.stubEnv("OMB_CLOUD_VOICE_TOKEN", INCLUDED);
  };

  it("with no own key, lists voices and speaks with the included token, only through the relay", async () => {
    include();
    const { listVoices, speak, voiceConfigured } = await voice();
    const settings = cfg({ voice: "v-1" });
    expect(voiceConfigured(settings)).toBe(true);
    expect((await listVoices(settings)).map((v) => v.id)).toEqual(["v-1"]);
    expect((await speak(settings, "hello")).mime).toBe("audio/mpeg");
    expect(relayed().map((request) => request.url.split("?")[0])).toEqual(["/relay/v1/voices", "/relay/v1/text-to-speech/v-1/stream"]);
    expect(direct()).toEqual([]);
    expect(seen.every((request) => request.headers["xi-api-key"] === INCLUDED)).toBe(true);
  });

  it("an own key saved in Settings wins and goes only to ElevenLabs; removing it falls back", async () => {
    include();
    const { speak } = await voice();
    const settings = cfg({ key: "sk-own", voice: "v-1" });
    await speak(settings, "hello");
    expect(relayed()).toEqual([]);
    expect(direct().map((request) => request.headers["xi-api-key"])).toEqual(["sk-own"]);
    seen.length = 0;
    settings.tts!.key = "";
    await speak(settings, "hello");
    expect(direct()).toEqual([]);
    expect(relayed().map((request) => request.headers["xi-api-key"])).toEqual([INCLUDED]);
  });

  it("an own key from the environment (OMB_TTS_KEY) wins and goes only to ElevenLabs", async () => {
    include();
    vi.stubEnv("OMB_TTS_KEY", "sk-from-env");
    const { loadConfig } = await import("../config.ts");
    const { speak } = await voice();
    await speak({ ...loadConfig(), tts: { ...loadConfig().tts, voice: "v-1" } }, "hello");
    expect(relayed()).toEqual([]);
    expect(direct().map((request) => request.headers["xi-api-key"])).toEqual(["sk-from-env"]);
  });

  it("verifies a key being saved against ElevenLabs only, never the relay", async () => {
    include();
    const { verifyKey } = await voice();
    expect(await verifyKey("elevenlabs", "sk-new")).toEqual({ ok: true });
    expect(seen.map((request) => [request.url, request.headers["xi-api-key"]])).toEqual([["/v1/voices", "sk-new"]]);
  });

  it("tells Settings the voice is included, and never the token", async () => {
    include();
    const { describeVoice } = await voice();
    const described = describeVoice(cfg({ voice: "v-1" }));
    expect(described).toEqual({ configured: true, ready: true, voice: "v-1", provider: "elevenlabs", baseUrl: "", model: "", included: true });
    expect(JSON.stringify(described)).not.toContain(INCLUDED);
    expect(describeVoice(cfg({ key: "sk-own", voice: "v-1" }))).not.toHaveProperty("included");
    expect(describeVoice(cfg({ provider: "fish", voice: "v-1" }))).toMatchObject({ configured: false });
    expect(describeVoice(cfg({ provider: "fish", voice: "v-1" }))).not.toHaveProperty("included");
    vi.stubEnv("OMB_CLOUD_VOICE_TOKEN", undefined);
    expect(describeVoice(cfg({ voice: "v-1" }))).toMatchObject({ configured: false, ready: false });
  });
});
