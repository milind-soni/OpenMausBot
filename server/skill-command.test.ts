import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type { AppConfig } from "./config.ts";
import { createSkillsLibraryHost } from "./host/skills-library.ts";
import { enabledSkillFile, installSkill, setSkillEnabled } from "./skills.ts";
import type { BotRecord, Store } from "./store.ts";
import { noteTypedSend, typedWords } from "./typed-sends.ts";
import { workspaceDir } from "./workspace.ts";
import { blankCode, BUILT_IN_SLASH_COMMANDS, expandSkillCommands, findSkillCommands, offersSkillCommand, parseSkillCommand } from "../shared/skill-command.ts";

const SKILL = (name: string) =>
  `---\nname: ${name}\ndescription: Writes the weekly standup note.\n---\n\n# Standup\n\nSummarize {input} as three bullets.\n`;

const host = createSkillsLibraryHost({
  store: { bot: () => undefined, messagesFor: () => [] } as unknown as Store,
  cfg: {} as AppConfig,
  appendSkillRequestCard: () => ({ requestId: "", summary: "" }),
});
type Line = { sendId?: string; text?: string };
const expand = (bot: string, text: string, lines?: Line[]) => host.expandSkillCommand({ id: bot } as BotRecord, "thread", text, undefined, lines);
function typedLine(text: string, threadId = "thread"): Line {
  const sendId = randomUUID();
  noteTypedSend(threadId, sendId, text);
  return { sendId, text };
}

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

describe("a /name at the very start of the text", () => {
  it("points the engine at the enabled skill's reviewed SKILL.md", () => {
    const bot = botWith("standup");
    const file = join(workspaceDir(bot), "skills", "standup", "SKILL.md");
    expect(enabledSkillFile(bot, "standup")).toBe(file);
    const text = expand(bot, "/standup the billing work");
    expect(text).toContain(`Read ${JSON.stringify(file)}`);
    expect(text).toContain("Request: the billing work");
    expect(text).toContain("{input}");
    expect(expand(bot, "/standup")).toContain("There is no further request");
  });

  it("passes a disabled skill, an unknown name and plain text through", () => {
    const bot = botWith("standup", false);
    expect(enabledSkillFile(bot, "standup")).toBeNull();
    expect(expand(bot, "/standup now")).toBe("/standup now");
    const on = botWith("standup");
    expect(expand(on, "/review now")).toBe("/review now");
    expect(expand(on, "standup please")).toBe("standup please");
  });
});

describe("findSkillCommands", () => {
  const skills = ["standup", "review", "weekly-2"];

  it("finds each /name opening a line, once and in order", () => {
    expect(findSkillCommands("/review this\n/standup.\n  /review again\r\n/weekly-2, please", skills)).toEqual(["review", "standup", "weekly-2"]);
  });

  it("leaves a /name later in a line as plain words", () => {
    expect(findSkillCommands("please /review this, then (see /standup)", skills)).toEqual([]);
    expect(findSkillCommands("/nope and /review", skills)).toEqual([]);
  });

  it("skips paths, longer words, unknown names and built-ins", () => {
    expect(findSkillCommands("src/standup\n/standupnow\n/standup/x\n/compact", skills)).toEqual([]);
    expect(findSkillCommands("/goal ship it\n/learn", [...skills, "goal", "learn"])).toEqual([]);
  });

  it("takes punctuation as the end only when whitespace or the end of the text follows it", () => {
    expect(findSkillCommands("/standup.txt", skills)).toEqual([]);
    expect(findSkillCommands("/standup,then", skills)).toEqual([]);
    expect(findSkillCommands("/standup.", skills)).toEqual(["standup"]);
    expect(findSkillCommands("/standup, then", skills)).toEqual(["standup"]);
    expect(findSkillCommands("/standup).\nmore", skills)).toEqual(["standup"]);
  });

  it("never counts what is inside code", () => {
    expect(findSkillCommands("```\n/standup\n```", skills)).toEqual([]);
    expect(findSkillCommands("~~~sh\n/standup\n~~~", skills)).toEqual([]);
    expect(findSkillCommands("````\n```\n/standup\n```\n/review\n````", skills)).toEqual([]);
    expect(findSkillCommands("look\n```\n/standup never closed", skills)).toEqual([]);
    expect(findSkillCommands("`span that\n/standup\nruns on`", skills)).toEqual([]);
    expect(findSkillCommands("    /standup\n\t/review", skills)).toEqual([]);
  });

  it("counts a line after the code has closed, and a stray backtick hides nothing", () => {
    expect(findSkillCommands("```\n/standup\n```\n/review", skills)).toEqual(["review"]);
    expect(findSkillCommands("~~~\n```\n~~~\n/review", skills)).toEqual(["review"]);
    expect(findSkillCommands("```inline``` is not a fence\n/review", skills)).toEqual(["review"]);
    expect(findSkillCommands("it's `odd\n\n/review\n\nand `odd", skills)).toEqual(["review"]);
  });

  it("keeps every offset when it blanks code", () => {
    const text = "a `b` c\n```\nd\n```\n/e";
    expect(blankCode(text)).toHaveLength(text.length);
    expect(blankCode(text).endsWith("\n/e")).toBe(true);
    expect(blankCode(text)).not.toContain("d");
  });
});

