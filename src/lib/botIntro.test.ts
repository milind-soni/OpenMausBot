import { describe, expect, it } from "vitest";
import { botIntro, botSummary } from "./botIntro";

// Mirrors the seeded team in server/default-bots.ts (persona-prompt descriptions).
const persona = (role: string) => `Role: You are the ${role}.\nPersonality & Task: You do the work.`;
const DEFAULT_BOTS = [
  { title: "CEO", description: persona("CEO and Lead Project Manager") },
  { title: "Developer", description: persona("Lead Full-Stack Developer") },
  { title: "Marketer", description: persona("Lead Marketer and Brand Strategist") },
  { title: "UI/UX Designer", description: persona("Senior UI/UX Designer and Motion Specialist") },
  { title: "Tester", description: persona("Quality Assurance Lead and Reviewer") },
];

describe("botIntro", () => {
  it("never shows a default bot's persona prompt verbatim", () => {
    for (const bot of DEFAULT_BOTS) {
      const { summary, starters } = botIntro(bot);
      expect(summary).not.toMatch(/Role:|Personality/);
      expect(starters.length).toBeGreaterThan(0);
    }
    expect(botIntro(DEFAULT_BOTS[0]).summary).toBe("Your CEO and Lead Project Manager.");
  });

  it("gives each default role its own starters", () => {
    const sets = DEFAULT_BOTS.map((bot) => botIntro(bot).starters.join("|"));
    expect(new Set(sets).size).toBe(DEFAULT_BOTS.length);
  });

  it("keeps plain user-written descriptions and falls back to the title", () => {
    expect(botSummary("Helps me with taxes", "Accountant")).toBe("Helps me with taxes");
    expect(botSummary("", "Accountant")).toBe("Your Accountant.");
    expect(botSummary("", "")).toBeNull();
    expect(botIntro({ title: "", description: "" }).starters[0]).toBe("What can you help me with?");
  });
});
