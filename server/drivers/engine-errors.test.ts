import { describe, expect, it } from "vitest";

import { engineFailureKind, engineFailureMessage, httpStatusOf, plainFailureMessage, providerReason, stopCause } from "./engine-errors.ts";
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
