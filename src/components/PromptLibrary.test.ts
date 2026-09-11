// Prompt library UI: merging stays deduped and bounded, the closed control
// renders plain text (per the repo's static-markup component tests), and
// the preview's replace flow is gated when instructions already exist.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { mergePresets, PresetPreview } from "./PromptLibrary";

const preset = (id: string, label = id) => ({ id, label, description: "d", text: "Text of " + label, source: "built-in" });

describe("mergePresets", () => {
  it("keeps built-ins first, drops duplicate ids, and stays bounded", () => {
    const merged = mergePresets([preset("a")], [preset("a", "dup"), preset("b"), preset("c")]);
    expect(merged.map((p) => p.id)).toEqual(["a", "b", "c"]);
    const many = mergePresets([preset("a")], Array.from({ length: 300 }, (_, i) => preset(`p${i}`)));
    expect(many).toHaveLength(200);
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

  it("offers a direct Apply for an empty soul", () => {
    const html = renderToStaticMarkup(
      createElement(PresetPreview, { preset: preset("y"), hasExisting: false, onApply: () => {}, onClose: () => {} }),
    );
    expect(html).toContain(">Apply<");
    expect(html).not.toContain("will be overwritten");
  });
});
