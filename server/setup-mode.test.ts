// Setup mode: only a /setup message turns on a coaching block
// that makes the bot clarify the job and use result-aware configuration tools.
import { describe, expect, it } from "vitest";

import {
  SETUP_PROMPT,
  expandSetupTurnText,
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

describe("setupModeActive", () => {
  it("does not turn an ordinary request into onboarding for a blank bot", () => {
    for (const text of ["hello", "Summarize this report", "Run the daily check", "A teammate asked you to review this diff"]) {
      expect(setupModeActive({ soul: "", description: "", text })).toBe(false);
      expect(setupModeActive({ soul: "  \n", description: undefined, text })).toBe(false);
      expect(setupModeActive({ text })).toBe(false);
    }
  });

  it("requires /setup whether or not the profile has been filled in", () => {
    expect(setupModeActive({ text: "/setup" })).toBe(true);
    expect(setupModeActive({ soul: "Be brief.", description: "", text: "hello" })).toBe(false);
    expect(setupModeActive({ soul: "", description: "Files bugs.", text: "hello" })).toBe(false);
    expect(setupModeActive({ soul: "Be brief.", description: "Files bugs.", text: "/setup" })).toBe(true);
    expect(setupModeActive({ soul: "Be brief.", description: "", text: "/setup change my job" })).toBe(true);
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
    expect(SETUP_PROMPT).toContain("Ask for missing choices, not an extra yes");
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

describe("setupSystemPrompt working-folder clause and result ordering", () => {
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

  it("explains the requested changes before tools and follows applied versus pending outcomes", () => {
    const text = setupSystemPrompt(true, {});
    expect(text).toContain("First send one message describing the changes you are about to request, then make the tool calls");
    expect(text).toContain("if applied, continue without another confirmation");
    expect(text).toContain("if pending, end the turn and wait");
    expect(text).toContain("Do not repeat the list or claim success from the permission mode alone");
    expect(text).toContain("A credential request still needs the user's secure entry");
    expect(text).toContain("Full Access does not supply answers, credentials, or broader permissions for another bot");
    expect(text).not.toContain("each of which the user must confirm");
    expect(text).not.toContain("propose it paused");
  });
});
