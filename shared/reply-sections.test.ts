// The section convention decides what a voice reads and what the reader sees
// first, so its boundary is pinned here rather than discovered on a live
// reply. The cases that matter are the ones a real transcript contains: the
// reply that followed the convention, the one that opened with its own
// heading, the one that never had headings at all, and a shell snippet whose
// comment starts with a hash.
import { describe, expect, it } from "vitest";

import { splitReply } from "./reply-sections";

describe("splitReply", () => {
  it("takes the prose before the first heading as the lead", () => {
    const parts = splitReply(
      "The login redirect is fixed and the suite passes.\n\n## What changed\n\n`server/auth.ts` now keeps the query string.\n\n## Files\n\n- auth.ts",
    );
    expect(parts.lead).toBe("The login redirect is fixed and the suite passes.");
    expect(parts.detail.startsWith("## What changed")).toBe(true);
    expect(parts.titles).toEqual(["What changed", "Files"]);
    expect(parts.structured).toBe(true);
    expect(parts.title).toBeUndefined();
  });

  it("treats a reply that opens with a heading as that section's body", () => {
    const parts = splitReply("## Summary\n\nI fixed the redirect.\n\n## Detail\n\nHere is the diff.");
    expect(parts.lead).toBe("I fixed the redirect.");
    // the heading is the reader's label, not a sentence a voice says
    expect(parts.title).toBe("Summary");
    expect(parts.detail).toBe("## Detail\n\nHere is the diff.");
    expect(parts.titles).toEqual(["Detail"]);
  });

  it("keeps a heading-only reply speakable from its body", () => {
    const parts = splitReply("## Notes\n\nEverything is fine.");
    expect(parts.lead).toBe("Everything is fine.");
    expect(parts.title).toBe("Notes");
    expect(parts.detail).toBe("");
    expect(parts.titles).toEqual([]);
  });

  it("falls back to the first paragraph when the reply has no headings", () => {
    const parts = splitReply("Tests pass.\n\n- one\n- two\n\nMore prose.");
    expect(parts.structured).toBe(false);
    expect(parts.lead).toBe("Tests pass.");
    expect(parts.detail).toBe("- one\n- two\n\nMore prose.");
  });

  it("keeps a one-paragraph reply whole", () => {
    const parts = splitReply("Done — the flaky test was a shared fixture.");
    expect(parts.lead).toBe("Done — the flaky test was a shared fixture.");
    expect(parts.detail).toBe("");
    expect(parts.structured).toBe(false);
  });

  it("is empty for empty input rather than a lone sentence", () => {
    expect(splitReply("")).toEqual({ lead: "", detail: "", titles: [], structured: false });
    expect(splitReply("   \n\n  ")).toEqual({ lead: "", detail: "", titles: [], structured: false });
  });

  it("does not read a shell comment as a heading", () => {
    const parts = splitReply(
      "Here is how to run it:\n\n```sh\n# install deps\npnpm install\n```\n\n## Then\n\n`pnpm test`.",
    );
    expect(parts.lead.startsWith("Here is how to run it:")).toBe(true);
    expect(parts.lead).toContain("pnpm install");
    expect(parts.titles).toEqual(["Then"]);
  });

  it("closes a fence only on its own character", () => {
    // a ``` line inside a ~~~ block is code, so the reply keeps one heading
    const parts = splitReply("Lead paragraph.\n\n~~~\n```\n# not a heading\n~~~\n\n## Real\n\nBody.");
    expect(parts.titles).toEqual(["Real"]);
    expect(parts.lead).toContain("# not a heading");
    expect(parts.detail).toBe("## Real\n\nBody.");
  });

  it("ignores a hash that is not a heading", () => {
    const parts = splitReply("Issue #42 is closed.\n\nNo headings here.");
    expect(parts.structured).toBe(false);
    expect(parts.lead).toBe("Issue #42 is closed.");
  });

  it("normalizes CRLF so the boundary still lands on a line", () => {
    const parts = splitReply("Fixed it.\r\n\r\n## Detail\r\n\r\nBody.");
    expect(parts.lead).toBe("Fixed it.");
    expect(parts.detail).toBe("## Detail\n\nBody.");
  });
});

