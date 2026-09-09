import { createElement } from "react";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  ChatMarkdown,
  CodeBlock,
  chatUrlTransform,
  markdownImageName,
  markdownImageOpenUrl,
  localFilePath,
  textDirection,
} from "./ChatMarkdown";
import { StoreProvider } from "@/state/store";
import { ThreadRefsContext } from "./ThreadRefs";
import * as AttachmentPreview from "./AttachmentPreview";

vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof React>();
  return { ...react, useEffect: vi.fn(react.useEffect) };
});

describe("mention highlighting", () => {
  const mentionPeers = [{ name: "Atlas" }, { name: "調査担当" }];
  it("carries bot colors into Markdown without coloring everyone as a bot", () => {
    const html = renderToStaticMarkup(createElement(ChatMarkdown, {
      text: "@Atlas @Juniper @everyone", everyone: true,
      mentionPeers: [{ name: "Atlas", color: "blue" }, { name: "Juniper", color: "red" }],
    }));
    expect(html).toContain('style="--mention-color:#377FE6">@Atlas');
    expect(html).toContain('style="--mention-color:#D94B52">@Juniper');
    expect(html).toContain('<span class="mention-highlight">@everyone</span>');
  });
  it("highlights known mentions in prose, lists and tables", () => {
    const html = renderToStaticMarkup(createElement(ChatMarkdown, {
      text: "Ask @Atlas.\n\n- @調査担当 確認\n\n| Who |\n| --- |\n| @everyone |", mentionPeers, everyone: true,
    }));
    expect(html.match(/class="mention-highlight"/g)).toHaveLength(3);
    expect(html).toContain('<span class="mention-highlight">@Atlas</span>');
    expect(html).toContain("<table");
  });
  it("leaves code, links, emails and unknown names untouched", () => {
    const html = renderToStaticMarkup(createElement(ChatMarkdown, {
      text: "`@Atlas`\n\n```text\n@Atlas\n```\n\n[@Atlas](https://example.test) me@Atlas.test @Ghost", mentionPeers,
    }));
    expect(html).not.toContain('class="mention-highlight"');
    expect(html).toContain('href="https://example.test"');
  });
  it("keeps model HTML inert even when it contains a matching name", () => {
    const html = renderToStaticMarkup(createElement(ChatMarkdown, {
      text: '<img src=x onerror="bad()"> @Atlas', mentionPeers,
    }));
    expect(html).not.toContain("<img");
    expect(html).not.toContain('<script');
  });
});

describe("repaired tables", () => {
  it("keeps valid escaped-pipe cells and setext headings intact", () => {
    const html = renderToStaticMarkup(createElement(ChatMarkdown, {
      text: "Pros | Cons\n---\n\n| a \\| b | c |\n| --- | --- |\n| 1 | 2 |",
    }));
    expect(html).toContain('font-semibold">Pros | Cons</div>');
    expect(html.match(/<table\b/g)).toHaveLength(1);
    expect(html).toContain(">a | b</th>");
    expect(html.match(/<th\b/g)).toHaveLength(2);
  });

  it.each([
    "![shot][asset]\n\n[asset]: /workspace/preview.png",
    "![asset]\n\n[asset]: /workspace/preview.png",
    "![outer [inner]](/workspace/preview.png)",
  ])("keeps attachment offsets intact for all image syntax: %s", (image) => {
    const text = `| A | B | C |\n|---|---|\n| 1 | 2 | 3 |\n\n${image}`;
    const preview = vi.spyOn(AttachmentPreview, "MarkdownImagePreview");
    try {
      const html = renderToStaticMarkup(createElement(ChatMarkdown, {
        text, message: { threadId: "thread-1", messageId: "message-1" },
      }));
      expect(html).not.toContain("<table");
      expect(html).toContain("Loading ");
      expect(preview.mock.calls[0][0].sourceOffset).toBe(text.indexOf("!["));
    } finally {
      preview.mockRestore();
    }
  });

  it("renders a table whose delimiter row is a cell short of its header", () => {
    const html = renderToStaticMarkup(createElement(ChatMarkdown, {
      text: "| A | B | C |\n|---|---|\n| 1 | 2 | 3 |",
    }));
    expect(html).toContain("<table");
    expect(html).toContain("<th");
  });
  it("renders a table that arrived welded onto one line", () => {
    const html = renderToStaticMarkup(createElement(ChatMarkdown, {
      text: "Lead-in prose\n| A | B | |---|---| | 1 | 2 |",
    }));
    expect(html).toContain("<table");
    expect(html).toContain("Lead-in prose");
  });
  it("keeps a message holding an image byte-for-byte, offsets intact", () => {
    // MarkdownImagePreview resolves the attachment by source offset, so the
    // repair must not move it; the broken table stays broken by design.
    const html = renderToStaticMarkup(createElement(ChatMarkdown, {
      text: "![shot](https://example.test/a.png)\n\n| A | B | C |\n|---|---|\n| 1 | 2 | 3 |",
    }));
    expect(html).not.toContain("<table");
  });
});

