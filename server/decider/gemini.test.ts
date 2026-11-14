import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config.ts";
import { geminiAccount } from "./accounts.ts";
import { createDecider, deciderAccount, deciderPatchKey, deciderSavePatch, describeDecider } from "./index.ts";
import { GEMINI_DECIDER_MODEL, GEMINI_DECIDER_URL } from "./gemini.ts";
import type { DeciderQuestion } from "./types.ts";

const KEY = "gemini-private-decision-key";
const ON: AppConfig = { decider: { provider: "gemini", enabled: true, geminiKey: KEY } };
const STATE = { message: "private message" };
const QUESTIONS = {
  choice: { type: "choice", instructions: "Who?", options: { a: "A", b: "B" } },
  score: { type: "score", instructions: "How urgent?", levels: ["Low", "High"] },
  yes: { type: "yesno", instructions: "Relevant?", criteria: { yes: "In scope", no: "Out of scope" } },
} satisfies Record<string, DeciderQuestion>;
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const yes = () => response({ answers: { answer: { type: "noul", noul: 0.9 } } });
const make = (config: AppConfig, fetchImpl: typeof fetch) => createDecider({ config: () => config, fetch: fetchImpl });

afterEach(() => vi.unstubAllEnvs());

describe("Gemini Decisions API", () => {
  it("sends all three question types with Google's credentials and wire format", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => response({
      answers: {
        choice: { type: "choice", choice: "b", probabilities: { a: 0.1, b: 0.9 }, confidence: 0.5 },
        score: { type: "score", score: 0.8, probabilities: { "0": 0.2, "1": 0.8 }, legend: { "0": "Low", "1": "High" } },
        yes: { type: "noul", noul: 0.9, confidence: 0.9 },
      }, usage: { total_input_tokens: 123, total_output_tokens: 0 },
    }));
    const result = await make(ON, fetchImpl).ask("botDecide", STATE, QUESTIONS);
    expect(result).toMatchObject({ ok: true, provider: "gemini", model: GEMINI_DECIDER_MODEL, inputTokens: 123, answers: {
      choice: { type: "choice", choice: "b", pTop: 0.9, margin: 0.8 },
      score: { type: "score", score: 0.8, level: 1, probabilities: [0.2, 0.8] },
      yes: { type: "yesno", p: 0.9 },
    } });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(GEMINI_DECIDER_URL);
    expect(init).toMatchObject({ method: "POST", redirect: "error", headers: { "x-goog-api-key": KEY } });
    expect(new Headers(init!.headers).has("authorization")).toBe(false);
    expect(JSON.parse(String(init!.body))).toEqual({ model: GEMINI_DECIDER_MODEL, input: JSON.stringify(STATE), questions: {
      choice: { type: "choice", instructions: "Who?", criteria: { a: "A", b: "B" } },
      score: { type: "score", instructions: "How urgent?", criteria: ["Low", "High"] },
      yes: { type: "noul", instructions: "Relevant?", criteria: { true_description: "In scope", false_description: "Out of scope" } },
    } });
    expect(String(init!.body)).not.toContain(KEY);
  });

  it.each([[401, "rejected"], [403, "rejected"], [429, "rate_limited"], [503, "overloaded"], [413, "too_large"], [400, "http_error"]])("maps HTTP %s without exposing the body", async (status, reason) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => response({ error: KEY }, status as number));
    const result = await make(ON, fetchImpl).testKey();
    expect(result).toMatchObject({ ok: false, provider: "gemini", reason, status });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it.each([null, [], {}, { answers: {} }, { answers: { answer: { noul: 2 } } }, { answers: { answer: { type: "choice", noul: 0.9 } } }])("refuses malformed answers: %j", async (body) => {
    expect(await make(ON, vi.fn(async () => response(body))).testKey()).toMatchObject({ ok: false, reason: "malformed" });
  });

  it("refuses invalid choices and probabilities", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => response({ answers: { answer: { type: "choice", choice: "stranger", probabilities: { a: 0.1, stranger: 0.9 } } } }));
    expect(await make(ON, fetchImpl).choose("roomRouting", STATE, QUESTIONS.choice)).toMatchObject({ ok: false, reason: "malformed" });
  });

  it("recognizes Google's invalid-key error without exposing its message", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => response({ error: { message: KEY, details: [{ reason: "API_KEY_INVALID" }] } }, 400));
    const result = await make(ON, fetchImpl).testKey();
    expect(result).toMatchObject({ ok: false, reason: "rejected", status: 400 });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it("bounds a stalled body and supports cancellation", async () => {
    const stalled = vi.fn<typeof fetch>(async () => ({ ok: true, json: () => new Promise(() => {}) }) as Response);
    expect(await make(ON, stalled).testKey({}, { timeoutMs: 50 })).toMatchObject({ ok: false, reason: "timeout" });
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn<typeof fetch>();
    expect(await make(ON, fetchImpl).testKey({}, { signal: controller.signal })).toMatchObject({ ok: false, reason: "cancelled" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("contains network and redirect failures", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => { throw new Error(`redirect or network failure ${KEY}`); });
    expect(await make(ON, fetchImpl).testKey()).toMatchObject({ ok: false, reason: "unreachable" });
    expect(fetchImpl.mock.calls[0]![1]!.redirect).toBe("error");
  });
});

