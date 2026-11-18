// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { setLocale } from "../lib/i18n";
import { StreamingReplyContext } from "@/state/live-reply";

const mode = vi.hoisted(() => ({ whole: false, pieces: 0 }));
vi.mock("@/lib/markdown-stream-blocks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/markdown-stream-blocks")>();
  return {
    ...actual,
    splitMarkdownBlocks: (text: string) => (mode.whole ? null : actual.splitMarkdownBlocks(text)),
    splitStreamPieces: (block: string) => {
      const pieces = mode.whole ? null : actual.splitStreamPieces(block);
      if (pieces) mode.pieces++;
      return pieces;
    },
  };
});
vi.mock("@/lib/interface-mode", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/interface-mode")>(),
  useAdvancedMode: () => true,
  readAdvancedMode: () => true,
}));

const { ChatMarkdown, ensureChatKatex, normalizeMathDelimiters } = await import("./ChatMarkdown");
const { mayHoldMath } = await import("@/lib/markdown-stream-blocks");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CORPUS: Record<string, string> = {
  "tight bullets": "- one\n- two with `code`\n- three **bold**\n- four\n\nAfter the list.",
  "tight ordered": "1. one\n2. two\n3. three\n10. ten\n11. eleven\n",
  "ordered from above one": "7. seven\n8. eight\n9. nine\n\nDone",
  "ordered with parens": "1) one\n2) two\n3) three",
  "loose bullets": "- one\n\n- two\n\n- three\n\nAfter",
  "loose ordered with bodies": "1. **First**\n\n   The body of the first.\n\n2. **Second**\n\n   The body of the second.\n\n3. **Third**\n\nEnd.",
  "tight then loose": "- one\n- two\n- three\n\n- four\n- five",
  "blank inside one item only": "- one\n\n  more of one\n- two\n- three\n",
  "blank inside a nested list": "- one\n  - a\n\n  - b\n- two\n- three\n",
  "nested lists": "- one\n  - a\n  - b\n    - deep\n- two\n  1. x\n  2. y\n- three",
  "ordered with nested bullets": "1. Title\n   - sub a\n   - sub b\n2. Next\n   - sub c\n3. Last\n",
  "nested under ten": "9. nine\n   - in nine\n10. ten\n    - in ten\n   - not in ten\n11. eleven",
  "under-indented child": "1. one\n  - not nested\n2. two",
  "list with a fence": "- one\n  ```js\n  const a = 1;\n\n  const b = 2;\n  ```\n- two\n- three",
  "item opening with a fence": "- ```sh\n  ls -la\n  ```\n- two\n-   ```\n    wide\n    ```\n- three",
  "fence broken by the next item": "- one\n  ```\n  code\n- two\n- three",
  "loose list with a fence": "1. Run it:\n\n   ```sh\n   pnpm test\n   ```\n\n2. Read it.\n\n3. Ship it.",
  "list with a blockquote": "- one\n  > quoted\n  > more\n- two\n> outside\n- three",
  "list with indented code": "- one\n\n      code\n\n- two\n-     code first\n- three",
  "indented code before what cannot interrupt": "    code\n\n2. item\n\n    code\n\n-\n\n    code\n\n> -\n\n    code\n\n<br>\n\n    code\n\n| a | b |\n|---|---|\n",
  "indented code inside a numbered list": "1. a\n\n       code\n\n2. b\n\n3. c\n\n       code\n\n4.\n5. e",
  "indented code inside bullets": "- a\n\n      code\n\n-\n- c\n\n      code\n\n- - \n- 2. x\n",
  "indented code inside a tight list": "- a\n      code\n-\n- c\n1. x\n\n1. a\n       code\n2. b\n3.\n",
  "task list": "- [ ] open\n- [x] done\n- [ ] another `one`\n- plain\n",
  "loose task list": "- [ ] open\n\n- [x] done\n\n- [ ] more",
  "marker changes": "- one\n- two\n* three\n* four\n+ five\n\n1. a\n2. b\n1) c\n2) d",
  "thematic breaks in a list": "- one\n- two\n- - -\n- three\n* * *\n* four\n---\n- five",
  "setext under an item": "- one\n---\n- two\n\nText\n-\n- three",
  "lazy continuation": "- one\nlazy line\n- two\n  kept\nlazy again\n- three",
  "lazy digits": "1. one\n2. two\n12\n3. three\n4",
  "empty items": "- one\n-\n- three\n-\n  filled later\n- \n- six\n-\n\n  not in the item",
  "empty first item": "-\n- two\n- three\n\n1.\n2. two",
  "list after a paragraph": "Here are the steps:\n- one\n- two\n- three\n\nAnd numbered:\n1. a\n2. b",
  "numbers that do not start a list": "The year was\n2. not a list\n3. still text\n\nIt was\n1. a list\n2. indeed",
  "list after a heading": "## Steps\n- one\n- two\n\n### More\n1. a\n2. b\n",
  "list after other blocks": "> quote\n- one\n- two\n\n<div>\n- html\n- still\n\n| a | b |\n- x | y\n- z\n",
  "paragraph after a tight list": "- one\n- two\nnot an item\n\n- three\n  kept\n\n  kept too\n\n text\n",
  "list with pipes and at signs": "- run `a | b` for @sam\n- then `c || d`\n- x | y\n- | z |\n",
  "list with links and images": "- [docs](https://example.com) and ![pic](https://example.com/a.png)\n- <https://example.com>\n- plain https://example.com/x\n",
  "list with right-to-left text": "- 123\n- 456\n- שלום עולם\n- more\n\n1. 1\n2. مرحبا\n",
  "list with html": "- one\n  <!-- note\n\n  still note -->\n- two\n- <b>three</b>\n",
  "long tight list": Array.from({ length: 12 }, (_, i) => `- item ${i} with **bold** and \`code\``).join("\n"),
  "table": "| a | b | c |\n|---|---|---|\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |\n\nAfter",
  "table with alignment": "| left | mid | right |\n|:-----|:---:|------:|\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |\n",
  "table with code and pipes": "| cmd | what |\n| --- | --- |\n| `a \\| b` | pipe |\n| `c` | x \\| y |\n| `d | e` | split |\n| **f** | [g](https://example.com) |\n",
  "table with ragged rows": "| a | b |\n|---|---|\n| 1 |\n| 1 | 2 | 3 |\n|\n| | |\n|| x |\n",
  "table header first": "| name | value |\n",
  "table with a growing delimiter": "| a | b | c |\n|---|---|\n| 1 | 2 |\n\n| a | b |\n|---|---|---|\n| 1 | 2 |\n",
  "table without outer pipes": "a | b\n--|--\n1 | 2\n3 | 4\n",
  "table rows without a leading pipe": "| a | b |\n|---|---|\n| 1 | 2 |\n3 | 4\nplain\n| 5 | 6 |\n",
  "table ended by other blocks": "| a | b |\n|---|---|\n| 1 | 2 |\n> quote\n\n| a | b |\n|---|---|\n| 1 | 2 |\n# Heading\n\n| a | b |\n|---|---|\n| 1 | 2 |\n```\ncode\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n- item\n",
  "table of one column": "| a |\n|---|\n| 1 |\n| x | y |---|---| z | w |\n| 2 |\n",
  "table needing repair": "Intro\n| a | b |\n|---|\n| 1 | 2 |\n\n| a | b | |---|---| | 1 | 2 | | 3 | 4 |\n",
  "table with right-to-left text": "| 1 | 2 |\n|---|---|\n| 3 | 4 |\n| שלום | 5 |\n",
  "table with breaks": "| a | b |\n|---|---|\n| one<br>two | x |\n| three | y<br/>z |\n",
  "table after an image": "![pic](https://example.com/a.png)\n\n| a | b |\n|---|\n| 1 | 2 |\n\n- one\n- two\n",
  "html block": "<details>\n<summary>More</summary>\n\nHidden **text**.\n\n</details>\n\nAfter\n\n<div>\n- not a list\n\n- a list\n",
  "html that runs past blank lines": "<pre>\nline\n\n- not a list\n</pre>\n\nAfter\n\n<!-- a\n\ncomment -->\n\nText\n\n<script>\n\nlet a;\n\n</script> tail\n\nEnd",
  "html left open": "Intro\n\n<!-- open\n\n- one\n\n# two\n\nthree",
  "html inside a paragraph": "Text\n<style>\n\np { color: red }\n\n</style>\n\nAfter <b>bold</b> text\n\n<?php\n\necho 1;\n\n?>\n\n<!DOCTYPE html>\n\nEnd",
  "display math": "Intro\n\n$$\nx^2 + y^2\n\n= z^2\n$$\n\nBetween\n\n$$a + b$$\n\nMore\n\n\\[\nc\n\\]\n\n\\[ d \\]\n\nEnd",
  "display math at the top": "$$x^2$$\n\nOne paragraph.\n\nAnother paragraph.\n\n- one\n- two\n",
  "display math left open": "Intro\n\n$$\nx\n\ny\n\n- z\n",
  "display math inside text": "The value $$x$$ is here.\n\nAnd more.\n\nA lone $$ sign.\n\nMore still.\n\n$$ closes it",
  "display math across paragraphs": "Start \\[ a\n\nb \\] end\n\nText $$ one\n\ntwo $$ three\n\nfour",
  "display math with a tag": "$$ meta\nx\n\ny\n\nz\n",
  "display math in a list": "1. First:\n   $$\n   x\n   $$\n2. Second: $$y$$\n\nAfter\n\n3. Third",
  "inline math": "With \\(a + b\\) and $c$ inline.\n\nPrices: $5 and $10.\n\nOpen \\( here\n\nclosed \\) there\n\nEnd",
  "math and code": "Run `echo $$` now.\n\nThen `\\[` too.\n\n```sh\necho $$\n```\n\n$$\nx `y`\n$$\n\nEnd\n\n$$\n\n    z $$\n\nEnd",
  "list with dollars": "- costs $5\n- and $6 here$\n- b y$ and $z w$\n",
  "footnotes": "A claim.[^1]\n\n- one\n- two\n\n[^1]: The source.\n\nAfter",
  "reference links": "See [the docs][1] and [more].\n\n- [x][1]\n- two\n\n[1]: https://example.com\n[more]: https://example.com/more\n",
  "container marks": "::: note\n\nbody\n\n:::\n\nAfter",
  "code fences": "Intro\n\n```js\nconst a = 1;\n\n- not a list\n```\n\n~~~\n| a | b |\n|---|---|\n~~~\n\n    indented\n\n    more\n\nEnd",
  "blank-looking lines": "one\n\u00a0\ntwo\n \t \nthree\n\n- a\n\u00a0\n- b\n",
  "mixed": "# Report\n\nSummary with **bold**, `code` and a [link](https://example.com).\n\n## Steps\n\n1. Install:\n\n   ```sh\n   pnpm install\n   ```\n\n2. Run it.\n3. Done.\n\n| step | time |\n|------|-----:|\n| one | 1 s |\n| two | 2 s |\n\n> Note: this is quoted.\n\n- [x] shipped\n- [ ] verified\n\n<details>\n\nMore.\n\n</details>\n\n$$\nE = mc^2\n$$\n\nThe end.",
  "html directly above a list": "<div>\n- a\n- b\n\n<details>\n<summary>S</summary>\n- a\n- b\n</details>\n\n<br>\n- one\n\n</pre>\n1) p\n",
  "pipe line above a list": "a | b\n- | -\n- c\n",
  "item text opening with a marker": "Text\n- - \n\nText\n- 2. x\n\nPlain text here.\n1. **Title**\n2. next\n",
  "html named inline and in a fence": "Use `<script>` and `<!-- -->` in a line.\n\nNext\n\n- a\n- b\n\n```html\n<!doctype html>\n<script>\nlet a = 1;\n\nlet b = 2;\n</script>\n```\n\nAfter\n",
  "quoted comment": "> quote\n> <!-- note\n\nstill -->\n\nEnd",
  "right-to-left first letter in a later row": "| # | 1 |\n| - | - |\n| 2 | \u05e9\u05dc\u05d5\u05dd |\n",
  "long html opener inside a short html block": "</pre>\n<!X\n\n```\n+ plus\n</pre>\n<!X\n- [x] done\n</pre>\n\n|",
  "first item indented by one": " - a\n- b\n- c\n\n-\tx\n- b\n",
};

