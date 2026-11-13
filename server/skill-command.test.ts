import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type { AppConfig } from "./config.ts";
import { createSkillsLibraryHost } from "./host/skills-library.ts";
import { enabledSkillFile, installSkill, setSkillEnabled } from "./skills.ts";
import type { BotRecord, Store } from "./store.ts";
import { noteTypedSend, typedWords } from "./typed-sends.ts";
import { workspaceDir } from "./workspace.ts";
import { blankCode, BUILT_IN_SLASH_COMMANDS, offersSkillCommand, parseSkillCommand, skillCalls, skillMentions } from "../shared/skill-command.ts";

const SKILL = (name: string) =>
  `---\nname: ${name}\ndescription: Writes the weekly standup note.\n---\n\n# Standup\n\nSummarize {input} as three bullets.\n`;

const host = createSkillsLibraryHost({
  store: { bot: () => undefined, messagesFor: () => [] } as unknown as Store,
  cfg: {} as AppConfig,
  appendSkillRequestCard: () => ({ requestId: "", summary: "" }),
});
type Line = { sendId?: string; text?: string };
const expand = (bot: string, text: string, lines?: Line[], ownStart = false) => host.expandSkillCommand({ id: bot } as BotRecord, "thread", text, undefined, lines, ownStart);
function typedLine(text: string, threadId = "thread"): Line {
  const sendId = randomUUID();
  noteTypedSend(threadId, sendId, text);
  return { sendId, text };
}
const typedBy = (bot: string, text: string) => expand(bot, text, [typedLine(text)]);

function botWith(name: string, enabled = true, bot = `slash-bot-${Math.random().toString(36).slice(2, 10)}`): string {
  const installed = installSkill(bot, "local:test", [{ path: "SKILL.md", content: SKILL(name) }]);
  expect("error" in installed).toBe(false);
  if (enabled) expect("error" in setSkillEnabled(bot, name, true)).toBe(false);
  return bot;
}