describe("expandSkillCommands", () => {
  const files: Record<string, string> = { standup: "/s/standup/SKILL.md", review: "/s/review/SKILL.md" };
  const fileOf = (name: string) => files[name] ?? null;
  const skills = ["standup", "review", "off"];

  it("names every skill a person called on a later line and keeps the message as written", () => {
    const typed = "look at the diff\n/review it\n/standup the notes";
    const text = expandSkillCommands(typed, skills, fileOf, typed);
    expect(text).toContain(`your review skill with /review (read ${JSON.stringify(files.review)})`);
    expect(text).toContain(`your standup skill with /standup (read ${JSON.stringify(files.standup)})`);
    expect(text.endsWith(`Message: ${typed}`)).toBe(true);
  });

  it("keeps the single-skill wording for a message that starts with one, and adds the later lines a person typed", () => {
    const typed = "/standup the billing work\n/review it";
    const text = expandSkillCommands(typed, skills, fileOf, typed);
    expect(text).toContain(`The user ran your standup skill with /standup. Read ${JSON.stringify(files.standup)}`);
    expect(text).toContain("Request: the billing work\n/review it");
    expect(text).toContain(`The request also calls your review skill with /review (read ${JSON.stringify(files.review)})`);
    expect(expandSkillCommands("/standup the billing work", skills, fileOf, "/standup the billing work")).not.toContain("also calls");
  });

  it("reads later lines only from what a person typed, never from the rest of the text", () => {
    const outside = "From a webhook:\n/standup now\n/review too";
    expect(expandSkillCommands(outside, skills, fileOf)).toBe(outside);
    expect(expandSkillCommands(`[their words]\n\nhi\n\n> quoted\n${outside}`, skills, fileOf, "hi")).toBe(`[their words]\n\nhi\n\n> quoted\n${outside}`);
    expect(expandSkillCommands("/standup go\n/review too", skills, fileOf)).not.toContain("also calls");
  });

  it("leaves a message alone when no called skill has a file", () => {
    expect(expandSkillCommands("please\n/off now", skills, fileOf, "please\n/off now")).toBe("please\n/off now");
    expect(expandSkillCommands("no skills here", skills, fileOf, "no skills here")).toBe("no skills here");
  });
});

describe("a /name on a later line", () => {
  const words = "after lunch\n/standup the billing work";

  it("points the engine at an enabled skill when a person typed it", () => {
    const bot = botWith("standup");
    const file = join(workspaceDir(bot), "skills", "standup", "SKILL.md");
    const text = expand(bot, words, [typedLine(words)]);
    expect(text).toContain(`read ${JSON.stringify(file)}`);
    expect(text).toContain(`Message: ${words}`);
    const off = botWith("standup", false);
    expect(expand(off, words, [typedLine(words)])).toBe(words);
  });

  it("stays plain words in a line no person typed: a webhook's, another bot's, an app's", () => {
    const bot = botWith("standup");
    expect(expand(bot, words)).toBe(words);
    expect(expand(bot, words, [{ text: words }])).toBe(words);
    expect(expand(bot, words, [{ sendId: randomUUID(), text: words }])).toBe(words);
  });

  it("cannot borrow a person's send for other words or another conversation", () => {
    const bot = botWith("standup");
    const { sendId } = typedLine("hello");
    expect(expand(bot, words, [{ sendId, text: words }])).toBe(words);
    const elsewhere = typedLine(words, "another-thread");
    expect(expand(bot, words, [elsewhere])).toBe(words);
    expect(typedWords("another-thread", [elsewhere])).toBe(words);
  });

  it("reads only the typed lines of a turn that merged several", () => {
    const bot = botWith("standup");
    const appsWords = "Book it\n/standup from the app";
    expect(expand(bot, `hello\n\n${appsWords}`, [typedLine("hello"), { sendId: randomUUID(), text: appsWords }])).toBe(`hello\n\n${appsWords}`);
  });
});