// A fence the text never closes keeps its actions hidden until the reply is finished.
const OPEN_AT_THE_END = ["item opening with a fence", "fence broken by the next item", "long html opener inside a short html block"];

const FRAGMENTS = [
  "- one", "- two `code`", "- three **bold**", "* star", "+ plus", "-", "- ", "- - -", "---", "***", "- [ ] task", "- [x] done",
  "1. first", "2. second", "3. third", "10. tenth", "1) paren", "2) paren", "1.", "7", "12",
  "  - nested", "> -", "> 2. two", "- 2. x", "- - ", "  more of it", "   deeper text", "    four in", "      six in", " one in", "  > quoted inside", "  ```", "  code", "   ```",
  "| a | b |", "|---|---|", "|:--|--:|", "| 1 | 2 |", "| `x \\| y` | z |", "| 3 |", "|", "a | b", "--|--", "| a | b | c |", "|---|---|---|", "|---|",
  "Plain text here.", "Another line", "# Heading", "## Two", "> quote", "> - quoted item", "```", "```js", "~~~", "const a = 1;",
  "<div>", "</div>", "<details>", "<!-- note", "end -->", "<pre>", "</pre>", "<script>", "</script>", "<b>bold</b> text", "<?x", "?>", "<!X", "<br>",
  "$$", "$$x^2$$", "\\[", "\\]", "\\[ y \\]", "a $$ b", "\\(c\\) and $d$", "\\( open", "close \\)", "$5 and $6", "`echo $$`", "$$ meta", "  $$",
  "1. **Title**", "   body text", "   - sub", "  | a | b |", "> | a | b |", "| a | b |  ", "\\| a", "text\\", "[x] not a task", "- [link](https://example.com)",
  "@sam and #thread", "https://example.com/path", "![pic](https://example.com/a.png)", "שלום", "123", "\u00a0", "=== ", "===", "text | with | pipes",
];

