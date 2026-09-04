// Typed memory entries contract: every file the parser accepts renders back
// byte-for-byte, markers parse only in their canonical shape, and selection
// keeps the profile and takes the rest newest-first under the budget.
import { describe, expect, it } from "vitest";

import {
  entriesOf,
  MEMORY_PROFILE_MAX_LINES,
  parseMemory,
  renderEntry,
  renderMemory,
  selectMemory,
  type MemoryEntry,
} from "./memory-entries.ts";

const roundTrips = (md: string) => expect(renderMemory(parseMemory(md))).toBe(md);

const bullets = (kind: MemoryEntry["kind"], count: number, from = 1) =>
  Array.from({ length: count }, (_, i) => `- (2026-01-${String(from + i).padStart(2, "0")}) ${kind} ${from + i}`).join("\n");

describe("memory-entries parse/render", () => {
  it("round-trips every section shape, heading spelling, bullet character, and marker", () => {
    const md = [
      "# Memory",
      "",
      "Some prose the user wrote.",
      "",
      "## fact",
      "- (2026-09-01, thread ab6c9339-04a4-4527-816e-2d274dc4b46f, msg 9aca80c9-3065-4a76-8d68-fdd1cde42713) Pricing page owned by growth.",
      "* A starred fact with no marker.",
      "+ (2026-08-01, supersedes 2026-07-01) A plus fact.",
      "A prose line inside facts stays put.",
      "",
      "## PREFERENCES",
      "- (2026-08-30) Prefers short PR descriptions.",
      "  with a continuation line",
      "  and another",
      "",
      "## Contacts",
      "- Alex, growth team",
      "not a bullet",
      "",
      "## Episode",
      "- (2026-09-04, thread t1) Audited example.com.",
      "",
      "## Procedures",
      "- (2026-08-28) Deploy:",
      "  ```sh",
      "  - sk-live-notakeyjustcode0000000000",
      "  ## Not a heading",
      "  ```",
      "",
      "## History",
      "- (2026-07-01, superseded 2026-08-01) The old plus fact.",
      "",
    ].join("\n");
    roundTrips(md);

    const doc = parseMemory(md);
    expect(doc.preamble).toEqual(["# Memory", "", "Some prose the user wrote.", ""]);
    const entries = entriesOf(doc);
    expect(entries.map((entry) => entry.kind)).toEqual(["fact", "fact", "fact", "preference", "episode", "procedure", "history"]);
    expect(entries[0]).toMatchObject({
      date: "2026-09-01",
      threadId: "ab6c9339-04a4-4527-816e-2d274dc4b46f",
      messageId: "9aca80c9-3065-4a76-8d68-fdd1cde42713",
      text: "Pricing page owned by growth.",
      bullet: "-",
    });
    expect(entries[1]).toMatchObject({ bullet: "*", text: "A starred fact with no marker." });
    expect(entries[1]!.date).toBeUndefined();
    expect(entries[2]).toMatchObject({ bullet: "+", supersedes: "2026-07-01" });
    expect(entries[3]!.text).toBe("Prefers short PR descriptions.\nwith a continuation line\nand another");
    // the fenced block is one entry, and nothing inside it became a bullet or heading
    expect(entries[5]!.text).toBe("Deploy:\n```sh\n- sk-live-notakeyjustcode0000000000\n## Not a heading\n```");
    expect(entries[6]).toMatchObject({ kind: "history", supersededBy: "2026-08-01" });
    // the unknown section is preserved as lines, in place
    expect(doc.sections[2]).toEqual({ rawHeading: "## Contacts", lines: ["- Alex, growth team", "not a bullet", ""] });
  });

  it("treats a heading-less file as implicit facts and renders it without a heading", () => {
    const md = "- the user prefers pnpm\n- deploys on Fridays\n";
    roundTrips(md);
    const doc = parseMemory(md);
    expect(doc.preamble).toEqual([]);
    expect(doc.sections).toHaveLength(1);
    expect(entriesOf(doc).map((entry) => [entry.kind, entry.text])).toEqual([
      ["fact", "the user prefers pnpm"],
      ["fact", "deploys on Fridays"],
    ]);
  });

  it("keeps bullets before the first heading as facts, not preamble", () => {
    const md = "# Memory\n- an old bullet\n\n## Preferences\n- (2026-09-01) new style\n";
    roundTrips(md);
    const doc = parseMemory(md);
    expect(doc.preamble).toEqual(["# Memory"]);
    expect(entriesOf(doc).map((entry) => entry.kind)).toEqual(["fact", "preference"]);
  });

  it("does not glue a non-indented line to the entry above, and stops continuations after prose", () => {
    const md = "## Facts\n- one\nprose\n  indented after prose\n- two\n";
    roundTrips(md);
    const [one, two] = entriesOf(parseMemory(md));
    expect(one!.text).toBe("one");
    expect(two!.text).toBe("two");
  });

  it("treats malformed markers as text and keeps odd ids as given", () => {
    for (const body of ["(yesterday) x", "(2026-9-2) x", "(2026-09-02 thread x) x", "(2026-09-02, msg a, thread b) x"]) {
      const [entry] = entriesOf(parseMemory(`- ${body}`));
      expect(entry!.date).toBeUndefined();
      expect(entry!.text).toBe(body);
      roundTrips(`- ${body}`);
    }
    const [short] = entriesOf(parseMemory("- (2026-09-02, thread ab6c) x"));
    expect(short).toMatchObject({ date: "2026-09-02", threadId: "ab6c", text: "x" });
  });

  it("renderEntry emits no marker without a date and indents continuation lines", () => {
    expect(renderEntry({ kind: "fact", text: "plain", bullet: "-" })).toBe("- plain");
    const rendered = renderEntry({ kind: "fact", text: "first\nsecond", bullet: "*", date: "2026-01-01", supersededBy: "2026-02-02" });
    expect(rendered).toBe("* (2026-01-01, superseded 2026-02-02) first\n  second");
    expect(entriesOf(parseMemory(rendered))[0]).toMatchObject({ text: "first\nsecond", supersededBy: "2026-02-02" });
  });
});

