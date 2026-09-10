import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { setLocale } from "@/lib/i18n";
import { locales } from "@/locales";

import { RawMarkdownView, RawToggleAction } from "./RawMarkdownToggle";

afterEach(() => {
  setLocale("en");
  delete locales["raw-toggle-test"];
});

describe("RawToggleAction", () => {
  it("renders with inactive label and styling when raw mode is off", () => {
    const markup = renderToStaticMarkup(
      createElement(RawToggleAction, {
        active: false,
        onToggle: () => undefined,
      }),
    );

    expect(markup).toContain('aria-label="Show raw markdown"');
    expect(markup).toContain('title="Show raw markdown"');
    expect(markup).not.toContain("text-accent");
    expect(markup).toContain('type="button"');
    expect(markup).toContain('aria-pressed="false"');
  });

  it("renders with active label, highlight styling, and Eye icon when raw mode is on", () => {
    const markup = renderToStaticMarkup(
      createElement(RawToggleAction, {
        active: true,
        onToggle: () => undefined,
      }),
    );

    expect(markup).toContain('aria-label="Show rendered markdown"');
    expect(markup).toContain('title="Show rendered markdown"');
    expect(markup).toContain("text-accent");
    expect(markup).toContain("bg-raised");
    expect(markup).toContain("opacity-100");
    expect(markup).toContain('aria-pressed="true"');
  });

  it("uses the active language for both toggle states", () => {
    locales["raw-toggle-test"] = {
      "chat.showRawMarkdown": "Voir le Markdown brut",
      "chat.showRenderedMarkdown": "Voir le Markdown rendu",
    };
    setLocale("raw-toggle-test");
    for (const [active, label] of [[false, "Voir le Markdown brut"], [true, "Voir le Markdown rendu"]] as const) {
      const markup = renderToStaticMarkup(createElement(RawToggleAction, { active, onToggle: () => undefined }));
      expect(markup).toContain(`aria-label="${label}"`);
      expect(markup).toContain(`title="${label}"`);
    }
  });
});

describe("RawMarkdownView", () => {
  it("renders raw markdown text in preformatted container without executing or dropping tags", () => {
    const sampleMarkdown = "# Title\n\n```ts\nconst x = 42;\n```\n\n* bullet point\n<script>alert(1)</script>";
    const markup = renderToStaticMarkup(
      createElement(RawMarkdownView, {
        text: sampleMarkdown,
      }),
    );

    expect(markup).toContain("<pre");
    expect(markup).toContain("font-mono");
    expect(markup).toContain("whitespace-pre-wrap");
    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain(sampleMarkdown.replaceAll("<", "&lt;").replaceAll(">", "&gt;"));
    expect(markup).not.toContain("<script>");
  });

  it("remounts the message boundary when toggling away from a failed renderer", () => {
    const source = readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8");
    expect(source).toContain('<MessageBoundary key={viewRaw ? "raw" : "rendered"}');
    expect(source).toContain("<RawMarkdownView text={text} />");
  });
});
