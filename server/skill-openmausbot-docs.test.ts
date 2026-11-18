import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadBundledSkills, selectBundledSkills } from "./skill-library.ts";

describe("openmausbot-docs skill guide", () => {
  const skills = loadBundledSkills(join(process.cwd(), "skills"));
  const guide = skills.find((skill) => skill.manifest.id === "openmausbot-docs")?.instructions ?? "";
  const ids = (text: string) => selectBundledSkills(text, [], skills).map((skill) => skill.manifest.id);

  it("mounts when the person asks about the app's own settings, and stays out of ordinary work", () => {
    for (const text of [
      "Where does OpenMausBot keep its bots?",
      "how do I change the approval level for one bot",
      "Open MausBot 的配置文件在哪",
      "where are my bot's routines stored",
      "explain OMB settings for connected apps",
      "MausBot 设置里记忆开关是什么意思",
    ]) {
      expect(ids(text), text).toContain("openmausbot-docs");
    }
    for (const text of [
      "write a paragraph about my bot",
      "book a call for Friday",
      "fix the failing test in src/app.ts",
      "summarize this email",
      "chart our signups by month",
      "Build a bot settings form for my Discord bot",
    ]) {
      expect(ids(text), text).not.toContain("openmausbot-docs");
    }
  });

  it("keeps the guide short, names the data folder, and every page it names exists", () => {
    expect(guide.split("\n").length).toBeLessThanOrEqual(110);
    expect(guide).toContain("~/.openmausbot/");
    expect(guide).toContain("config.json");
    expect(guide).toContain("bots/<botId>/SOUL.md");
    const pages = [...guide.matchAll(/`([a-z0-9-]+\.md)`/g)].map((match) => match[1]);
    expect(pages.length).toBeGreaterThan(20);
    for (const page of new Set(pages)) {
      expect(existsSync(join(process.cwd(), "docs", page)), page).toBe(true);
    }
  });

  it("sends the reader to the app before the docs, and never asks for a key to be quoted", () => {
    expect(guide).toContain("the app wins");
    expect(guide).toContain("never quote a key back");
    expect(guide).toContain("change them through the app or its API");
  });
});
