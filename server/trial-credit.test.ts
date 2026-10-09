// The trial Claude credit's refusals, as the OpenAI-compatible relay answers
// them and as the chat engine reports them: told apart by the HTTP status and
// the relay's own error code (first in its error object, so it survives the
// engine keeping only the start of a body), never by what a model says.
import { describe, expect, it } from "vitest";
import { TRIAL_CREDIT_REFUSED, trialCreditEnds, trialCreditFailure, trialCreditRefusal } from "./trial-credit.ts";
import { trialCreditKind } from "../shared/trial-credit.ts";

/** The relay's error body, exactly as the Admin writes it (server/cloud-credit.ts `error`): its code first. */
const relay = (code: string, message: string, type = "insufficient_quota") => JSON.stringify({ error: { code, type, message, param: null } });
/** The chat engine's failure line: "upstream HTTP <status>: <the first 200 characters of the body>". */
const failure = (status: number, body: string) => `upstream HTTP ${status}: ${body.slice(0, 200)}`;

describe("the trial Claude credit's refusal", () => {
  it("reads used up, gone, too low and paused from the relay's status and its own code", () => {
    expect(trialCreditRefusal(402, relay("trial_credit_used_up", "Your $5 of Claude credit is used up."))).toBe("used_up");
    expect(trialCreditRefusal(402, relay("trial_credit_ended", "Claude credit isn't available on this Cloud."))).toBe("ended");
    expect(trialCreditRefusal(401, relay("invalid_api_key", "This Claude credit key isn't valid.", "invalid_request_error"))).toBe("ended");
    expect(trialCreditRefusal(400, relay("trial_credit_too_low", "Your Claude credit has $0.20 left, too little for this request.", "invalid_request_error"))).toBe("too_low");
    expect(trialCreditRefusal(429, relay("trial_credit_paused", "Claude credit is paused for now.", "rate_limit_error"))).toBe("paused");
    expect(trialCreditRefusal(429)).toBe("paused");
    // Only the two 402s and the unknown token end the credit; paused and too low are for now.
    expect((["used_up", "ended", "too_low", "paused"] as const).map(trialCreditEnds)).toEqual([true, true, false, false]);
  });

  it("never ends the credit on a refusal without the relay's own code: a proxy's page, an upstream's words, or a status alone", () => {
    for (const [status, body] of [[402, ""], [402, "<html>Payment Required</html>"], [403, "<html>Forbidden by the firewall</html>"], [401, ""],
      [402, JSON.stringify({ error: { message: "Your credit balance is too low", type: "billing_error" } })], [400, relay("upstream_refused", "Claude couldn't complete this request (HTTP 400).")],
      [500, relay("upstream_unavailable", "x")], [502, ""], [404, relay("not_found", "x")]] as const) {
      expect(trialCreditRefusal(status, body), `${status} ${body}`).toBeNull();
    }
  });

  it("reads the chat engine's own failure line, which keeps only the start of a body, and never a model's reply or another error", () => {
    // The relay's sentences run past 200 characters with the JSON around them: the code, first, is still read.
    const usedUp = relay("trial_credit_used_up", `Your $5 of Claude credit is used up. To keep your bots working, connect your own Claude or ChatGPT account, or an API key, on your Cloud.`);
    expect(usedUp.length).toBeGreaterThan(200);
    expect(trialCreditFailure(failure(402, usedUp))).toBe("used_up");
    expect(trialCreditFailure(failure(402, relay("trial_credit_ended", "Claude credit isn't available on this Cloud.")))).toBe("ended");
    expect(trialCreditFailure(failure(400, relay("trial_credit_too_low", "Your Claude credit has $0.20 left, too little for this request. Start a new chat, or connect your own Claude or ChatGPT account, or an API key, on your Cloud.", "invalid_request_error")))).toBe("too_low");
    expect(trialCreditFailure(failure(429, relay("trial_credit_paused", "Claude credit is paused for now.", "rate_limit_error")))).toBe("paused");
    for (const message of ["Your trial Claude credit is used up, so I can't help.", "upstream HTTP 500: overloaded", "upstream HTTP 400: {}", "upstream HTTP 402",
      "Stopped after 64 steps without a final answer.", "fetch failed", ` ${failure(402, usedUp)}`]) expect(trialCreditFailure(message), message).toBeNull();
  });

  it("says each in plain words, with the next step, never a retired word or the API's own, and the app tells each back from its words", () => {
    expect(TRIAL_CREDIT_REFUSED.used_up).toBe("Your trial Claude credit is used up. To keep your bots working, sign in with your own Claude or ChatGPT account, or add an API key.");
    for (const [kind, sentence] of Object.entries(TRIAL_CREDIT_REFUSED)) {
      expect(sentence).toMatch(/own Claude or ChatGPT account, or add an API key\.$/);
      expect(sentence).not.toMatch(/\{|HTTP|insufficient_quota|billing_error|your Cloud|AI credit/);
      expect(trialCreditKind(sentence)).toBe(kind);
    }
    expect(trialCreditKind("upstream HTTP 402")).toBeNull();
  });
});
