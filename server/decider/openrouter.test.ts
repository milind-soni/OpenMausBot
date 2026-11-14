import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../config.ts";
import { createDecider } from "./index.ts";
import { OPENROUTER_DEFAULT_MODEL, openrouterEndpoint, openrouterRequestBody } from "./openrouter.ts";

const KEY = "sk-or-v1-unit-secret-key-0123456789abcdef";
const CHAT_MODEL = "openai/gpt-4.1-nano";
// A chat model, so most of this file exercises chat completions; the default model is a decisions one.
const ON: AppConfig = { decider: { enabled: true, provider: "openrouter", openrouterKey: KEY, openrouterModel: CHAT_MODEL, openrouterApi: "chat", jobs: { roomRouting: true } } };
const NO_MODEL: AppConfig = { decider: { enabled: true, provider: "openrouter", openrouterKey: KEY, jobs: { roomRouting: true } } };
const OPTIONS = { maya: "Maya, Product Designer bot.", theo: "Theo, Frontend Engineer bot." };
const QUESTION = { instructions: "Which bot should answer `new_message`?", options: OPTIONS };
const STATE = { new_message: { from: "Milind", text: "PRIVATE-MESSAGE-TEXT the navbar overlaps on Safari" } };

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

/** What OpenRouter returns: the model's JSON is a string in choices[0].message.content. */
function completion(answers: unknown, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({
    model: "openai/gpt-4.1-nano-2025-04-14",
    choices: [{ message: { role: "assistant", content: typeof answers === "string" ? answers : JSON.stringify(answers) } }],
    usage: { prompt_tokens: 431, completion_tokens: 24 },
    ...extra,
  }), { status: 200, headers: { "content-type": "application/json" } });
}
const choiceAnswers = (choice: string, probabilities: Record<string, number>) => ({ answers: { answer: { choice, probabilities } } });

function decider(config: AppConfig, fetchImpl: FetchMock) {
  return createDecider({ config: () => config, fetch: fetchImpl as unknown as typeof fetch });
}

afterEach(() => vi.restoreAllMocks());

