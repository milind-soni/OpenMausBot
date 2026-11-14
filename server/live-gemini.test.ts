import { describe, expect, it, vi } from "vitest";
import { createGeminiLiveSession, geminiErrorMessage, geminiFieldMask, geminiLiveBaseUrl, geminiLiveEndpoint, geminiLiveSetup, GEMINI_LIVE_MODEL } from "./live-gemini.ts";
import { FISH_DELEGATE_TOOL } from "./live-fish.ts";

const NOW = Date.parse("2026-11-14T10:00:00Z");
const ENDPOINT = geminiLiveEndpoint({});

function fakeGemini(answer: () => Response = () => new Response(JSON.stringify({ name: "auth_tokens/tok-1" }), { status: 200 })) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => answer());
}

const create = (fetchImpl: typeof fetch, key = " gemini-secret ", voice = "Kore") =>
  createGeminiLiveSession({ key, endpoint: ENDPOINT, voice, bot: { name: "Rigel" }, history: [], cloudHome: false, fetchImpl, now: () => NOW });

describe("Gemini Live endpoint", () => {
  it("talks to Google's v1beta API with the default Live model", () => {
    expect(ENDPOINT).toEqual({ provider: "gemini", apiBase: "https://generativelanguage.googleapis.com/v1beta", model: GEMINI_LIVE_MODEL });
  });

  it("takes a model id from OMB_GEMINI_LIVE_MODEL and ignores anything else", () => {
    expect(geminiLiveEndpoint({ OMB_GEMINI_LIVE_MODEL: "models/gemini-3.8-live-extended-thinking" }).model).toBe("gemini-3.8-live-extended-thinking");
    expect(geminiLiveEndpoint({ OMB_GEMINI_LIVE_MODEL: "../evil?x=1" }).model).toBe(GEMINI_LIVE_MODEL);
  });

  it("accepts only a loopback override of the API's address", () => {
    expect(geminiLiveBaseUrl({ OMB_GEMINI_LIVE_URL: "http://127.0.0.1:9123" })).toBe("http://127.0.0.1:9123");
    expect(geminiLiveBaseUrl({ OMB_GEMINI_LIVE_URL: "https://evil.example" })).toBe("https://generativelanguage.googleapis.com");
  });
});

describe("a Gemini Live call's token", () => {
  it("is asked for with the key in a header, once, with the setup locked except session resumption", async () => {
    const fetchImpl = fakeGemini();
    const session = await create(fetchImpl);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://generativelanguage.googleapis.com/v1beta/auth_tokens");
    expect(init!.headers).toMatchObject({ "x-goog-api-key": "gemini-secret" });
    const body = JSON.parse(String(init!.body));
    expect(body).toMatchObject({ uses: 1, newSessionExpireTime: "2026-11-14T10:01:00.000Z", expireTime: "2026-11-14T11:00:00.000Z" });
    expect(body.bidiGenerateContentSetup).toMatchObject({ model: `models/${GEMINI_LIVE_MODEL}`, generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } } } } });
    expect(body.bidiGenerateContentSetup.systemInstruction.parts[0].text).toContain("Rigel");
    expect(body.bidiGenerateContentSetup.tools[0].functionDeclarations[0]).toMatchObject({ name: FISH_DELEGATE_TOOL, behavior: "NON_BLOCKING" });
    expect(body.fieldMask.split(",")).toEqual(expect.arrayContaining(["model", "generationConfig.responseModalities", "generationConfig.speechConfig", "systemInstruction.parts", "tools", "contextWindowCompression.slidingWindow"]));
    expect(body.fieldMask).not.toContain("sessionResumption");
    expect(JSON.stringify(session)).not.toContain("gemini-secret");
    expect(session).toEqual({
      session_id: expect.stringMatching(/^gemini_[0-9a-f]{24}$/),
      token: "auth_tokens/tok-1",
      ws_url: "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained",
      model: `models/${GEMINI_LIVE_MODEL}`,
      expires_at: "2026-11-14T10:01:00.000Z",
    });
  });

  it("locks every field it sets, nested ones by their inner keys", () => {
    expect(geminiFieldMask(geminiLiveSetup("m", "hi", "Puck"))).toBe(
      "model,generationConfig.responseModalities,generationConfig.speechConfig,systemInstruction.parts,tools,inputAudioTranscription,outputAudioTranscription,contextWindowCompression.slidingWindow");
  });

  it("speaks in the chosen Gemini voice, and in Gemini's default for a name Gemini does not have", async () => {
    const voiceOf = async (voice: string) => {
      const fetchImpl = fakeGemini();
      await create(fetchImpl, "k", voice);
      return JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body)).bidiGenerateContentSetup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName;
    };
    expect(await voiceOf("Charon")).toBe("Charon");
    expect(await voiceOf("")).toBe("Puck");
    expect(await voiceOf("marin")).toBe("Puck");
  });

  it("connects a loopback override over ws", async () => {
    const endpoint = geminiLiveEndpoint({ OMB_GEMINI_LIVE_URL: "http://127.0.0.1:9123" });
    const session = await createGeminiLiveSession({ key: "k", endpoint, voice: "Puck", bot: { name: "R" }, history: [], cloudHome: false, fetchImpl: fakeGemini(), now: () => NOW });
    expect(session.ws_url).toBe("ws://127.0.0.1:9123/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained");
  });

  it("is never asked for without a key", async () => {
    const fetchImpl = fakeGemini();
    await expect(create(fetchImpl, "  ")).rejects.toMatchObject({ status: 409 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails in words fit for the person, never Gemini's body", async () => {
    const fetchImpl = fakeGemini(() => new Response("API key not valid: gemini-secret", { status: 400 }));
    await expect(create(fetchImpl)).rejects.toMatchObject({ status: 502, message: geminiErrorMessage(400) });
    await expect(create(fakeGemini(() => new Response("{}", { status: 403 })))).rejects.toMatchObject({ message: expect.stringContaining("rejected the API key") });
    await expect(create(fakeGemini(() => new Response("{}", { status: 429 })))).rejects.toMatchObject({ status: 429 });
  });

  it("refuses an answer that is not a token", async () => {
    for (const name of [undefined, "", "tokens/x", "auth_tokens/../x y"]) {
      await expect(create(fakeGemini(() => new Response(JSON.stringify({ name }), { status: 200 })))).rejects.toMatchObject({ status: 502 });
    }
  });

  it("says when Gemini cannot be reached", async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError("fetch failed"); });
    await expect(create(fetchImpl as unknown as typeof fetch)).rejects.toMatchObject({ status: 502, message: "Could not reach Gemini. Check the internet connection." });
  });
});
