import { describe, expect, it } from "vitest";

import { claudeSignInLink } from "./ClaudeSignIn";

describe("the Claude sign-in link shown in Settings", () => {
  it("is only ever Anthropic's own page over https", () => {
    expect(claudeSignInLink("https://claude.com/cai/oauth/authorize?code=true&state=x")).toBe("https://claude.com/cai/oauth/authorize?code=true&state=x");
    expect(claudeSignInLink("https://console.anthropic.com/oauth/authorize")).toBeTruthy();
    expect(claudeSignInLink("https://sub.claude.ai/x")).toBeTruthy();
    expect(claudeSignInLink("http://claude.com/x")).toBeNull();
    expect(claudeSignInLink("https://claude.com.evil.example/x")).toBeNull();
    expect(claudeSignInLink("https://evil.example/?u=https://claude.com")).toBeNull();
    expect(claudeSignInLink("https://a:b@claude.com/x")).toBeNull();
    expect(claudeSignInLink(null)).toBeNull();
    expect(claudeSignInLink("not a url")).toBeNull();
  });
});