it("requests both code palettes for skin-aware highlighting", async () => {
  const originalUseEffect = (await vi.importActual<typeof React>("react")).useEffect;
  const effects: React.EffectCallback[] = [];
  const effect = vi.mocked(React.useEffect).mockImplementation((callback) => { effects.push(callback); });
  const codeToHtml = vi.fn().mockResolvedValue("<pre>dual palette</pre>");
  vi.doMock("shiki", () => ({ codeToHtml }));
  const cleanup: ReturnType<React.EffectCallback>[] = [];
  try {
    renderToStaticMarkup(createElement(ChatMarkdown, { text: "```text\nPalette regression sample\n```" }));
    for (const callback of effects) cleanup.push(callback());
    await vi.waitFor(() => expect(codeToHtml).toHaveBeenCalledWith("Palette regression sample", {
      lang: "text",
      themes: { light: "github-light-default", dark: "github-dark-default" },
      defaultColor: "light-dark()",
    }));
  } finally {
    for (const close of cleanup) if (typeof close === "function") close();
    effect.mockImplementation(originalUseEffect);
    vi.doUnmock("shiki");
  }
});

describe("#Title thread links in markdown", () => {
  const threads = [
    { botId: "scout", botName: "Scout", threadId: "qa-245", title: "QA PR 245", activeAt: 2 },
    { botId: "scout", botName: "Scout", threadId: "short", title: "QA", activeAt: 1 },
  ];
  const render = (text: string) => renderToStaticMarkup(createElement(StoreProvider, null,
    createElement(ThreadRefsContext.Provider, { value: { threads, currentBotId: "scout" } }, createElement(ChatMarkdown, { text }))));

  it("links a known title in prose as a button that opens the thread", () => {
    const markup = render("I opened #QA PR 245 for the review.");
    expect(markup).toContain('<button type="button" data-thread-link="qa-245"');
    expect(markup).toContain('title="Open #QA PR 245"');
    expect(markup).toContain(">#QA PR 245</button>");
    expect(markup).not.toContain('data-thread-link="short"');
  });

  it("leaves code, links, headings and issue numbers alone", () => {
    const markup = render("`#QA PR 245` in code, [#QA PR 245](https://example.test) as a link, #123 an issue\n\n# QA PR 245\n\nplain");
    expect(markup).not.toContain("data-thread-link");
    expect(markup).toContain("<code");
    // the heading survives as a heading (this renderer draws it as a div), unlinked
    expect(markup).toContain('font-semibold">QA PR 245</div>');
  });

  it("does nothing without any visible threads", () => {
    const markup = renderToStaticMarkup(createElement(StoreProvider, null, createElement(ChatMarkdown, { text: "#QA PR 245" })));
    expect(markup).not.toContain("data-thread-link");
    expect(markup).toContain("#QA PR 245");
  });
});