describe("parseSkillCommand", () => {
  it("reads a leading /name and the request after it", () => {
    expect(parseSkillCommand("/standup", ["standup"])).toEqual({ name: "standup", request: "" });
    expect(parseSkillCommand("/standup  the billing work\nand more", ["standup"])).toEqual({ name: "standup", request: "the billing work\nand more" });
    expect(parseSkillCommand("/standup.", ["standup"])).toEqual({ name: "standup", request: "" });
    expect(parseSkillCommand("/standup: the billing work", ["standup"])).toEqual({ name: "standup", request: "the billing work" });
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

describe("words a person typed", () => {
  it("offers only enabled skill files for driver staging", () => {
    const bot = botWith("standup");
    const record = { id: bot } as BotRecord;
    expect(host.turnSkillFiles(record, "thread")).toEqual([enabledSkillFile(bot, "standup")]);
    expect("error" in setSkillEnabled(bot, "standup", false)).toBe(false);
    expect(host.turnSkillFiles(record, "thread")).toEqual([]);
  });

  it("points the engine at the enabled skill's reviewed SKILL.md", () => {
    const bot = botWith("standup");
    const file = join(workspaceDir(bot), "skills", "standup", "SKILL.md");
    expect(enabledSkillFile(bot, "standup")).toBe(file);
    const text = typedBy(bot, "/standup the billing work");
    expect(text).toContain(`Read ${JSON.stringify(file)}`);
    expect(text).toContain("Request: the billing work");
    expect(text).toContain("{input}");
    expect(typedBy(bot, "/standup")).toContain("There is no further request");
    expect(typedBy(bot, "/standup.")).toContain("There is no further request");
  });

  it("runs a skill named later in the message with the whole message as the request", () => {
    const bot = botWith("standup");
    const file = join(workspaceDir(bot), "skills", "standup", "SKILL.md");
    const text = typedBy(bot, "write up the billing work with /standup please");
    expect(text).toContain(`Read ${JSON.stringify(file)}`);
    expect(text).toContain("Request: write up the billing work with /standup please");
    expect(typedBy(bot, "first line\n/standup.")).toContain(`Read ${JSON.stringify(file)}`);
  });

  it("runs every skill named in one message", () => {
    const bot = botWith("review", true, botWith("standup"));
    const standup = join(workspaceDir(bot), "skills", "standup", "SKILL.md");
    const review = join(workspaceDir(bot), "skills", "review", "SKILL.md");
    const text = typedBy(bot, "/review the diff, then /standup it and /review again");
    expect(text).toContain("ran 2 of your skills with /review, /standup");
    expect(text).toContain(`${JSON.stringify(review)} for /review`);
    expect(text).toContain(`${JSON.stringify(standup)} for /standup`);
    expect(text).toContain("Request: /review the diff, then /standup it and /review again");
  });

  it("leaves paths, links and built-in commands alone", () => {
    const bot = botWith("standup");
    expect(typedBy(bot, "open notes/standup now")).toBe("open notes/standup now");
    expect(typedBy(bot, "see https://x.test/standup")).toBe("see https://x.test/standup");
    expect(typedBy(bot, "the /standups folder")).toBe("the /standups folder");
    expect(skillMentions("run /learn then /goal and /standup")).toEqual(["standup"]);
    expect(skillMentions("open /standup.txt or /standup,now")).toEqual([]);
    expect(typedBy(bot, "open /standup.txt")).toBe("open /standup.txt");
  });

  it("passes a disabled skill, an unknown name and plain text through", () => {
    const bot = botWith("standup", false);
    expect(enabledSkillFile(bot, "standup")).toBeNull();
    expect(typedBy(bot, "/standup now")).toBe("/standup now");
    const on = botWith("standup");
    expect(typedBy(on, "/review now")).toBe("/review now");
    expect(typedBy(on, "standup please")).toBe("standup please");
  });
});

describe("skills in text no person typed", () => {
  const words = "Please look at this and /standup it\n/standup again";

  it("stay plain words past the very start: a webhook's, another bot's, an app's", () => {
    const bot = botWith("standup");
    expect(expand(bot, words)).toBe(words);
    expect(expand(bot, words, [{ text: words }])).toBe(words);
    expect(expand(bot, words, [{ sendId: randomUUID(), text: words }])).toBe(words);
  });

  it("run only the one at the very start, and only when that start is the person's own line or the owner's routine", () => {
    const bot = botWith("review", true, botWith("standup"));
    const text = expand(bot, "/standup the work, then /review it", undefined, true);
    expect(text).toContain("The user ran your standup skill with /standup.");
    expect(text).toContain("Request: the work, then /review it");
    expect(skillCalls("/standup the work, then /review it", "", true)).toEqual(["standup"]);
    expect(skillCalls("[A note]\n/standup the work", "", true)).toEqual([]);
  });

  it("stay plain words at the very start of a webhook's, a relay's or another bot's text", () => {
    const bot = botWith("standup");
    expect(expand(bot, "/standup the work")).toBe("/standup the work");
    expect(skillCalls("/standup the work", "")).toEqual([]);
  });

  it("cannot borrow a person's send for other words or another conversation", () => {
    const bot = botWith("standup");
    const { sendId } = typedLine("hello");
    expect(expand(bot, words, [{ sendId, text: words }])).toBe(words);
    const elsewhere = typedLine(words, "another-thread");
    expect(expand(bot, words, [elsewhere])).toBe(words);
    expect(typedWords("another-thread", [elsewhere])).toBe(words);
  });

  it("stay plain beside a person's own line in a turn that merged several", () => {
    const bot = botWith("standup");
    const appsWords = "Book it with /standup from the app";
    expect(expand(bot, `hello\n\n${appsWords}`, [typedLine("hello"), { sendId: randomUUID(), text: appsWords }])).toBe(`hello\n\n${appsWords}`);
  });
});

describe("skillMentions and code", () => {
  it("never counts what is inside code", () => {
    expect(skillMentions("```\n/standup\n```")).toEqual([]);
    expect(skillMentions("~~~sh\nrun /standup\n~~~")).toEqual([]);
    expect(skillMentions("````\n```\n/standup\n```\n/review\n````")).toEqual([]);
    expect(skillMentions("look\n```\n/standup never closed")).toEqual([]);
    expect(skillMentions("use `a /standup b` here")).toEqual([]);
    expect(skillMentions("`span that\n/standup\nruns on`")).toEqual([]);
    expect(skillMentions("    /standup\n\t/review")).toEqual([]);
  });

  it("counts words after the code has closed, and a stray backtick hides nothing", () => {
    expect(skillMentions("```\n/standup\n```\nthen /review")).toEqual(["review"]);
    expect(skillMentions("~~~\n```\n~~~\n/review")).toEqual(["review"]);
    expect(skillMentions("```inline``` is not a fence, /review")).toEqual(["review"]);
    expect(skillMentions("it's `odd\n\n/review\n\nand `odd")).toEqual(["review"]);
  });

  it("keeps every offset when it blanks code", () => {
    const text = "a `b` c\n```\nd\n```\n/e";
    expect(blankCode(text)).toHaveLength(text.length);
    expect(blankCode(text).endsWith("\n/e")).toBe(true);
    expect(blankCode(text)).not.toContain("d");
  });

  it("reads a long message of odd backtick runs quickly", () => {
    const text = `${Array.from({ length: 2000 }, (_, index) => "`".repeat(index + 1)).join(" ")} /standup`;
    const started = Date.now();
    expect(skillMentions(text)).toEqual(["standup"]);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
