import { describe, expect, it } from "vitest";
import { teamSetupDecisionText, type TeamSetupRequest } from "./team-setup.ts";

const request = (result: TeamSetupRequest["result"]): TeamSetupRequest => ({
  version: 1, requestId: "req-1", botId: "chief", threadId: "t1", reason: "", createdAt: 0, requesterRevision: "r",
  operations: [], newTeams: [], ...(result ? { result } : {}),
});

describe("teamSetupDecisionText", () => {
  it("tells the Chief when a bot created after approval has no cloud computer yet", () => {
    const text = teamSetupDecisionText(request({ state: "applied", newTeams: [], bots: [
      { id: "b1", name: "Pixel", action: "created" },
      { id: "b2", name: "Covered", action: "created" },
      { id: "b3", name: "Old", action: "updated" },
    ] }), (id) => id !== "b2");
    expect(text).toContain("team setup decision req-1:");
    expect(text).toContain("@Pixel has no cloud computer yet");
    expect(text).not.toContain("@Covered has no cloud computer");
    expect(text).not.toContain("@Old has no cloud computer");
  });

  it("adds nothing for a denied setup or when every new bot has a computer", () => {
    const denied = teamSetupDecisionText(request({ state: "denied", newTeams: [], bots: [{ id: "b1", name: "Pixel", action: "created" }] }), () => true);
    const covered = teamSetupDecisionText(request({ state: "applied", newTeams: [], bots: [{ id: "b1", name: "Pixel", action: "created" }] }), () => false);
    for (const text of [denied, covered]) {
      expect(text).not.toContain("no cloud computer");
      expect(text.endsWith("Existing thread models were not changed.")).toBe(true);
    }
  });
});
