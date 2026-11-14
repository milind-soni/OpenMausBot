import { describe, expect, it } from "vitest";

import { classifyTurn, fastModelFor, routeDirectTurn, routeTurn, type RouteInput } from "./turn-route.ts";
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

  it("skips a quick model the engine refused before", () => {
    expect(fastModelFor(mixed, "gpt-5.4", new Set(["gpt-5.4-mini"]))).toBeUndefined();
    expect(fastModelFor(claude, "claude-opus-5", new Set(["gpt-5.4-mini"]))).toBe("claude-haiku-4-5");
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

describe("long conversations", () => {
  const windowed: ModelCatalog = { default: "claude-opus-5", options: [
    { id: "claude-opus-5", label: "Claude Opus 5", contextWindow: 1_000_000 },
    { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", contextWindow: 200_000 },
  ] };
  const input: RouteInput = {
    conversational: true, followsBotModel: true, automated: false, signals: { text: "hi there", ...plain },
    model: "claude-opus-5", effort: "high", catalog: windowed,
  };

  it("stays on the configured model when the thread would crowd the quick model's window", () => {
    expect(routeTurn({ ...input, contextTokens: 150_000 })).toEqual({ tier: "simple", model: "claude-opus-5", effort: "high", variant: undefined });
    expect(routeTurn({ ...input, contextTokens: 40_000 }).quickModel).toBe("Claude Haiku 4.5");
  });
});

describe("routeDirectTurn", () => {
  const bot = { replyStyle: "conversational" as const, modelSelection: { instanceId: "claude", model: "claude-opus-5" } };
  const instance = { models: claude, adapter: { capabilities: { effortLevels: ["low", "high"] as const } } };
  const message = { text: "and the other one?", images: [] };

  it("reads tool use after the last ask from the thread", () => {
    const quiet = [{ role: "user", kind: "text" }, { role: "bot", kind: "text" }];
    const worked = [{ role: "user", kind: "text" }, { role: "bot", kind: "activity" }, { role: "bot", kind: "text" }];
    expect(routeDirectTurn(bot, {}, quiet, message, instance, false).quickModel).toBe("Claude Haiku 4.5");
    expect(routeDirectTurn(bot, {}, worked, message, instance, false).tier).toBe("complex");
  });

  it("never moves a short line when the sign-in can refuse a catalog model, as Codex on a ChatGPT account does", () => {
    const codex = { models: mixed, adapter: { capabilities: { effortLevels: ["low", "high"] as const } } };
    const own = { replyStyle: "conversational" as const, modelSelection: { instanceId: "codex", model: "gpt-5.4", effort: "high" as const } };
    const hi = { text: "hey, how are you?", images: [] };
    expect(routeDirectTurn(own, {}, [], hi, codex, false).model).toBe("gpt-5.4-mini");
    expect(routeDirectTurn(own, {}, [], hi, { ...codex, quickModelsUsable: () => false }, false))
      .toEqual({ tier: "simple", model: "gpt-5.4", effort: "low", variant: undefined });
    expect(routeDirectTurn(own, {}, [], hi, codex, false, new Set(["gpt-5.4-mini"])).quickModel).toBeUndefined();
  });

  it("leaves a thread with its own model and an automated turn alone", () => {
    expect(routeDirectTurn(bot, { modelSelection: bot.modelSelection }, [], message, instance, false).tier).toBeNull();
    expect(routeDirectTurn(bot, {}, [], message, instance, true).tier).toBeNull();
  });
});
