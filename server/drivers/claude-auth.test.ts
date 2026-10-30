// These tests inject the CLI runner, so they never read or change the developer's real credentials.
import { describe, expect, it } from "vitest";

import { claudeSignedIn } from "./claude-auth-status.ts";
import { claudeAuthFailure } from "./claude-auth-recovery.ts";
import { claudeResultError, claudeVersionTooOld } from "./claude.ts";
import { claudeApiErrorMessage, claudeEngineReset, claudeLimitFacts, claudeLimitMessage, claudeLimitRefusal, claudeUsageLimit } from "./claude-limits.ts";
import { classifyError } from "./retry.ts";

describe("claudeSignedIn", () => {
  it("uses the CLI's machine-readable auth status", async () => {
    const run = ((cli, args, options, callback) => {
      expect(cli).toBe("claude-custom");
      expect(args).toEqual(["auth", "status", "--json"]);
      expect(options).toMatchObject({ timeout: 8000, env: { PATH: "/custom/bin" } });
      callback(null, '{"loggedIn":true}');
    }) satisfies typeof import("../procs.ts").execCli;

    expect(await claudeSignedIn("claude-custom", { PATH: "/custom/bin" }, run)).toBe(true);
  });

  it("uses loggedIn:false even though the real CLI exits with code 1", async () => {
    const run = ((_cli, _args, _options, callback) => {
      callback(new Error("exit code 1"), '{"loggedIn":false,"authMethod":"none"}');
    }) satisfies typeof import("../procs.ts").execCli;

    expect(await claudeSignedIn("claude", {}, run)).toBe(false);
  });

  it("fails closed when the command has no valid status", async () => {
    const failed = ((_cli, _args, _options, callback) => {
      callback(new Error("auth status unavailable"), "");
    }) satisfies typeof import("../procs.ts").execCli;
    const malformed = ((_cli, _args, _options, callback) => {
      callback(null, "not json");
    }) satisfies typeof import("../procs.ts").execCli;

    expect(await claudeSignedIn("claude", {}, failed)).toBe(false);
    expect(await claudeSignedIn("claude", {}, malformed)).toBe(false);
  });
});

describe("claudeAuthFailure", () => {
  const LOGIN_TEXT = "Not logged in \u00b7 Please run /login";

  it("reads the signed-out turn the CLI actually sends", () => {
    // captured from claude 2.1.263 run with an empty CLAUDE_CONFIG_DIR
    expect(claudeAuthFailure({ error: "authentication_failed", is_api_error_message: true }, LOGIN_TEXT)).toBe(true);
  });

  it("still catches a flagged frame that does not name the reason", () => {
    expect(claudeAuthFailure({ is_api_error_message: true }, LOGIN_TEXT)).toBe(true);
    expect(claudeAuthFailure({ error: "api_error" }, "401 unauthorized")).toBe(true);
  });

  it("leaves a model's own words alone", () => {
    expect(claudeAuthFailure({}, LOGIN_TEXT)).toBe(false);
    expect(claudeAuthFailure({}, "You are not logged in to npm; run npm login.")).toBe(false);
  });

  it("leaves other api errors to the retry classifier", () => {
    expect(claudeAuthFailure({ error: "api_error", is_api_error_message: true }, "API Error (529): overloaded")).toBe(false);
  });
});

describe("claudeVersionTooOld", () => {
  // the text the CLI relays when the API refuses a model newer than it
  const TOO_OLD = "API Error: 400 Claude Code 2.1.268 does not support this model; version 2.1.280 or newer is required. Run 'claude update', or update the Claude desktop app, then try again.";

  it("reads the api-error frame for a model this install is too old for", () => {
    expect(claudeVersionTooOld({ is_api_error_message: true }, TOO_OLD)).toBe(true);
    expect(claudeVersionTooOld({ error: "invalid_request" }, TOO_OLD)).toBe(true);
  });

  it("leaves a model's own words and other api errors alone", () => {
    expect(claudeVersionTooOld({}, TOO_OLD)).toBe(false);
    expect(claudeVersionTooOld({ is_api_error_message: true }, "API Error: 400 prompt is too long")).toBe(false);
  });
});

