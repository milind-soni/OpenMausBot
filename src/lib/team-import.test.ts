import { describe, expect, it } from "vitest";

import { teamImportPreview } from "./team-import";
import { takeImportName } from "../../shared/import-name";

describe("team import preview", () => {
  it("previews numbered copies using the same name allocator as the importer", () => {
    const taken = new Set(["scout", "scout 2", "archived"]);
    expect(takeImportName("SCOUT", taken)).toBe("SCOUT 3");
    expect(takeImportName("Scout", taken)).toBe("Scout 4");
    expect(takeImportName("Archived", taken)).toBe("Archived 2");
    const long = "a".repeat(100);
    taken.add(long);
    expect(takeImportName(long, taken)).toBe(`${"a".repeat(98)} 2`);
  });
  it("previews portable backups and validates their references before confirmation", () => {
    const backup = {
      format: "openmaus.backup", version: 1, name: "Saved team", exportedAt: 0,
      bots: [{ key: "bot", name: "Scout", title: "Research", description: "", color: "cyan", chiefOfStaff: false,
        hidden: true, playbooks: [], activeTask: "thread", tasks: [{ key: "thread", title: "Chat", createdAt: 0,
          activeLeafId: "message", messages: [{ id: "message", parentId: null, role: "user", text: "Hello", at: 0 }] }] }],
      groups: [], routines: [],
    };
    expect(teamImportPreview(backup)).toMatchObject({ kind: "backup", name: "Saved team", rooms: 0, conversations: 1, archivedBots: 1, members: [{ name: "Scout", title: "Research" }] });
    expect(() => teamImportPreview({ ...backup, version: 999 })).toThrow("Invalid backup");
    backup.bots[0].activeTask = "unknown";
    expect(() => teamImportPreview(backup)).toThrow("unknown active task");
  });

  it.each([1, 2])("previews version %s team files", (version) => {
    const preview = teamImportPreview({
      format: "openmaus.team",
      version,
      team: {
        name: " Engineering ",
        description: " Ships software ",
        members: [{ name: " Ada ", title: " Tech Lead " }],
        ...(version === 1
          ? { room: { name: "Engineering", bulletin: "", defaultResponder: { kind: "everyone" } } }
          : {}),
      },
    });

    expect(preview).toMatchObject({
      name: "Engineering",
      description: "Ships software",
      members: [{ name: "Ada", title: "Tech Lead" }],
    });
  });

  it("rejects unsupported and empty files", () => {
    expect(() => teamImportPreview({ format: "openmaus.team", version: 3, team: {} })).toThrow("not supported");
    expect(() =>
      teamImportPreview({ format: "openmaus.team", version: 2, team: { name: "Empty", members: [] } }),
    ).toThrow("no members");
  });

  it("previews the complete package setup before installation", () => {
    const preview = teamImportPreview({
      format: "openmaus.package",
      version: 1,
      package: {
        name: "Lead Desk",
        summary: "Find qualified conversations.",
        agents: [
          { key: "scout", name: "Scout", title: "Researcher" },
          { key: "writer", name: "Writer", title: "Outreach" },
        ],
        chiefOfStaff: "scout",
        rooms: [{}],
        playbooks: [{}, {}],
        routines: [{}],
        requirements: {
          apps: [
            { label: "Reddit" },
            { label: "Google Sheets", optional: true },
          ],
        },
      },
    });

    expect(preview).toMatchObject({
      kind: "package",
      name: "Lead Desk",
      chiefOfStaff: "Scout",
      rooms: 1,
      playbooks: 2,
      routines: 1,
      apps: [
        { label: "Reddit", optional: false },
        { label: "Google Sheets", optional: true },
      ],
    });
  });

  it("previews a portable Markdown playbook", () => {
    const preview = teamImportPreview(`---
botmrr: 1
name: Lead Desk
summary: Find qualified conversations.
agents:
  - key: scout
    name: Scout
    title: Researcher
chiefOfStaff: scout
rooms: []
playbooks: []
routines: []
requirements:
  apps:
    - label: Reddit
---

# Lead Desk

## Activation

Create the team.`);

    expect(preview).toMatchObject({
      kind: "package",
      name: "Lead Desk",
      chiefOfStaff: "Scout",
      apps: [{ label: "Reddit", optional: false }],
    });
  });
});