describe("the OpenRouter request on the wire", () => {
  it("POSTs strict JSON-schema chat completions with the key, the model and no reasoning", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(completion(choiceAnswers("theo", { theo: 0.97, maya: 0.03 })));
    const result = await decider({ decider: { ...ON.decider, openrouterModel: "meta-llama/llama-3.3-70b-instruct" } }, fetchImpl)
      .choose("roomRouting", STATE, QUESTION);
    expect(result).toMatchObject({ ok: true, provider: "openrouter", inputTokens: 431, model: "openai/gpt-4.1-nano-2025-04-14" });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("error");
    expect(init?.headers).toMatchObject({ authorization: `Bearer ${KEY}`, "content-type": "application/json" });
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      model: "meta-llama/llama-3.3-70b-instruct",
      temperature: 0,
      provider: { require_parameters: true },
      response_format: { type: "json_schema", json_schema: { name: "decision", strict: true } },
    });
    expect(body).not.toHaveProperty("reasoning");
    const answer = body.response_format.json_schema.schema.properties.answers.properties.answer;
    expect(answer.properties.choice.enum).toEqual(["maya", "theo"]);
    expect(answer.required).toEqual(["choice", "probabilities"]);
    expect(answer.properties.probabilities).toMatchObject({ required: ["maya", "theo"], additionalProperties: false });
    const [system, user] = body.messages;
    expect(system.role).toBe("system");
    expect(system.content).not.toContain("PRIVATE-MESSAGE-TEXT");
    expect(JSON.parse(user.content)).toEqual({
      state: STATE,
      questions: { answer: { type: "choice", instructions: QUESTION.instructions, criteria: OPTIONS } },
    });
  });

  it("sends a decisions model to the Decisions API in Jev's shape and reads Jev's answers", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      answers: { answer: { type: "choice", choice: "theo", confidence: 0.9, probabilities: { maya: 0.16, theo: 0.84 } } },
      id: "gen-dec-1", model: "typesafe/jev-1.13-20260917", provider: "TypeSafe", usage: { input_tokens: 476, output_tokens: 70 },
    }), { status: 200 }));
    const config: AppConfig = { decider: { ...ON.decider, openrouterModel: "typesafe/jev-1.13", openrouterApi: "decisions" } };
    const result = await decider(config, fetchImpl).choose("roomRouting", STATE, QUESTION);
    expect(result).toMatchObject({ ok: true, provider: "openrouter", inputTokens: 476, model: "typesafe/jev-1.13-20260917" });
    if (result.ok) expect(result.answers).toMatchObject({ choice: "theo", pTop: 0.84 });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://openrouter.ai/api/alpha/decisions");
    expect(init?.headers).toMatchObject({ authorization: `Bearer ${KEY}` });
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "typesafe/jev-1.13",
      state: STATE,
      questions: { answer: { type: "choice", instructions: QUESTION.instructions, criteria: OPTIONS } },
    });
  });

  it("a saved model's own API wins over a stale one, and a malformed Decisions answer → malformed", async () => {
    const chat = vi.fn<typeof fetch>().mockResolvedValue(completion(choiceAnswers("theo", { theo: 0.97, maya: 0.03 })));
    await decider({ decider: { ...ON.decider, openrouterApi: undefined } }, chat).choose("roomRouting", STATE, QUESTION);
    expect(String(chat.mock.calls[0]![0])).toBe("https://openrouter.ai/api/v1/chat/completions");
    const bad = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ answers: { answer: { type: "choice", choice: "ghost", probabilities: {} } } }), { status: 200 }));
    const config: AppConfig = { decider: { ...ON.decider, openrouterModel: "typesafe/jev-1.13", openrouterApi: "decisions" } };
    expect(await decider(config, bad).choose("roomRouting", STATE, QUESTION)).toMatchObject({ ok: false, reason: "malformed" });
  });

  it("asks the default model, through the Decisions API, when none is saved", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      answers: { answer: { type: "choice", choice: "theo", probabilities: { maya: 0.1, theo: 0.9 } } }, model: OPENROUTER_DEFAULT_MODEL, usage: { input_tokens: 9, output_tokens: 1 },
    }), { status: 200 }));
    await expect(decider(NO_MODEL, fetchImpl).choose("roomRouting", STATE, QUESTION)).resolves.toMatchObject({ ok: true });
    expect(String(fetchImpl.mock.calls[0]![0])).toBe("https://openrouter.ai/api/alpha/decisions");
    expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body)).model).toBe("typesafe/jev-1.13");
    expect(OPENROUTER_DEFAULT_MODEL).toBe("typesafe/jev-1.13");
  });

  it("builds the schema for yes/no and score questions, and scales max_tokens with the options", () => {
    const body = openrouterRequestBody(STATE, {
      urgent: { type: "yesno", instructions: "Urgent?" },
      hard: { type: "score", instructions: "How hard?", levels: ["easy", "medium", "hard"] },
    }, "m/x");
    const answers = body.response_format.json_schema.schema as { properties: { answers: { properties: Record<string, unknown> } } };
    expect(answers.properties.answers.properties.urgent).toMatchObject({ required: ["noul"], properties: { noul: { type: "number" } } });
    expect(answers.properties.answers.properties.hard).toMatchObject({ required: ["score", "probabilities"] });
    expect((answers.properties.answers.properties.hard as { properties: { probabilities: { required: string[] } } }).properties.probabilities.required).toEqual(["0", "1", "2"]);
    expect(body.max_tokens).toBe(96 + 24 * 4);
    const many = Object.fromEntries(Array.from({ length: 255 }, (_, i) => [`o${i}`, "x"]));
    expect(openrouterRequestBody(STATE, { answer: { type: "choice", instructions: "?", options: many } }, "m/x").max_tokens).toBe(2_048);
  });

  it("leaves room for long option keys, which a reply spells twice", () => {
    const id = "6f1c2a9e-3b7d-4e58-9a10-2c4d5e6f7a8b";
    const options = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`${id.slice(0, -1)}${i}`, "a bot"]));
    const tokens = openrouterRequestBody(STATE, { answer: { type: "choice", instructions: "?", options } }, "m/x").max_tokens;
    expect(tokens).toBeGreaterThanOrEqual(96 + 24 * 5 + 5 * id.length);
    expect(tokens).toBeGreaterThan(5 * 2 * 25 + 100);
  });

  it("decodes yes/no and score answers", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(completion({ answers: { answer: { noul: 0.81 } } }))
      .mockResolvedValueOnce(completion({ answers: { answer: { score: 1.2, probabilities: { 0: 0.1, 1: 0.6, 2: 0.3 } } } }));
    const d = decider(ON, fetchImpl);
    await expect(d.yesNo("roomRouting", STATE, "Is this about the navbar?")).resolves.toMatchObject({ ok: true, answers: { type: "yesno", p: 0.81 } });
    await expect(d.score("roomRouting", STATE, { instructions: "How hard?", levels: ["easy", "medium", "hard"] }))
      .resolves.toMatchObject({ ok: true, answers: { type: "score", score: 1.2, level: 1 } });
  });

  it("uses a configured base URL: https anywhere, http only on this machine", async () => {
    expect(String(openrouterEndpoint("https://gateway.example.com/api/v1/"))).toBe("https://gateway.example.com/api/v1/chat/completions");
    expect(String(openrouterEndpoint("http://127.0.0.1:9911/v1"))).toBe("http://127.0.0.1:9911/v1/chat/completions");
    expect(String(openrouterEndpoint(undefined, "models"))).toBe("https://openrouter.ai/api/v1/models");
    expect(openrouterEndpoint("http://gateway.example.com")).toBeNull();
    expect(openrouterEndpoint("https://user:pw@gateway.example.com")).toBeNull();
    const fetchImpl = vi.fn<typeof fetch>();
    const remote = { decider: { ...ON.decider, openrouterBaseUrl: "http://gateway.example.com" } };
    await expect(decider(remote, fetchImpl).choose("roomRouting", STATE, QUESTION)).resolves.toMatchObject({ ok: false, reason: "misconfigured" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("OpenRouter answers are validated like Jev's", () => {
  it.each([
    ["a choice that was never offered", choiceAnswers("quinn", { quinn: 1 })],
    ["a probability for an option that was never offered", choiceAnswers("theo", { theo: 0.9, quinn: 0.1 })],
    ["a probability that is not a number", choiceAnswers("theo", { theo: "0.9" as unknown as number, maya: 0.1 })],
    ["a choice that is not the most likely option", choiceAnswers("maya", { maya: 0.2, theo: 0.8 })],
    ["probabilities that do not add up", choiceAnswers("theo", { theo: 0.3, maya: 0.2 })],
    ["no answer for the question", { answers: {} }],
    ["JSON that is not an object", "[1, 2]"],
    ["content that is not JSON", "Sure! The answer is theo."],
  ])("%s → malformed", async (_name, content) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(completion(content));
    await expect(decider(ON, fetchImpl).choose("roomRouting", STATE, QUESTION)).resolves.toMatchObject({ ok: false, reason: "malformed" });
  });

  it.each([
    ["a 200 that carries an error", { error: { code: 502, message: "upstream failed" } }],
    ["no choices", { choices: [] }],
    ["a message with no content", { choices: [{ message: { role: "assistant" } }] }],
    ["content that is not text", { choices: [{ message: { content: { answers: {} } } }] }],
  ])("%s → malformed", async (_name, body) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    await expect(decider(ON, fetchImpl).choose("roomRouting", STATE, QUESTION)).resolves.toMatchObject({ ok: false, reason: "malformed" });
  });

  it("a body that is not JSON → malformed", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("<html>gateway</html>", { status: 200 }));
    await expect(decider(ON, fetchImpl).choose("roomRouting", STATE, QUESTION)).resolves.toMatchObject({ ok: false, reason: "malformed" });
  });

  it("never takes tokens or a model name from the model's own JSON", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(completion(
      { ...choiceAnswers("theo", { theo: 0.9, maya: 0.1 }), model: "attacker", usage: { input_tokens: 1 } },
      { model: undefined, usage: undefined },
    ));
    const result = await decider(ON, fetchImpl).choose("roomRouting", STATE, QUESTION);
    expect(result.ok).toBe(true);
    expect(result).not.toHaveProperty("model");
    expect(result).not.toHaveProperty("inputTokens");
  });
});

