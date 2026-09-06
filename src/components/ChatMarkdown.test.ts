import { createElement } from "react";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  ChatMarkdown,
  chatUrlTransform,
  markdownImageName,
  markdownImageOpenUrl,
  localFilePath,
} from "./ChatMarkdown";

vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof React>();
  return { ...react, useEffect: vi.fn(react.useEffect) };
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
