// Prompt library UI: merging stays deduped and bounded, combining turns a
// multi-prompt mix into headed sections, the mix bar gates apply on the
// SOUL cap, and replacing existing instructions needs an explicit confirm.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BOT_PROFILE_LIMITS } from "../../shared/bot-profile";
import { combinePresets, mergePresets, MixBar, PresetPreview } from "./PromptLibrary";

const preset = (id: string, label = id, text?: string) => ({
  id,
  label,
  description: "d",
  text: text ?? "Text of " + label,
  source: "built-in",
});

describe("mergePresets", () => {
  it("keeps built-ins first, drops duplicate ids, and stays bounded", () => {
    const merged = mergePresets([preset("a")], [preset("a", "dup"), preset("b"), preset("c")]);
    expect(merged.map((p) => p.id)).toEqual(["a", "b", "c"]);
    const many = mergePresets([preset("a")], Array.from({ length: 300 }, (_, i) => preset(`p${i}`)));
    expect(many).toHaveLength(200);
  });
});

describe("combinePresets", () => {
  it("applies a single prompt as-is, without headings", () => {
    expect(combinePresets([preset("a", "Reviewer")])).toBe("Text of Reviewer");
  });

  it("gives each combined prompt a heading and separates the sections", () => {
    const combined = combinePresets([preset("a", "Reviewer"), preset("b", "Writer")]);
    expect(combined).toBe("## Reviewer\n\nText of Reviewer\n\n---\n\n## Writer\n\nText of Writer");
  });

  it("keeps the user's selection order and returns empty for an empty mix", () => {
    const combined = combinePresets([preset("b", "B"), preset("a", "A")]);
    expect(combined.indexOf("## B")).toBeLessThan(combined.indexOf("## A"));
    expect(combinePresets([])).toBe("");
  });
});

describe("PresetPreview", () => {
  it("renders the prompt text and, with existing instructions, requires an explicit replace", () => {
    const html = renderToStaticMarkup(
      createElement(PresetPreview, {
        preset: preset("x", "Code reviewer"),
        hasExisting: true,
        onApply: () => {},
        onClose: () => {},
      }),
    );
    expect(html).toContain("Code reviewer");
    expect(html).toContain("Text of Code reviewer");
    expect(html).toContain("Replace instructions");
    expect(html).toContain("will be overwritten");
  });

  it("offers a direct Apply and an Add-to-mix action for an empty soul", () => {
    const html = renderToStaticMarkup(
      createElement(PresetPreview, {
        preset: preset("y"),
        hasExisting: false,
        onApply: () => {},
        onAddToMix: () => {},
        onClose: () => {},
      }),
    );
    expect(html).toContain(">Apply<");
    expect(html).toContain("Add to mix");
    expect(html).not.toContain("will be overwritten");
  });
});

describe("MixBar", () => {
  it("shows the combined byte count and gates replace behind a confirm", () => {
    const html = renderToStaticMarkup(
      createElement(MixBar, {
        mix: [preset("a", "Reviewer"), preset("b", "Writer")],
        hasExisting: true,
        onApply: () => {},
        onRemove: () => {},
        onClear: () => {},
      }),
    );
    expect(html).toContain("2 prompts combined");
    expect(html).toContain(`${
      (("## Reviewer\n\nText of Reviewer\n\n---\n\n## Writer\n\nText of Writer").length)
    }`);
    expect(html).toContain("Apply combined (2)");
    // With existing instructions the first click opens the confirm; static
    // markup can only prove the gated entry point exists.
  });

  it("disables apply when the combination exceeds the SOUL cap", () => {
    const big = "x".repeat(BOT_PROFILE_LIMITS.soul);
    const html = renderToStaticMarkup(
      createElement(MixBar, {
        mix: [preset("a", "Big", big), preset("b", "Bigger", big)],
        hasExisting: false,
        onApply: () => {},
        onRemove: () => {},
        onClear: () => {},
      }),
    );
    expect(html).toContain("too big for SOUL.md");
    expect(html).toContain("disabled");
  });
});
