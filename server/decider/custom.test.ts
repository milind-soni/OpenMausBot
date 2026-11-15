import { describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../config.ts";
import { createDecider, deciderAccount, deciderPatchKey, deciderSavePatch, describeDecider } from "./index.ts";

const KEY = "gw-unit-secret-key";
const BASE = "https://gateway.example.com/v1";
const MODEL = "decision-model-1";
const ON = (api: "systemone" | "decisions"): AppConfig => ({
  decider: { enabled: true, provider: "custom", customKey: KEY, customBaseUrl: BASE, customModel: MODEL, customApi: api },
});
const QUESTIONS = {
  wants_refund: { type: "yesno" as const, instructions: "Does the user want a refund?" },
  queue: { type: "choice" as const, instructions: "Which queue?", options: { billing: "Billing and refunds", technical: "Technical issues", other: "Other" } },
  urgency: { type: "score" as const, instructions: "Rate the urgency.", levels: ["Low", "Medium", "High"] },
};
const STATE = "My order arrived crushed. I want a refund, please handle it quickly.";

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The issue's sample `/decisions` response. */
const DECISIONS_ANSWERS = [
  { type: "predicate", name: "wants_refund", probability: 0.98 },
  {
    type: "choice", name: "queue", choice: "billing", confidence: 0.86,
    probabilities: [{ value: "billing", probability: 0.9 }, { value: "technical", probability: 0.03 }, { value: "other", probability: 0.07 }],
  },
  {
    type: "score", name: "urgency", score: 1.7, confidence: 0.7,
    probabilities: [{ label: "Low", value: 0, probability: 0.05 }, { label: "Medium", value: 1, probability: 0.2 }, { label: "High", value: 2, probability: 0.75 }],
  },
];

function run(config: AppConfig, response: Response) {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response);
  const decider = createDecider({ config: () => config, fetch: fetchImpl as unknown as typeof fetch });
  return { fetchImpl, result: decider.ask("botDecide", STATE, QUESTIONS) };
}

