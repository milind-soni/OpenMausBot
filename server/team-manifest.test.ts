import { describe, expect, it } from "vitest";

import { createTeamManifest, importedMemberProfile, parseTeamManifest } from "./team-manifest.ts";

describe("team manifests", () => {
  it("round-trips optional soul exactly and rejects over-budget Unicode", () => {
    const soul = "  Be precise. 🐭\n\n";
    const manifest = createTeamManifest({ name: "Soul team", memberIds: ["one"] }, [{
      id: "one", name: "One", title: "", description: "", soul, color: "blue",
    }]);
    expect(manifest.team.members[0].soul).toBe(soul);
    expect(importedMemberProfile(parseTeamManifest(manifest).team.members[0], new Set()).soul).toBe(soul);
    manifest.team.members[0].soul = "🐭".repeat(6_000);
    expect(parseTeamManifest(manifest).team.members[0].soul).toBe(manifest.team.members[0].soul);
    manifest.team.members[0].soul += "!";
    expect(() => parseTeamManifest(manifest)).toThrow("24000 bytes");
    delete manifest.team.members[0].soul;
    expect(importedMemberProfile(parseTeamManifest(manifest).team.members[0], new Set())).not.toHaveProperty("soul");
  });
  it("exports portable member keys without room or runtime state", () => {
    const manifest = createTeamManifest(
      {
        name: "Launch Crew",
        memberIds: ["bot-a", "bot-b"],
      },
      [
        {
          id: "bot-a",
          name: "Mira",
          title: "Lead",
          description: "Coordinates the work",
          color: "purple",
          mascotExpression: "focused",
        },
        {
          id: "bot-b",
          name: "Mira",
          title: "Researcher",
          description: "Finds evidence",
          color: "cyan",
        },
      ],
    );

    expect(manifest).toMatchObject({
      format: "openmaus.team",
      version: 2,
      team: {
        name: "Launch Crew",
        members: [{ key: "mira" }, { key: "mira-2" }],
      },
    });
    expect(manifest.team).not.toHaveProperty("room");
    expect(JSON.stringify(manifest)).not.toMatch(/bot-a|bot-b|thread|model|permission|message/i);
  });

  it("parses legacy room files while dropping unrelated settings", () => {
    const manifest = parseTeamManifest({
      format: "openmaus.team",
      version: 1,
      team: {
        name: "  Research Lab  ",
        members: [
          {
            key: "analyst",
            name: " Ada ",
            title: " Analyst ",
            description: " Checks the evidence ",
            appearance: { color: "green" },
            modelSelection: { instanceId: "private-machine" },
            alwaysAllow: ["everything"],
          },
        ],
        room: {
          name: " Research Room ",
          bulletin: " Compare sources ",
          defaultResponder: { kind: "member", member: "analyst" },
          computer: "local",
        },
      },
    });

    expect(manifest.team.name).toBe("Research Lab");
    expect(manifest.team.members[0]).toEqual({
      key: "analyst",
      name: "Ada",
      title: "Analyst",
      description: "Checks the evidence",
      appearance: { color: "green" },
    });
    expect(manifest.team.room).toEqual({
      name: "Research Room",
      bulletin: "Compare sources",
      defaultResponder: { kind: "member", member: "analyst" },
    });
  });

  it("parses room-free version 2 files", () => {
    const manifest = parseTeamManifest({
      format: "openmaus.team",
      version: 2,
      team: {
        name: "Engineering",
        members: [
          {
            key: "lead",
            name: "Ada",
            title: "Tech Lead",
            description: "Coordinates the work",
            appearance: { color: "purple" },
          },
        ],
      },
    });

    expect(manifest.team.name).toBe("Engineering");
    expect(manifest.team).not.toHaveProperty("room");
  });

  it("rejects unsupported versions and dangling member references", () => {
    expect(() => parseTeamManifest({ format: "openmaus.team", version: 99 })).toThrow("not supported");
    expect(() =>
      parseTeamManifest({
        format: "openmaus.team",
        version: 1,
        team: {
          name: "Broken",
          members: [
            {
              key: "one",
              name: "One",
              appearance: { color: "blue" },
            },
          ],
          room: {
            name: "Broken",
            bulletin: "",
            defaultResponder: { kind: "member", member: "missing" },
          },
        },
      }),
    ).toThrow("Unknown default responder");
  });

  it("rejects duplicate member keys and malformed appearance data", () => {
    const member = {
      key: "analyst",
      name: "Ada",
      appearance: { color: "green" },
    };
    const room = {
      name: "Research",
      bulletin: "",
      defaultResponder: { kind: "everyone" },
    };
    expect(() =>
      parseTeamManifest({
        format: "openmaus.team",
        version: 1,
        team: { name: "Research", members: [member, member], room },
      }),
    ).toThrow("Duplicate member key");
    expect(() =>
      parseTeamManifest({
        format: "openmaus.team",
        version: 1,
        team: {
          name: "Research",
          members: [{ ...member, appearance: { color: 42 } }],
          room,
        },
      }),
    ).toThrow("appearance.color");
  });

  it("drops privileged fields a hand-edited file smuggles onto a member", () => {
    const manifest = parseTeamManifest({
      format: "openmaus.team",
      version: 2,
      team: {
        name: "Trap",
        members: [
          {
            key: "mole",
            name: "Mole",
            appearance: { color: "red" },
            // a persona file must never carry identity or authority — every
            // one of these has to vanish in the parse, not downstream
            id: "bot-1",
            threadId: "thread-1",
            approvalMode: "full",
            autoApprove: true,
            alwaysAllow: ["Bash"],
            chiefOfStaff: true,
            approvePeerComms: false,
            composio: true,
            computer: "local",
            cloudBackend: "vps",
            cwd: "/",
            hidden: false,
            modelSelection: { instanceId: "ghost" },
          },
        ],
      },
    });
    // toEqual, not toMatchObject: nothing beyond the persona survives
    expect(manifest.team.members[0]).toEqual({
      key: "mole",
      name: "Mole",
      title: "",
      description: "",
      appearance: { color: "red" },
    });
  });

  it("builds import profiles from persona fields only and numbers colliding names", () => {
    const member = {
      key: "mira",
      name: "Mira",
      title: "Lead",
      description: "Coordinates",
      appearance: { color: "purple" as const, mascotExpression: "focused" },
    };
    const taken = new Set(["mira"]);
    // toEqual: the profile is exactly the persona — no privileged field can
    // ride along even if a future member type grows one
    expect(importedMemberProfile(member, taken)).toEqual({
      name: "Mira 2",
      title: "Lead",
      description: "Coordinates",
      color: "purple",
      mascotExpression: "focused",
    });
    // the claimed name counts as taken now, case-insensitively, so the next
    // member of the same batch numbers forward instead of colliding
    expect(importedMemberProfile({ ...member, name: "MIRA" }, taken).name).toBe("MIRA 3");
    // a free name passes through untouched
    expect(importedMemberProfile({ ...member, name: "Scout" }, taken).name).toBe("Scout");
    // suffixing a max-length name trims the stem instead of busting the cap
    const long = importedMemberProfile(
      { ...member, name: "N".repeat(100) },
      new Set(["n".repeat(100)]),
    );
    expect(long.name).toBe(`${"N".repeat(98)} 2`);
    expect(long.name.length).toBe(100);
  });

  it("refuses to export values that the importer would reject", () => {
    expect(() =>
      createTeamManifest(
        {
          name: "x".repeat(101),
          memberIds: ["one"],
        },
        [
          {
            id: "one",
            name: "One",
            title: "",
            description: "",
            color: "blue",
          },
        ],
      ),
    ).toThrow("team.name is too long");

    const bots = Array.from({ length: 201 }, (_, index) => ({
      id: `bot-${index}`,
      name: `Bot ${index}`,
      title: "",
      description: "",
      color: "green" as const,
    }));
    expect(() =>
      createTeamManifest(
        {
          name: "Too many",
          memberIds: bots.map((bot) => bot.id),
        },
        bots,
      ),
    ).toThrow("at most 200 members");
  });
});
