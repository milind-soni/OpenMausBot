import { describe, expect, it } from "vitest";

import { createBotPackageExport } from "./package-export.ts";
import type { BotRecord } from "./store.ts";

describe("package export", () => {
  it("keeps collaboration structure while excluding runtime authority and state", () => {
    const exported = createBotPackageExport({
      name: "Launch Crew",
      authorName: "Mira",
      bots: [
        {
          id: "private-id",
          threadId: "private-thread",
          name: "Lead",
          title: "Chief",
          description: "Coordinates",
          soul: "Preserve the mission.\n",
          notifications: true,
          color: "purple",
          unread: false,
          modelSelection: { instanceId: "private-engine", model: "secret-model", effort: "medium" },
          resumeCursors: { provider: "secret-session" },
          chiefOfStaff: true,
          composio: true,
          cwd: "/private/path",
          approvalMode: "full",
          autoApprove: true,
          alwaysAllow: ["everything"],
          installedPackage: {
            id: "source",
            name: "Source",
            release: "1.0.0",
            requiredApps: [{ slug: "github", label: "GitHub", reason: "Read repositories.", optional: true }],
          },
          playbooks: [{ key: "launch", name: "Launch", summary: "Ship", triggers: ["launch plan"], instructions: "Verify the release." }],
          createdAt: 1,
        },
      ],
      groups: [{
        id: "private-room-id",
        threadId: "private-room-thread",
        name: "Launch Room",
        memberIds: ["private-id"],
        defaultResponder: { kind: "member", botId: "private-id" },
        bulletin: "Ship carefully.",
        unread: false,
        createdAt: 1,
      }],
      routines: [
        {
          id: "private-routine-id",
          name: "Release check",
          prompt: "Verify release readiness.",
          target: "bot",
          botId: "private-id",
          runOn: "maus",
          enabled: true,
          schedule: { type: "daily", time: "09:00", weekdays: [1] },
          durationMinutes: 30,
          attachments: [{
            id: "private-attachment",
            kind: "file",
            name: "private.txt",
            path: "/private/calendar/context.txt",
            size: 42,
          }],
          nextRunAt: 123,
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: "private-room-routine-id",
          name: "Team release review",
          prompt: "Review the release together.",
          target: "room-goal",
          groupId: "private-room-id",
          botId: "private-id",
          runOn: "maus",
          enabled: true,
          schedule: { type: "daily", time: "10:00", weekdays: [1] },
          durationMinutes: 30,
          nextRunAt: 456,
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: "private-interval-routine-id",
          name: "Frequent release check",
          prompt: "Watch release readiness.",
          target: "bot",
          botId: "private-id",
          runOn: "maus",
          enabled: true,
          schedule: { type: "interval", everyMinutes: 15, anchorAt: 1_788_254_400_000 },
          durationMinutes: 30,
          timeoutMinutes: 20,
          nextRunAt: 789,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });
    expect(exported.package.routines).toHaveLength(2);
    expect(exported.package.agents[0].soul).toBe("Preserve the mission.\n");
    expect(exported.package.routines?.[1]?.schedule).toEqual({
      type: "interval",
      everyMinutes: 15,
      anchorAt: 1_788_254_400_000,
    });
    expect(exported.package.routines?.[1]?.timeoutMinutes).toBe(20);

    expect(exported).toMatchObject({
      format: "openmaus.package",
      package: {
        chiefOfStaff: "lead",
        requirements: { apps: [{ slug: "github" }] },
        rooms: [{ members: ["lead"], defaultResponder: { kind: "agent", agent: "lead" } }],
        routines: [
          { agent: "lead", enabledAfterInstall: false },
          { agent: "lead", enabledAfterInstall: false },
        ],
        playbooks: [{ key: "launch" }],
      },
    });
    expect(JSON.stringify(exported)).not.toMatch(/private-id|private-thread|private-engine|secret-model|secret-session|private\/path|private-attachment|approvalMode|autoApprove|alwaysAllow|nextRunAt/);
  });

  it("shares one identical playbook definition across multiple bots", () => {
    const sharedPlaybook = {
      key: "qualify",
      name: "Qualify",
      summary: "Check fit",
      triggers: ["qualify lead"],
      instructions: "Check the lead against the stated criteria.",
    };
    const bot = (id: string, name: string): BotRecord => ({
      id,
      threadId: `thread-${id}`,
      name,
      title: "Researcher",
      description: "Researches leads",
      notifications: true,
      color: "green" as const,
      unread: false,
      modelSelection: { instanceId: "engine", model: "model", effort: "medium" },
      resumeCursors: {},
      playbooks: [sharedPlaybook],
      createdAt: 1,
    });

    const exported = createBotPackageExport({
      name: "Lead Crew",
      bots: [bot("one", "Scout"), bot("two", "Reviewer")],
      groups: [],
      routines: [],
    });

    expect(exported.package.playbooks).toHaveLength(1);
    expect(exported.package.agents.map((agent) => agent.playbooks)).toEqual([
      ["qualify"],
      ["qualify"],
    ]);
  });
});
