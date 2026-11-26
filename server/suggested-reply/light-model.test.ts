import { describe, expect, it } from "vitest";

import type { ModelCatalog } from "../contracts.ts";
import { codexBackgroundRoute } from "../drivers/codex-background-text.ts";
import { lightModelFor, type LightModelEngine } from "./light-model.ts";

const catalog = (...ids: string[]): ModelCatalog => ({ default: ids[0] ?? "", options: ids.map((id) => ({ id, label: id })) });
const call = async () => "";
const textEngine = (driverKind: string, models: ModelCatalog, extra: Partial<LightModelEngine> = {}): LightModelEngine => ({ driverKind, models, generateText: call, ...extra });
const backgroundEngine = (driverKind: string, models: ModelCatalog, extra: Partial<LightModelEngine> = {}): LightModelEngine => ({ driverKind, models, generateMemoryText: call, ...extra });

describe("lightModelFor", () => {
  it("picks Haiku for Claude", () => {
    expect(lightModelFor(textEngine("claudeAgent", catalog("claude-opus-5-5", "claude-sonnet-5", "claude-haiku-5-5", "claude-haiku-4-5"))))
      .toEqual({ model: "claude-haiku-5-5", call: "text" });
  });

  it("picks the small model for Codex on an API key", () => {
    expect(lightModelFor(backgroundEngine("codex", catalog("gpt-6", "gpt-6-luna", "gpt-5.4-mini"), { quickModelsUsable: () => true })))
      .toEqual({ model: "gpt-6-luna", call: "background" });
    expect(lightModelFor(backgroundEngine("codex", catalog("gpt-6", "gpt-5.4-mini"))))
      .toEqual({ model: "gpt-5.4-mini", call: "background" });
  });

  it("keeps Codex's background call on the small model it was pinned to, with no retry on a bigger one", () => {
    const models = catalog("gpt-6", "gpt-6-luna", "gpt-5.4-mini");
    const light = lightModelFor(backgroundEngine("codex", models))!.model;
    const pinned = { model: light, refused: new Set<string>(), onRefused: () => {} };
    expect(codexBackgroundRoute(models, true, pinned)).toEqual({ model: "gpt-6-luna" });
    expect(codexBackgroundRoute(models, true, pinned, true)).toEqual({ model: "gpt-6-luna" });
  });

  it("picks Grok's mini model, then its fast one", () => {
    expect(lightModelFor(textEngine("grok", catalog("grok-4.7", "grok-4", "grok-4-fast", "grok-3-mini")))).toEqual({ model: "grok-3-mini", call: "text" });
    expect(lightModelFor(backgroundEngine("grokAgent", catalog("grok-4.7", "grok-4-fast")))).toEqual({ model: "grok-4-fast", call: "background" });
  });

  it("picks Flash-Lite for Antigravity, else Flash", () => {
    expect(lightModelFor(backgroundEngine("antigravityAgent", catalog("gemini-4-argon", "gemini-3.8-flash", "gemini-3.8-flash-lite"))))
      .toEqual({ model: "gemini-3.8-flash-lite", call: "background" });
    expect(lightModelFor(backgroundEngine("antigravityAgent", catalog("gemini-4-argon", "gemini-3.8-flash"))))
      .toEqual({ model: "gemini-3.8-flash", call: "background" });
  });

  it("is off when the provider lists no small model", () => {
    expect(lightModelFor(textEngine("claudeAgent", catalog("claude-opus-5-5", "claude-sonnet-5")))).toBeNull();
    expect(lightModelFor(backgroundEngine("grokAgent", catalog("grok-4.7", "grok-4.6")))).toBeNull();
    expect(lightModelFor(backgroundEngine("codex", catalog("gpt-6", "gpt-6-codex")))).toBeNull();
  });

  it("is off when the sign-in refuses small models (Codex on a ChatGPT plan)", () => {
    expect(lightModelFor(backgroundEngine("codex", catalog("gpt-6", "gpt-6-luna"), { quickModelsUsable: () => false }))).toBeNull();
  });

  it("is off when the engine's one-shot call can't name the model", () => {
    expect(lightModelFor(backgroundEngine("claudeAgent", catalog("claude-haiku-5-5")))).toBeNull();
    expect(lightModelFor(backgroundEngine("geminiAgent", catalog("gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite")))).toBeNull();
  });

  it("is off for local models, custom endpoints and other agents", () => {
    expect(lightModelFor(textEngine("openai-compat", catalog("gpt-4o", "gpt-4o-mini")))).toBeNull();
    expect(lightModelFor(textEngine("ollama", catalog("llama3.2:1b", "qwen-mini")))).toBeNull();
    expect(lightModelFor(backgroundEngine("customAcp", catalog("tiny-mini")))).toBeNull();
    expect(lightModelFor(textEngine("mistral", catalog("mistral-large", "mistral-small")))).toBeNull();
    const local: ModelCatalog = { default: "claude-sonnet-5", options: [{ id: "claude-sonnet-5", label: "Sonnet" }, { id: "local/haiku-ish", label: "local", local: {} as never }] };
    expect(lightModelFor(textEngine("claudeAgent", local))).toBeNull();
    const custom: ModelCatalog = { default: "x", options: [{ id: "claude-haiku-5-5", label: "mine", custom: true }] };
    expect(lightModelFor(textEngine("claudeAgent", custom))).toBeNull();
  });

  it("skips a small model this engine refused before", () => {
    expect(lightModelFor(textEngine("claudeAgent", catalog("claude-haiku-5-5", "claude-haiku-4-5")), new Set(["claude-haiku-5-5"])))
      .toEqual({ model: "claude-haiku-4-5", call: "text" });
    expect(lightModelFor(textEngine("claudeAgent", catalog("claude-haiku-5-5")), new Set(["claude-haiku-5-5"]))).toBeNull();
  });
});