describe("selectMemory", () => {
  const budget = { maxLines: 200, maxBytes: 24_000 };

  it("returns everything, complete, when the file fits", () => {
    const doc = parseMemory("# Memory\n\n## Facts\n- (2026-01-02) b\n- (2026-01-01) a\n\n## Preferences\n- p\n");
    const selection = selectMemory(doc, budget);
    expect(selection.complete).toBe(true);
    expect(selection.dropped).toEqual({});
    expect(selection.text).toBe("# Memory\n## Preferences\n- p\n## Facts\n- (2026-01-02) b\n- (2026-01-01) a");
    expect(selection.lines).toBe(6);
  });

  it("drops the oldest episodes first, then the oldest facts, and says so in the headings", () => {
    const md = `## Facts\n${bullets("fact", 30)}\n## Episodes\n${bullets("episode", 30)}\n`;
    const selection = selectMemory(parseMemory(md), { maxLines: 40, maxBytes: 24_000 });
    expect(selection.complete).toBe(false);
    // 40 lines: 1 heading + 30 facts, 1 heading + 8 episodes
    expect(selection.dropped).toEqual({ episode: 22 });
    expect(selection.text).toContain("## Facts (newest first)\n- (2026-01-30) fact 30");
    expect(selection.text).toContain("## Episodes (newest first; 22 older not shown)\n- (2026-01-30) episode 30");
    expect(selection.text).not.toContain("episode 8\n");
    const tighter = selectMemory(parseMemory(md), { maxLines: 20, maxBytes: 24_000 });
    // 20 lines: 1 heading + 19 facts; episodes never get a heading
    expect(tighter.dropped).toEqual({ fact: 11, episode: 30 });
    expect(tighter.text).not.toContain("## Episodes");
  });

  it("does not let a long procedure starve facts", () => {
    const md = `## Procedures\n- runbook:\n${Array.from({ length: 180 }, (_, i) => `  step ${i}`).join("\n")}\n## Facts\n${bullets("fact", 30)}\n`;
    const selection = selectMemory(parseMemory(md), budget);
    expect(selection.dropped).toEqual({ procedure: 1 });
    expect(selection.text).toContain("## Facts (newest first)");
    expect(selection.text).not.toContain("## Procedures");
  });

  it("caps the profile and cuts decisions before preferences", () => {
    const md = `## Preferences\n${bullets("preference", 60)}\n## Decisions\n${bullets("decision", 60)}\n## Facts\n${bullets("fact", 5)}\n`;
    const selection = selectMemory(parseMemory(md), budget);
    // 1 + 60 preferences = 61 lines; decisions get 100 - 61 = 39 lines: heading + 38
    expect(selection.dropped).toEqual({ decision: 22 });
    expect(selection.text).toContain("## Preferences (newest first)\n- (2026-01-60) preference 60");
    expect(selection.text).toContain("## Decisions (newest first; 22 older not shown)");
    expect(selection.text).toContain("## Facts (newest first)\n- (2026-01-05) fact 5");
    expect(MEMORY_PROFILE_MAX_LINES).toBe(100);
  });

  it("never selects history, loads unknown sections last, and cuts them last", () => {
    const md = `## History\n- (2025-01-01, superseded 2026-01-01) old\n## Notes\nfree text\nmore\n\n## Facts\n${bullets("fact", 3)}\n`;
    const full = selectMemory(parseMemory(md), budget);
    expect(full.text).toBe(`## Facts\n- (2026-01-03) fact 3\n- (2026-01-02) fact 2\n- (2026-01-01) fact 1\n## Notes\nfree text\nmore`);
    expect(full.text).not.toContain("old");
    const tight = selectMemory(parseMemory(md), { maxLines: 5, maxBytes: 24_000 });
    expect(tight.dropped).toEqual({ other: 3 });
    expect(tight.text).not.toContain("## Notes");
  });

  it("keeps file order for a heading-less undated file", () => {
    const md = "- first\n- second\n- third\n";
    expect(selectMemory(parseMemory(md), { maxLines: 3, maxBytes: 24_000 }).text).toBe("## Facts (newest first; 1 older not shown)\n- first\n- second");
  });

  it("applies the byte cap after the line cap, cutting from the end", () => {
    const md = `## Facts\n${bullets("fact", 10)}\n`;
    const selection = selectMemory(parseMemory(md), { maxLines: 200, maxBytes: 80 });
    expect(selection.bytes).toBeLessThanOrEqual(80);
    expect(selection.complete).toBe(false);
    expect(selection.dropped.other).toBeGreaterThan(0);
    expect(selection.text.startsWith("## Facts")).toBe(true);
  });
});
