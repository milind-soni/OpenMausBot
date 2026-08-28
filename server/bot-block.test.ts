// The pages a browsing agent gets stuck on.
//
// Getting this wrong in the permissive direction wastes a turn; getting it
// wrong in the strict direction interrupts the user over an ordinary page —
// so anything that could plausibly be a real page stays "low" and only
// records. The negative cases below are the ones that matter most.
import { describe, expect, it } from "vitest";

import { BLOCK_HELP_WINDOW_MS, classifyBlockPage, createBlockHelpGate } from "./bot-block.ts";

describe("classifyBlockPage", () => {
  const blocked: Array<[string, string, string]> = [
    ["https://www.google.com/sorry/index?continue=x", "", "google_sorry"],
    ["https://accounts.google.com/signin/rejected?x=1", "", "google_signin_rejected"],
    ["https://challenges.cloudflare.com/turnstile", "", "cloudflare_challenge"],
    ["https://shop.example.com/", "Just a moment...", "cloudflare_challenge"],
    ["https://shop.example.com/cdn-cgi/challenge-platform/h/b/orchestrate", "", "cloudflare_challenge"],
    ["https://geo.captcha-delivery.com/captcha/", "", "datadome"],
    ["https://example.com/px/captcha", "", "perimeterx"],
    ["https://example.com/_Incapsula_Resource?SWUDNSAI=9", "", "imperva"],
    ["https://abc.token.awswaf.com/abc", "", "aws_waf"],
    ["https://www.linkedin.com/checkpoint/challenge/verify", "", "linkedin_checkpoint"],
    ["https://app.example.com/", "Vercel Security Checkpoint", "vercel_checkpoint"],
    ["https://client-api.arkoselabs.com/fc/gt2/", "", "arkose"],
  ];
  for (const [url, title, family] of blocked) {
    it(`flags ${family} for ${url || title}`, () => {
      const hit = classifyBlockPage({ url, title });
      expect(hit?.family).toBe(family);
      expect(hit?.confidence).toBe("high");
    });
  }

  it("only records a bare captcha frame — it is often embedded in a real page", () => {
    const hit = classifyBlockPage({ url: "https://www.google.com/recaptcha/api2/anchor?k=x", title: "" });
    expect(hit?.family).toBe("recaptcha");
    expect(hit?.confidence).toBe("low");
  });

  it("does not flag an ordinary page", () => {
    expect(classifyBlockPage({ url: "https://example.com/docs", title: "Docs" })).toBeUndefined();
  });

  it("does not flag a page that merely mentions captcha in its path", () => {
    expect(
      classifyBlockPage({ url: "https://example.com/blog/how-captcha-works", title: "How CAPTCHA works" }),
    ).toBeUndefined();
  });

  it("does not flag a lookalike host that only ends in a brand name", () => {
    expect(classifyBlockPage({ url: "https://notlinkedin.com/checkpoint/challenge", title: "" })).toBeUndefined();
  });

  it("strips www so a signature written bare still matches", () => {
    expect(classifyBlockPage({ url: "https://www.linkedin.com/checkpoint/challenge", title: "" })?.host).toBe(
      "linkedin.com",
    );
  });

  it("returns undefined for an unparseable url", () => {
    expect(classifyBlockPage({ url: "not a url", title: "" })).toBeUndefined();
  });

  it("tolerates a missing title", () => {
    expect(classifyBlockPage({ url: "https://example.com/" })).toBeUndefined();
  });
});

describe("createBlockHelpGate", () => {
  it("asks once per host, then holds off for the window", () => {
    let now = 1_000_000;
    const gate = createBlockHelpGate(() => now);
    expect(gate.shouldAsk("shop.example.com")).toBe(true);
    expect(gate.shouldAsk("shop.example.com")).toBe(false);
    now += BLOCK_HELP_WINDOW_MS - 1;
    expect(gate.shouldAsk("shop.example.com")).toBe(false);
    now += 2;
    expect(gate.shouldAsk("shop.example.com")).toBe(true);
  });

  it("tracks hosts independently — being stuck on one is not being stuck on another", () => {
    const gate = createBlockHelpGate(() => 0);
    expect(gate.shouldAsk("a.example.com")).toBe(true);
    expect(gate.shouldAsk("b.example.com")).toBe(true);
    expect(gate.shouldAsk("a.example.com")).toBe(false);
  });
});
