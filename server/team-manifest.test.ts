import { describe, expect, it } from "vitest";

import { FACE_BOX } from "../shared/cursor-face-data.ts";
import { createCustomMascotFitContext, suggestCustomMascotAnchor } from "../shared/custom-mascot-fitting.ts";
import { type CustomMascotPoint, type MascotProfile } from "../shared/mascot-profile.ts";
import { validateCustomMascotDefinition } from "./custom-mascot-validation.ts";
import { createTeamManifest, importedMemberProfile, parseTeamManifest } from "./team-manifest.ts";

function customMascotProfile(): MascotProfile {
  const outline: CustomMascotPoint[] = Array.from({ length: 96 }, (_, index) => {
    const angle = (index / 96) * Math.PI * 2;
    return [FACE_BOX / 2 + Math.cos(angle) * 108, FACE_BOX / 2 + Math.sin(angle) * 108] as const;
  });
  const anchor = suggestCustomMascotAnchor(createCustomMascotFitContext(outline));
  const shape = validateCustomMascotDefinition({ name: "Bunny", outline, anchor });
  return { version: 1, shapes: [shape], selected: { kind: "custom", shapeId: shape.id } };
}

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

  it("round-trips validated custom mascot profiles and omits empty libraries", () => {
    const profile = customMascotProfile();
    const manifest = createTeamManifest({ name: "Makers", memberIds: ["one"] }, [{
      id: "one", name: "One", title: "", description: "", color: "blue", mascotProfile: profile,
    }]);
    expect(manifest.team.members[0]!.appearance.mascotProfile).toEqual(profile);
    const parsed = parseTeamManifest(manifest).team.members[0]!;
    expect(importedMemberProfile(parsed, new Set()).mascotProfile).toEqual(profile);

    const stale = structuredClone(manifest);
    stale.team.members[0]!.appearance.mascotProfile!.shapes[0]!.name = "Changed";
    expect(() => importedMemberProfile(parseTeamManifest(stale).team.members[0]!, new Set())).toThrow(/fingerprint/);

    const empty: MascotProfile = { version: 1, shapes: [], selected: { kind: "builtin", bodyId: "cursor" } };
    const withoutShapes = createTeamManifest({ name: "Makers", memberIds: ["one"] }, [{
      id: "one", name: "One", title: "", description: "", color: "blue", mascotProfile: empty,
    }]);
    expect(withoutShapes.team.members[0]!.appearance).not.toHaveProperty("mascotProfile");
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
    expect(importedMemberProfile(member, taken)).toEqual({
      name: "Mira 2",
      title: "Lead",
      description: "Coordinates",
      color: "purple",
      mascotExpression: "focused",
    });
    expect(importedMemberProfile({ ...member, name: "MIRA" }, taken).name).toBe("MIRA 3");
    expect(importedMemberProfile({ ...member, name: "Scout" }, taken).name).toBe("Scout");
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
