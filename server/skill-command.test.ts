import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { enabledSkillFile, expandSkillCommandTurnText, installSkill, setSkillEnabled } from "./skills.ts";
import { workspaceDir } from "./workspace.ts";
import { BUILT_IN_SLASH_COMMANDS, expandSkillCommands, findSkillCommands, offersSkillCommand, parseSkillCommand } from "../shared/skill-command.ts";

const SKILL = (name: string) =>
  `---\nname: ${name}\ndescription: Writes the weekly standup note.\n---\n\n# Standup\n\nSummarize {input} as three bullets.\n`;

function botWith(name: string, enabled = true): string {
  const bot = `slash-bot-${Math.random().toString(36).slice(2, 10)}`;
  const installed = installSkill(bot, "local:test", [{ path: "SKILL.md", content: SKILL(name) }]);
  expect("error" in installed).toBe(false);
  if (enabled) expect("error" in setSkillEnabled(bot, name, true)).toBe(false);
  return bot;
}

describe("parseSkillCommand", () => {
  it("reads a leading /name and the request after it", () => {
    expect(parseSkillCommand("/standup", ["standup"])).toEqual({ name: "standup", request: "" });
    expect(parseSkillCommand("/standup  the billing work\nand more", ["standup"])).toEqual({ name: "standup", request: "the billing work\nand more" });
    expect(parseSkillCommand("  /weekly-2 go", ["weekly-2"])).toEqual({ name: "weekly-2", request: "go" });
  });

  it("leaves anything else as ordinary text", () => {
    expect(parseSkillCommand("/standupnow", ["standup"])).toBeNull();
    expect(parseSkillCommand("please run /standup", ["standup"])).toBeNull();
    expect(parseSkillCommand("/compact", ["standup"])).toBeNull();
    expect(parseSkillCommand("/Standup", ["standup"])).toBeNull();
  });

  it("never lets a skill shadow a built-in command", () => {
    for (const name of BUILT_IN_SLASH_COMMANDS) {
      expect(parseSkillCommand(`/${name} x`, [name])).toBeNull();
      expect(offersSkillCommand(name)).toBe(false);
    }
    expect(offersSkillCommand("standup")).toBe(true);
  });
});

describe("expandSkillCommandTurnText", () => {
  it("points the engine at the enabled skill's reviewed SKILL.md", () => {
    const bot = botWith("standup");
    const file = join(workspaceDir(bot), "skills", "standup", "SKILL.md");
    expect(enabledSkillFile(bot, "standup")).toBe(file);
    const text = expandSkillCommandTurnText(bot, "/standup the billing work");
    expect(text).toContain(`Read ${JSON.stringify(file)}`);
    expect(text).toContain("Request: the billing work");
    expect(text).toContain("{input}");
    expect(expandSkillCommandTurnText(bot, "/standup")).toContain("There is no further request");
  });

  it("passes a disabled skill, an unknown name and plain text through", () => {
    const bot = botWith("standup", false);
    expect(enabledSkillFile(bot, "standup")).toBeNull();
    expect(expandSkillCommandTurnText(bot, "/standup now")).toBe("/standup now");
    const on = botWith("standup");
    expect(expandSkillCommandTurnText(on, "/review now")).toBe("/review now");
    expect(expandSkillCommandTurnText(on, "standup please")).toBe("standup please");
  });
});

describe("findSkillCommands", () => {
  const skills = ["standup", "review", "weekly-2"];

  it("finds each /name that is its own word, anywhere in the message, once and in order", () => {
    expect(findSkillCommands("please /review this, then /standup.\n/review again", skills)).toEqual(["review", "standup"]);
    expect(findSkillCommands("/weekly-2 and (see /standup)", skills)).toEqual(["weekly-2", "standup"]);
  });

  it("skips paths, longer words, unknown names and built-ins", () => {
    expect(findSkillCommands("edit src/standup or /standupnow or /compact", skills)).toEqual([]);
    expect(findSkillCommands("/goal ship it /learn", [...skills, "goal", "learn"])).toEqual([]);
  });
});

describe("expandSkillCommands", () => {
  const files: Record<string, string> = { standup: "/s/standup/SKILL.md", review: "/s/review/SKILL.md" };
  const fileOf = (name: string) => files[name] ?? null;
  const skills = ["standup", "review", "off"];

  it("names every skill called later in a message and keeps the message as written", () => {
    const text = expandSkillCommands("look at the diff, /review it and write /standup notes", skills, fileOf);
    expect(text).toContain(`your review skill with /review (read ${JSON.stringify(files.review)})`);
    expect(text).toContain(`your standup skill with /standup (read ${JSON.stringify(files.standup)})`);
    expect(text.endsWith("Message: look at the diff, /review it and write /standup notes")).toBe(true);
  });

  it("keeps the single-skill wording for a message that starts with one, and adds the others it calls", () => {
    const text = expandSkillCommands("/standup the billing work, then /review it", skills, fileOf);
    expect(text).toContain(`The user ran your standup skill with /standup. Read ${JSON.stringify(files.standup)}`);
    expect(text).toContain("Request: the billing work, then /review it");
    expect(text).toContain(`The request also calls your review skill with /review (read ${JSON.stringify(files.review)})`);
    expect(expandSkillCommands("/standup the billing work", skills, fileOf)).not.toContain("also calls");
  });

  it("leaves a message alone when no called skill has a file", () => {
    expect(expandSkillCommands("please /off now", skills, fileOf)).toBe("please /off now");
    expect(expandSkillCommands("no skills here", skills, fileOf)).toBe("no skills here");
  });
});

describe("expandSkillCommandTurnText later in a message", () => {
  it("points the engine at an enabled skill called mid-sentence", () => {
    const bot = botWith("standup");
    const file = join(workspaceDir(bot), "skills", "standup", "SKILL.md");
    const text = expandSkillCommandTurnText(bot, "after lunch, /standup the billing work");
    expect(text).toContain(`read ${JSON.stringify(file)}`);
    expect(text).toContain("Message: after lunch, /standup the billing work");
    const off = botWith("standup", false);
    expect(expandSkillCommandTurnText(off, "after lunch, /standup")).toBe("after lunch, /standup");
  });
});