describe("Claude usage limits", () => {
  // Captured from 2.1.295: the rate_limit_event, and the same window on the refused call's api_error_params.
  const WEEKLY = { status: "rejected", resetsAt: 1791795600, rateLimitType: "seven_day", overageStatus: "rejected", overageDisabledReason: "org_level_disabled", isUsingOverage: false };
  const WEEKLY_TEXT = "You've hit your weekly limit \u00b7 resets Oct 12 at 2:30pm (Asia/Calcutta)";
  const BEFORE_RESET = Date.parse("2026-10-09T17:48:32Z");

  it("reads which window refuses the account, and only a refusal", () => {
    expect(claudeLimitRefusal(WEEKLY)).toEqual({ window: "seven_day", resetsAt: 1791795600 });
    expect(claudeLimitRefusal({ ...WEEKLY, rateLimitType: "five_hour" })).toEqual({ window: "five_hour", resetsAt: 1791795600 });
    expect(claudeLimitRefusal({ status: "rejected" })).toEqual({ window: null, resetsAt: null });
    expect(claudeLimitRefusal({ ...WEEKLY, status: "allowed_warning" })).toBeNull();
    expect(claudeLimitRefusal({ ...WEEKLY, status: "allowed" })).toBeNull();
    expect(claudeLimitRefusal({ ...WEEKLY, isUsingOverage: true })).toBeNull();
    expect(claudeLimitRefusal(undefined)).toBeNull();
  });

  // Captured from a refused Fable call while the 5-hour window was allowed at 18%: the model ran on extra usage.
  const OUT_OF_CREDITS = { status: "rejected", resetsAt: 1793491200, overageDisabledReason: "out_of_credits", isUsingOverage: false, errorCode: "credits_required" };

  it("tells used-up extra-usage credits apart from a plan window, and holds the engine only for a window every model shares", () => {
    const credits = claudeLimitRefusal(OUT_OF_CREDITS);
    expect(credits).toEqual({ window: null, resetsAt: 1793491200, credits: true });
    expect(claudeLimitRefusal({ status: "rejected", overageDisabledReason: "out_of_credits" })?.credits).toBe(true);
    expect(claudeEngineReset(credits)).toBeUndefined();
    expect(claudeEngineReset(claudeLimitRefusal({ ...WEEKLY, rateLimitType: "seven_day_opus" }))).toBeUndefined();
    expect(claudeEngineReset(claudeLimitRefusal({ ...WEEKLY, rateLimitType: "seven_day_fable" }))).toBeUndefined();
    expect(claudeEngineReset(claudeLimitRefusal(WEEKLY))).toEqual({ limitResetsAt: 1791795600_000 });
    expect(claudeEngineReset(claudeLimitRefusal({ ...WEEKLY, rateLimitType: "seven_day_overage_included" }))).toEqual({ limitResetsAt: 1791795600_000 });
    expect(claudeEngineReset(null)).toBeUndefined();
  });

  it("names what a limit refuses for the runtime error: the model's credits, its own window with that reset, or the account", () => {
    expect(claudeLimitFacts(claudeLimitRefusal(OUT_OF_CREDITS)), "no countdown to the billing period's end").toEqual({ limit: "credits" });
    expect(claudeLimitFacts(claudeLimitRefusal({ ...WEEKLY, rateLimitType: "seven_day_opus" }))).toEqual({ limit: "model", limitResetsAt: 1791795600_000 });
    expect(claudeLimitFacts(claudeLimitRefusal(WEEKLY))).toEqual({ limit: "engine", limitResetsAt: 1791795600_000 });
    expect(claudeLimitFacts(claudeLimitRefusal({ status: "rejected" }))).toEqual({ limit: "engine" });
    expect(claudeLimitFacts(null)).toEqual({ limit: "engine" });
  });

  it("says a model's credits ran out, with no countdown to the billing reset", () => {
    const message = claudeLimitMessage(claudeLimitRefusal(OUT_OF_CREDITS), undefined, BEFORE_RESET, "America/Los_Angeles");
    expect(message).toContain("runs on extra usage for your account, and those credits are used up");
    expect(message).toContain("switch this bot to a model your plan includes");
    expect(message).not.toMatch(/reached its|resets|Oct 31/);
    expect(claudeLimitMessage(claudeLimitRefusal({ ...WEEKLY, rateLimitType: "seven_day_fable" }), undefined, BEFORE_RESET, "UTC")).toContain("choose another model for this bot");
  });

  it("knows the refused call by its code, its words or a refused account", () => {
    expect(claudeUsageLimit({ error: "rate_limit", is_api_error_message: true, api_error: "usage_limit_reached" }, "")).toBe(true);
    expect(claudeUsageLimit({ is_api_error_message: true }, WEEKLY_TEXT)).toBe(true);
    expect(claudeUsageLimit({ is_api_error_message: true }, "You've hit your session limit \u00b7 resets 3pm")).toBe(true);
    expect(claudeUsageLimit({ is_api_error_message: true }, "You've hit your Opus limit")).toBe(true);
    // 2.1.272 named the update, not the weekly limit its rate_limit_event refused
    const tooOld = "API Error: 400 Claude Code 2.1.272 does not support this model; version 2.1.280 or newer is required.";
    expect(claudeUsageLimit({ error: "invalid_request", is_api_error_message: true }, tooOld, true)).toBe(true);
    expect(claudeUsageLimit({ error: "invalid_request", is_api_error_message: true }, tooOld)).toBe(false);
    expect(claudeUsageLimit({}, WEEKLY_TEXT)).toBe(false);
    expect(claudeUsageLimit({ is_api_error_message: true }, "API Error: 429 You've hit your rate limit, retry in 5s")).toBe(false);
  });

  it("says which limit, when it resets, and what runs until then", () => {
    expect(claudeLimitMessage(claudeLimitRefusal(WEEKLY), WEEKLY_TEXT, BEFORE_RESET, "Asia/Calcutta"))
      .toBe("This Claude account has reached its weekly limit, which resets Oct 12, 2:30 PM (Asia/Calcutta). Until then, switch this bot to another AI or Claude account.");
    expect(claudeLimitMessage({ window: "five_hour", resetsAt: 1791795600 }, undefined, BEFORE_RESET, "UTC"))
      .toBe("This Claude account has reached its 5-hour limit, which resets Oct 12, 9:00 AM (UTC). Until then, switch this bot to another AI or Claude account.");
    expect(claudeLimitMessage({ window: "seven_day_opus", resetsAt: 1791795600 }, undefined, BEFORE_RESET, "UTC"))
      .toBe("This Claude account has reached its weekly Opus limit, which resets Oct 12, 9:00 AM (UTC). Until then, choose another model for this bot.");
    expect(claudeLimitMessage({ window: "seven_day_sonnet", resetsAt: null })).toBe("This Claude account has reached its weekly Sonnet limit. For now, choose another model for this bot.");
    expect(claudeLimitMessage({ window: "overage", resetsAt: null }, "You're out of usage credits. Contact your admin to add more."))
      .toBe("This Claude account has reached its usage limit (Claude says: \"You're out of usage credits. Contact your admin to add more\"). For now, switch this bot to another AI or Claude account.");
    expect(claudeLimitMessage(claudeLimitRefusal(WEEKLY), WEEKLY_TEXT, 1791795600_000 + 1, "UTC")).toContain(`(Claude says: "${WEEKLY_TEXT}")`);
    expect(claudeLimitMessage(claudeLimitRefusal(WEEKLY), undefined, BEFORE_RESET, "Mars/Olympus")).toContain("which resets 2026-10-12 09:00 UTC.");
  });
});

