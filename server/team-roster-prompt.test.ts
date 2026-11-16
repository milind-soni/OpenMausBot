import { describe, expect, it } from "vitest";

import { chiefOfStaffPrompt, chiefOfStaffSystemPrompt } from "./chief-of-staff.ts";
import { peerRosterPrompt, peerRosterSystemPrompt, type RosterMember } from "./peer-roster.ts";
import { buildSystemPrompt, teamAvailabilityPart, teamRosterPart } from "./system-prompt.ts";
import { keyedStable, withRosterNote } from "./drivers/prompt-split.ts";

const bot = (id: string, extra: Partial<RosterMember> = {}): RosterMember => ({ id, name: `Bot ${id}`, title: "Researcher", ...extra });
const team = [bot("a"), bot("b")];
const grown = [...team, bot("c", { title: "Designer" })];

describe("who is on the team and the engine process a conversation keeps", () => {
  it("a teammate's rules do not change when a bot joins; only the roster does", () => {
    const before = peerRosterPrompt(team, bot("self"));
    const after = peerRosterPrompt(grown, bot("self"));
    expect(after.rules).toBe(before.rules);
    expect(after.roster).not.toBe(before.roster);
    expect(after.roster).toContain("[id: c]");
    expect(after.rules).not.toContain("[id:");
    expect(peerRosterSystemPrompt(grown, bot("self"))).toBe(`${after.rules}\n${after.roster}`);
  });

  it("a Chief's rules do not change when a bot joins; only the roster does", () => {
    const chief = bot("chief", { chiefOfStaff: true });
    const before = chiefOfStaffPrompt("chief", [chief, ...team], true);
    const after = chiefOfStaffPrompt("chief", [chief, ...grown], true);
    expect(after.rules).toBe(before.rules);
    expect(after.roster).toContain("[id: c]");
    expect(after.rules).not.toContain("[id:");
    expect(chiefOfStaffSystemPrompt("chief", [chief, ...grown], true)).toBe(`${after.rules}\n${after.roster}`);
  });

  it("keeps the roster in the stable half, out of the per-turn half and out of what an engine process is keyed on", () => {
    const built = (members: RosterMember[]) => {
      const prompt = peerRosterPrompt(members, bot("self"));
      return buildSystemPrompt("You are Kiwi.", "", [
        { id: "coordination", label: "Team and who is speaking", text: ` ${prompt.rules}` },
        teamRosterPart(prompt.roster),
        teamAvailabilityPart(members),
      ]);
    };
    const [before, after] = [built(team), built(grown)];
    expect(after.stable).toContain("[id: c]");
    expect(after.roster).toContain("[id: c]");
    expect(after.stable).toContain(after.roster);
    // Availability changing every few turns re-sends the per-turn half; the roster is not part of it.
    expect(after.volatile).not.toContain("[TEAM ROSTER]");
    expect(keyedStable({ systemStable: after.stable, systemRoster: after.roster })).toBe(keyedStable({ systemStable: before.stable, systemRoster: before.roster }));
    expect(before.text).toContain(peerRosterSystemPrompt(team, bot("self")));
    expect(teamRosterPart("").text).toBe("");
  });

  it("tells a warm process the roster once it changed, and nothing while it has not", () => {
    const roster = "\n[TEAM ROSTER]\nBot c [id: c]\n[/TEAM ROSTER]";
    expect(withRosterNote("hello", roster, roster)).toBe("hello");
    const note = withRosterNote("hello", roster, "\n[TEAM ROSTER]\n[/TEAM ROSTER]");
    expect(note).toContain("It replaces the roster in your instructions");
    expect(note).toContain("Bot c [id: c]");
    expect(note.endsWith("\n\nhello")).toBe(true);
    expect(withRosterNote("hello", "", roster)).toContain("has no members now");
  });
});
