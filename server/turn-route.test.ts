import { describe, expect, it } from "vitest";

import { classifyTurn, fastModelFor, routeTurn, type RouteInput } from "./turn-route.ts";
import type { ModelCatalog } from "./contracts.ts";

const plain = { attachments: 0, priorTurnUsedTools: false };

describe("classifyTurn", () => {
  it.each([
    "hey, how are you?",
    "what's the capital of france",
    "thanks!",
    "شلونك اليوم؟",
  ])("a short chat line is simple: %s", (text) => {
    expect(classifyTurn({ ...plain, text })).toBe("simple");
  });

  it.each([
    "fix the failing test in server/index.ts",
    "can you research flights to tokyo next week",
    "what does `useMemo` do here",
    "here is my code:\n```js\nconst a = 1\n```",
    "a".repeat(400),
    "one?\ntwo?\nthree?\nfour?\nfive?",
    "why? how? when?",
  ])("work, code or a long ask is complex: %s", (text) => {
    expect(classifyTurn({ ...plain, text })).toBe("complex");
  });

  it("treats attachments as complex", () => {
    expect(classifyTurn({ text: "what is this", attachments: 1, priorTurnUsedTools: false })).toBe("complex");
  });

  it("keeps a go-ahead on the full model, with or without earlier tool work", () => {
    expect(classifyTurn({ text: "yes do it", attachments: 0, priorTurnUsedTools: true })).toBe("complex");
    expect(classifyTurn({ text: "sure", attachments: 0, priorTurnUsedTools: false })).toBe("complex");
  });

  it("keeps a follow-up after tool work on the full model, but not a thank you", () => {
    expect(classifyTurn({ text: "and the other one?", attachments: 0, priorTurnUsedTools: true })).toBe("complex");
    expect(classifyTurn({ text: "thanks!", attachments: 0, priorTurnUsedTools: true })).toBe("simple");
  });
});

const claude: ModelCatalog = {
  default: "claude-sonnet-5",
  options: [
    { id: "claude-opus-5", label: "Claude Opus 5" },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
    { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
  ],
};
const mixed: ModelCatalog = {
  default: "a",
  options: [
    { id: "gpt-5.4", label: "GPT 5.4", provider: "openai" },
    { id: "gemini-3.8-flash", label: "Gemini Flash", provider: "google" },
    { id: "gpt-5.4-mini", label: "GPT 5.4 Mini", provider: "openai" },
  ],
};

describe("fastModelFor", () => {
  it("finds the engine's quick variant", () => {
    expect(fastModelFor(claude, "claude-opus-5")).toBe("claude-haiku-4-5");
  });

  it("never crosses to another provider", () => {
    expect(fastModelFor(mixed, "gpt-5.4")).toBe("gpt-5.4-mini");
    expect(fastModelFor({ default: "x", options: [{ id: "x", label: "X", provider: "openai" }, { id: "y-flash", label: "Y", provider: "google" }] }, "x")).toBeUndefined();
  });

  it("keeps a model that is already fast, and gives up without a catalog", () => {
    expect(fastModelFor(claude, "claude-haiku-4-5")).toBe("claude-haiku-4-5");
    expect(fastModelFor(undefined, "claude-opus-5")).toBeUndefined();
  });
});

describe("routeTurn", () => {
  const base: RouteInput = {
    conversational: true, followsBotModel: true, automated: false,
    signals: { text: "hi there", ...plain },
    model: "claude-opus-5", effort: "high", variant: "v", catalog: claude, effortLevels: ["low", "medium", "high"],
  };

  it("moves a simple line of a conversational bot to the quick model", () => {
    expect(routeTurn(base)).toEqual({ tier: "simple", model: "claude-haiku-4-5", quickModel: "Claude Haiku 4.5" });
  });

  it("keeps the configured model and effort for complex work", () => {
    expect(routeTurn({ ...base, signals: { ...base.signals, text: "deploy the app" } })).toEqual({ tier: "complex", model: "claude-opus-5", effort: "high", variant: "v" });
  });

  it("changes nothing for a default bot, a picked thread model or an automated turn", () => {
    const kept = { tier: null, model: "claude-opus-5", effort: "high", variant: "v" };
    expect(routeTurn({ ...base, conversational: false })).toEqual(kept);
    expect(routeTurn({ ...base, followsBotModel: false })).toEqual(kept);
    expect(routeTurn({ ...base, automated: true })).toEqual(kept);
  });

  it("lowers an explicit effort when the engine has no quick model", () => {
    expect(routeTurn({ ...base, catalog: { default: "x", options: [{ id: "claude-opus-5", label: "Opus" }] } }))
      .toEqual({ tier: "simple", model: "claude-opus-5", effort: "low", variant: "v" });
  });
});
