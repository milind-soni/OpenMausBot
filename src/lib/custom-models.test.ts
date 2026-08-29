import { describe, expect, it } from "vitest";

import { filterCustomModels, partitionCustomModels, suggestedModels } from "./custom-models";

const rows = [
  { id: "omlx::gemma-4-31b-it-bf16", label: "gemma-4-31b-it-bf16 (oMLX)", loaded: true },
  { id: "omlx::GLM-5.2-fp8", label: "GLM-5.2-fp8 (oMLX)" },
  { id: "ollama::llama3.2:latest", label: "llama3.2:latest (Ollama)" },
];

describe("filterCustomModels", () => {
  it("matches the visible label or the encoded host id", () => {
    expect(filterCustomModels(rows, "gemma").map((row) => row.id)).toEqual(["omlx::gemma-4-31b-it-bf16"]);
    expect(filterCustomModels(rows, "OLLAMA").map((row) => row.id)).toEqual(["ollama::llama3.2:latest"]);
    expect(filterCustomModels(rows, "omlx").map((row) => row.id)).toEqual([
      "omlx::gemma-4-31b-it-bf16",
      "omlx::GLM-5.2-fp8",
    ]);
  });

  it("treats blank search as no filter", () => {
    expect(filterCustomModels(rows, "  ")).toEqual(rows);
  });
});

describe("partitionCustomModels", () => {
  it("pins loaded models first and keeps relative order", () => {
    expect(partitionCustomModels(rows)).toEqual({
      pinned: [rows[0]],
      rest: [rows[1], rows[2]],
    });
  });

  it("skips the divider groups when nothing is loaded", () => {
    expect(partitionCustomModels(rows.filter((row) => !row.loaded))).toEqual({
      pinned: [],
      rest: [rows[1], rows[2]],
    });
  });
});

describe("suggestedModels", () => {
  it("pins the active and default models before filling from catalog order", () => {
    const options = ["a", "b", "c", "d", "e", "f"].map((id) => ({ id }));
    expect(suggestedModels(options, "b", "f", 4).map((option) => option.id)).toEqual(["f", "b", "a", "c"]);
  });

  it("does not duplicate a current default", () => {
    const options = ["a", "b", "c"].map((id) => ({ id }));
    expect(suggestedModels(options, "b", "b", 3).map((option) => option.id)).toEqual(["b", "a", "c"]);
  });

  it("keeps distinct live Cursor families discoverable instead of filling the rail with variants", () => {
    const options = [
      "auto",
      "composer-2.5",
      "composer-2.5-fast",
      "gpt-5.3-codex",
      "claude-sonnet-5-thinking-high",
      "gpt-5.3-codex-low",
      "gpt-5.3-codex-low-fast",
      "gpt-5.3-codex-fast",
      "gpt-5.2",
      "cursor-grok-4.6-high-fast",
      "claude-opus-5-thinking-high",
      "gpt-5.6-sol-high",
      "claude-fable-5-high",
      "gpt-5.6-luna-high",
    ].map((id) => ({ id }));

    const visible = suggestedModels(options, "auto", undefined, 8).map((option) => option.id);
    expect(visible).toContain("cursor-grok-4.6-high-fast");
    expect(visible).toContain("claude-fable-5-high");
    expect(visible).toContain("gpt-5.6-luna-high");
    expect(visible).toContain("claude-opus-5-thinking-high");
    expect(visible.filter((id) => id.startsWith("gpt-5.3-codex"))).toHaveLength(1);
  });
});
