// Where "is Claude signed in?" is answered. These tests inject the CLI
// runner, so they never read or mutate the developer's real credentials.
import { describe, expect, it } from "vitest";

import { claudeAuthFailure, claudeSignedIn } from "./claude.ts";

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
