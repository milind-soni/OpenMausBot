// Setup mode: a /setup message turns on a coaching block that makes the bot
// interview the user and configure itself through cards. A blank bot on an
// ordinary turn gets the light first-task block instead, never the interview.
import { describe, expect, it } from "vitest";

import {
  SETUP_PROMPT,
  botIsBlank,
  expandSetupTurnText,
  firstTaskActive,
  firstTaskSystemPrompt,
  parseSetupCommand,
  setupModeActive,
  setupSystemPrompt,
} from "./setup-mode.ts";

describe("parseSetupCommand", () => {
  it("recognises /setup with and without a request", () => {
    expect(parseSetupCommand("/setup")).toEqual({ request: "" });
    expect(parseSetupCommand("  /SETUP watch Discord and file bugs into Linear  ")).toEqual({
      request: "watch Discord and file bugs into Linear",
    });
    expect(parseSetupCommand("/setup\nevery 5 minutes")).toEqual({ request: "every 5 minutes" });
  });

  it("ignores ordinary chat that only mentions the word", () => {
    expect(parseSetupCommand("please setup a routine")).toBeNull();
    expect(parseSetupCommand("use /setup later")).toBeNull();
    expect(parseSetupCommand("/setupx")).toBeNull();
    expect(parseSetupCommand("")).toBeNull();
  });
});

describe("expandSetupTurnText", () => {
  it("turns a bare /setup into a request to set up, and keeps a described job", () => {
    expect(expandSetupTurnText("/setup")).toBe(
      "Set yourself up. Ask me what you need to know, then propose your configuration.",
    );
    expect(expandSetupTurnText("/setup watch Discord")).toBe("Set yourself up for this job: watch Discord");
    expect(expandSetupTurnText("hello")).toBe("hello");
  });
});

describe("botIsBlank", () => {
  it("is true only when both soul and description are empty or whitespace", () => {
    expect(botIsBlank({ soul: "", description: "" })).toBe(true);
    expect(botIsBlank({ soul: "  \n", description: undefined })).toBe(true);
    expect(botIsBlank({})).toBe(true);
    expect(botIsBlank({ soul: "Be brief.", description: "" })).toBe(false);
    expect(botIsBlank({ soul: "", description: "Files bugs." })).toBe(false);
  });
});

describe("setupModeActive and firstTaskActive", () => {
  const ordinary = "Combine all the images in Downloads into a single PDF called receipts.pdf, in date order.";

  it("a blank bot on an ordinary task is not in setup mode; it gets the first-task block", () => {
    for (const blank of [
      { soul: "", description: "", text: ordinary },
      { soul: "  \n", description: undefined, text: ordinary },
      { text: "hello" },
    ]) {
      expect(setupModeActive(blank)).toBe(false);
      expect(firstTaskActive(blank)).toBe(true);
    }
  });

  it("a blank bot sent /setup is in setup mode, not first-task", () => {
    for (const text of ["/setup", "/setup watch Discord"]) {
      expect(setupModeActive({ soul: "", description: "", text })).toBe(true);
      expect(firstTaskActive({ soul: "", description: "", text })).toBe(false);
    }
  });

  it("a configured bot sent /setup re-enters setup mode", () => {
    expect(setupModeActive({ soul: "Be brief.", description: "Files bugs.", text: "/setup" })).toBe(true);
    expect(setupModeActive({ soul: "Be brief.", description: "", text: "/setup change my job" })).toBe(true);
    expect(firstTaskActive({ soul: "Be brief.", description: "", text: "/setup change my job" })).toBe(false);
  });

  it("a configured bot on an ordinary task gets neither block", () => {
    for (const configured of [
      { soul: "Be brief.", description: "", text: ordinary },
      { soul: "", description: "Files bugs.", text: ordinary },
    ]) {
      expect(setupModeActive(configured)).toBe(false);
      expect(firstTaskActive(configured)).toBe(false);
    }
  });

  it("ordinary chat that merely mentions setup never enters the mode", () => {
    expect(setupModeActive({ soul: "", description: "", text: "please setup a routine" })).toBe(false);
    expect(setupModeActive({ soul: "", description: "", text: "use /setup later" })).toBe(false);
  });
});

