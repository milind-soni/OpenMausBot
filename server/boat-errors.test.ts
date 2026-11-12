import { describe, expect, it } from "vitest";

import { boatErrorMessage, boatRefusal } from "./boat.ts";

const billing = {
  ok: false,
  status: 402,
  code: "billing_required",
  message: "Start the $20/month Boat plan to create sandboxes.",
  error: {
    code: "billing_required",
    details: { billingUrl: "https://boat.dev/dashboard?tab=billing", accessTier: "trial" },
  },
};

describe("boatErrorMessage", () => {
  it("passes the provider's billing message through, with its link", () => {
    const msg = boatErrorMessage(402, "boat create", billing);
    expect(msg).toContain("$20/month Boat plan");
    expect(msg).toContain("https://boat.dev/dashboard?tab=billing");
    expect(msg).not.toMatch(/\(402\)/);
  });

  it("still says something useful when the provider says nothing", () => {
    expect(boatErrorMessage(402, "boat create", {})).toMatch(/paid Boat plan/i);
  });

  it("tells you to re-paste your own key on an auth failure", () => {
    expect(boatErrorMessage(401, "boat create", { message: "unauthorized" }))
      .toBe("boat.dev rejected your Boat API key — paste a current one in Settings → API keys");
  });

  it("never asks for a token the person never pasted when Cloud Pro's included one is refused", () => {
    for (const status of [401, 403]) {
      const msg = boatErrorMessage(status, "boat create", { message: "This cloud computer key is not valid." }, true);
      expect(msg).toBe("The cloud computers included with your Cloud plan aren't available right now. Try again later.");
      expect(msg).not.toMatch(/key|paste/);
    }
    expect(boatErrorMessage(402, "boat create", { message: "Cloud computers are included with an active Cloud Pro subscription." }, true))
      .toBe("Cloud computers are included with an active Cloud Pro subscription.");
  });

  it("names the rate limit rather than a bare status", () => {
    expect(boatErrorMessage(429, "boat create", { message: "Too many sandboxes created today." })).toBe(
      "Too many sandboxes created today.",
    );
  });

  it("falls back to the status when nothing is known", () => {
    expect(boatErrorMessage(500, "boat create")).toBe("boat create failed (500)");
  });
});

describe("boatRefusal", () => {
  it("keeps the provider's status and the Admin's own code for reading the failed place", () => {
    const inactive = { ok: false, code: "subscription_inactive", message: "Cloud computers are included with an active Cloud subscription.",
      error: { code: "subscription_inactive", message: "Cloud computers are included with an active Cloud subscription.", status: 402 } };
    expect(boatRefusal(402, "boat create", inactive, true)).toMatchObject({
      message: "Cloud computers are included with an active Cloud subscription.", boatStatus: 402, boatCode: "subscription_inactive",
    });
  });

  it("keeps the Admin's limit beside its code, and none from a body that names none", () => {
    const message = "Your Pro plan's 200 cloud computer hours for November are used up. They reset on 1 December.";
    const fields = { reason: "hours_used", plan: "Pro", limit: 200, used: 200.4, resetsAt: "2026-12-01T00:00:00.000Z" };
    const refused = boatRefusal(429, "boat create", { ok: false, type: "sandbox.error", status: 429, code: "limit_reached", message, ...fields,
      error: { code: "limit_reached", message, status: 429, ...fields } }, true);
    expect(refused).toMatchObject({ message, boatStatus: 429, boatCode: "limit_reached", boatLimit: fields });
    expect(boatRefusal(429, "boat create", { ok: false, code: "limit_reached", message }, true)).not.toHaveProperty("boatLimit");
  });

  it("never sets the status a route would answer with", () => {
    expect(boatRefusal(200, "boat create", { ok: false, message: "no sandbox" })).not.toHaveProperty("status");
    expect(boatRefusal(500, "boat create", { code: "Not A Code!" })).not.toHaveProperty("boatCode");
  });
});
