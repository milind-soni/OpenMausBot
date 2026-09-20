// The spoken register is the half of voice that decides whether it is
// pleasant, and it is the piece most likely to be tuned against real
// transcripts — so its behaviour is pinned here rather than discovered in
// the kitchen at 8am.
import { describe, expect, it } from "vitest";

import { narrateTool, speakable, toUtterances } from "./speech-text.ts";
// the function lives in shared/, and this file is where it meets toUtterances
import { spokenReply } from "../../shared/reply-sections.ts";

describe("speakable", () => {
  it("names a code block instead of reading it", () => {
    const out = speakable("Here's the fix:\n\n```ts\nconst x: number = 1;\nif (x) throw new Error('no');\n```\n\nThat's it.");
    expect(out).toContain("TypeScript code block");
    expect(out).not.toContain("const x");
    expect(out).not.toContain("throw");
    expect(out).toContain("That's it.");
  });

  it("closes an unterminated fence rather than swallowing the rest", () => {
    // a streamed reply can be mid-fence when we're asked to speak it
    const out = speakable("Working on it:\n\n```sh\nnpm test");
    expect(out).toContain("Working on it");
    expect(out).toContain("code block");
    expect(out).not.toContain("npm test");
  });

  it("keeps a link's words and drops its URL", () => {
    expect(speakable("See [the README](https://example.com/a/b?c=d) for more")).toBe(
      "See the README for more",
    );
  });

  it("turns a bare URL into a noun", () => {
    expect(speakable("Deployed to https://astra.example.com/status now")).toBe(
      "Deployed to a link now",
    );
  });

  it("says the file, not the path to it", () => {
    expect(speakable("I changed server/drivers/acp/core.ts today")).toBe("I changed core.ts today");
  });

  it("keeps short inline code but not long snippets", () => {
    expect(speakable("Run `pnpm test` first")).toBe("Run pnpm test first");
    const long = speakable(`Use \`${"x".repeat(60)}\` here`);
    expect(long).toBe("Use that snippet here");
  });

  it("strips list scaffolding but keeps the pause between items", () => {
    const out = speakable("- first thing\n- second thing\n- third thing");
    expect(out).toBe("first thing. second thing. third thing");
  });

  it("reads a table as rows, not pipes", () => {
    const out = speakable("| Name | State |\n| --- | --- |\n| Scout | idle |");
    expect(out).not.toContain("|");
    expect(out).not.toContain("---");
    expect(out).toContain("Scout, idle");
  });

  it("drops emphasis markers, emoji and checkboxes", () => {
    expect(speakable("**Done** ✅ — [x] shipped the _thing_")).toBe("Done — shipped the thing");
  });

  it("gives a heading a full stop so the voice breathes", () => {
    expect(speakable("## Results\nAll green")).toBe("Results. All green");
  });

  it("collapses the punctuation its own substitutions create", () => {
    expect(speakable("Done.\n\n\n- one\n\n- two")).toBe("Done. one. two");
  });

  it("is empty for empty input", () => {
    expect(speakable("")).toBe("");
    expect(speakable("   \n\n  ")).toBe("");
  });
});

describe("toUtterances", () => {
  it("splits on sentences", () => {
    const out = toUtterances("The tests pass now. I changed two files. Want me to push it?");
    expect(out).toHaveLength(3);
    expect(out[0]).toBe("The tests pass now.");
    expect(out[2]).toBe("Want me to push it?");
  });

  it("does not split inside a decimal or an abbreviation", () => {
    const out = toUtterances("It dropped to 11.7 seconds per step, i.e. about half of what it was before.");
    expect(out).toHaveLength(1);
  });

  it("glues a fragment onto its neighbour", () => {
    // two words handed to a synthesizer produce two words of flat prosody
    const out = toUtterances("Yes. The whole suite is green and nothing else changed.");
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("Yes.");
  });

  it("breaks a runaway sentence at a clause, never mid-word", () => {
    const long = `I looked at ${Array.from({ length: 40 }, (_, i) => `item ${i}`).join(", ")} and finished.`;
    const out = toUtterances(long, { maxChars: 120 });
    expect(out.length).toBeGreaterThan(1);
    for (const piece of out) expect(piece.length).toBeLessThanOrEqual(140);
    // nothing lost, nothing cut in half
    expect(out.join(" ")).toContain("item 39");
  });

  it("runs its input through the spoken register first", () => {
    const out = toUtterances("Fixed it.\n\n```js\nconsole.log(1)\n```\n\nShipped.");
    expect(out.join(" ")).not.toContain("console.log");
  });

  it("is empty for text that speaks to nothing", () => {
    expect(toUtterances("```\ncode only\n```")).not.toContain("code only");
    expect(toUtterances("")).toEqual([]);
  });
});