describe("OpenRouter failures come back as reasons", () => {
  it.each([
    [401, "rejected"],
    [403, "rejected"],
    [402, "http_error"],
    [429, "rate_limited"],
    [500, "http_error"],
    [503, "overloaded"],
    [529, "overloaded"],
  ])("HTTP %i → %s", async (status, reason) => {
    // an error body that echoes the key must never surface anywhere
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(`bad key ${KEY}`, { status }));
    const result = await decider(ON, fetchImpl).choose("roomRouting", STATE, QUESTION);
    expect(result).toMatchObject({ ok: false, provider: "openrouter", reason, status });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it("a network failure → unreachable, and a slow answer → timeout within the budget", async () => {
    const dead = vi.fn<typeof fetch>().mockRejectedValue(new TypeError(`fetch failed for ${KEY}`));
    const unreachable = await decider(ON, dead).choose("roomRouting", STATE, QUESTION);
    expect(unreachable).toMatchObject({ ok: false, reason: "unreachable" });
    expect(JSON.stringify(unreachable)).not.toContain(KEY);

    const stalled = { ok: true, status: 200, json: () => new Promise(() => undefined), body: null } as unknown as Response;
    const slow = vi.fn<typeof fetch>().mockResolvedValue(stalled);
    const started = Date.now();
    await expect(decider(ON, slow).choose("roomRouting", STATE, QUESTION, { timeoutMs: 80 })).resolves.toMatchObject({ ok: false, reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
