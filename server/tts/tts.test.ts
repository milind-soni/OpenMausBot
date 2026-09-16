// The voice, driven against a stub rather than the live service — same
// rule as the box and computer-proxy contract tests: what we send, and how
// a refusal is reported, are the things that break.
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AppConfig } from "../config.ts";

let server: Server;
/** every request the stub saw, so tests can assert on what we sent */
const seen: Array<{ method: string; url: string; headers: Record<string, string>; body: string }> = [];
/** flipped by tests that want ElevenLabs to refuse */
let refuse: { status: number; body: unknown } | null = null;

const MP3 = Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x11, 0x22, 0x33, 0x44]);
const WAV = Buffer.from("RIFF....WAVEfmt ");
/** flipped by tests that want the server to have no /v1/models route */
let modelsFail = false;
let stubBase = "";

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
      const path = (req.url ?? "").split("?")[0];
      // A RESTRICTED key — the common real-world case. It can read voices
      // and speak, but has no user_read. Verifying against /user would
      // reject it, which is exactly the bug this stub exists to catch.
      if (path === "/v1/user") return send(401, { detail: { status: "missing_permissions" } });
      if (path === "/v1/voices") {
        return send(200, {
          voices: [{ voice_id: "v-1", name: "Rachel", labels: { accent: "american", description: "calm" } }],
        });
      }
      if (path.startsWith("/v1/text-to-speech/")) {
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
      if (path === "/v1/models") {
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

/** The module reads its base URL at import time, so tests import after the
 * stub is listening. */
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
    // the two need different instructions, so they are different errors
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
    // ElevenLabs keys carry per-endpoint scopes. A key limited to speech
    // has no user_read, so verifying against /user rejects a key that
    // works perfectly — the stub 401s /user to hold that line.
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
    // names scopes, because "get a fresh key" is the wrong advice when the
    // key is real but restricted
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
    expect(call.url).toContain("/v1/text-to-speech/v-1");
    expect(call.url).toContain("output_format=mp3");
    expect(call.headers["xi-api-key"]).toBe("el-key");
    expect(call.url).not.toContain("el-key");
    expect(JSON.parse(call.body)).toMatchObject({ text: "hello there", model_id: "eleven_flash_v2_5" });
  });

  it("lets a caller override the voice per bot", async () => {
    seen.length = 0;
    const { speak } = await voice();
    await speak(cfg(ready), "hello", "v-other");
    expect(seen.at(-1)!.url).toContain("/v1/text-to-speech/v-other");
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
    // The public page and the owned-page walk run concurrently (fish.ts:102,
    // Promise.all), so how they interleave is not deterministic — asserting a
    // fixed order made this fail on loaded runners. What IS ordered is the
    // owned walk itself: page 2 is only fetched after page 1 reports hasMore.
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
  // `say -v ?` output: name, locale, then a # sample sentence. The header
  // above the table is localized, and some voice names contain spaces.
  const LISTING = [
    "Stimmen, die mit „say“ gesprochen werden können:", // localized header — must be ignored
    "Albert              en_US    # Hello! My name is Albert.",
    "Bad News            en_US    # The things I could tell you…",
    "Amélie              fr_CA    # Bonjour! Je m’appelle Amélie.",
    "", // trailing blank
  ].join("\n");

  /** A stand-in for `say`: records argv, writes a tiny WAV where -o points,
   * and answers -v ? with the listing above. */
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

    // the utterance temp dir does not outlive the call
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

  it("lists the server's models as voices, with a fallback when it cannot", async () => {
    refuse = null;
    const { listVoices } = await voice();
    expect(await listVoices(cfg(chatCfg({ baseUrl: stubBase })))).toEqual([
      { id: "alex", label: "alex" },
      { id: "turbo-en", label: "turbo-en" },
    ]);
    modelsFail = true;
    expect(await listVoices(cfg(chatCfg({ baseUrl: stubBase })))).toEqual([
      { id: "default", label: "Default", description: "the server's built-in Chatterbox voice" },
    ]);
    modelsFail = false;
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