describe("spokenReply", () => {
  // What a voice is handed is the lead half of a reply, so a long answer is
  // read for as long as its summary is — not for as long as its diff is.
  it("reads the lead of a reply that followed the section convention", () => {
    const text = "The redirect is fixed and the suite passes.\n\n## What changed\n\nI moved the query string onto the new path.\n\n## Files\n\n- auth.ts";
    expect(spokenReply(text)).toBe("The redirect is fixed and the suite passes.");
  });

  it("reads the opening section's body when the reply opens with a heading", () => {
    expect(spokenReply("## Summary\n\nI fixed the redirect.\n\n## Detail\n\nLong.")).toBe("I fixed the redirect.");
  });

  it("falls back to the whole reply when there are no headings to split on", () => {
    const text = "Tests pass.\n\n- one\n- two";
    expect(spokenReply(text)).toBe("Tests pass.");
    expect(spokenReply("Just the one sentence.")).toBe("Just the one sentence.");
  });

  it("reads a heading-only reply verbatim rather than saying nothing", () => {
    expect(spokenReply("## Notes")).toBe("## Notes");
    expect(toUtterances(spokenReply("## Notes"))).toEqual(["Notes."]);
  });

  // A model wrote its computer action as reply text. The reader may see the
  // raw payload; a voice reading `{ "action": "press", ... }` aloud is the
  // failure this module exists to prevent, so a pure-leak reply is silent.
  it("says nothing when the reply is nothing but a leaked tool payload", () => {
    const text = 'We need to output tool use calls.\n{ "action": "press", "keys": ["win", "r"] }';
    expect(spokenReply(text)).toBe("");
    expect(toUtterances(spokenReply(text))).toEqual([]);
  });

  it("speaks only the prose around a leaked payload, never the payload", () => {
    const text = 'Opening the Run dialog.\n{ "action": "press", "keys": ["win", "r"] }';
    expect(spokenReply(text)).toBe("Opening the Run dialog.");
  });

  // A payload inside a sentence is not a leak to remove: taking it out edits
  // the words around it, and the edited sentence is what the voice would say.
  it("speaks a sentence that contains a payload, payload and all", () => {
    const inline = 'The policy uses {"action": "click", "x": 1} by default.';
    expect(spokenReply(inline)).toBe(inline);
    expect(toUtterances(spokenReply(inline))).toEqual([inline]);
    const typed = 'I set {"action":"type","text":"hello"} in the script.';
    expect(spokenReply(typed)).toBe(typed);
  });

  // The mirror of the silence guard: a sentence that merely sounds like tool
  // narration is prose, so the voice says it rather than dropping it.
  it("speaks an ordinary sentence that only sounds like tool narration", () => {
    const sentences = [
      "We need to send the report to the team before Friday.",
      "I need to call the vendor about the invoice.",
      "Then let us call it a day.",
    ];
    for (const sentence of sentences) {
      expect(spokenReply(sentence)).toBe(sentence);
    }
  });
});

describe("narrateTool", () => {
  it("turns tool names into something worth hearing", () => {
    expect(narrateTool("Bash")).toBe("running a command");
    expect(narrateTool("Read")).toBe("reading a file");
    expect(narrateTool("Edit")).toBe("editing a file");
    expect(narrateTool("WebSearch")).toBe("searching the web");
    expect(narrateTool("screenshot")).toBe("looking at the screen");
  });

  it("sees through an MCP tool prefix", () => {
    expect(narrateTool("mcp__computer__click")).toBe("using the computer");
    expect(narrateTool("mcp__agents__ask_bot")).toBe("asking a teammate");
  });

  it("stays quiet for chips the user is already told about another way", () => {
    expect(narrateTool("auto-approved Bash:git (always allowed)")).toBeNull();
    expect(narrateTool("error: claude exited 1")).toBeNull();
    expect(narrateTool("")).toBeNull();
  });

  it("falls back to naming an unknown tool, without reading its argv", () => {
    expect(narrateTool("deploy_thing")).toBe("running deploy_thing");
    expect(narrateTool('curl -X POST "https://x/y" --data @{}')).toBeNull();
  });
});
