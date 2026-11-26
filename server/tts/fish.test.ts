import { afterEach, describe, expect, it, vi } from "vitest";

import { listVoices, synthesize, transcribe, verifyKey } from "./fish.ts";

afterEach(() => vi.unstubAllGlobals());

function stubFetch(status: number, body: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("Fish Audio transcribe", () => {
  it("sends the clip with the pro model and returns the trimmed text", async () => {
    const fetchMock = stubFetch(200, { text: "  hello there  ", duration: 1.2 });
    expect(await transcribe(new Uint8Array([1, 2, 3]), "audio/wav", "fish-key")).toBe("hello there");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/v1\/asr$/);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ authorization: "Bearer fish-key", model: "transcribe-1-pro" });
    const form = init.body as FormData;
    expect(form.get("ignore_timestamps")).toBe("true");
    expect(form.get("diarize")).toBe("false");
    expect(form.get("tag_audio_events")).toBe("false");
    const audio = form.get("audio") as File;
    expect(audio.name).toBe("speech.wav");
    expect(audio.size).toBe(3);
  });

  it("returns empty text when Fish heard nothing", async () => {
    stubFetch(200, {});
    expect(await transcribe(new Uint8Array(4), "audio/wav", "k")).toBe("");
  });

  it("explains a rejected key and an empty balance", async () => {
    stubFetch(401, { message: "bad" });
    await expect(transcribe(new Uint8Array(4), "audio/wav", "k")).rejects.toThrow("rejected that API key");
    stubFetch(402, { message: "Out of credit" });
    await expect(transcribe(new Uint8Array(4), "audio/wav", "k")).rejects.toThrow("Out of credit");
  });

  it("says Fish was unreachable when the request throws", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    await expect(transcribe(new Uint8Array(4), "audio/wav", "k")).rejects.toThrow("Couldn't reach Fish Audio to hear you");
  });
});

describe("Fish Audio requests", () => {
  it("refuse redirects, so the key and the person's audio go only to Fish", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await verifyKey("k");
    await listVoices("k");
    await synthesize("hello", "voice", "k");
    await transcribe(new Uint8Array(4), "audio/wav", "k");
    const inits = (fetchMock.mock.calls as unknown as Array<[string, RequestInit]>).map(([, init]) => init);
    expect(inits.length).toBeGreaterThanOrEqual(4);
    for (const init of inits) expect(init.redirect).toBe("error");
  });
});