function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomDocument(next: () => number): string {
  // Most documents draw from a few fragments, so lists and tables grow long enough to be cut.
  const pool = Array.from({ length: 2 + Math.floor(next() * 7) }, () => FRAGMENTS[Math.floor(next() * FRAGMENTS.length)]!);
  let text = "";
  for (let lines = 3 + Math.floor(next() * 14); lines > 0; lines--) {
    const from = next() < 0.75 ? pool : FRAGMENTS;
    text += from[Math.floor(next() * from.length)]! + (next() < 0.3 ? "\n\n" : "\n");
  }
  return next() < 0.5 ? text : text.trimEnd();
}

describe("a streamed reply drawn block by block and piece by piece", () => {
  let hosts: HTMLDivElement[];
  let streamed: Root;
  let whole: Root;
  const draw = (root: Root, text: string, streaming: boolean, asWhole: boolean) => {
    mode.whole = asWhole;
    act(() => root.render(createElement(StreamingReplyContext, { value: streaming }, createElement(ChatMarkdown, { text }))));
    mode.whole = false;
  };

  beforeAll(async () => {
    setLocale("en");
    await ensureChatKatex();
    hosts = [document.createElement("div"), document.createElement("div")];
    document.body.append(...hosts);
    streamed = createRoot(hosts[0]!);
    whole = createRoot(hosts[1]!);
  });
  afterAll(() => {
    act(() => { streamed.unmount(); whole.unmount(); });
    hosts.forEach((host) => host.remove());
  });

  /** The cut where drawing `text` in parts first differs from drawing it whole, or null. */
  const firstDifference = (text: string, cuts: number[]): string | null => {
    for (const cut of cuts) {
      const prefix = text.slice(0, cut);
      draw(streamed, prefix, true, false);
      draw(whole, prefix, true, true);
      const [parts, all] = [hosts[0]!.innerHTML, hosts[1]!.innerHTML];
      if (parts === all) continue;
      let at = 0;
      while (parts[at] === all[at]) at++;
      return `${JSON.stringify(prefix)} at ${at}\n  parts: ${JSON.stringify(parts.slice(Math.max(0, at - 60), at + 120))}\n  whole: ${JSON.stringify(all.slice(Math.max(0, at - 60), at + 120))}`;
    }
    return null;
  };

  // The cache is never cleared: a piece kept while drawing one document must also be right in every other.
  it.each(Object.entries(CORPUS))("%s: every prefix draws as the whole text does", (name, text) => {
    expect(firstDifference(text, Array.from({ length: text.length }, (_, index) => index + 1))).toBeNull();
    if (OPEN_AT_THE_END.includes(name)) return;
    draw(whole, text, false, true);
    expect(hosts[0]!.innerHTML, "the finished reply").toBe(hosts[1]!.innerHTML);
  });

  it("random documents: every sampled prefix draws as the whole text does", () => {
    const next = random(20261118);
    for (let index = 0; index < 150; index++) {
      const text = randomDocument(next);
      const cuts: number[] = [];
      for (let cut = 1; cut < text.length; cut += 1 + Math.floor(next() * 6)) cuts.push(cut);
      for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n", at + 1)) cuts.push(at, at + 1, at + 2);
      cuts.push(text.length);
      const ordered = [...new Set(cuts)].filter((cut) => cut >= 1 && cut <= text.length).sort((a, b) => a - b);
      expect(firstDifference(text, ordered), `document ${index}`).toBeNull();
    }
  }, 120_000);

  it("leaves text without math delimiters as it came when it is normalized in full", () => {
    const next = random(7);
    const texts = [...Object.values(CORPUS), ...Array.from({ length: 600 }, () => randomDocument(next))].filter((text) => !mayHoldMath(text));
    expect(texts.length).toBeGreaterThan(200);
    // An image map turns the shortcut off, so this is the full normalization the shortcut stands in for.
    for (const text of texts) expect(normalizeMathDelimiters(text, new Map()), text).toBe(text);
  });

  it("cuts lists and tables into pieces along the way", () => {
    expect(mode.pieces).toBeGreaterThan(1000);
  });
});
