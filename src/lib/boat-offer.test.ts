import { describe, expect, it } from "vitest";
import { BOAT_OFFER, boatClaimMailto, boatOfferRuns } from "./boat-offer";

const SUBJECT = "MausBot introduced me: $50 Boat credit";
const BODY = "Hi Boat team,\n\nMausBot introduced me to Boat. I'm on the $___ plan.\nMy Boat account email: ___\n\nThanks!";

describe("Boat's credit offer", () => {
  it("goes to boat.dev and claims at Boat's billing address, with no end date until Boat names one", () => {
    expect(BOAT_OFFER.url).toBe("https://boat.dev");
    expect(BOAT_OFFER.claimTo).toBe("support@ascii.dev");
    expect(BOAT_OFFER.until).toBeNull();
  });

  it("drafts the claim to that address with the subject and body Boat asked for, for the person to send", () => {
    const mailto = boatClaimMailto();
    expect(mailto).toBe("mailto:support@ascii.dev"
      + "?subject=MausBot%20introduced%20me%3A%20%2450%20Boat%20credit"
      + "&body=Hi%20Boat%20team%2C%0D%0A%0D%0AMausBot%20introduced%20me%20to%20Boat.%20I'm%20on%20the%20%24___%20plan.%0D%0AMy%20Boat%20account%20email%3A%20___%0D%0A%0D%0AThanks!");
    const url = new URL(mailto);
    expect(`${url.protocol}${url.pathname}`).toBe("mailto:support@ascii.dev");
    expect([...url.searchParams.keys()]).toEqual(["subject", "body"]);
    expect(url.searchParams.get("subject")).toBe(SUBJECT);
    expect(url.searchParams.get("body")!.replace(/\r\n/g, "\n")).toBe(BODY);
    expect(mailto, "a space is %20, never +, which some mail apps show as it is").not.toContain("+");
  });

  it("runs until its end date, and for good while none is set", () => {
    const end = Date.UTC(2026, 11, 1);
    expect(boatOfferRuns(end)).toBe(true);
    expect(boatOfferRuns(end - 1, { ...BOAT_OFFER, until: end })).toBe(true);
    expect(boatOfferRuns(end, { ...BOAT_OFFER, until: end })).toBe(false);
    expect(boatOfferRuns(end + 1, { ...BOAT_OFFER, until: end })).toBe(false);
  });
});
