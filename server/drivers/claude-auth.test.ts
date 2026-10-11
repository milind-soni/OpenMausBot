// Where "is Claude signed in?" is answered. These tests inject the CLI
// runner, so they never read or mutate the developer's real credentials.
import { describe, expect, it } from "vitest";

import { claudeAuthFailure, claudeLimitMessage, claudeLimitRefusal, claudeResultError, claudeSignedIn, claudeUsageLimit, claudeVersionTooOld } from "./claude.ts";

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
    // the flag is the gate: a reply that merely discusses logging in is a
    // reply, and must keep rendering as one
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

// An account past its usage limit was reported as "update required" and
// then "stop_sequence", and the Chief told the person three times to finish
// the bot's setup (Pesto, Oct 8-10). The CLI said what it was all along.
describe("Claude usage limits", () => {
  // captured from 2.1.295: the rate_limit_event, and the same window on the
  // refused call's api-error frame (api_error_params.rate_limit_info)
  const WEEKLY = { status: "rejected", resetsAt: 1791795600, rateLimitType: "seven_day", overageStatus: "rejected", overageDisabledReason: "org_level_disabled", isUsingOverage: false };
  const WEEKLY_TEXT = "You've hit your weekly limit \u00b7 resets Oct 12 at 2:30pm (Asia/Calcutta)";
  const BEFORE_RESET = Date.parse("2026-10-09T17:48:32Z");

  it("reads which window refuses the account, and only a refusal", () => {
    expect(claudeLimitRefusal(WEEKLY)).toEqual({ window: "seven_day", resetsAt: 1791795600 });
    expect(claudeLimitRefusal({ ...WEEKLY, rateLimitType: "five_hour" })).toEqual({ window: "five_hour", resetsAt: 1791795600 });
    expect(claudeLimitRefusal({ status: "rejected" })).toEqual({ window: null, resetsAt: null });
    // near a limit, under it, or past it on extra usage, the turn still runs
    expect(claudeLimitRefusal({ ...WEEKLY, status: "allowed_warning" })).toBeNull();
    expect(claudeLimitRefusal({ ...WEEKLY, status: "allowed" })).toBeNull();
    expect(claudeLimitRefusal({ ...WEEKLY, isUsingOverage: true })).toBeNull();
    expect(claudeLimitRefusal(undefined)).toBeNull();
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
    // a model's own words, and a per-minute rate limit, are not the account's limit
    expect(claudeUsageLimit({}, WEEKLY_TEXT)).toBe(false);
    expect(claudeUsageLimit({ is_api_error_message: true }, "API Error: 429 You've hit your rate limit, retry in 5s")).toBe(false);
  });

  it("says which limit, when it resets, and what runs until then", () => {
    expect(claudeLimitMessage(claudeLimitRefusal(WEEKLY), WEEKLY_TEXT, BEFORE_RESET, "Asia/Calcutta"))
      .toBe("This Claude account has reached its weekly limit, which resets Oct 12, 2:30 PM (Asia/Calcutta). Until then, switch this bot to another engine or Claude account.");
    expect(claudeLimitMessage({ window: "five_hour", resetsAt: 1791795600 }, undefined, BEFORE_RESET, "UTC"))
      .toBe("This Claude account has reached its 5-hour limit, which resets Oct 12, 9:00 AM (UTC). Until then, switch this bot to another engine or Claude account.");
    // a model's own weekly limit leaves the account's other models running
    expect(claudeLimitMessage({ window: "seven_day_opus", resetsAt: 1791795600 }, undefined, BEFORE_RESET, "UTC"))
      .toBe("This Claude account has reached its weekly Opus limit, which resets Oct 12, 9:00 AM (UTC). Until then, choose another model for this bot.");
    expect(claudeLimitMessage({ window: "seven_day_sonnet", resetsAt: null })).toBe("This Claude account has reached its weekly Sonnet limit. For now, choose another model for this bot.");
    // no reset to write: the CLI's words carry what it knows
    expect(claudeLimitMessage({ window: "overage", resetsAt: null }, "You're out of usage credits. Contact your admin to add more."))
      .toBe("This Claude account has reached its usage limit (Claude says: \"You're out of usage credits. Contact your admin to add more\"). For now, switch this bot to another engine or Claude account.");
    expect(claudeLimitMessage(claudeLimitRefusal(WEEKLY), WEEKLY_TEXT, 1791795600_000 + 1, "UTC")).toContain(`(Claude says: "${WEEKLY_TEXT}")`);
    // an unknown zone still writes the reset
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
});
