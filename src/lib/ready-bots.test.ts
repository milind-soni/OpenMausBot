import { describe, expect, it } from "vitest";

import { MAUS_COLORS } from "./mascot";
import { CLASSIC_ROLE_IDS, READY_BOT_CATEGORIES, READY_BOTS, checkerTemplate, matchesReadyBot, readyBot, readyBotCopy, readyBotTemplate } from "./ready-bots";
import { setLocale } from "./i18n";
import en from "@/locales/en.json";
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

describe("readyBotCopy", () => {
  it("reads each bot's words from the catalog, and keeps a bot's own English when the catalog has none", () => {
    for (const bot of READY_BOTS) for (const field of ["title", "description", "try"]) expect(Object.hasOwn(en, `readyBots.bot.${bot.id}.${field}`), `${bot.id}.${field}`).toBe(true);
    const unlisted = { ...readyBot("humanizer")!, id: "not-in-the-catalog", title: "Its title", description: "Its words", tryAsking: ["Its ask"] };
    try {
      setLocale("pt-br");
      expect(readyBotCopy(unlisted)).toEqual({ title: "Its title", description: "Its words", tryAsking: "Its ask" });
      expect(readyBotCopy(readyBot("humanizer")!).title).not.toBe(readyBot("humanizer")!.title);
    } finally {
      setLocale("en");
    }
  });
});

describe("the social media manager", () => {
  const social = readyBot("social")!;

  it("puts posts in Postiz as drafts or scheduled, and publishes at once only when asked", () => {
    expect(social).toMatchObject({ title: "Social media manager", category: "work", apps: ["postiz"] });
    expect(social.soul).toContain("Add every post to Postiz as a draft, unless the user gave it a time to go out: then schedule it for that time.");
    expect(social.soul).toContain("Never publish a post straight away (type now) unless the user asks for that post to go out now.");
    expect(social.soul).toContain("show a preview of it with show_html, then add it to Postiz without waiting for a reply.");
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

describe("the checked-work pair", () => {
  const editor = readyBot("editor")!, checker = readyBot("checker")!;

  it("names each other, and only the checker asks for another provider's AI", () => {
    expect(editor).toMatchObject({ title: "Writer and editor", partner: "checker" });
    expect(checker).toMatchObject({ title: "Checker", partner: "editor", checker: true });
    expect(READY_BOTS.filter((bot) => bot.checker).map((bot) => bot.id)).toEqual(["checker"]);
    for (const bot of READY_BOTS) if (bot.partner) expect(readyBot(bot.partner)?.partner).toBe(bot.id);
  });

  it("has the worker change only what it was asked, list each change, and hand the request and source to the checker as files", () => {
    for (const line of [
      "Change only what the task names. Never alter a fact, event, name, number, date, description or quote you were not asked to change",
      "list every change you made",
      "in a new folder named checks/<a short name for the task> in your working folder, never beside the person's own files",
      "request.md with the person's request word for word, source.md with the original text exactly as given",
      "When the person attached the source, pass their file instead of source.md and name it as sent.",
      "pick the teammate whose role is Checker",
      "coordinate_bots (files, thread \"new\", a short title)",
      "Never paste the long text into the message.",
      "on a model from another provider than yours",
      "a draft or an edit of a document, have it checked; a quick answer needs no check",
      "When a brief asks you to check work, you are the checker: follow the brief and skip these steps.",
      "While a check runs, end your turn with one short line saying the work is being checked; don't show the result yet.",
      "rework true to the thread id from the first receipt, passing result.md, the source and request.md with files again on every round",
      "Stop after 3 check rounds",
      "what is still open, with the checker's last report",
      "\"Not checked:\" and the reason",
    ]) expect(editor.soul).toContain(line);
  });

  it("has the checker compare with both the source and the request, report every kind of issue, and pass only with none", () => {
    for (const line of [
      "against the original request and the source",
      "you never hand work on to anyone",
      "Changed fact:", "Added detail:", "Unmet instruction:", "Regression:", "Unlisted change:",
      "\"pass\" when there are no issues, or \"issues: N\" otherwise",
      "Never pass with an issue open",
      "answer \"cannot check\", never pass",
      "only your last message reaches whoever asked",
    ]) expect(checker.soul).toContain(line);
  });

  it("starts the checker on another provider's AI only when the server found one, and keeps everything else", () => {
    const template = readyBotTemplate(defaults(), checker);
    const other = { instanceId: "codex", model: "codex-default" };
    expect(checkerTemplate(template, other).profile).toMatchObject({ name: "Vera", modelSelection: other, approvalMode: "ask", cwd: "/work/site" });
    for (const none of [null, undefined]) expect(checkerTemplate(template, none)).toBe(template);
    expect(template.profile.modelSelection).toEqual({ instanceId: "claude", model: "opus" });
  });
});
