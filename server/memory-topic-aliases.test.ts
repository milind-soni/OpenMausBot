import { describe, expect, it } from "vitest";

import { mergeTopicText, parseTopicHeader } from "./memory-topics.ts";

describe("quoted memory topic aliases", () => {
  it("keeps commas, quotes, brackets and backslashes inside flow-list aliases", () => {
    const aliases = ["San Francisco, CA", 'The "Launch" project', "[draft]", "C:\\work"];
    expect(parseTopicHeader(`---\naliases: ${JSON.stringify(aliases)}\n---\n`).aliases).toEqual(aliases);
  });

  it("decodes YAML quoting in block-list aliases", () => {
    const text = `---\naliases:\n  - 'O''Brien'\n  - "The \\"Launch\\" project"\n  - 'San Francisco, CA'\n---\n`;
    expect(parseTopicHeader(text).aliases).toEqual(["O'Brien", 'The "Launch" project', "San Francisco, CA"]);
  });

  it("treats a quoted scalar as one alias while retaining legacy comma-separated aliases", () => {
    expect(parseTopicHeader('---\naliases: "San Francisco, CA"\n---\n').aliases).toEqual(["San Francisco, CA"]);
    expect(parseTopicHeader("---\naliases: food, lunch\n---\n").aliases).toEqual(["food", "lunch"]);
  });

  it("round-trips newly organized aliases through their saved frontmatter", () => {
    const aliases = ["San Francisco, CA", 'The "Launch" project', "[draft]", "*priority", "support: tier 2"];
    const text = mergeTopicText(null, { title: "Work", aliases, lines: ["- Keep the deployment notes."] });
    expect(parseTopicHeader(text).aliases).toEqual(aliases);
  });

  it("preserves quoted aliases while adding new aliases to an existing topic", () => {
    const existing = '---\ntitle: Work\naliases: ["San Francisco, CA", "[draft]"]\n---\n\n- Existing note.\n';
    const merged = mergeTopicText(existing, {
      title: "Work", aliases: ["SAN FRANCISCO, CA", 'The "Launch" project'], lines: ["- New note."],
    });
    expect(parseTopicHeader(merged).aliases).toEqual(["San Francisco, CA", "[draft]", 'The "Launch" project']);
    expect(merged).toContain("- Existing note.\n- New note.\n");
  });
});
