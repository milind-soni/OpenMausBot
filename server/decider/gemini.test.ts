import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config.ts";
import { createDecider, deciderAccount, deciderBorrowedKey, deciderSavePatch, describeDecider } from "./index.ts";
import { GEMINI_DECIDER_MODEL, GEMINI_DECIDER_URL } from "./gemini.ts";
import type { DeciderQuestion } from "./types.ts";

const KEY = "gemini-private-key";
const ON: AppConfig = { decider: { enabled: true }, tts: { geminiKey: KEY } };
const STATE = { message: "private message" };
const QUESTIONS = {
  choice: { type: "choice", instructions: "Who?", options: { a: "A", b: "B" } },
  score: { type: "score", instructions: "How urgent?", levels: ["Low", "High"] },
  yes: { type: "yesno", instructions: "Relevant?", criteria: { yes: "In scope", no: "Out of scope" } },
} satisfies Record<string, DeciderQuestion>;
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const make = (config: AppConfig, fetchImpl: typeof fetch) => createDecider({ config: () => config, fetch: fetchImpl });

describe("Gemini decisions", () => {
  it("sends every question type in Google's wire format with the key in its header only", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => response({
      answers: {
        choice: { type: "choice", choice: "b", probabilities: { a: 0.1, b: 0.9 } },
        score: { type: "score", score: 0.8, probabilities: { "0": 0.2, "1": 0.8 } },
        yes: { type: "noul", noul: 0.9 },
      },
      usage: { total_input_tokens: 123 },
    }));
    const result = await make(ON, fetchImpl).ask("botDecide", STATE, QUESTIONS);
    expect(result).toMatchObject({ ok: true, provider: "gemini", model: GEMINI_DECIDER_MODEL, inputTokens: 123, answers: {
      choice: { choice: "b", pTop: 0.9 }, score: { level: 1 }, yes: { p: 0.9 },
    } });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(GEMINI_DECIDER_URL);
    expect(init).toMatchObject({ redirect: "error", headers: { "x-goog-api-key": KEY } });
    expect(JSON.parse(String(init!.body))).toEqual({ model: GEMINI_DECIDER_MODEL, input: JSON.stringify(STATE), questions: {
      choice: { type: "choice", instructions: "Who?", criteria: { a: "A", b: "B" } },
      score: { type: "score", instructions: "How urgent?", criteria: ["Low", "High"] },
      yes: { type: "noul", instructions: "Relevant?", criteria: { true_description: "In scope", false_description: "Out of scope" } },
    } });
  });

  it.each([
    [400, { error: { message: KEY, details: [{ reason: "API_KEY_INVALID" }] } }, "rejected"],
    [400, { error: { message: KEY } }, "http_error"],
    [403, { error: KEY }, "rejected"],
    [429, { error: KEY }, "rate_limited"],
  ])("maps HTTP %s without the body", async (status, body, reason) => {
    const result = await make(ON, vi.fn(async () => response(body, status))).testKey();
    expect(result).toMatchObject({ ok: false, provider: "gemini", reason, status });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it("refuses an answer that does not fit the question", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => response({ answers: { answer: { type: "choice", choice: "z", probabilities: { z: 1 } } } }));
    expect(await make(ON, fetchImpl).choose("roomRouting", STATE, QUESTIONS.choice)).toMatchObject({ ok: false, reason: "malformed" });
  });
});

describe("the saved Gemini key as the decision model's last fallback", () => {
  it("uses the speech key, else the image key, and only when nothing else decides", () => {
    expect(deciderAccount({ tts: { geminiKey: "speech" }, imageGen: { geminiKey: "image" } })).toMatchObject({ provider: "gemini", token: "speech" });
    expect(deciderAccount({ imageGen: { geminiKey: "image" } })).toMatchObject({ provider: "gemini", token: "image" });
    expect(deciderAccount({ ...ON, decider: { key: "jev-key" } })?.provider).toBe("jev");
    expect(deciderAccount({ ...ON, decider: { openrouterKey: "router-key" } })?.provider).toBe("openrouter");
    expect(deciderAccount({ ...ON, decider: { provider: "custom" } })).toBeNull();
    expect(deciderAccount({})).toBeNull();
  });

  it("never stands in for a set-up custom endpoint, whatever its protocol", () => {
    for (const customApi of ["systemone", "decisions", "chat"] as const) {
      const cfg: AppConfig = { ...ON, decider: { enabled: true, provider: "custom", customKey: "own", customBaseUrl: "https://decide.example.com/v1", customApi } };
      expect(deciderAccount(cfg)?.provider).toBe("custom");
      expect(describeDecider(cfg)).toMatchObject({ provider: "custom", api: customApi });
    }
  });

  it("keeps a picked OpenRouter as Settings' choice while only the Gemini key decides", () => {
    expect(describeDecider({ ...ON, decider: { enabled: true, provider: "openrouter" } })).toMatchObject({ provider: "gemini", chosen: "openrouter" });
    expect(describeDecider(ON)).not.toHaveProperty("chosen");
  });

  it("stays off until switched on, and never reports the key", () => {
    expect(describeDecider({ tts: { geminiKey: KEY } })).toMatchObject({ provider: "gemini", configured: true, enabled: false });
    expect(describeDecider(ON)).toMatchObject({ provider: "gemini", configured: true, enabled: true });
    expect(JSON.stringify(describeDecider(ON))).not.toContain(KEY);
  });

  it("lets the switch go on with only a Gemini key, and keeps it on when an own key is cleared", () => {
    expect(deciderBorrowedKey({ imageGen: { geminiKey: KEY } })).toBe(true);
    expect(deciderBorrowedKey({})).toBe(false);
    expect(deciderSavePatch({ enabled: true }, {}, { shared: true })).toMatchObject({ ok: true });
    expect(deciderSavePatch({ key: "" }, { key: "jev-key", enabled: true }, { shared: true })).toEqual({ ok: true, patch: { key: "" } });
  });

  it("calls nothing while the switch is off", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    expect(await make({ tts: { geminiKey: KEY } }, fetchImpl).yesNo("botDecide", STATE, "Relevant?")).toMatchObject({ ok: false, reason: "disabled" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