describe("claudeResultError", () => {
  it("says what failed a turn that ended in an error result alone", () => {
    // 2.1.295, for a resumed session it no longer had
    expect(claudeResultError({ subtype: "error_during_execution", errors: ["No conversation found with session ID: 9de1"] }))
      .toBe("No conversation found with session ID: 9de1");
    expect(claudeResultError({ subtype: "error_max_turns", result: "Reached the turn limit " })).toBe("Reached the turn limit");
    expect(claudeResultError({ subtype: "error_during_execution", errors: [" "] })).toBe("Claude ended the turn with an error (error_during_execution).");
  });

  it("shows an error result's own words, never its synthetic message's stop_sequence nor the subtype success", () => {
    // 2.1.295's error result: subtype "success", is_error, the synthetic message's stop_reason, Claude's text as `result`
    const result = { type: "result", subtype: "success", is_error: true, stop_reason: "stop_sequence", api_error_status: 402, result: "Credit balance is too low" };
    expect(claudeResultError(result)).toBe('Your Claude account is out of credits (Claude says: "Credit balance is too low"). Add credits with Claude, then run it again.');
    expect(claudeResultError({ ...result, api_error_status: undefined, result: "API Error: Repeated 529 Overloaded errors. The API is at capacity — this is usually temporary. Try again in a moment." }))
      .toBe('Claude is overloaded right now (Claude says: "Repeated 529 Overloaded errors"). This is usually temporary, so try again in a few minutes.');
    for (const frame of [{ ...result, result: "" }, { ...result, result: undefined, terminal_reason: undefined }]) {
      expect(claudeResultError(frame)).toBe("Claude ended the turn with an error (unknown).");
    }
    expect(claudeResultError({ ...result, result: " ", terminal_reason: "api_error" })).toBe("Claude ended the turn with an error (api_error).");
    expect(claudeResultError({ ...result, result: "", terminal_reason: "api_error" })).not.toMatch(/stop_sequence|success/);
  });
});

