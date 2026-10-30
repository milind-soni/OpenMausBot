import { describe, expect, it } from "vitest";

import { withoutMentionedLines } from "./about-me.ts";
import { passageMatcher } from "./memory-entries.ts";
import { ownersOwnAsk, withoutMentions } from "./memory-forget.ts";

const mentions = (passage: string) => passageMatcher(passage)!;

describe("passageMatcher", () => {
  it("matches whole words however the note was typed, and refuses a passage too short to name anything", () => {
    expect(mentions("IST")("The person is in India (IST)")).toBe(true);
    expect(mentions("IST")("The person sees a dentist on Fridays")).toBe(false);
    expect(mentions("short answers")("The person prefers SHORT   answers.")).toBe(true);
    expect(mentions("I'm vegetarian")("I’m vegetarian")).toBe(true);
    expect(passageMatcher("ab")).toBeNull();
    expect(passageMatcher(" - ")).toBeNull();
  });
});

describe("withoutMentions", () => {
  it("drops a dated entry by its fact, never by the chat it came from", () => {
    const notes = [
      '- 2026-10-27 · from chat "Remember: short answers" (noticed) · The person is in India (IST)',
      '- 2026-10-27 · from chat "Remember: short answers" (noticed) · The person prefers short answers',
      "- 2026-10-01 · ~~The person likes long answers~~ · superseded 2026-10-27",
    ].join("\n");
    expect(withoutMentions(notes, mentions("short answers"))).toEqual({
      text: '- 2026-10-27 · from chat "Remember: short answers" (noticed) · The person is in India (IST)\n- 2026-10-01 · ~~The person likes long answers~~ · superseded 2026-10-27',
      removed: ["The person prefers short answers"],
    });
    expect(withoutMentions(notes, mentions("long answers")).removed).toEqual(["The person likes long answers"]);
  });

  it("keeps a topic's frontmatter and headings, and drops a hand-written line that mentions it", () => {
    const topic = "---\ntitle: work\naliases: [IST, hours]\n---\n# Hours\n- Works in IST, 10 to 7\n- Ships on Thursdays\n";
    expect(withoutMentions(topic, mentions("IST"))).toEqual({
      text: "---\ntitle: work\naliases: [IST, hours]\n---\n# Hours\n- Ships on Thursdays\n",
      removed: ["Works in IST, 10 to 7"],
    });
  });
});

describe("withoutMentionedLines", () => {
  it("drops About me lines, learned or written, by their fact and never by the bot that learned them", () => {
    const aboutMe = "I live in Pune.\nI like short answers.\n- 2026-10-27 · learned by Short Answers Bot · The person is in India (IST)\n- 2026-10-27 · learned by Scout · The person prefers short answers";
    expect(withoutMentionedLines(aboutMe, mentions("short answers"))).toEqual({
      text: "I live in Pune.\n- 2026-10-27 · learned by Short Answers Bot · The person is in India (IST)",
      removed: ["I like short answers.", "The person prefers short answers"],
    });
  });
});

describe("ownersOwnAsk", () => {
  it("is true only when the person's own words started the turn", () => {
    expect(ownersOwnAsk([{ role: "user", kind: "text" }, { role: "bot", kind: "text" }])).toBe(true);
    expect(ownersOwnAsk([{ role: "user", kind: "text", sender: { name: "Asha" } }])).toBe(false);
    expect(ownersOwnAsk([{ role: "user", kind: "text", peerAsk: true }])).toBe(false);
    expect(ownersOwnAsk([{ role: "bot", kind: "text" }])).toBe(false);
  });
});
