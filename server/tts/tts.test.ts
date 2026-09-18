// The voice, driven against a stub rather than the live service — same
// rule as the box and computer-proxy contract tests: what we send, and how
// a refusal is reported, are the things that break.
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AppConfig } from "../config.ts";
import { piperInstallable, piperTarget } from "./piper-install.ts";
import { piperAvailable } from "./piper.ts";

/** The one-click install is offered where a pinned engine exists for this
 * platform and architecture — same idea as `onBuiltInPlatform` below. */
const onInstallablePlatform = piperInstallable(piperTarget());

let server: Server;
/** every request the stub saw, so tests can assert on what we sent */
const seen: Array<{ method: string; url: string; headers: Record<string, string>; body: string }> = [];
/** flipped by tests that want ElevenLabs to refuse */
let refuse: { status: number; body: unknown } | null = null;

const MP3 = Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x11, 0x22, 0x33, 0x44]);

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
      send(404, { detail: "no such stub route" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  process.env.ASTRA_ELEVENLABS_API = `http://127.0.0.1:${port}/v1`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

/** The module reads its base URL at import time, so tests import after the
 * stub is listening. */
const voice = () => import("./index.ts");

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
    // piperAvailable and the install fields ride along so Settings can grey out
    // the offline engine, offer the one-click install and show its progress
    // before the user asks for any of it; the key itself never does.
    expect(described).toEqual({
      configured: true,
      ready: true,
      voice: "v-1",
      provider: "elevenlabs",
      piperAvailable: false,
      piperInstallable: onInstallablePlatform,
      piperInstalling: false,
      piperInstallError: null,
    });
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
    expect(await verifyKey("el-key")).toEqual({ ok: true });
    expect(seen.map((r) => r.url.split("?")[0])).not.toContain("/v1/user");
  });

  it("says what to do when the key is genuinely refused", async () => {
    refuse = { status: 401, body: { detail: "invalid api key" } };
    const { verifyKey } = await voice();
    const result = await verifyKey("nope");
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
  // The built-in engine exists on macOS (`say`) and Windows (SAPI) alike;
  // the runner seam below mimics `say` on every platform.
  const onBuiltInPlatform = process.platform === "darwin" || process.platform === "win32";

  it("needs no key — only a picked voice — once selected", async () => {
    const { voiceConfigured, voiceReady, describeVoice } = await voice();
    expect(voiceConfigured(cfg(system))).toBe(onBuiltInPlatform);
    expect(voiceReady(cfg({ provider: "system" }), "Albert")).toBe(onBuiltInPlatform);
    expect(voiceReady(cfg(system))).toBe(onBuiltInPlatform);
    const described = describeVoice(cfg(system));
    expect(described).toEqual({
      configured: onBuiltInPlatform,
      ready: onBuiltInPlatform,
      voice: "Albert",
      provider: "system",
      piperAvailable: false,
      piperInstallable: onInstallablePlatform,
      piperInstalling: false,
      piperInstallError: null,
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

describe("Piper (offline neural voices)", () => {
  // The vitest home is a throwaway directory (server/testing/setup.ts), so
  // the engine is never provisioned here; these tests hold the contract that
  // matters on machines without it — selected-but-absent stays honest.
  const unavailable = !piperAvailable();

  it("reports a selected Piper provider even when the engine is absent", async () => {
    const { voiceProvider } = await voice();
    expect(voiceProvider(cfg({ provider: "piper", voice: "en_US-amy-medium" }))).toBe("piper");
    // and an unset provider is still ElevenLabs
    expect(voiceProvider(cfg({ key: "k", voice: "v" }))).toBe("elevenlabs");
  });

  it("refuses to speak with Piper-shaped advice, not ElevenLabs advice", async () => {
    const { speak, NoVoiceConfigured } = await voice();
    const attempt = () => speak(cfg({ provider: "piper", voice: "en_US-amy-medium" }), "hi");
    expect(attempt).toThrow(NoVoiceConfigured);
    try {
      attempt();
      expect.unreachable("speak should have thrown");
    } catch (error) {
      const message = (error as Error).message;
      if (unavailable) {
        // the engine is missing HERE: the advice must say so, and must not
        // point at ElevenLabs — the user picked the offline engine
        expect(message).toMatch(/Piper/);
        expect(message).not.toMatch(/ElevenLabs/);
      }
    }
  });

  it("counts as unconfigured while the engine is absent", async () => {
    const { voiceConfigured, voiceReady, providerConfigured } = await voice();
    if (!unavailable) return; // provisioned home: availability gates below still hold
    const selected = { provider: "piper" as const, voice: "en_US-amy-medium" };
    expect(providerConfigured(cfg(selected))).toBe(false);
    expect(voiceConfigured(cfg(selected))).toBe(false);
    expect(voiceReady(cfg(selected))).toBe(false);
  });

  it("lists voices through the piper module only when the engine exists", async () => {
    const { listVoices } = await voice();
    const voices = await listVoices(cfg({ provider: "piper" }));
    if (unavailable) expect(voices).toEqual([]);
    else expect(voices.length).toBeGreaterThan(0);
  });
});
