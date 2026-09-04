import { describe, expect, it } from "vitest";

import { teamImportPreview } from "./team-import";

describe("team import preview", () => {
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

  it("preserves safe mascot bodies for static import preview", () => {
    const preview = teamImportPreview({
      format: "openmaus.team",
      version: 2,
      team: {
        name: "Appearance team",
        members: [{
          name: "Ada",
          appearance: {
            color: "cyan",
            mascotExpression: "happy",
            mascotBody: "cursor",
          },
        }, {
          name: "Fallback",
          appearance: { color: "not-a-color", mascotBody: "not-a-body" },
        }],
      },
    });

    expect(preview.members[0]?.appearance).toEqual({
      color: "cyan",
      mascotExpression: "happy",
      mascotBody: "cursor",
    });
    expect(preview.members[1]?.appearance).toBeUndefined();
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

  it("marks manual-only routines as paused without inventing a schedule", () => {
    const preview = teamImportPreview({
      format: "openmaus.package",
      version: 1,
      package: {
        name: "Manual team",
        agents: [{ key: "reviewer", name: "Reviewer" }],
        routines: [{
          name: "Imported review",
          agent: "reviewer",
          prompt: "Review when asked.",
          runOn: "maus",
          schedule: { type: "manual" },
          durationMinutes: 30,
          enabledAfterInstall: false,
        }],
      },
    });

    expect(preview.routineEntries).toMatchObject([{
      name: "Imported review",
      owner: "Reviewer",
      schedule: "Manual only",
      status: "Paused after import",
    }]);
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
