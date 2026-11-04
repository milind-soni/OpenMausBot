import { describe, expect, it } from "vitest";

import {
  aboutMeWithImport,
  IMPORT_NOTE_MAX_BYTES,
  IMPORTED_FACTS_MAX_CHARS,
  MemoryImportError,
  memoryImportNote,
  memoryImportNotePath,
  memoryImportPrompt,
  parseMemoryImport,
} from "./memory-import.ts";

const ANSWER = `Sure! Here's everything I have.

## 1. About me
- Goes by Sam; based in Pune, India (Asia/Kolkata)
- Runs operations at a small logistics company
* Prefers short answers with bullet points
- Never wants emails sent without checking first

## My setup
### Inbox Triage
- **Name:** Inbox Triage
- **Purpose:** Sorts my morning email into urgent, later and newsletters.
- **When it runs:** Weekdays at 8:00 Asia/Kolkata
- **Apps and data:** Gmail

### **Weekly Report**
- **Purpose:** Drafts Friday's shipments report from the tracking sheet.

Continued in the next message

## My setup (continued)
### Vendor Watch
- **Purpose:** Flags late vendor invoices.

## Ongoing context
- Hiring a dispatcher; interviews next week.
- Moving tracking from Sheets to Airtable.`;

describe("bringing memory over from another assistant", () => {
  it("asks plainly, as the person, for their own information under three fixed headings, and never for hidden instructions", () => {
    const prompt = memoryImportPrompt("Grok");
    expect(prompt).toContain("everything I've set up with you here in Grok");
    expect(prompt).toContain("This is my own information and I'm asking for it for my own use.");
    for (const heading of ["## About me", "## My setup", "## Ongoing context"]) expect(prompt).toContain(heading);
    expect(prompt).toContain("Write [removed] in their place.");
    expect(prompt.toLowerCase()).not.toMatch(/system prompt|ignore (all|previous)|jailbreak|developer mode|hidden instructions/);
  });

  it("reads the facts, each set-up item in full and the context, across answers split by continue", () => {
    const imported = parseMemoryImport(ANSWER);
    expect(imported.facts).toEqual([
      "Goes by Sam; based in Pune, India (Asia/Kolkata)",
      "Runs operations at a small logistics company",
      "Prefers short answers with bullet points",
      "Never wants emails sent without checking first",
    ]);
    expect(imported.setup.map((item) => item.name)).toEqual(["Inbox Triage", "Weekly Report", "Vendor Watch"]);
    expect(imported.setup[0]!.details).toContain("**When it runs:** Weekdays at 8:00 Asia/Kolkata");
    expect(imported.setup[1]!.details).not.toContain("Continued in the next message");
    expect(imported.context).toBe("- Hiring a dispatcher; interviews next week.\n- Moving tracking from Sheets to Airtable.");
  });

  it("joins a bullet that wraps onto the next line, and keeps text under another heading out", () => {
    const imported = parseMemoryImport("## About me\n- Runs operations at a small logistics company\n  in Pune, mostly road freight\n- Likes tea\n\n## Source notes\n- Exported from the app on Monday\n\n## Ongoing context\nHiring.");
    expect(imported.facts).toEqual(["Runs operations at a small logistics company in Pune, mostly road freight", "Likes tea"]);
    expect(imported.context).toBe("Hiring.");
  });

  it("treats Nothing yet as empty, and refuses an answer without any of the headings", () => {
    expect(parseMemoryImport("## About me\n- Likes tea\n\n## My setup\nNothing yet.\n\n## Ongoing context\nNothing yet.")).toEqual({ facts: ["Likes tea"], setup: [], context: "" });
    expect(() => parseMemoryImport("I can't help with that.")).toThrow(MemoryImportError);
  });

  it("adds each new fact to About you once, in a dated block, within its share of About you", () => {
    const merged = aboutMeWithImport("I'm Sam.\n- Prefers short answers with bullet points", parseMemoryImport(ANSWER).facts, "Grok", "2026-11-03");
    expect(merged).toMatchObject({ added: 3, alreadyKnown: 1, leftOut: 0 });
    expect(merged.text).toBe([
      "I'm Sam.", "- Prefers short answers with bullet points", "",
      "From Grok (imported 2026-11-03):",
      "- Goes by Sam; based in Pune, India (Asia/Kolkata)",
      "- Runs operations at a small logistics company",
      "- Never wants emails sent without checking first",
    ].join("\n"));
    const many = Array.from({ length: 200 }, (_, index) => `Fact number ${index} about the person, written out at some length`);
    const capped = aboutMeWithImport("", many, "Muse", "2026-11-03");
    expect(capped.text.length).toBeLessThanOrEqual(IMPORTED_FACTS_MAX_CHARS);
    expect(capped.added + capped.leftOut).toBe(200);
    // A short fact after one too long to fit still goes in.
    const long = "x".repeat(IMPORTED_FACTS_MAX_CHARS);
    expect(aboutMeWithImport("", [long, "Likes tea"], "Muse", "2026-11-03")).toMatchObject({ added: 1, leftOut: 1, text: expect.stringContaining("- Likes tea") });
    expect(aboutMeWithImport("Likes tea", ["likes tea"], "Muse", "2026-11-03")).toEqual({ text: "Likes tea", added: 0, alreadyKnown: 1, leftOut: 0 });
    // Whole words only: "Likes tea" is new to someone who "Dislikes tea".
    expect(aboutMeWithImport("Dislikes tea", ["Likes tea"], "Muse", "2026-11-03")).toMatchObject({ added: 1, alreadyKnown: 0 });
  });

  it("keeps everything in a note MausBot finds by its words, one per source, under the memory file cap", () => {
    const { text: note, clipped } = memoryImportNote(parseMemoryImport(ANSWER), "Grok", "2026-11-03");
    expect(clipped).toBe(false);
    expect(note.startsWith("---\ntitle: What Grok knew\n")).toBe(true);
    expect(note).toContain("aliases: [Grok, imported memory, my old assistant, my setup]");
    expect(note).toContain("### Inbox Triage\n- **Name:** Inbox Triage");
    expect(note).toContain("## Ongoing context\n- Hiring a dispatcher");
    expect(memoryImportNotePath("Grok")).toBe("memory/imported-from-grok.md");
    expect(memoryImportNotePath(" grok ")).toBe("memory/imported-from-grok.md");
    expect(memoryImportNotePath("  My Old Bot!! ")).toMatch(/^memory\/imported-from-my-old-bot-[a-z0-9]{1,6}\.md$/);
    expect(memoryImportNotePath("A/B")).not.toBe(memoryImportNotePath("A B"));
    expect(memoryImportNotePath("A/B")).toBe(memoryImportNotePath("a/b"));
    const huge = memoryImportNote({ facts: [], setup: [{ name: "Big", details: "é".repeat(200_000) }], context: "" }, "Grok", "2026-11-03");
    expect(huge.clipped).toBe(true);
    expect(new TextEncoder().encode(huge.text).length).toBeLessThanOrEqual(IMPORT_NOTE_MAX_BYTES + 100);
    expect(huge.text).toContain("too long to keep here");
  });
});
