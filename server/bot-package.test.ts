import { describe, expect, it } from "vitest";

import { packageAgentAsMember, parseBotPackage, renderBotPackageMarkdown } from "./bot-package.ts";
import { BOT_INSTRUCTIONS_MAX_CHARS } from "./team-manifest.ts";

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
  const portableSkill = {
    name: "source-check",
    description: "Check sources before writing.",
    source: "conversation:source-check",
    instructions: "---\nname: source-check\ndescription: Check sources before writing.\n---\n\n# Source check\n",
  };

  it("round-trips portable skills and rejects dangling or mismatched references", () => {
    const withSkill = {
      ...validPackage,
      package: {
        ...validPackage.package,
        agents: [{ ...validPackage.package.agents[0], skills: [portableSkill.name] }],
        skills: { version: 1, entries: [portableSkill] },
      },
    };
    const parsed = parseBotPackage(withSkill);
    expect(parsed.package.agents[0]?.skills).toEqual(["source-check"]);
    expect(parseBotPackage(renderBotPackageMarkdown(parsed)).package.skills?.entries).toEqual([portableSkill]);
    expect(() => parseBotPackage({
      ...withSkill,
      package: { ...withSkill.package, agents: [{ ...withSkill.package.agents[0], skills: ["missing"] }] },
    })).toThrow("unknown skill");
    expect(() => parseBotPackage({
      ...withSkill,
      package: { ...withSkill.package, skills: { version: 1, entries: [{ ...portableSkill, description: "Different" }] } },
    })).toThrow("does not match its description");
  });

  it("parses the complete portable structure and strips authority fields", () => {
    const parsed = parseBotPackage(validPackage);
    expect(parsed.package.rooms![0]?.defaultResponder).toEqual({ kind: "agent", agent: "lead" });
    expect(parsed.package.agents[0]).not.toHaveProperty("autoApprove");
    expect(packageAgentAsMember(parsed.package.agents[0]!)).toEqual({
      key: "lead",
      name: "Ada",
      title: "Research Lead",
      description: "Own the brief.",
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

  it("accepts five-minute routine windows and rejects shorter ones", () => {
    const routine = {
      key: "morning-brief",
      name: "Morning brief",
      agent: "lead",
      prompt: "Summarize the overnight queue.",
      runOn: "maus",
      schedule: { type: "daily", time: "09:00", weekdays: [1] },
      durationMinutes: 5,
      enabledAfterInstall: false,
    };
    const document = {
      ...validPackage,
      package: { ...validPackage.package, routines: [routine] },
    };

    expect(parseBotPackage(document).package.routines?.[0]?.durationMinutes).toBe(5);
    expect(() => parseBotPackage({
      ...document,
      package: {
        ...document.package,
        routines: [{ ...routine, durationMinutes: 4 }],
      },
    })).toThrow(/expected number to be >=5/);
  });

  it("round-trips interval routine schedules", () => {
    const document = {
      ...validPackage,
      package: {
        ...validPackage.package,
        routines: [{
          key: "frequent-check",
          name: "Frequent check",
          agent: "lead",
          prompt: "Check the queue.",
          runOn: "maus",
          schedule: { type: "interval", everyMinutes: 15, anchorAt: 1_788_254_400_000 },
          durationMinutes: 30,
          timeoutMinutes: 20,
          enabledAfterInstall: false,
        }],
      },
    };

    const parsed = parseBotPackage(document);
    expect(parsed.package.routines?.[0]?.schedule).toEqual({
      type: "interval",
      everyMinutes: 15,
      anchorAt: 1_788_254_400_000,
    });
    expect(parsed.package.routines?.[0]?.timeoutMinutes).toBe(20);
    expect(renderBotPackageMarkdown(parsed)).toContain("every 15 minutes");
    expect(renderBotPackageMarkdown(parsed)).toContain("**Run limit:** 20 minutes");
    expect(() => parseBotPackage({
      ...document,
      package: {
        ...document.package,
        routines: [{
          ...document.package.routines[0],
          schedule: {
            type: "interval",
            everyMinutes: 15,
            anchorAt: Number.MAX_SAFE_INTEGER,
          },
        }],
      },
    })).toThrow();
  });

  it("round-trips a paused manual-only routine without inventing a schedule", () => {
    const manual = structuredClone(validPackage);
    manual.package.routines = [{
      key: "manual-review",
      name: "Manual review",
      agent: "lead",
      prompt: "Review when asked.",
      runOn: "maus",
      schedule: { type: "manual" },
      durationMinutes: 30,
      enabledAfterInstall: false,
    }];
    const parsed = parseBotPackage(manual);
    expect(parsed.package.routines?.[0]?.schedule).toEqual({ type: "manual" });
    expect(renderBotPackageMarkdown(parsed)).toContain("**Schedule:** manual only");
  });

  it("keeps long agent instructions within the shared portable cap", () => {
    const accepted = structuredClone(validPackage);
    accepted.package.agents[0].description = "A".repeat(6_219);
    expect(parseBotPackage(accepted).package.agents[0]?.description).toHaveLength(6_219);
    const rejected = structuredClone(validPackage);
    rejected.package.agents[0].description = "A".repeat(BOT_INSTRUCTIONS_MAX_CHARS + 1);
    expect(() => parseBotPackage(rejected)).toThrow("agents.0.description is too long");
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
});