describe("firstTaskSystemPrompt", () => {
  it("is empty when not active", () => {
    expect(firstTaskSystemPrompt(false)).toBe("");
    expect(firstTaskSystemPrompt(false, { cwd: "/Users/me" })).toBe("");
  });

  it("tells a blank bot to do the task now, ask at most one costly question, and offer setup once afterwards", () => {
    const text = firstTaskSystemPrompt(true);
    expect(text.startsWith("\n\nYou have not been set up yet. Do the task the person asked for now, using sensible defaults;")).toBe(true);
    expect(text).toContain("work in your private workspace, using full paths, unless they name a folder");
    expect(text).toContain("Ask a question only when a wrong guess would be costly to undo, and ask one, not several.");
    expect(text).toContain("offer once, in one sentence, to remember a name, standing rules, and a working folder through propose_profile");
    expect(text).toContain("raise that card only if they say yes");
    expect(text).toContain("Never gate the task on setup.");
    // none of the interview
    expect(text).not.toContain("Wait for a yes");
    expect(text).not.toContain("at most four questions");
    expect(text).not.toContain("propose_routine");
    expect(text).not.toContain("skill_manage");
  });

  it("names the bot's working folder when it has one", () => {
    const text = firstTaskSystemPrompt(true, { cwd: "/Users/me/Projects/site" });
    expect(text).toContain("work in /Users/me/Projects/site, using full paths, unless they name another folder");
    expect(text).not.toContain("private workspace");
  });
});

describe("setupSystemPrompt", () => {
  it("is empty when not active, regardless of the skills option", () => {
    expect(setupSystemPrompt(false)).toBe("");
    expect(setupSystemPrompt(false, { skills: true })).toBe("");
  });

  it("is the skill_manage-naming block when active with skills on", () => {
    expect(setupSystemPrompt(true, { skills: true })).toBe(SETUP_PROMPT);
    expect(SETUP_PROMPT.startsWith("\n\n")).toBe(true);
    for (const tool of ["propose_profile", "propose_routine", "skill_manage", "request_credential"]) {
      expect(SETUP_PROMPT).toContain(tool);
    }
    expect(SETUP_PROMPT).toContain("at most four questions");
    expect(SETUP_PROMPT).toContain("Wait for a yes");
  });

  it("never mentions skill_manage when active with skills off (or unspecified)", () => {
    for (const prompt of [setupSystemPrompt(true), setupSystemPrompt(true, { skills: false })]) {
      expect(prompt).not.toContain("skill_manage");
      expect(prompt).toContain("propose_profile");
      expect(prompt).toContain("propose_routine");
      expect(prompt).toContain("request_credential");
      expect(prompt).toContain("describe procedures plainly in your standing instructions");
    }
  });
});

describe("setupSystemPrompt working-folder clause and card ordering", () => {
  it("names the current folder and tells the bot to offer to keep it", () => {
    const text = setupSystemPrompt(true, { skills: true, cwd: "/Users/me/Projects/site" });
    expect(text).toContain("today that is /Users/me/Projects/site; offer to keep it");
    expect(text).toContain("propose_profile for your identity, standing rules");
    expect(text).toContain("and the working folder (cwd)");
  });

  it("says there is no folder yet when the bot works in its private workspace", () => {
    const text = setupSystemPrompt(true, { skills: false });
    expect(text).toContain("today it has none and works in a private workspace");
    expect(text).not.toContain("skill_manage");
  });

  it("requires the summary message before the cards, and only a short line after", () => {
    const text = setupSystemPrompt(true, {});
    expect(text).toContain("first send one message that lists the cards you are about to raise, then make the tool calls");
    expect(text).toContain("the cards must appear after that message, never before it");
    expect(text).toContain("After the tool calls add at most one short line");
  });
});
