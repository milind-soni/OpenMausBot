import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { PromptPreview, type PromptPreviewData } from "./PromptPreview";

const data: PromptPreviewData = {
  sections: [
    { id: "persona", label: "Identity", text: "You are Scout, a personal bot in OpenMausBot.", bytes: 120 },
    { id: "soul", label: "Standing instructions (SOUL.md)", text: "Always cite primary sources.", bytes: 340 },
  ],
  totalBytes: 460,
  approxTokens: 115,
  note: "Approximate — a real turn can add task notes and per-message skills.",
};

describe("PromptPreview", () => {
  it("shows the byte/token header while closed, without the section rows", () => {
    const markup = renderToStaticMarkup(
      createElement(PromptPreview, { data, open: false, onToggle: vi.fn() }),
    );

    expect(markup).toContain("Prompt preview · 460 bytes ≈ 115 tokens");
    expect(markup).not.toContain("Identity");
    expect(markup).not.toContain("Standing instructions (SOUL.md)");
  });

  it("renders one row per section, with its label and byte count, when open", () => {
    const markup = renderToStaticMarkup(
      createElement(PromptPreview, { data, open: true, onToggle: vi.fn() }),
    );

    expect(markup).toContain("Prompt preview · 460 bytes ≈ 115 tokens");
    expect(markup).toContain("Identity");
    expect(markup).toContain("120 bytes");
    expect(markup).toContain("Standing instructions (SOUL.md)");
    expect(markup).toContain("340 bytes");
    expect(markup).toContain(data.note);
  });

  it("shows a failure message instead of Loading… forever when the fetch failed", () => {
    const markup = renderToStaticMarkup(
      createElement(PromptPreview, { data: null, error: true, open: true, onToggle: vi.fn() }),
    );

    expect(markup).toContain("Couldn’t load the prompt preview.");
    expect(markup).not.toContain("Loading…");
  });

  it("still shows Loading… (not the failure message) while a fetch is in flight", () => {
    const markup = renderToStaticMarkup(
      createElement(PromptPreview, { data: null, error: false, open: true, onToggle: vi.fn() }),
    );

    expect(markup).toContain("Loading…");
    expect(markup).not.toContain("Couldn’t load the prompt preview.");
  });
});