describe("Markdown image metadata", () => {
  it("prefers alt text and otherwise derives a readable filename", () => {
    expect(markdownImageName("https://example.test/random.png", "Final render")).toBe("Final render");
    expect(markdownImageName("https://example.test/output/Launch%20art.webp")).toBe("Launch art.webp");
    expect(markdownImageName("")).toBe("Image");
  });

  it("only offers an external action for HTTP sources", () => {
    expect(markdownImageOpenUrl("https://example.test/image.png?token=abc"))
      .toBe("https://example.test/image.png?token=abc");
    expect(markdownImageOpenUrl("http://127.0.0.1/image.png"))
      .toBe("http://127.0.0.1/image.png");
    expect(markdownImageOpenUrl("file:///tmp/image.png")).toBeUndefined();
    expect(markdownImageOpenUrl("data:image/png;base64,abc")).toBeUndefined();
    expect(markdownImageOpenUrl("/api/attachments/image.png")).toBeUndefined();
    expect(markdownImageOpenUrl("//cdn.example.test/image.png"))
      .toBe("https://cdn.example.test/image.png");
  });
});

describe("message-scoped file targets", () => {
  it("recognizes relative and Windows UNC paths without treating web URLs as files", () => {
    expect(localFilePath("report.md#latest")).toBe("report.md#latest");
    expect(localFilePath("output.png")).toBe("output.png");
    expect(localFilePath("\\\\server\\share\\report.pdf")).toBe("\\\\server\\share\\report.pdf");
    expect(localFilePath("file://server/share/report.pdf")).toBe("//server/share/report.pdf");
    expect(localFilePath("//cdn.example.test/report.pdf")).toBeNull();
    expect(localFilePath("/C:/posix/report.pdf")).toBe("/C:/posix/report.pdf");
    expect(localFilePath("file:///C:/Users/Maus/report.pdf")).toBe("C:/Users/Maus/report.pdf");
    expect(localFilePath("https://example.test/report.pdf")).toBeNull();
    expect(localFilePath("#section")).toBeNull();
    expect(localFilePath("javascript:alert(1)")).toBeNull();
  });

  it("preserves supported local file spellings without widening unsafe protocols", () => {
    expect(chatUrlTransform("file:///Users/milind/report.md")).toBe("file:///Users/milind/report.md");
    expect(chatUrlTransform("C:/Users/Maus/report.md")).toBe("C:/Users/Maus/report.md");
    expect(chatUrlTransform("\\\\server\\share\\report.md")).toBe("\\\\server\\share\\report.md");
    expect(chatUrlTransform("javascript:alert(1)")).toBe("");
    expect(chatUrlTransform("https://example.test/report.md")).toBe("https://example.test/report.md");
  });
});

