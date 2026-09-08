import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ComposerTokenBadge } from "./ComposerTokenBadge";

describe("ComposerTokenBadge", () => {
  it("renders nothing when token estimate is 0", () => {
    const markup = renderToStaticMarkup(
      createElement(ComposerTokenBadge, {
        metrics: { words: 0, characters: 0, estimatedTokens: 0 },
      }),
    );
    expect(markup).toBe("");
  });

  it("renders formatted token count and accessible attributes for prompt content", () => {
    const markup = renderToStaticMarkup(
      createElement(ComposerTokenBadge, {
        metrics: { words: 12, characters: 64, estimatedTokens: 16 },
      }),
    );

    expect(markup).toContain("~16 tok");
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('aria-label="12 words, approximately 16 tokens"');
    expect(markup).toContain('title="Prompt estimate: 12 words, ~16 tokens (64 characters)"');
  });

  it("applies warning styles for large prompts approaching context limits", () => {
    const markup = renderToStaticMarkup(
      createElement(ComposerTokenBadge, {
        metrics: { words: 25000, characters: 140000, estimatedTokens: 35000 },
      }),
    );

    expect(markup).toContain("~35k tok");
    expect(markup).toContain("text-warning");
  });

  it("applies danger styles for extremely large prompts", () => {
    const markup = renderToStaticMarkup(
      createElement(ComposerTokenBadge, {
        metrics: { words: 80000, characters: 500000, estimatedTokens: 120000 },
      }),
    );

    expect(markup).toContain("~120k tok");
    expect(markup).toContain("text-danger");
  });
});