describe("a custom decision endpoint", () => {
  it("speaks System One: Jev's body with the configured model, at {base}/systemone", async () => {
    const { fetchImpl, result } = run(ON("systemone"), reply({
      model: MODEL,
      answers: {
        wants_refund: { type: "noul", noul: 0.98 },
        queue: { type: "choice", choice: "billing", probabilities: { billing: 0.9, technical: 0.03, other: 0.07 }, confidence: 0.86 },
        urgency: { type: "score", score: 1.7, probabilities: { 0: 0.05, 1: 0.2, 2: 0.75 } },
      },
      usage: { input_tokens: 120, output_tokens: 16 },
    }));
    expect(await result).toMatchObject({
      ok: true, provider: "custom", inputTokens: 120,
      answers: { wants_refund: { p: 0.98 }, queue: { choice: "billing", pTop: 0.9 }, urgency: { score: 1.7, level: 2 } },
    });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(`${BASE}/systemone`);
    expect(init).toMatchObject({ method: "POST", redirect: "error", headers: { authorization: `Bearer ${KEY}` } });
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ model: MODEL, state: STATE, questions: { wants_refund: { type: "noul" }, queue: { criteria: { billing: "Billing and refunds" } }, urgency: { criteria: ["Low", "Medium", "High"] } } });
  });

  it("speaks OpenAI Decisions: an ordered question list at {base}/decisions, answers read by position", async () => {
    const { fetchImpl, result } = run(ON("decisions"), reply({ model: MODEL, answers: DECISIONS_ANSWERS, usage: { input_tokens: 120, output_tokens: 16, total_tokens: 136 } }));
    expect(await result).toMatchObject({
      ok: true, provider: "custom", inputTokens: 120,
      answers: { wants_refund: { type: "yesno", p: 0.98 }, queue: { choice: "billing", pTop: 0.9 }, urgency: { score: 1.7, level: 2, probabilities: [0.05, 0.2, 0.75] } },
    });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(`${BASE}/decisions`);
    expect(JSON.parse(String(init?.body))).toEqual({
      model: MODEL,
      input: STATE,
      stream: false,
      questions: [
        { type: "predicate", name: "wants_refund", instructions: "Does the user want a refund?" },
        {
          type: "choice", name: "queue", instructions: "Which queue?",
          choices: [{ value: "billing", description: "Billing and refunds" }, { value: "technical", description: "Technical issues" }, { value: "other", description: "Other" }],
        },
        { type: "score", name: "urgency", instructions: "Rate the urgency.", levels: ["Low", "Medium", "High"].map((label) => ({ label, description: label })) },
      ],
    });
  });

  it("refuses /decisions answers out of order or short", async () => {
    const swapped = [DECISIONS_ANSWERS[1], DECISIONS_ANSWERS[0], DECISIONS_ANSWERS[2]];
    expect(await run(ON("decisions"), reply({ answers: swapped })).result).toMatchObject({ ok: false, reason: "malformed" });
    expect(await run(ON("decisions"), reply({ answers: DECISIONS_ANSWERS.slice(0, 2) })).result).toMatchObject({ ok: false, reason: "malformed" });
  });

  it("maps a refused key to rejected and never sends a key over plain http elsewhere", async () => {
    expect(await run(ON("systemone"), reply({ error: { message: "no", type: "invalid_request_error" } }, 401)).result)
      .toMatchObject({ ok: false, reason: "rejected", status: 401 });
    const plain: AppConfig = { decider: { ...ON("systemone").decider, customBaseUrl: "http://gateway.example.com/v1" } };
    expect(deciderAccount(plain)).toBeNull();
    const local: AppConfig = { decider: { ...ON("systemone").decider, customBaseUrl: "http://127.0.0.1:8080/v1" } };
    expect(deciderAccount(local)).toMatchObject({ provider: "custom", api: "http://127.0.0.1:8080/v1" });
  });

  it("decides only while it is the chosen provider, and Settings sees its model, protocol and address but not the key", () => {
    const both: AppConfig = { decider: { ...ON("decisions").decider, key: "jev-key" } };
    expect(deciderAccount(both)?.provider).toBe("custom");
    const described = describeDecider(both);
    expect(described).toMatchObject({ provider: "custom", model: MODEL, api: "decisions", baseUrl: BASE, configured: true });
    expect(JSON.stringify(described)).not.toContain(KEY);
    const backToJev: AppConfig = { decider: { ...both.decider, provider: "jev" } };
    expect(deciderAccount(backToJev)?.provider).toBe("jev");
    expect(describeDecider(backToJev).provider).toBe("jev");
  });

  it("stays chosen while it is being set up, even with another key saved, and lends that key nothing", () => {
    const settingUp: AppConfig = { decider: { enabled: true, provider: "custom", key: "jev-key" } };
    expect(deciderAccount(settingUp)).toBeNull();
    expect(describeDecider(settingUp)).toMatchObject({ provider: "custom", configured: false, model: "", baseUrl: "" });
  });

  it("tests a saved key before keeping it, and needs a usable base URL with it", () => {
    expect(deciderPatchKey({ customKey: "new" }, ON("decisions").decider)).toEqual({
      provider: "custom", check: { key: "new", provider: "custom", api: "decisions", model: MODEL },
    });
    expect(deciderSavePatch({ customKey: "new" }, { customBaseUrl: BASE })).toMatchObject({ ok: true, patch: { enabled: true } });
    expect(deciderSavePatch({ customKey: "new" }, {})).toMatchObject({ ok: false, errorKey: "serverError.decider.baseUrlRequired" });
    expect(deciderSavePatch({ customKey: "" }, ON("systemone").decider)).toMatchObject({ ok: true, patch: { enabled: false } });
  });
});