describe("ChatMarkdown attachments", () => {
  it("requires consent before loading a remote image", () => {
    const html = renderToStaticMarkup(createElement(ChatMarkdown, {
      text: "![Launch art](https://assets.example/hero.png)",
    }));

    expect(html).toContain("External image hidden for privacy");
    expect(html).toContain("Load image");
    expect(html).not.toContain("src=\"https://assets.example/hero.png\"");
  });

  it("requires consent for a protocol-relative image even inside a local link", () => {
    const html = renderToStaticMarkup(createElement(ChatMarkdown, {
      text: "[![Launch art](//assets.example/hero.png)](/workspace/original.png)",
      message: { threadId: "thread-1", messageId: "message-1" },
    }));

    expect(html).toContain("External image hidden for privacy");
    expect(html).not.toContain("src=\"//assets.example/hero.png\"");
  });

  it("keeps host paths private while routing them through the scoped file handler", () => {
    const html = renderToStaticMarkup(createElement(ChatMarkdown, {
      text: "[macOS](file:///Users/milind/report.md) [Windows](C:/Users/Maus/report.md)",
      message: { threadId: "thread-1", messageId: "message-1" },
    }));
    expect(html).toContain('title="Save a copy"');
    expect(html).not.toContain("/Users/milind/report.md");
    expect(html).not.toContain("C:/Users/Maus/report.md");
  });

  it("keeps an unscoped legacy file link inert", () => {
    const html = renderToStaticMarkup(createElement(ChatMarkdown, {
      text: "[Download the report](/workspace/final-report.pdf)",
    }));

    expect(html).toContain("Download the report");
    expect(html).toContain("Unavailable legacy file reference");
    expect(html).not.toContain("href=\"/workspace/final-report.pdf\"");
    expect(html).not.toContain("type=\"button\"");
  });

  it("makes a message-authorized file link downloadable", () => {
    const html = renderToStaticMarkup(createElement(ChatMarkdown, {
      text: "[Download the report](/workspace/final-report.pdf)",
      message: { threadId: "thread-1", messageId: "message-1" },
    }));
    expect(html).toContain('title="Save a copy"');
    expect(html).not.toContain("/workspace/final-report.pdf");
    expect(html).toContain("type=\"button\"");
  });

  it("does not nest a preview button in an anchor or block in a paragraph", () => {
    const standalone = renderToStaticMarkup(createElement(ChatMarkdown, {
      text: "![Launch art](https://assets.example/hero.png)",
    }));
    const linked = renderToStaticMarkup(createElement(ChatMarkdown, {
      text: "[![Launch art](https://assets.example/hero.png)](https://assets.example/original.png)",
    }));
    expect(standalone).not.toMatch(/<p[^>]*>\s*<div/);
    expect(linked).not.toMatch(/<a[^>]*>[\s\S]*role="button"/);
    expect(linked).toContain("href=\"https://assets.example/original.png\"");
  });

  it("does not expose a message-scoped host image path to the img element", () => {
    const html = renderToStaticMarkup(createElement(ChatMarkdown, {
      text: "![Generated preview](/workspace/output.png)",
      message: { threadId: "thread-1", messageId: "message-1" },
    }));
    expect(html).toContain("Loading Generated preview");
    expect(html).not.toContain("src=\"/workspace/output.png\"");
  });
});

describe("ChatMarkdown code blocks", () => {
  it.each([
    ["tsx", "TypeScript (TSX)"],
    ["averylongunknownlanguageidentifier", "Averylongunknownlanguageidentifier"],
  ])("lets the %s badge shrink without wrapping the count or controls", (lang, label) => {
    const html = renderToStaticMarkup(createElement(CodeBlock, {
      code: "first\nsecond", lang, streaming: false,
    }));
    const badge = html.match(/<span[^>]*title="[^"]*"[^>]*>/)?.[0];
    expect(badge).toContain(`title="${label}"`);
    expect(badge).toContain("min-w-0 truncate");
    expect(html).toContain("flex min-w-0 flex-1 items-center gap-2");
    expect(html).toMatch(/<span class="[^"]*shrink-0 whitespace-nowrap[^"]*">2 lines<\/span>/);
    expect(html).toContain("flex shrink-0 items-center gap-1 whitespace-nowrap");
    expect(html).toContain('aria-label="Copy code to clipboard"');
    expect(html).toContain('aria-label="Wrap long lines"');
  });

  it.each([["c++", "C++"], ["c#", "C#"]])("preserves punctuation in the %s fence label", (lang, label) => {
    const html = renderToStaticMarkup(createElement(ChatMarkdown, {
      text: `\`\`\`${lang}\nint value = 1;\n\`\`\``,
    }));
    expect(html).toContain(`>${label}</span>`);
  });

  it("counts deliberate blank lines before the closing fence", () => {
    const html = renderToStaticMarkup(createElement(ChatMarkdown, {
      text: "```ts\nconst x = 1;\n\n```",
    }));
    expect(html).toContain("2 lines");
    expect(html).toContain("const x = 1;\n</pre>");
  });

  it("renders normalized language badge, line count, and accessible buttons for fenced code", () => {
    const html = renderToStaticMarkup(createElement(ChatMarkdown, {
      text: "```ts\nconst x: number = 42;\nconsole.log(x);\n```",
    }));

    expect(html).toContain("TypeScript");
    expect(html).toContain("2 lines");
    expect(html).toContain('aria-label="Copy code to clipboard"');
    expect(html).toContain('aria-label="Wrap long lines"');
    expect(html).toContain('aria-label="Download snippet as file"');
    expect(html).toContain('title="Copy code"');
    expect(html).toContain('title="Download snippet as file"');
    expect(html).toContain('type="button"');
  });

  it("renders singular line count and handles unknown or omitted language identifiers", () => {
    const htmlUnknown = renderToStaticMarkup(createElement(ChatMarkdown, {
      text: "```zig\nconst std = @import(\"std\");\n```",
    }));
    expect(htmlUnknown).toContain("Zig");
    expect(htmlUnknown).toContain("1 line");

    const htmlOmitted = renderToStaticMarkup(createElement(ChatMarkdown, {
      text: "```\necho plain\n```",
    }));
    expect(htmlOmitted).toContain("Code");
    expect(htmlOmitted).toContain("1 line");
  });

  it("renders CodeBlock component directly with proper structure and accessibility", () => {
    const html = renderToStaticMarkup(createElement(CodeBlock, {
      code: "line1\nline2\nline3\n",
      lang: "py",
      streaming: false,
    }));

    expect(html).toContain("Python");
    expect(html).toContain("4 lines");
    expect(html).toContain('aria-label="Copy code to clipboard"');
    expect(html).toContain('aria-label="Wrap long lines"');
    expect(html).toContain('aria-label="Download snippet as file"');
    expect(html).toContain("line1\nline2\nline3");
  });
});

