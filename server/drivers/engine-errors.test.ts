import { describe, expect, it } from "vitest";

import { engineFailure, engineFailureKind, engineFailureMessage, errorReplyFailure, httpStatusOf, plainFailureMessage, providerReason, stopCause } from "./engine-errors.ts";
import { classifyError } from "./retry.ts";

const reason = (text: string) => classifyError({ text }).reason;

/** Grok Build's refusal as ACP relays it: acpRpcError puts "Internal error" before Grok's own line and the method after. */
const grok = (status: string, said = "") => `Internal error: API error (status ${status})${said ? `: ${said}` : ""} (session/prompt)`;

describe("engineFailureMessage", () => {
  it("names a Grok account out of credits, keeping Grok's own short reason", () => {
    // the Cloud routine runs' error, as far as it was kept
    expect(engineFailureMessage("Grok", grok("402 Payment Required", "Grok Build us…")))
      .toBe('Your Grok account is out of credits (Grok says: "Grok Build us…"). Add credits with Grok, then run it again.');
    expect(engineFailureMessage("Grok", "Internal error: API error (status 402 Payment Required) (session/prompt, service: session, APIError)"))
      .toBe("Your Grok account is out of credits. Add credits with Grok, then run it again.");
  });

  it("names any other provider out of credits the same way, by status or by its words", () => {
    expect(engineFailureMessage("Cursor", "Internal error: API error (status 402 Payment Required): Your team has no credits left. Ask an admin to add more. (session/prompt)"))
      .toBe('Your Cursor account is out of credits (Cursor says: "Your team has no credits left"). Add credits with Cursor, then run it again.');
    expect(engineFailureMessage("Gemini", "Internal error: insufficient credits for this request"))
      .toBe('Your Gemini account is out of credits (Gemini says: "insufficient credits for this request"). Add credits with Gemini, then run it again.');
    expect(plainFailureMessage("MiniMax", "provider returned a completion error: upstream error 1008: insufficient balance"))
      .toBe('Your MiniMax account is out of credits (MiniMax says: "upstream error 1008: insufficient balance"). Add credits with MiniMax, then run it again.');
  });

  it("keeps each failure's class, so retries, account switching and health codes read it as before", () => {
    const cases: Array<[string, string, string, boolean]> = [
      [grok("402 Payment Required", "Grok Build us…"), "Your Grok account is out of credits", "quota", false],
      [grok("429 Too Many Requests", "You've reached your free Grok Build usage limit for now. Get SuperGrok for much higher limits"),
        'This Grok account has reached its usage limit (Grok says: "You\'ve reached your free Grok Build usage limit for now"). Wait for it to reset', "quota", false],
      [grok("429 Too Many Requests", "slow down please"), 'Grok hit a rate limit (HTTP 429; Grok says: "slow down please"). Wait a minute', "rate_limited", true],
      [grok("529 Overloaded"), "Grok is overloaded right now (HTTP 529). This is usually temporary", "overloaded", true],
      [grok("503 Service Unavailable", "upstream connect error"), 'Grok had a temporary server problem (HTTP 503; Grok says: "upstream connect error")', "server_error", true],
      [grok("401 Unauthorized", "token expired"), 'Grok stopped with an error (HTTP 401; Grok says: "token expired").', "auth", false],
      [grok("400 Bad Request", "unknown field"), 'Grok stopped with an error (HTTP 400; Grok says: "unknown field").', "invalid_request", false],
    ];
    for (const [raw, words, kind, transient] of cases) {
      const message = engineFailureMessage("Grok", raw)!;
      expect(message, raw).toContain(words);
      expect(message, raw).not.toMatch(/Internal error|API error \(status|session\/prompt/);
      expect(classifyError({ text: message }), message).toEqual({ transient, reason: kind });
      expect(classifyError({ text: raw }).reason, raw).toBe(kind);
    }
  });

  it("leaves a failure it does not know to the caller, whose text stays as it was", () => {
    expect(engineFailureMessage("Grok", "Internal error: could not change mode")).toBeNull();
    expect(engineFailureMessage("Grok", "Grok could not confirm its MCP catalog in time. No prompt was sent.")).toBeNull();
    expect(plainFailureMessage("xAI", "xAI HTTP 401: Incorrect API key provided (invalid_api_key)")).toBe("xAI HTTP 401: Incorrect API key provided (invalid_api_key)");
    expect(engineFailureKind("Stopped after 64 steps without a final answer.")).toBeNull();
  });
});

describe("providerReason", () => {
  it("keeps the provider's first sentence and drops wrappers, raw bodies, bare status phrases and secrets", () => {
    expect(providerReason("xAI HTTP 402: Your team has used all available credits. To continue, purchase more credits.")).toBe("Your team has used all available credits");
    expect(providerReason('API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}')).toBeNull();
    expect(providerReason('API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long"}}')).toBe("prompt is too long");
    expect(providerReason(grok("402 Payment Required", "<html><body>Payment Required</body></html>"))).toBeNull();
    expect(providerReason(grok("402 Payment Required", "Payment Required"))).toBeNull();
    expect(providerReason(grok("402 Payment Required", 'no credits for key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 "now"'))).not.toMatch(/abcdefghijklmnop|"/);
    const long = providerReason(grok("402 Payment Required", "credit ".repeat(80)))!;
    expect(long.length).toBeLessThanOrEqual(160);
    expect(long.endsWith("credit…")).toBe(true);
    expect(providerReason(grok("402 Payment Required", "x".repeat(400)))).toBeNull();
  });

  it("reads the status from Grok Build's, the chat drivers' and Claude Code's lines", () => {
    expect(httpStatusOf(grok("402 Payment Required"))).toBe(402);
    expect(httpStatusOf("Mistral HTTP 503: unavailable")).toBe(503);
    expect(httpStatusOf("API Error: 529 Overloaded")).toBe(529);
    expect(httpStatusOf("returned HTTP 200 with no body")).toBeNull();
    expect(httpStatusOf("the routine ran 402 times")).toBeNull();
  });
});

describe("a provider refusing a tool's schema", () => {
  /** Kimi Code's prompt failure as acpRpcError relays it; Moonshot's line is quoted in https://github.com/MoonshotAI/kimi-code/issues/4231. */
  const KIMI = "Internal error: 400 tools.function.parameters is not a valid moonshot flavored json schema, details: <At path 'root': schema exceeds maximum allowed size> (session/prompt)";

  it("says in plain words that a tool was too large, keeping the words that class it an invalid request", () => {
    const plain = engineFailureMessage("Kimi", KIMI);
    expect(plain).toBe("Kimi refused this turn as an invalid request because the input schema of one of this bot's tools is too large, so nothing ran. "
      + "Turn off the MCP server or app that tool comes from for this bot, or switch the bot to another AI.");
    expect(engineFailureKind(KIMI)).toBe("tool_schema");
    expect([reason(KIMI), reason(plain!)]).toEqual(["invalid_request", "invalid_request"]);
    expect(classifyError({ text: plain! }).transient).toBe(false);
  });

  it("names the tool when the provider does", () => {
    expect(engineFailureMessage("OpenAI", "OpenAI HTTP 400: Invalid schema for function 'computer_browser_prepare': schema must be a JSON Schema of 'type: \"object\"', got 'type: \"None\"'."))
      .toBe('OpenAI refused this turn as an invalid request because the input schema of the "computer_browser_prepare" tool uses a form OpenAI does not accept, so nothing ran. '
        + "Turn off the MCP server or app that tool comes from for this bot, or switch the bot to another AI.");
    expect(engineFailureKind("API Error: 400 tools.12.custom.input_schema: JSON schema is invalid")).toBe("tool_schema");
    expect(engineFailureKind("Invalid JSON payload received. Unknown name \"additionalProperties\" at 'tools[0].function_declarations[3].parameters'")).toBe("tool_schema");
  });

  it("is in plain words on the chat runtime too, where any other failure keeps its text", () => {
    expect(plainFailureMessage("Kimi", KIMI)).toBe(engineFailureMessage("Kimi", KIMI));
    expect(plainFailureMessage("Groq", "Groq HTTP 400: model_decommissioned")).toBe("Groq HTTP 400: model_decommissioned");
    expect(engineFailureKind("Mistral HTTP 400: Invalid model: kimi")).toBe("refused");
  });
});

describe("errorReplyFailure", () => {
  const NOW = Date.parse("2026-10-27T06:12:46Z");
  const anthropic = (status: number, type: string, message: string) =>
    `${status} {"type":"error","error":{"type":"${type}","message":"${message}"},"request_id":"req_011CgY35mSFzqEa1NBU5nq8i"}`;

  it("names a usage limit and its reset from a 429's retry-after, in the zone given", () => {
    const reply = `${anthropic(429, "rate_limit_error", "[1308][Usage limit reached for 5 hour. Your limit will reset at 2026-10-27 15:22:19][2026]")} retry-after-ms=4171000`;
    expect(errorReplyFailure("omp", reply, NOW, "UTC")).toEqual({
      message: 'This omp account has reached its usage limit (omp says: "[1308][Usage limit reached for 5 hour"), which resets Oct 27, 7:22 AM (UTC). Until then, switch this bot to another AI.',
      text: { key: "chat.notice.usageLimitResets", params: {
        provider: "omp", detail: ' (omp says: "[1308][Usage limit reached for 5 hour")',
        resetsAt: NOW + 4_171_000, timeZone: "UTC", resets: "Oct 27, 7:22 AM (UTC)",
      } },
      stopReason: "quota",
      limit: "engine",
      limitResetsAt: NOW + 4_171_000,
    });
  });

  it("reads a 429 without a wait by its words, and an OpenAI-style body too", () => {
    const limit = errorReplyFailure("omp", anthropic(429, "rate_limit_error", "You've reached your 5-hour usage limit."), NOW);
    expect(limit).toMatchObject({ stopReason: "quota", limit: "engine" });
    expect(limit).not.toHaveProperty("limitResetsAt");
    expect(errorReplyFailure("omp", '429 {"error":{"message":"Rate limit reached for requests","type":"requests","code":"rate_limit_exceeded"}}'))
      .toEqual({ message: 'omp hit a rate limit (HTTP 429; omp says: "Rate limit reached for requests"). Wait a minute, then run it again.', stopReason: "rpc_error" });
    expect(errorReplyFailure("omp", '  529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n'))
      .toEqual({ message: "omp is overloaded right now (HTTP 529). This is usually temporary, so try again in a few minutes.", stopReason: "rpc_error" });
  });

  it("keeps a 429 whose wait an engine retries on its own a rate limit, and reads a longer one as a usage limit", () => {
    const perMinute = anthropic(429, "rate_limit_error", "This request would exceed your organization's rate limit of 30,000 input tokens per minute.");
    const rateLimit = { message: `omp hit a rate limit (HTTP 429; omp says: "This request would exceed your organization's rate limit of 30,000 input tokens per minute"). Wait a minute, then run it again.`, stopReason: "rpc_error" };
    expect(errorReplyFailure("omp", `${perMinute} retry-after-ms=20000`, NOW)).toEqual(rateLimit);
    expect(errorReplyFailure("omp", `${perMinute} retry-after-ms=120000`, NOW)).toEqual(rateLimit);
    expect(errorReplyFailure("omp", `${perMinute} retry-after-ms=120001`, NOW)).toMatchObject({ stopReason: "quota", limit: "engine", limitResetsAt: NOW + 120_001 });
  });

  it("never reads another status's wait as a usage limit", () => {
    expect(errorReplyFailure("omp", `${anthropic(529, "overloaded_error", "Overloaded")} retry-after-ms=300000`, NOW))
      .toEqual({ message: "omp is overloaded right now (HTTP 529). This is usually temporary, so try again in a few minutes.", stopReason: "rpc_error" });
  });

  it("asks for the person's setup on an account out of credits, as the same failure thrown does, whatever its wait", () => {
    const outOfCredits = {
      message: 'Your omp account is out of credits (omp says: "Your credit balance is too low to access the Anthropic API"). Add credits with omp, then run it again.',
      stopReason: "auth_required",
      setup: true,
    };
    expect(errorReplyFailure("omp", anthropic(402, "billing_error", "Your credit balance is too low to access the Anthropic API."), NOW)).toEqual(outOfCredits);
    expect(errorReplyFailure("omp", `${anthropic(429, "billing_error", "Your credit balance is too low to access the Anthropic API.")} retry-after-ms=300000`, NOW))
      .toEqual(outOfCredits);
  });

  it("leaves any other text a reply: an error quoted in words, a success status, a body that is no error", () => {
    for (const text of [
      `Here is what came back: ${anthropic(403, "permission_error", "OAuth authentication is currently not allowed for this organization.")}`,
      `${anthropic(403, "permission_error", "refused")} and then I stopped`,
      '200 {"type":"error","error":{"type":"x","message":"y"}}',
      '403 {"type":"message","content":[]}',
      '403 {"error":"refused"}',
      "403 {not json}",
      `${anthropic(429, "rate_limit_error", "slow down")} retry-after-ms=soon`,
    ]) expect(errorReplyFailure("omp", text), text).toBeNull();
  });
});

describe("stopCause", () => {
  it("never lets a bare stop token stand alone as the cause, and keeps the token so its class still reads", () => {
    for (const token of ["stop_sequence", "api_error", "rpc_error", "error"]) {
      expect(stopCause(token)).toBe(`The engine stopped without saying why (stop reason: ${token}).`);
    }
    expect(reason(stopCause("quota")!)).toBe("quota");
    expect(stopCause("provider crashed")).toBe("provider crashed");
    expect(stopCause("  ")).toBeUndefined();
    expect(stopCause(null)).toBeUndefined();
  });

  it("says in plain words what an ACP stop reason that names its cause means, with the advice that fits it", () => {
    // no cause carries another reason's actions whole: the advice is per reason, not one shared line
    const advice: Record<string, RegExp[]> = {
      refusal: [/again|retry/, /reword/, /switch/],
      max_tokens: [/continue/, /shorter/],
      max_turn_requests: [/carry on/, /split/],
    };
    for (const [token, own] of Object.entries(advice)) {
      const cause = stopCause(token)!;
      expect(cause, token).toContain(`(stop reason: ${token})`);
      for (const action of own) expect(cause, `${token} advises ${action}`).toMatch(action);
      for (const [other, others] of Object.entries(advice)) {
        if (other === token) continue;
        expect(others.some((action) => !action.test(cause)), `${token} does not read as ${other}`).toBe(true);
      }
    }
    for (const token of ["refusal", "max_tokens", "max_turn_requests"]) {
      const cause = stopCause(token)!;
      expect(classifyError({ text: cause })).toEqual({ transient: false, reason: "unknown" });
      expect(engineFailureKind(cause)).toBeNull();
    }
    expect(stopCause("constructor")).toBe("The engine stopped without saying why (stop reason: constructor).");
  });

  it("names the AI when the caller knows it, and still classifies like the bare token", () => {
    expect(stopCause("refusal")).toMatch(/^The AI refused\b/);
    expect(stopCause("refusal", "Gemini")).toMatch(/^Gemini refused to go on with this request \(stop reason: refusal\)\./);
    expect(stopCause("max_tokens", "OpenCode")).toMatch(/^OpenCode's reply reached its maximum length/);
    expect(stopCause("refusal", "  ")).toMatch(/^The AI refused\b/);
    for (const provider of ["Gemini", "Qwen", "OpenCode", "Cursor", "Grok", "DeepSeek", "Cline"]) {
      for (const token of ["refusal", "max_tokens", "max_turn_requests"]) {
        const cause = stopCause(token, provider)!;
        expect(classifyError({ text: cause })).toEqual({ transient: false, reason: "unknown" });
        expect(engineFailureKind(cause)).toBeNull();
      }
    }
  });
});

describe("engineFailure", () => {
  it("carries the reset instant and zone for the reader's language, with the same English fallback", () => {
    const resetsAt = Date.UTC(2026, 9, 27, 7, 22);
    const failure = engineFailure("Grok", "usage limit", { resetsAt, timeZone: "UTC" })!;
    expect(failure.message).toBe('This Grok account has reached its usage limit (Grok says: "usage limit"), which resets Oct 27, 7:22 AM (UTC). Until then, switch this bot to another AI.');
    expect(failure.text).toEqual({ key: "chat.notice.usageLimitResets", params: {
      provider: "Grok", detail: ' (Grok says: "usage limit")', resetsAt, timeZone: "UTC", resets: "Oct 27, 7:22 AM (UTC)",
    } });
    const unknownZone = engineFailure("Grok", "usage limit", { resetsAt, timeZone: "not-a-zone" })!;
    expect(unknownZone.message).toContain("2026-10-27 07:22 UTC");
    expect(unknownZone.text?.params).toMatchObject({ resetsAt, timeZone: "UTC" });
    expect(classifyError({ text: failure.message })).toEqual({ transient: false, reason: "quota" });
  });

  it("names a usage limit by its catalog key, its provider's quoted words kept raw", () => {
    const failure = engineFailure("Grok", "Internal error: API error (status 429): You have reached your usage limit for this month (session/prompt)", { kind: "usage_limit" });
    expect(failure?.text?.key).toBe("chat.notice.usageLimit");
    expect(failure?.message).toBe(engineFailureMessage("Grok", "Internal error: API error (status 429): You have reached your usage limit for this month (session/prompt)", { kind: "usage_limit" }));
    expect(failure?.text?.params).toEqual({ provider: "Grok", detail: expect.stringMatching(/^ \(Grok says: ".+"\)$/) });
    expect(engineFailure("Grok", "429 Too Many Requests", { kind: "rate_limit" })).toEqual({ message: expect.stringContaining("rate limit") });
  });
});

describe("a model the engine has no route to", () => {
  // OpenCode 2.2.5's session/prompt answer for a model declared under a provider it has no SDK package for, as acpRpcError words it.
  const raw = (model: string, pkg = "unknown") => `Internal error: Unsupported package for ${model}: ${pkg} (session/prompt, service: session, provider.no-route)`;

  it("says in one plain sentence that the named model can't be used here, with no Internal error", () => {
    const failure = engineFailure("OpenCode", raw("chutes/deepseek-ai/DeepSeek-V4.1-Flash-1017"))!;
    expect(failure.message).toBe("OpenCode can't use the model chutes/deepseek-ai/DeepSeek-V4.1-Flash-1017 here, so choose another model for this bot.");
    expect(failure.text).toEqual({ key: "chat.notice.modelNoRoute", params: { provider: "OpenCode", model: "chutes/deepseek-ai/DeepSeek-V4.1-Flash-1017" } });
    expect(engineFailureMessage("OpenCode", raw("ollama-cloud/deepseek-v4.1-flash:1017", ""))).toBe("OpenCode can't use the model ollama-cloud/deepseek-v4.1-flash:1017 here, so choose another model for this bot.");
    expect(engineFailureMessage("OpenCode", "Internal error: Model unavailable: test/missing (session/prompt, service: session, provider.no-route)"))
      .toBe("OpenCode can't use the model test/missing here, so choose another model for this bot.");
    expect(engineFailure("OpenCode", "Internal error (session/prompt, service: session, provider.no-route)")).toEqual({
      message: "OpenCode can't use this bot's model here, so choose another model for this bot.",
      text: { key: "chat.notice.modelNoRouteUnnamed", params: { provider: "OpenCode" } },
    });
  });

  it("is a final failure, raw or in plain words, and no other failure is", () => {
    const plain = engineFailureMessage("OpenCode", raw("chutes/deepseek-ai/DeepSeek-V4.1-Flash-1017"))!;
    for (const text of [raw("chutes/deepseek-ai/DeepSeek-V4.1-Flash-1017"), plain, engineFailureMessage("OpenCode", "provider.no-route")!]) {
      expect(classifyError({ text })).toEqual({ transient: false, reason: "unknown_model" });
    }
    expect(engineFailureKind(raw("x/y"))).toBe("model_no_route");
    expect(engineFailureKind("Internal error: Cannot connect to API: ECONNREFUSED (session/prompt, service: session, APIError)")).toBeNull();
    expect(classifyError({ text: "Internal error: OpenCode service failure (session/prompt)" }).reason).toBe("unknown");
  });
});

describe("classifyError reads an explicit HTTP status before body text", () => {
  it.each([
    ["OpenAI HTTP 409: max 500 tokens", { transient: false, reason: "invalid_request" }],
    ["(status 409 Conflict): max 500 tokens", { transient: false, reason: "invalid_request" }],
    ["API Error: 409 Conflict", { transient: false, reason: "invalid_request" }],
    ["API Error: 503: proxy said HTTP 409 for backend", { transient: true, reason: "server_error" }],
    ["Internal error: API Error: 503: proxy said HTTP 409 for backend", { transient: true, reason: "server_error" }],
    ["API Error: 409: backend said HTTP 503 for this call", { transient: false, reason: "invalid_request" }],
    // A nested terminal status must not shadow a transient failure the same string reports in a
    // later clause: a CLI stderr tail, or a chained cause (messageOf joins it after "Error: ").
    ["API Error: 410: resource gone\nHTTP 503 Service Unavailable", { transient: true, reason: "server_error" }],
    ["API Error: 410: resource gone\nHTTP 429: too many requests", { transient: true, reason: "rate_limited" }],
    ["API Error: 410: resource gone Error: HTTP 503 Service Unavailable", { transient: true, reason: "server_error" }],
    // ...but a status quoted inside the same clause stays nested, even on a later line.
    ["API Error: 410: resource gone\nDetails: the backend returned HTTP 503", { transient: false, reason: "invalid_request" }],
    ["API Error: 410: resource gone\nOpenAI HTTP 409: conflict", { transient: false, reason: "invalid_request" }],
    ["xAI HTTP 429: too many requests", { transient: true, reason: "rate_limited" }],
    ["(status 503 Service Unavailable)", { transient: true, reason: "server_error" }],
    ["(status 529) overloaded", { transient: true, reason: "overloaded" }],
    ["HTTP 408: request timed out", { transient: true, reason: "timeout" }],
    ["Upstream returned 401 Unauthorized", { transient: false, reason: "auth" }],
    ["Upstream returned 402 Payment Required: exceeded your quota", { transient: false, reason: "quota" }],
  ])("classifies %s", (message, expected) => {
    expect(classifyError({ text: message })).toEqual(expected);
  });

  it("retries a 409 from OpenAI and not from any other provider", () => {
    expect(classifyError({ text: "API Error: 409 Conflict" }, { openAi: true }))
      .toEqual({ transient: true, reason: "server_error" });
    expect(classifyError({ text: "OpenAI HTTP 409: conflict with the current resource state" }, { openAi: true }))
      .toEqual({ transient: true, reason: "server_error" });
    expect(classifyError({ text: "API Error: 409 Conflict" }))
      .toEqual({ transient: false, reason: "invalid_request" });
    expect(classifyError({ text: "OpenAI HTTP 409: max 500 tokens" }))
      .toEqual({ transient: false, reason: "invalid_request" });
  });

  it("reads the outer failure when an error's cause quotes a nested backend error", () => {
    const nested = new Error("API Error: 410: resource gone", { cause: new Error("HTTP 503 Service Unavailable") });
    expect(classifyError(nested)).toEqual({ transient: true, reason: "server_error" });
  });
});
