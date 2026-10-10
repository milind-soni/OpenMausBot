import { describe, expect, it } from "vitest";
import { plainPreviewText } from "./plain-preview";

describe("plainPreviewText", () => {
  it.each([
    ["I added the **cover card** to the deck (11 slides).", "I added the cover card to the deck (11 slides)."],
    ["I read **[Prudctual/OpenMausBot](https://github.com/Prudctual/OpenMausBot)** and the issues.", "I read Prudctual/OpenMausBot and the issues."],
    ["See [the guide](https://example.com/a_(b)) first", "See the guide first"],
    ["![chart](/api/attachments/chart.png) is attached", "chart is attached"],
    ["Open <https://example.com/x> now", "Open https://example.com/x now"],
    ["Start with `pnpm install`, then test.", "Start with pnpm install, then test."],
    ["```ts\nconst draft = await loadDraft(id);\n```\nThe loader is fixed.", "const draft = await loadDraft(id); The loader is fixed."],
    ["## Findings\n- The form accepts any password.\n- Cookies lack `Secure`.", "Findings The form accepts any password. Cookies lack Secure."],
    ["1. first\n2) second\n- [x] done", "first second done"],
    ["> quoted line\n>> nested", "quoted line nested"],
    ["| name | score |\n|---|:---:|\n| Ada | 9 |", "name score Ada 9"],
    ["_lightly_ and *also* and ~~gone~~ and ***all***", "lightly and also and gone and all"],
    ["above\n\n---\n\nbelow", "above below"],
    ["line one<br>line two", "line one line two"],
    ["a reply cut off mid **bold", "a reply cut off mid bold"],
    ["```python\nprint('hi')", "print('hi')"],
    ["escaped \\*star\\* stays", "escaped *star* stays"],
    // code keeps its own syntax, fenced or inline
    ["```js\nconst pattern = '**required**';\n```", "const pattern = '**required**';"],
    // a longer closing fence of the same character closes the block
    ["```\nnpm test\n````\nAll **green** now.", "npm test All green now."],
    // a fence of the other character does not
    ["~~~\nlet a = 1\n```\nb", "let a = 1 ``` b"],
    ["Use `**kwargs` and `[a](b)` as written", "Use **kwargs and [a](b) as written"],
    ["Run `a\\*b` here", "Run a\\*b here"],
    ["~~~\n# not a heading\n- not a list\n~~~\nafter", "# not a heading - not a list after"],
    // an image's address can hold balanced parentheses too
    ["![plot](/charts/a_(b).png) attached", "plot attached"],
  ])("reads %j as plain text", (input, expected) => {
    expect(plainPreviewText(input)).toBe(expected);
  });

  it("leaves text without markdown alone", () => {
    for (const text of ["snake_case_name stays", "2 * 3 = 6", "price is $5 * 2", "C# and F# are fine", "use a_b_c here", "Done."]) {
      expect(plainPreviewText(text)).toBe(text);
    }
  });

  it("keeps right-to-left text and its own punctuation", () => {
    expect(plainPreviewText("قرأت تفاصيل **[Prudctual/OpenMausBot](https://github.com/x)** مستودعك")).toBe("قرأت تفاصيل Prudctual/OpenMausBot مستودعك");
  });

  it("folds every line break and run of spaces into one line", () => {
    expect(plainPreviewText("  one\n\n\ttwo   three \n")).toBe("one two three");
  });
});
