import { describe, expect, it } from "vitest";

import { MAUS_COLORS } from "./mascot";
import { CLASSIC_ROLE_IDS, READY_BOT_CATEGORIES, READY_BOTS, matchesReadyBot, readyBot, readyBotTemplate } from "./ready-bots";
import { MASCOT_BODY_IDS } from "../../shared/mascot-bodies";
import type { NewBotDefaults } from "../../shared/new-bot-defaults";

const defaults = (): NewBotDefaults => ({
  profile: {
    name: "Suggested", modelSelection: { instanceId: "claude", model: "opus" }, approvalMode: "ask",
    computer: "local", cwd: "/work/site", composio: true, color: "green",
  },
  memory: { "MEMORY.md": "- The person's own default note" },
  skills: [],
  routines: [{ name: "Mine", prompt: "Mine", schedule: { type: "daily", time: "07:00", weekdays: [1] }, enabled: true }],
});

describe("ready-made bots", () => {
  it("have unique ids and keep the six classic roles", () => {
    const ids = READY_BOTS.map((bot) => bot.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of CLASSIC_ROLE_IDS) expect(readyBot(id)).toBeDefined();
  });

  it("each has a look the app can draw, a category, and something to try", () => {
    for (const bot of READY_BOTS) {
      expect(Object.keys(MAUS_COLORS)).toContain(bot.look.color);
      expect(MASCOT_BODY_IDS).toContain(bot.look.mascotBody);
      expect(READY_BOT_CATEGORIES).toContain(bot.category);
      expect(bot.tryAsking.length).toBeGreaterThanOrEqual(2);
      expect(bot.description.length).toBeLessThanOrEqual(120);
    }
  });

  it("fit the standing-instructions limit", () => {
    for (const bot of READY_BOTS) {
      expect(new TextEncoder().encode(bot.soul).length).toBeLessThan(24_000);
      expect(bot.soul.length).toBeGreaterThan(200);
    }
  });

  it("only ever bring paused routines and notes under the memory folder", () => {
    for (const bot of READY_BOTS) {
      for (const routine of bot.routines ?? []) expect(routine.enabled).toBe(false);
      for (const path of Object.keys(bot.notes ?? {})) expect(path).toMatch(/^(MEMORY\.md|memory\/[a-z0-9-]+\.md)$/);
    }
  });
});

describe("readyBotTemplate", () => {
  const plant = readyBot("plant-care")!;

  it("sets who the bot is and how it looks", () => {
    const { profile } = readyBotTemplate(defaults(), plant);
    expect(profile).toMatchObject({ name: "Fern", title: "Plant care log", soul: plant.soul, color: "green", mascotBody: "drop" });
  });

  it("never changes the person's model, approval level, computer, folder or apps", () => {
    const { profile } = readyBotTemplate(defaults(), plant);
    expect(profile).toMatchObject({
      modelSelection: { instanceId: "claude", model: "opus" }, approvalMode: "ask", computer: "local", cwd: "/work/site", composio: true,
    });
  });

  it("adds notes beside the person's own and appends its routines paused", () => {
    const template = readyBotTemplate(defaults(), plant);
    expect(template.memory["MEMORY.md"]).toContain("The person's own default note");
    expect(template.memory["MEMORY.md"]).toContain("memory/plants.md");
    expect(template.memory["memory/plants.md"]).toContain("title: My plants");
    expect(template.routines.map((routine) => [routine.name, routine.enabled])).toEqual([["Mine", true], ["Weekly plant check", false]]);
  });

  it("leaves the defaults it was given untouched", () => {
    const given = defaults();
    readyBotTemplate(given, plant);
    expect(given).toEqual(defaults());
  });
});

describe("matchesReadyBot", () => {
  it("finds a bot by name, title, description or category, ignoring case", () => {
    const echo = readyBot("humanizer")!;
    expect(["echo", "HUMANIZER", "read like you", "writing", ""].every((query) => matchesReadyBot(echo, query))).toBe(true);
    expect(matchesReadyBot(echo, "spreadsheet")).toBe(false);
  });
});

describe("the social media manager", () => {
  const social = readyBot("social")!;

  it("puts posts in Postiz as drafts or scheduled, and publishes at once only when asked", () => {
    expect(social).toMatchObject({ title: "Social media manager", category: "work", apps: ["postiz"] });
    expect(social.soul).toContain("Add every post to Postiz as a draft, unless the user gave it a time to go out: then schedule it for that time.");
    expect(social.soul).toContain("Never publish a post straight away (type now) unless the user asks for that post to go out now.");
    expect(social.routines).toEqual([expect.objectContaining({ name: "Weekly post plan", enabled: false })]);
    expect(social.routines![0]!.prompt).toContain("as drafts");
  });

  it("brings its notes and leaves the person's approval level, so publishing asks as their other bots do", () => {
    const template = readyBotTemplate(defaults(), social);
    expect(template.profile.approvalMode).toBe("ask");
    expect(template.memory["memory/social.md"]).toContain("title: Social media");
    expect(template.memory["MEMORY.md"]).toContain("memory/social.md");
  });
});