describe("splitReply tool-leak stripping", () => {
  // What a real transcript contained: the model wrote its computer action as
  // reply text and narrated the mechanics. Neither is prose.
  it("strips a bare action payload and the narration around it", () => {
    const parts = splitReply(
      'We need to output tool use calls.\n{ "action": "press", "keys": ["win", "r"] }\nOpening the Run dialog for you.',
    );
    expect(parts.toolLeakOnly).toBeUndefined();
    expect(parts.lead).toBe("Opening the Run dialog for you.");
    expect(parts.lead).not.toContain("action");
    expect(parts.lead).not.toContain("output tool use");
  });

  it("strips a pretty-printed payload and an array of actions", () => {
    const parts = splitReply(
      'Opening the editor.\n\n{\n  "action": "click",\n  "x": 120,\n  "y": 44\n}\n\n[{"action": "press_key", "keys": "ctrl+c"}]\n\nCopied the selection.',
    );
    expect(parts.lead).toBe("Opening the editor.");
    expect(parts.lead).not.toContain("click");
    expect(parts.lead).not.toContain("press_key");
  });

  it("keeps a fenced JSON example — that is code the reader asked for", () => {
    const body = 'Here is the payload shape:\n\n```json\n{"action": "click", "x": 1, "y": 2}\n```';
    const parts = splitReply(body);
    expect(parts.toolLeakOnly).toBeUndefined();
    // the first-paragraph rule puts the fence in the detail half, where the
    // reader still sees it — the sanitizer must not have touched it
    expect(parts.detail).toContain('"action": "click"');
  });

  it("marks a reply that is nothing but leak so the voice stays silent", () => {
    const parts = splitReply('We need to output tool use calls.\n{ "action": "press", "keys": ["win", "r"] }');
    expect(parts.toolLeakOnly).toBe(true);
    // the reader still sees the raw text; the lead is deliberately unspeakable
    expect(parts.lead).toContain('"action": "press"');
    expect(parts.structured).toBe(false);
  });

  it("leaves ordinary JSON-looking prose and narration alone", () => {
    const body = "Let me check the screen first. The config accepts {\"retries\": 3} per job.";
    const parts = splitReply(body);
    expect(parts.lead).toBe(body);
  });

  // The defect this guard exists for: a payload used to be deleted wherever it
  // was recognized, including inside a sentence, and the sentence left behind
  // is what the reader got and what the voice said aloud. Removal now edits
  // nothing, so a payload that cannot come out whole stays in.
  it("leaves a payload inside a sentence alone rather than editing the sentence", () => {
    const inline = 'The policy uses {"action": "click", "x": 1} by default.';
    expect(splitReply(inline).lead).toBe(inline);
    const typed = 'I set {"action":"type","text":"hello"} in the script.';
    expect(splitReply(typed).lead).toBe(typed);
  });

  it("leaves an inline payload alone in an array and with prose after it", () => {
    const array = 'The runner logs [{"action": "click", "x": 1}] each time.';
    expect(splitReply(array).lead).toBe(array);
    const trailing = '{"action":"click"} then it worked.';
    expect(splitReply(trailing).lead).toBe(trailing);
  });

  it("still removes a payload that owns its line, indentation and all", () => {
    const parts = splitReply('Done.\n\n  {"action": "click", "x": 1}\n\nNext.');
    expect(parts.lead).toBe("Done.");
    expect(parts.detail).toBe("Next.");
  });

  // The other direction of the same guard: a line is dropped only when it names
  // the act of emitting tool calls. Ordinary sentences that merely sound like
  // telegraphing — "we need to send", "now let's call" — matched a broader
  // pattern, so they were deleted, and alone in a reply the voice said nothing.
  it("keeps an ordinary sentence that only sounds like tool narration", () => {
    const sentences = [
      "We need to send the report to the team before Friday.",
      "I need to call the vendor about the invoice.",
      "Then let us call it a day.",
      "Next let me send the report over to them.",
    ];
    for (const sentence of sentences) {
      const parts = splitReply(sentence);
      expect(parts.lead).toBe(sentence);
      expect(parts.toolLeakOnly).toBeUndefined();
    }
  });

  it("still drops a line that does name the act of emitting tool calls", () => {
    // prose around it survives, and a reply that is nothing but that line stays
    // leak-only so the voice is silent — the guarantee the pattern exists for
    expect(splitReply('We need to output tool use calls.\n\nHere is the summary.').lead)
      .toBe("Here is the summary.");
    expect(splitReply("We need to output tool use calls.").toolLeakOnly).toBe(true);
  });
});
