// The setting is one enum and one string, so the tests are mostly about the
// two things that would hurt: a default that is not silent, and a stored
// value that is not one of the three still reaching a prompt.
import { describe, expect, it } from "vitest";

import {
  DEFAULT_DEPTH,
  DEPTH_PROFILES,
  depthProfileSystemPrompt,
  isDepthProfile,
  resolveDepthProfile,
} from "./depth-profile.ts";

describe("depth profiles", () => {
  it("offers exactly three, defaulting to the silent one", () => {
    expect([...DEPTH_PROFILES]).toEqual(["quick", "standard", "deep"]);
    expect(DEFAULT_DEPTH).toBe("standard");
    // the whole point of the default: an existing bot's prompt is unchanged
    expect(depthProfileSystemPrompt("standard")).toBe("");
    expect(depthProfileSystemPrompt(undefined)).toBe("");
  });

  it("falls back rather than letting an unknown value reach a prompt", () => {
    // values arrive from bots.json on disk and from the API, so "not one of
    // the three" has to mean standard, not a crash and not a passthrough
    for (const bad of [null, 42, "DEEP", "verbose", "", {}, [], true]) {
      expect(resolveDepthProfile(bad)).toBe("standard");
      expect(depthProfileSystemPrompt(bad)).toBe("");
    }
    expect(isDepthProfile("deep")).toBe(true);
    expect(isDepthProfile("Deep")).toBe(false);
  });

  it("asks quick for brevity and deep for evidence", () => {
    const quick = depthProfileSystemPrompt("quick");
    const deep = depthProfileSystemPrompt("deep");
    // quick's whole job is to cap length and kill preamble
    expect(quick).toMatch(/one-line question gets a one-line answer/i);
    expect(quick).toMatch(/no preamble/i);
    // and it must not smuggle in the report contract
    expect(quick).not.toMatch(/still open/i);
    // both are appended to a running system prompt, so each needs its own
    // leading separator or it welds onto the previous sentence
    expect(quick.startsWith(" ")).toBe(true);
    expect(deep.startsWith(" ")).toBe(true);
  });

  it("tells a deep bot to keep the report in the reply", () => {
    // the failure this exists to prevent: a bot writes the real work to a
    // file in its workspace and leaves a summary in chat, so the person who
    // asked never sees it
    expect(depthProfileSystemPrompt("deep")).toMatch(/put the report in your reply/i);
    expect(depthProfileSystemPrompt("deep")).toMatch(/verified/i);
    expect(depthProfileSystemPrompt("deep")).toMatch(/still open/i);
  });

  it("carries nothing dynamic that would move between turns", () => {
    // This rides the cached system prompt, so the text has to depend on the
    // profile and nothing else. The way that breaks in practice is someone
    // interpolating a timestamp, a bot name, or a count into the guidance —
    // all of which show up as digits or a template hole, and none of which
    // any of the three profiles legitimately contains.
    for (const profile of DEPTH_PROFILES) {
      const text = depthProfileSystemPrompt(profile);
      expect(text).not.toMatch(/\d/);
      expect(text).not.toContain("${");
      expect(text).not.toContain("undefined");
    }
  });
});