describe("bidi: message content carries its own direction", () => {
  const ARABIC = "مرحبا بالعالم";

  it("reads direction from the first strong letter, ignoring weak characters", () => {
    expect(textDirection("مرحبا")).toBe("rtl");
    expect(textDirection("hello")).toBe("ltr");
    expect(textDirection("")).toBe("ltr");
    // digits, punctuation and emoji are directionally weak — keep scanning
    expect(textDirection("  «2024» — مرحبا hello")).toBe("rtl");
    expect(textDirection("🎉 42. hello مرحبا")).toBe("ltr");
    expect(textDirection("שלום")).toBe("rtl");
    // the ranges have to hold for every RTL script, not a maintained list:
    // these span all four blocks Unicode reserves for right-to-left letters
    expect(textDirection("\u0780")).toBe("rtl"); // Thaana
    expect(textDirection("\u07CA")).toBe("rtl"); // N'Ko
    expect(textDirection("\uFB2E")).toBe("rtl"); // Hebrew presentation form
    expect(textDirection("\u{10D00}")).toBe("rtl"); // Hanifi Rohingya
    expect(textDirection("\u{10E80}")).toBe("rtl"); // Yezidi
    expect(textDirection("\u{10D50}")).toBe("rtl"); // Garay (10D40 is a digit)
    expect(textDirection("\u{10F70}")).toBe("rtl"); // Old Uyghur
    expect(textDirection("\u{1E900}")).toBe("rtl"); // Adlam
    // and must not swallow the LTR scripts that sit near those blocks
    expect(textDirection("\u{11000}\u{11005}")).toBe("ltr"); // Brahmi
    expect(textDirection("\u0915")).toBe("ltr"); // Devanagari
    expect(textDirection("\u4E2D")).toBe("ltr"); // Han
  });

  it("gives every block its own direction instead of the UI's", () => {
    const html = renderToStaticMarkup(createElement(ChatMarkdown, {
      text: [
        `# ${ARABIC}`,
        "",
        `${ARABIC} paragraph`,
        "",
        "An English paragraph stays left-to-right.",
        "",
        `> ${ARABIC}`,
        "",
        `- ${ARABIC}`,
        "",
        `| ${ARABIC} | b |`,
        "| --- | --- |",
        `| ${ARABIC} | 2 |`,
      ].join("\n"),
    }));

    expect(html).toContain('<div dir="rtl" class="mt-2 text-[16px] font-semibold">');
    expect(html).toContain('<p dir="rtl">');
    expect(html).toContain('<p dir="ltr">An English paragraph');
    expect(html).toContain('<blockquote dir="rtl"');
    expect(html).toContain('<ul dir="rtl"');
    expect(html).toContain('<table dir="rtl"');
  });

  it("keeps a table on one direction so columns and cells stay aligned", () => {
    // cells must NOT resolve individually: an Arabic header over a Latin
    // column would hang off the opposite edge from its own data
    const html = renderToStaticMarkup(createElement(ChatMarkdown, {
      text: `| ${ARABIC} | ms |\n| --- | --- |\n| buildIndex | 340 |`,
    }));
    expect(html).toContain('<table dir="rtl"');
    expect(html).not.toContain("<th dir=");
    expect(html).not.toContain("<td dir=");
  });

  it("judges a block by its prose, not by the code inside it", () => {
    const html = renderToStaticMarkup(createElement(ChatMarkdown, {
      text: `\`fs.readFileSync\` ${ARABIC} داخل الحلقة`,
    }));
    expect(html).toContain('<p dir="rtl">');
  });

  it("uses logical box properties so indents and rules follow the text", () => {
    const html = renderToStaticMarkup(createElement(ChatMarkdown, {
      text: `- ${ARABIC}\n\n1. ${ARABIC}\n\n> ${ARABIC}\n\n| a |\n| --- |\n| b |`,
    }));

    expect(html).toContain("list-disc space-y-1 ps-5");
    expect(html).toContain("list-decimal space-y-1 ps-5");
    expect(html).toContain("border-s-2 border-hairline ps-3");
    expect(html).toContain("px-2 py-1.5 text-start font-semibold");
    expect(html).not.toMatch(/class="[^"]*\bpl-5\b/);
    expect(html).not.toMatch(/class="[^"]*\bborder-l-2\b/);
    expect(html).not.toMatch(/class="[^"]*\btext-left\b/);
  });

  it("pins code left-to-right and isolates it from the surrounding RTL text", () => {
    const inline = renderToStaticMarkup(createElement(ChatMarkdown, {
      text: `${ARABIC} \`items[0].name\` ${ARABIC}`,
    }));
    expect(inline).toContain('<code dir="ltr"');
    expect(inline).toContain("[unicode-bidi:isolate]");

    const fenced = renderToStaticMarkup(createElement(CodeBlock, {
      code: "const total = items[0].count + 1;",
      lang: "ts",
      streaming: false,
    }));
    expect(fenced).toContain('<div dir="ltr"');
  });

  it("lets an inline span break, so a long path cannot leave the bubble", () => {
    // an unbreakable token wider than the bubble has nowhere to go but
    // outside it, and in an RTL paragraph that is off the left edge, where
    // the line ends — the direction that reads as text escaping the message
    const html = renderToStaticMarkup(createElement(ChatMarkdown, {
      text: `${ARABIC} \`dist/{download,privacy,terms,license,support,presskit,changelogs,docs,about,feedback}\` ${ARABIC}`,
    }));
    const inline = /<code [^>]*class="([^"]*)"/.exec(html)?.[1] ?? "";
    expect(inline).toContain("break-words");
  });

  it("gives links a base direction, not isolation alone", () => {
    // isolate keeps a link from disturbing the sentence around it, but the
    // link's own contents still lay out along its inherited direction — a URL
    // in an RTL paragraph needs an LTR base of its own.
    const url = renderToStaticMarkup(createElement(ChatMarkdown, {
      text: `${ARABIC} <https://example.test/a/b?x=1> ${ARABIC}`,
    }));
    expect(url).toContain('dir="auto"');

    // an Arabic label must not be pinned LTR, which is why the anchor
    // resolves rather than hard-coding a direction
    const labelled = renderToStaticMarkup(createElement(ChatMarkdown, {
      text: `[${ARABIC}](https://example.test/a)`,
    }));
    expect(labelled).toContain('dir="auto"');

    // a local path is always left-to-right, so that root is pinned. It needs
    // a message context: without one the link degrades to a plain label.
    const path = renderToStaticMarkup(createElement(ChatMarkdown, {
      text: `${ARABIC} [report](/Users/maus/out/report.md) ${ARABIC}`,
      message: { threadId: "thread-1", messageId: "message-1" },
    }));
    expect(path).toContain('<span dir="ltr"');
  });
});
