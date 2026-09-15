// Mention tokens (Phase 2 part 4): found, serialised, resolved to one line
// each, unknown ones left alone.
import { describe, expect, it } from "vitest";

import { findMentions, mentionToken, resolveMentions } from "./mentions.ts";

const resolve = ({ type, id }: { type: string; id: string }) =>
  type === "bot" && id === "b1" ? "Scout — a research bot, idle"
  : type === "room" && id === "r9" ? "Launch — 3 members"
  : type === "task" && id === "t4" ? "Invoice Acme — ready, owner person, due 2026-09-19"
  : null;

describe("mention tokens", () => {
  it("finds tokens with and without a name, and ignores unknown types", () => {
    expect(findMentions("ask @Scout [[omb:bot:b1]] in [[omb:room:r9]] about [[omb:widget:x]]")).toEqual([
      { type: "bot", id: "b1", name: "Scout" },
      { type: "room", id: "r9" },
    ]);
    expect(mentionToken("task", "t4", "Invoice Acme")).toBe("@Invoice-Acme [[omb:task:t4]]");
  });

  it("expands known tokens to name plus id, appends the resolved list once, and leaves unknown ones", () => {
    const { text, resolved } = resolveMentions("Ask @Scout [[omb:bot:b1]] to finish [[omb:task:t4]]; also [[omb:task:t4]] and [[omb:skill:nope]].", resolve);
    expect(text).toContain("Ask Scout (bot b1) to finish Invoice Acme (task t4); also Invoice Acme (task t4) and [[omb:skill:nope]].");
    expect(text).toContain("[References in these instructions, resolved by OpenMausBot; use the ids directly:");
    expect(text).toContain("- bot b1: Scout — a research bot, idle");
    expect(text.split("- task t4:")).toHaveLength(2);
    expect(resolved.map((r) => r.id)).toEqual(["b1", "t4"]);
    expect(resolveMentions("nothing here", resolve)).toEqual({ text: "nothing here", resolved: [] });
  });
});
