import { describe, expect, it } from "vitest";

import { builtInBrowserEnabled, llmThreadTitlesEnabled, parseSkillReviewSteps, roomMemoryCaptureEnabled, savedStepsEnabled, shareLearnedSkillsMode, sharedComputersEnabled, showToolCallsEnabled, skillAuthoringEnabled, skillReviewEnabled, skillReviewSteps, skillReviewUnavailableEngines } from "./feature-flags";

describe("experimental feature flags", () => {
  it("keeps skill authoring on by default, before and after the config arrives", () => {
    expect(skillAuthoringEnabled(null)).toBe(true);
    expect(skillAuthoringEnabled({})).toBe(true);
    expect(skillAuthoringEnabled({ features: {} })).toBe(true);
    expect(skillAuthoringEnabled({ features: { skillAuthoring: true } })).toBe(true);
  });

  it("switches skill authoring off only on an explicit opt-out", () => {
    expect(skillAuthoringEnabled({ features: { skillAuthoring: false } })).toBe(false);
  });

  it("names the engines in use that cannot run the skill review: no background call, or no agents tools", () => {
    const instances = [
      { instanceId: "codex", displayName: "Codex", capabilities: { backgroundText: true, agentsMcp: true } },
      { instanceId: "pi", displayName: "Pi", capabilities: { backgroundText: false, agentsMcp: true } },
      { instanceId: "chat", displayName: "Groq", capabilities: { backgroundText: true, agentsMcp: false } },
      { instanceId: "old", displayName: "Old server engine" },
      { instanceId: "unused", displayName: "Unused", capabilities: { backgroundText: false } },
    ];
    const on = (...ids: string[]) => ids.map((instanceId) => ({ modelSelection: { instanceId } }));
    expect(skillReviewUnavailableEngines(on("codex", "codex"), instances)).toEqual([]);
    expect(skillReviewUnavailableEngines(on("codex", "pi", "pi", "chat", "old", "missing"), instances)).toEqual(["Pi", "Groq", "Old server engine"]);
    expect(skillReviewUnavailableEngines([], instances)).toEqual([]);
  });

  it("learns skills automatically only after an opt-in, and never without skill authoring", () => {
    expect(skillReviewEnabled(null)).toBe(false);
    expect(skillReviewEnabled({ features: {} })).toBe(false);
    expect(skillReviewEnabled({ features: { skillReview: true } })).toBe(true);
    expect(skillReviewEnabled({ features: { skillReview: true, skillAuthoring: false } })).toBe(false);
  });

  it("reviews after ten tool steps by default, within 3 to 100", () => {
    expect(skillReviewSteps(null)).toBe(10);
    expect(skillReviewSteps({ features: { skillReviewSteps: 25 } })).toBe(25);
    expect(skillReviewSteps({ features: { skillReviewSteps: 1 } })).toBe(3);
    expect(skillReviewSteps({ features: { skillReviewSteps: 500 } })).toBe(100);
    expect(parseSkillReviewSteps(" 12 ")).toBe(12);
    for (const bad of ["", "2", "101", "4.5", "-5", "ten"]) expect(parseSkillReviewSteps(bad)).toBeNull();
  });

  it("keeps the experimental browser off until explicitly enabled", () => {
    expect(builtInBrowserEnabled(null)).toBe(false);
    expect(builtInBrowserEnabled({})).toBe(false);
    expect(builtInBrowserEnabled({ features: { browser: false } })).toBe(false);
    expect(builtInBrowserEnabled({ features: { browser: true } })).toBe(true);
  });

  it("hides tool-call chips by default", () => {
    expect(showToolCallsEnabled(null)).toBe(false);
    expect(showToolCallsEnabled({})).toBe(false);
    expect(showToolCallsEnabled({ features: { showToolCalls: false } })).toBe(false);
  });

  it("shows tool-call chips only after explicit opt-in", () => {
    expect(showToolCallsEnabled({ features: { showToolCalls: true } })).toBe(true);
  });

  it("keeps computer sharing off unless the server says it is on", () => {
    expect(sharedComputersEnabled(null)).toBe(false);
    expect(sharedComputersEnabled({})).toBe(false);
    expect(sharedComputersEnabled({ features: {} })).toBe(false);
    expect(sharedComputersEnabled({ features: { sharedComputers: false } })).toBe(false);
    expect(sharedComputersEnabled({ features: { sharedComputers: true } })).toBe(true);
  });

  it("offers Regenerate title only while the server has generated titles on", () => {
    expect(llmThreadTitlesEnabled(null)).toBe(false);
    expect(llmThreadTitlesEnabled({ features: {} })).toBe(false);
    expect(llmThreadTitlesEnabled({ features: { llmThreadTitles: false } })).toBe(false);
    expect(llmThreadTitlesEnabled({ features: { llmThreadTitles: true } })).toBe(true);
  });

  it("keeps Learn from group chats off until it is switched on", () => {
    expect(roomMemoryCaptureEnabled(null)).toBe(false);
    expect(roomMemoryCaptureEnabled({ features: {} })).toBe(false);
    expect(roomMemoryCaptureEnabled({ features: { roomMemoryCapture: true } })).toBe(true);
  });

  it("offers sharing learned skills only with the skills library, asking by default", () => {
    expect(shareLearnedSkillsMode(null)).toBe("off");
    expect(shareLearnedSkillsMode({ features: { shareLearnedSkills: "auto" } })).toBe("off");
    expect(shareLearnedSkillsMode({ features: { skillsLibrary: true } })).toBe("ask");
    expect(shareLearnedSkillsMode({ features: { skillsLibrary: true, shareLearnedSkills: "auto" } })).toBe("auto");
    expect(shareLearnedSkillsMode({ features: { skillsLibrary: true, shareLearnedSkills: "off" } })).toBe("off");
  });
});

describe("saved steps flag", () => {
  it("is on unless the config turns it off", () => {
    expect(savedStepsEnabled(null)).toBe(true);
    expect(savedStepsEnabled({ features: {} })).toBe(true);
    expect(savedStepsEnabled({ features: { savedSteps: false } })).toBe(false);
  });
});
