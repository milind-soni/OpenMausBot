import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { modelColor } from "@/lib/model-color";

vi.mock("@/state/store", async (original) => {
  const actual = await original<typeof import("@/state/store")>();
  return { ...actual, useStore: () => ({ state: actual.initialState, dispatch: vi.fn() }) };
});

const { GroupBars } = await import("./UsageSection");

const group = (key: string, label: string, input: number) => ({
  key, label, turns: 1, input, output: 0, cachedInput: 0, costUsd: null,
});

describe("model colours in the usage breakdown", () => {
  it("paints each model's dot and bar with the tone its provider keeps", () => {
    const models = [
      group("model:codex/gpt-6.1-sol", "gpt-6.1-sol", 1_000),
      group("model:codex/gpt-6-luna", "gpt-6-luna", 800),
      group("model:opencodeGo/opencode-go/deepseek-v4.1-flash", "deepseek-v4.1-flash", 600),
    ];
    const html = renderToStaticMarkup(createElement(GroupBars, { groupBy: "model", groups: models }));
    const painted = [...html.matchAll(/data-model-color="(#[0-9a-f]{6})"/gi)].map((match) => match[1]!);
    expect(painted).toHaveLength(6);
    const unique = [...new Set(painted)];
    expect(unique).toHaveLength(3);
    for (const model of models) expect(unique).toContain(modelColor(model.key));
  });

  it("leaves the other groupings on the app's accent colour", () => {
    const html = renderToStaticMarkup(createElement(GroupBars, { groupBy: "bot", groups: [group("bot:b1", "Scout", 1_000)] }));
    expect(html).not.toContain("data-model-color");
    expect(html).toContain("bg-accent/70");
  });
});
