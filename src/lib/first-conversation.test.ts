import { describe, expect, it } from "vitest";
import { anchorFor, nextSpotlight, placementFor, SPOTLIGHTS, tourComplete, type ChatObservation } from "./first-conversation";

const quiet: ChatObservation = { replyStarted: false, replyFinished: false, approvalVisible: false, connectorVisible: false };

describe("first conversation spotlights", () => {
  it("shows nothing until the first reply starts", () => {
    expect(nextSpotlight(quiet, [], null)).toBeNull();
  });

  it("opens on the composer when the reply starts, then the model chip when it ends", () => {
    expect(nextSpotlight({ ...quiet, replyStarted: true }, [], null)).toBe("spot.composer");
    // the model chip waits for the composer to be dismissed
    expect(nextSpotlight({ ...quiet, replyStarted: true, replyFinished: true }, [], null)).toBe("spot.composer");
    expect(nextSpotlight({ ...quiet, replyFinished: true }, ["spot.composer"], null)).toBe("spot.model");
  });

  it("never stacks: an active spotlight stays until dismissed", () => {
    expect(nextSpotlight({ ...quiet, replyFinished: true, approvalVisible: true }, ["spot.composer"], "spot.model")).toBe("spot.model");
  });

  it("lets a live card interrupt the chrome order", () => {
    expect(nextSpotlight({ ...quiet, replyStarted: true, approvalVisible: true }, [], null)).toBe("spot.approval");
    expect(nextSpotlight({ ...quiet, replyStarted: true, connectorVisible: true }, [], null)).toBe("spot.connector");
    expect(nextSpotlight({ ...quiet, approvalVisible: true, connectorVisible: true }, ["spot.approval"], null)).toBe("spot.connector");
  });

  it("shows each spotlight once", () => {
    const all = [...SPOTLIGHTS];
    expect(nextSpotlight({ replyStarted: true, replyFinished: true, approvalVisible: true, connectorVisible: true }, all, null)).toBeNull();
    expect(tourComplete(all)).toBe(true);
    expect(tourComplete(all.slice(1))).toBe(false);
  });

  it("resumes the composer after an approval outlasts the reply", () => {
    expect(nextSpotlight({ ...quiet, replyFinished: true }, ["spot.approval"], null)).toBe("spot.composer");
    expect(nextSpotlight({ ...quiet, replyFinished: true }, ["spot.approval", "spot.composer"], null)).toBe("spot.model");
  });

  it("maps every spotlight to an anchor and a placement", () => {
    for (const id of SPOTLIGHTS) {
      expect(anchorFor(id)).toBeTruthy();
      expect(["above", "below"]).toContain(placementFor(id));
    }
    expect(placementFor("spot.composer")).toBe("above");
  });
});
