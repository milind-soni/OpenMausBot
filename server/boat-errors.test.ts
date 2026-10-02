// What the user is told when the boat provider refuses. These strings are
// the whole difference between "boat create failed (402)" and knowing you
// need to start a plan — so they are pinned, including the rule that the
// provider's own wording wins over ours.
import { describe, expect, it } from "vitest";

import { boatErrorMessage } from "./boat.ts";

const billing = {
  ok: false,
  status: 402,
  code: "billing_required",
  message: "Start the $20/month Boat plan to create sandboxes.",
  error: {
    code: "billing_required",
    details: { billingUrl: "https://box.ascii.dev/box/dashboard?tab=billing", accessTier: "trial" },
  },
};

describe("boatErrorMessage", () => {
  it("passes the provider's billing message through, with its link", () => {
    const msg = boatErrorMessage(402, "boat create", billing);
    expect(msg).toContain("$20/month Boat plan");
    expect(msg).toContain("https://box.ascii.dev/box/dashboard");
    expect(msg).not.toMatch(/\(402\)/);
  });

  it("still says something useful when the provider says nothing", () => {
    expect(boatErrorMessage(402, "boat create", {})).toMatch(/paid Boat plan/i);
  });

  it("tells you to re-paste the token on an auth failure", () => {
    const msg = boatErrorMessage(401, "boat create", { message: "unauthorized" });
    expect(msg).toMatch(/token/i);
    // Provider tokens still carry the historical "box_" prefix.
    expect(msg).toMatch(/box_/);
  });

  it("never asks for a token the person never pasted when Cloud Pro's included one is refused", () => {
    for (const status of [401, 403]) {
      const msg = boatErrorMessage(status, "boat create", { message: "This cloud computer key is not valid." }, true);
      expect(msg).toBe("The cloud computers included with your Cloud plan aren't available right now. Try again later.");
      expect(msg).not.toMatch(/box_|paste/);
    }
    // Cloud Pro's own refusals (its limits, its subscription) keep their words.
    expect(boatErrorMessage(402, "boat create", { message: "Cloud computers are included with an active Cloud Pro subscription." }, true))
      .toBe("Cloud computers are included with an active Cloud Pro subscription.");
  });

  it("names the rate limit rather than a bare status", () => {
    expect(boatErrorMessage(429, "boat create", { message: "Too many boxes created today." })).toBe(
      "Too many boxes created today.",
    );
  });

  it("falls back to the status when nothing is known", () => {
    expect(boatErrorMessage(500, "boat create")).toBe("boat create failed (500)");
  });
});
