import { describe, expect, it } from "vitest";

import { plainPreviewText } from "./plain-preview.ts";

describe("the one line a sidebar or a notification shows", () => {
  it("keeps the words of the markdown a person typed, and none of its markers", () => {
    expect(plainPreviewText("**bold** and _italic_ and ~~strike~~")).toBe("bold and italic and strike");
    expect(plainPreviewText("- [ ] buy milk")).toBe("buy milk");
    expect(plainPreviewText("1. first\n2. second")).toBe("first second");
    expect(plainPreviewText("# Heading\ntext")).toBe("Heading text");
    expect(plainPreviewText("> quoted\n> lines")).toBe("quoted lines");
    expect(plainPreviewText("see [docs](https://x/y_(z)) now")).toBe("see docs now");
    // Underscores inside a word, and a lone `*` between numbers, are no emphasis.
    expect(plainPreviewText("snake_case_name stays; 2 * 3 = 6")).toBe("snake_case_name stays; 2 * 3 = 6");
    expect(plainPreviewText("use `code` here")).toBe("use code here");
    expect(plainPreviewText("```js\nconst x = 1;\n```\nafter")).toBe("const x = 1; after");
  });

  it("drops a Setext heading's underline, which is no word of the line", () => {
    expect(plainPreviewText("Report\n======\nthis week")).toBe("Report this week");
    expect(plainPreviewText("Q3 plan\n===")).toBe("Q3 plan");
    expect(plainPreviewText("Q3 plan\n---")).toBe("Q3 plan");
    expect(plainPreviewText("Q3 plan\n--")).toBe("Q3 plan");
  });

  it("reads a spaced thematic break as the rule it is, not as a list of dashes", () => {
    expect(plainPreviewText("- - -")).toBe("");
    expect(plainPreviewText("before\n* * *\nafter")).toBe("before after");
    expect(plainPreviewText("---")).toBe("");
  });

  it("keeps a list item whose text starts with a dash", () => {
    expect(plainPreviewText("- -5 degrees outside")).toBe("-5 degrees outside");
  });
});