describe("Gemini selection and key references", () => {
  it("uses Gemini only when selected, and preserves the existing providers' order", () => {
    const config: AppConfig = { ...ON, decider: { ...ON.decider, key: "jev-key", openrouterKey: "router-key" } };
    expect(deciderAccount(config)?.provider).toBe("gemini");
    expect(deciderAccount({ ...config, decider: { ...config.decider, provider: "jev" } })?.provider).toBe("jev");
    expect(deciderAccount({ decider: { geminiKey: KEY, enabled: true } })).toBeNull();
    expect(deciderAccount({ ...config, decider: { ...config.decider, geminiKey: "" } })).toBeNull();
  });

  it.each(["own", "speech", "images"] as const)("resolves only the selected %s key, including replacements and removal", async (source) => {
    const config: AppConfig = { decider: { ...ON.decider, geminiKeySource: source }, tts: { geminiKey: "speech-secret" }, imageGen: { geminiKey: "image-secret" } };
    const expected = source === "speech" ? "speech-secret" : source === "images" ? "image-secret" : KEY;
    const fetchImpl = vi.fn<typeof fetch>(async () => yes());
    await make(config, fetchImpl).testKey();
    expect(new Headers(fetchImpl.mock.calls[0]![1]!.headers).get("x-goog-api-key")).toBe(expected);
    expect(JSON.stringify(describeDecider(config))).not.toContain(expected);
    const holder = source === "speech" ? config.tts! : source === "images" ? config.imageGen! : config.decider!;
    holder.geminiKey = "replacement";
    expect(geminiAccount(config)?.token).toBe("replacement");
    holder.geminiKey = "";
    expect(geminiAccount(config)).toBeNull();
    expect(describeDecider(config)).toMatchObject({ provider: "gemini", configured: false, enabled: false, geminiKeySource: source });
    expect(await make(config, fetchImpl).yesNo("botDecide", STATE, "Relevant?")).toMatchObject({ ok: false, reason: "no_key" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("tests draft keys at Gemini and exposes only source availability", async () => {
    const config: AppConfig = { tts: { geminiKey: "speech-secret" }, imageGen: { geminiKey: "image-secret" } };
    const fetchImpl = vi.fn<typeof fetch>(async () => yes());
    await make(config, fetchImpl).testKey({ provider: "gemini", key: KEY });
    expect(new Headers(fetchImpl.mock.calls[0]![1]!.headers).get("x-goog-api-key")).toBe(KEY);
    expect(describeDecider({ ...config, decider: { provider: "gemini" } })).toMatchObject({ geminiKeySource: "own", geminiKeySources: { speech: true, images: true }, configured: false });
  });

  it("supports saving, enabling, clearing, and checking the separate key", () => {
    expect(deciderSavePatch({ geminiKey: ` ${KEY} ` }, undefined)).toEqual({ ok: true, patch: { geminiKey: KEY, enabled: true, jobs: { roomRouting: true } } });
    expect(deciderSavePatch({ geminiKey: "" }, ON.decider)).toEqual({ ok: true, patch: { geminiKey: "", enabled: false } });
    expect(deciderSavePatch({ geminiKeySource: "speech" }, {}, { gemini: true })).toEqual({ ok: true, patch: { geminiKeySource: "speech", enabled: true, jobs: { roomRouting: true } } });
    expect(deciderPatchKey({ geminiKey: ` ${KEY} ` }, undefined)).toEqual({ provider: "gemini", check: { provider: "gemini", key: KEY } });
  });
});
