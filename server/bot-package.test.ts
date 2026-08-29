import { describe, expect, it } from "vitest";

import { packageAgentAsMember, parseBotPackage, renderBotPackageMarkdown } from "./bot-package.ts";

const validPackage: any = {
  format: "openmaus.package",
  version: 1,
  package: {
    id: "research-desk",
    release: "1.0.0",
    name: "Research Desk",
    tagline: "Turn a question into a sourced brief.",
    summary: "A small research team.",
    category: "Research",
    author: { name: "OpenMausBot" },
    license: "MIT",
    outcomes: ["Produce a sourced brief."],
    setupMinutes: 3,
    requirements: { apps: [], capabilities: [] },
    agents: [
      {
        key: "lead",
        name: "Ada",
        title: "Research Lead",
        description: "Own the brief.",
        reportingMode: "actionable",
        appearance: { color: "purple" },
        playbooks: ["source-check"],
        autoApprove: true,
      },
    ],
    chiefOfStaff: "lead",
    rooms: [
      {
        key: "desk",
        name: "Research Desk",
        members: ["lead"],
        bulletin: "Cite sources.",
        defaultResponder: { kind: "agent", agent: "lead" },
      },
    ],
    playbooks: [
      {
        key: "source-check",
        name: "Source Check",
        summary: "Verify sources.",
        triggers: ["research brief"],
        instructions: "Separate facts from inference.",
      },
    ],
  },
};

describe("bot packages", () => {
  it("parses the complete portable structure and strips authority fields", () => {
    const parsed = parseBotPackage(validPackage);
    expect(parsed.package.rooms![0]?.defaultResponder).toEqual({ kind: "agent", agent: "lead" });
    expect(parsed.package.agents[0]).not.toHaveProperty("autoApprove");
    expect(packageAgentAsMember(parsed.package.agents[0]!)).toEqual({
      key: "lead",
      name: "Ada",
      title: "Research Lead",
      description: "Own the brief.",
      reportingMode: "actionable",
      appearance: { color: "purple" },
    });
  });

  it("round-trips one Chief-of-Staff-readable Markdown playbook", () => {
    const markdown = renderBotPackageMarkdown(parseBotPackage(validPackage));
    expect(markdown).toContain("## Activation");
    expect(markdown).toContain("Give this file to your Chief of Staff");
    expect(markdown).not.toContain("autoApprove");
    expect(parseBotPackage(markdown).package).toMatchObject({
      id: "research-desk",
      chiefOfStaff: "lead",
      agents: [{ key: "lead", name: "Ada" }],
    });
  });

  it("rejects dangling agent, room, playbook, chief, and routine references", () => {
    expect(() => parseBotPackage({
      ...validPackage,
      package: { ...validPackage.package, chiefOfStaff: "missing" },
    })).toThrow("Unknown Chief of Staff");
    expect(() => parseBotPackage({
      ...validPackage,
      package: {
        ...validPackage.package,
        agents: [{ ...validPackage.package.agents[0], playbooks: ["missing"] }],
      },
    })).toThrow("unknown playbook");
  });

  it("renders a coordinator-free package without inventing a Chief role", () => {
    const withoutCoordinator = parseBotPackage({
      ...validPackage,
      package: { ...validPackage.package, chiefOfStaff: undefined },
    });
    const markdown = renderBotPackageMarkdown(withoutCoordinator);
    expect(markdown).toContain("agent harness or person setting up the team");
    expect(markdown).toContain("No coordinator is required");
    expect(markdown).not.toContain("You are the Chief of Staff");
  });

  it("rejects an inverted interval before activation can mutate state", () => {
    expect(() => parseBotPackage({
      ...validPackage,
      package: {
        ...validPackage.package,
        routines: [{
          key: "watch",
          name: "Watch",
          agent: "lead",
          prompt: "Watch for changes.",
          runOn: "maus",
          schedule: { type: "interval", everyMinutes: 5, from: "19:00", to: "08:00", weekdays: [1] },
          durationMinutes: 15,
          enabledAfterInstall: false,
        }],
      },
    })).toThrow("interval end time must be after its start time");
  });
});
