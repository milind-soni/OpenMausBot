// Where "is Claude signed in?" is answered. These tests inject the CLI
// runner, so they never read or mutate the developer's real credentials.
import { describe, expect, it } from "vitest";

import { claudeAuthFailure, claudeSignedIn, claudeVersionTooOld } from "./claude.ts";

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
