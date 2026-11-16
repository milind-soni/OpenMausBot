import { describe, expect, it } from "vitest";

import { chiefOfStaffPrompt, chiefOfStaffSystemPrompt } from "./chief-of-staff.ts";
import { peerRosterPrompt, peerRosterSystemPrompt, type RosterMember } from "./peer-roster.ts";
import { buildSystemPrompt, teamRosterPart } from "./system-prompt.ts";

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

  it("keeps the roster out of the half an engine process is keyed on", () => {
    const built = (members: RosterMember[]) => {
      const prompt = peerRosterPrompt(members, bot("self"));
      return buildSystemPrompt("You are Kiwi.", "", [
        { id: "coordination", label: "Team and who is speaking", text: ` ${prompt.rules}` },
        teamRosterPart(prompt.roster),
      ]);
    };
    expect(built(grown).stable).toBe(built(team).stable);
    expect(built(grown).volatile).toContain("[id: c]");
    expect(built(team).text).toContain(peerRosterSystemPrompt(team, bot("self")));
    expect(teamRosterPart("").text).toBe("");
  });
});
