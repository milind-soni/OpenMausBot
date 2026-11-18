import { describe, expect, it } from "vitest";
import { roomLeadId, steerMeantForSpeaker } from "./room-steer-addressee.ts";

describe("roomLeadId", () => {
  it("is the member the room answers with, or the auto room's fallback", () => {
    expect(roomLeadId({ kind: "member", botId: "lead" })).toBe("lead");
    expect(roomLeadId({ kind: "auto", fallbackBotId: "lead" })).toBe("lead");
    expect(roomLeadId({ kind: "auto" })).toBeUndefined();
    expect(roomLeadId({ kind: "everyone" })).toBeUndefined();
    expect(roomLeadId({ kind: "mentions" })).toBeUndefined();
  });
});

describe("steerMeantForSpeaker", () => {
  const base = { speakerId: "worker", mentioned: [] as string[], leadId: "lead", speakerOnHandedWork: false };

  it("an unnamed line steers a speaker answering the person", () => {
    expect(steerMeantForSpeaker(base)).toBe(true);
  });

  it("an unnamed line never steers a member doing a job the lead handed it", () => {
    expect(steerMeantForSpeaker({ ...base, speakerOnHandedWork: true })).toBe(false);
    expect(steerMeantForSpeaker({ ...base, speakerOnHandedWork: true, leadId: undefined })).toBe(false);
  });

  it("the lead takes an unnamed line even while it works on a handed job", () => {
    expect(steerMeantForSpeaker({ ...base, speakerId: "lead", speakerOnHandedWork: true })).toBe(true);
  });

  it("a named line steers only a bot it names", () => {
    expect(steerMeantForSpeaker({ ...base, mentioned: ["lead"] })).toBe(false);
    expect(steerMeantForSpeaker({ ...base, mentioned: ["worker"], speakerOnHandedWork: true })).toBe(true);
    expect(steerMeantForSpeaker({ ...base, speakerId: "lead", mentioned: ["worker"] })).toBe(false);
  });
});
