import { describe, expect, it, vi } from "vitest";
import { GROQ_API, OPENAI_API, RELAY_ROTATE_MS, speechSource, SpeechRefusal } from "./speech.ts";

const CLOUD = { OMB_CLOUD_VOICE_URL: "https://admin.example.test/api/cloud/services/voice/v1", OMB_CLOUD_VOICE_TOKEN: "omb_voice_relay_token" };
const ALL_KEYS = { tts: { key: "sk_eleven" }, groq: { key: "gsk_groq" }, openai: { key: "sk-openai" } };

describe("which speech-to-text a meeting uses", () => {
  it("uses the hosted key only on a Cloud, through its relay, whatever keys the person also has", () => {
    expect(speechSource(ALL_KEYS, {}, fetch, CLOUD).kind).toBe("relay");
    expect(speechSource({}, {}, fetch, CLOUD).kind).toBe("relay");
  });

  it("uses the person's own keys elsewhere: ElevenLabs, then Groq, then OpenAI, then Whisper on the computer", () => {
    expect(speechSource(ALL_KEYS, {}, fetch, {}).kind).toBe("eleven");
    expect(speechSource({ groq: ALL_KEYS.groq, openai: ALL_KEYS.openai }, {}, fetch, {})).toMatchObject({ kind: "chunks", provider: "groq" });
    expect(speechSource({ openai: ALL_KEYS.openai, tts: { key: "  " } }, {}, fetch, {})).toMatchObject({ kind: "chunks", provider: "openai" });
    expect(speechSource({}, {}, fetch, {}).kind).toBe("whisper");
  });

  it("uses Whisper on the computer when the person asks for it, on a Cloud too", () => {
    expect(speechSource(ALL_KEYS, { local: true }, fetch, CLOUD).kind).toBe("whisper");
  });

  it("asks the relay for a single-use token with the relay token, and says plainly when the allowance is used up", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(`${CLOUD.OMB_CLOUD_VOICE_URL}/single-use-token/realtime_scribe`);
      expect(new Headers(init?.headers).get("xi-api-key")).toBe(CLOUD.OMB_CLOUD_VOICE_TOKEN);
      return Response.json({ token: "sutkn_1" });
    }) as unknown as typeof fetch;
    const relay = speechSource({}, {}, fetchImpl, CLOUD);
    if (relay.kind !== "relay") throw new Error("expected the relay");
    expect(await relay.grant()).toEqual({ kind: "eleven", token: "sutkn_1", rotateMs: RELAY_ROTATE_MS });
    const used = "Your Pro voice allowance for November, which meeting transcription also uses, is used up. It resets on 1 December.";
    const refusing = speechSource({}, {}, (async () => Response.json({ detail: { status: "quota_exceeded", message: used } }, { status: 429 })) as unknown as typeof fetch, CLOUD);
    if (refusing.kind !== "relay") throw new Error("expected the relay");
    await expect(refusing.grant()).rejects.toThrow(new SpeechRefusal(used));
  });

  it("transcribes with Groq or OpenAI from this server, words in milliseconds, segments when there are no words", async () => {
    const calls: Array<{ url: string; auth: string | null; form: FormData }> = [];
    const answers = [
      { words: [{ word: " We", start: 0.1, end: 0.3 }, { word: "launch.", start: 0.3, end: 0.9 }], text: "We launch." },
      { segments: [{ text: " Fine by me.", start: 1.2, end: 2 }], text: "Fine by me." },
    ];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization"), form: init?.body as FormData });
      return Response.json(answers.shift());
    }) as unknown as typeof fetch;
    const groq = speechSource({ groq: { key: "gsk_groq" } }, {}, fetchImpl, {});
    const openai = speechSource({ openai: { key: "sk-openai" } }, {}, fetchImpl, {});
    if (groq.kind !== "chunks" || openai.kind !== "chunks") throw new Error("expected chunks");
    expect(await groq.transcribe(Buffer.from("OggS"))).toEqual([{ w: "We", s: 100, e: 300 }, { w: "launch.", s: 300, e: 900 }]);
    expect(await openai.transcribe(Buffer.from("OggS"))).toEqual([{ w: "Fine by me.", s: 1_200, e: 2_000 }]);
    expect(calls.map((call) => [call.url, call.auth, call.form.get("model")])).toEqual([
      [`${GROQ_API}/audio/transcriptions`, "Bearer gsk_groq", "whisper-large-v3-turbo"],
      [`${OPENAI_API}/audio/transcriptions`, "Bearer sk-openai", "whisper-1"],
    ]);
    expect(calls[0]!.form.getAll("timestamp_granularities[]")).toEqual(["word", "segment"]);
    const refused = speechSource({ groq: { key: "gsk_bad", url: "https://groq.example.test/openai/v1/" } }, {},
      (async () => Response.json({ error: { message: "Invalid API Key" } }, { status: 401 })) as unknown as typeof fetch, {});
    if (refused.kind !== "chunks") throw new Error("expected chunks");
    await expect(refused.transcribe(Buffer.from("x"))).rejects.toThrow("Groq refused the transcription request with the key in Settings (401). Invalid API Key");
  });
});
