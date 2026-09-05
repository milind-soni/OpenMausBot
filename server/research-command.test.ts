// The command is a parser and a prompt, so the tests are about the two ways
// that goes wrong: swallowing a message that was never the command, and
// quietly dropping the standards that make the prompt worth having.
import { describe, expect, it } from "vitest";

import {
  buildResearchPrompt,
  expandResearchTurnText,
  parseResearchCommand,
  RESEARCH_PROMPT_MARKER,
} from "./research-command.ts";

describe("parseResearchCommand", () => {
  it("takes the rest of the line as the request", () => {
    expect(parseResearchCommand("/research who owns investsights.in")).toEqual({
      request: "who owns investsights.in",
    });
    expect(parseResearchCommand("  /Research  spaced out  ")).toEqual({ request: "spaced out" });
    // bare command is valid — the prompt falls back to the conversation
    expect(parseResearchCommand("/research")).toEqual({ request: "" });
    expect(parseResearchCommand("/research   ")).toEqual({ request: "" });
  });

  it("keeps a multi-line request intact", () => {
    // the composer sends newlines; a request that lost its lines would reach
    // the model as one run-on sentence
    expect(parseResearchCommand("/research first line\nsecond line")).toEqual({
      request: "first line\nsecond line",
    });
  });

  it("leaves anything that is not the command alone", () => {
    for (const text of [
      "research this for me",
      "/researching is fun",
      "/research-notes",
      "please run /research later",
      "",
      "/learn something else",
    ]) {
      expect(parseResearchCommand(text)).toBeNull();
      expect(expandResearchTurnText(text)).toBe(text);
    }
  });
});

describe("buildResearchPrompt", () => {
  it("carries the request and the standards that make it research", () => {
    const prompt = buildResearchPrompt("who owns investsights.in");
    expect(prompt.startsWith(RESEARCH_PROMPT_MARKER)).toBe(true);
    expect(prompt).toContain("who owns investsights.in");
    // the three things that separate research from recall
    expect(prompt).toMatch(/corroborate/i);
    expect(prompt).toMatch(/verified from what you inferred/i);
    expect(prompt).toMatch(/could not check/i);
    // and the refusal that keeps a gap honest
    expect(prompt).toMatch(/never fill a gap with a plausible number/i);
  });

  it("falls back to the conversation when no request is given", () => {
    const prompt = buildResearchPrompt("   ");
    expect(prompt).toMatch(/conversation/i);
    // it still has to be a real instruction, not a stub
    expect(prompt.length).toBeGreaterThan(400);
  });

  it("treats fetched pages as data, not instructions", () => {
    // a research turn opens attacker-controlled pages by design, so the
    // prompt has to say so before the model reads one
    expect(buildResearchPrompt("anything")).toMatch(/data, not instructions/i);
  });
});

describe("expandResearchTurnText", () => {
  it("expands the command and passes ordinary text through", () => {
    const expanded = expandResearchTurnText("/research the SEO of investsights.in");
    expect(expanded).not.toBe("/research the SEO of investsights.in");
    expect(expanded).toContain("the SEO of investsights.in");
    expect(expandResearchTurnText("just a normal message")).toBe("just a normal message");
  });

  it("does not re-expand its own output", () => {
    // the turn text passes through both expanders; the second must not
    // recognise the first one's result as a fresh command
    const once = expandResearchTurnText("/research something");
    expect(expandResearchTurnText(once)).toBe(once);
  });
});