describe("claudeApiErrorMessage", () => {
  it("names the cause an api-error frame's kind or status gives, and keeps the class of Claude's own words", () => {
    const cases: Array<[{ error?: string; api_error_status?: number }, string, string, string]> = [
      [{ error: "billing_error" }, "Credit balance is too low",
        'Your Claude account is out of credits (Claude says: "Credit balance is too low"). Add credits with Claude, then run it again.', "quota"],
      [{ error: "overloaded" }, "API Error: Repeated 529 Overloaded errors. The API is at capacity — this is usually temporary. Try again in a moment.",
        'Claude is overloaded right now (Claude says: "Repeated 529 Overloaded errors"). This is usually temporary, so try again in a few minutes.', "overloaded"],
      [{ error: "unknown" }, 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
        "Claude is overloaded right now (HTTP 529). This is usually temporary, so try again in a few minutes.", "overloaded"],
      [{ error: "server_error" }, "API Error: Connection to the API was lost (ECONNRESET). This is usually temporary — try again.",
        'Claude had a temporary server problem (Claude says: "Connection to the API was lost (ECONNRESET)"). Try again in a few minutes.', "connection_reset"],
      [{ error: "unknown" }, 'API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}',
        'Claude had a temporary server problem (HTTP 500; Claude says: "Internal server error"). Try again in a few minutes.', "server_error"],
      [{ error: "rate_limit" }, "Opus is experiencing high load, please use /model to switch to Sonnet",
        'Claude hit a rate limit (Claude says: "Opus is experiencing high load, please use /model to switch to Sonnet"). Wait a minute, then run it again.', "rate_limited"],
      [{ error: "invalid_request" }, 'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 215000 tokens > 200000 maximum"}}',
        'Claude stopped with an error (HTTP 400; Claude says: "prompt is too long: 215000 tokens > 200000 maximum").', "invalid_request"],
    ];
    for (const [frame, text, words, kind] of cases) {
      expect(claudeApiErrorMessage(frame, text), text).toBe(words);
      expect(classifyError({ text: words }).reason, words).toBe(kind);
    }
  });

  it("keeps Claude's own words for a cause it does not name", () => {
    const text = "There's an issue with the selected model (claude-fixture). It may not exist or you may not have access to it.";
    expect(claudeApiErrorMessage({ error: "model_not_found" }, `${text} `)).toBe(text);
  });
});
