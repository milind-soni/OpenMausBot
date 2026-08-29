import { describe, expect, it } from "vitest";

import type { ModelSelection } from "./contracts.ts";
import {
  preferredCoordinatorSelection,
  resolveWorkerModelSelection,
  type WorkerEngineChoice,
} from "./worker-model-selection.ts";

const owner = {
  instanceId: "cursor",
  model: "cursor-grok-4.6-high",
  effort: "high",
} satisfies ModelSelection;

const cursor = {
  instanceId: "cursor",
  displayName: "Cursor",
  models: {
    default: "cursor-auto",
    options: [
      { id: "cursor-auto", label: "Auto" },
      { id: "cursor-grok-4.6-high", label: "Grok 4.6 High" },
      { id: "cursor-claude-fable-5", label: "Claude Fable 5" },
      { id: "cursor-claude-sonnet-4.6", label: "Claude Sonnet 4.6" },
      { id: "cursor-claude-sonnet-4.5", label: "Claude Sonnet 4.5" },
    ],
  },
  effortLevels: ["low", "medium", "high"],
} satisfies WorkerEngineChoice;

const claude = {
  instanceId: "claude",
  displayName: "Claude Code",
  models: {
    default: "sonnet",
    options: [
      { id: "haiku", label: "Haiku" },
      { id: "sonnet", label: "Sonnet" },
      { id: "opus", label: "Opus" },
    ],
  },
  effortLevels: ["low", "medium", "high"],
} satisfies WorkerEngineChoice;

const codex = {
  instanceId: "codex",
  driverKind: "codex",
  displayName: "Codex",
  models: {
    default: "gpt-5.6-sol",
    options: [
      { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
      { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
      { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
    ],
  },
  effortLevels: ["low", "medium", "high", "xhigh", "max"],
} satisfies WorkerEngineChoice;

describe("worker model selection", () => {
  it("inherits the coordinator selection when no override is requested", () => {
    expect(resolveWorkerModelSelection(owner, {}, cursor)).toEqual({ ok: true, selection: owner });
  });

  it("resolves a unique human-facing model fragment on the inherited engine", () => {
    expect(resolveWorkerModelSelection(owner, { model: "Fable" }, cursor)).toEqual({
      ok: true,
      selection: { instanceId: "cursor", model: "cursor-claude-fable-5", effort: "high" },
    });
  });

  it("uses the new engine default and clears engine-specific effort when only the engine changes", () => {
    expect(resolveWorkerModelSelection(owner, { engineId: "claude" }, claude)).toEqual({
      ok: true,
      selection: { instanceId: "claude", model: "sonnet" },
    });
  });

  it("accepts an explicit effort or clears it with default", () => {
    expect(resolveWorkerModelSelection(owner, { model: "Fable", effort: "low" }, cursor)).toEqual({
      ok: true,
      selection: { instanceId: "cursor", model: "cursor-claude-fable-5", effort: "low" },
    });
    expect(resolveWorkerModelSelection(owner, { model: "Fable", effort: "default" }, cursor)).toEqual({
      ok: true,
      selection: { instanceId: "cursor", model: "cursor-claude-fable-5" },
    });
  });

  it("rejects an ambiguous label instead of guessing", () => {
    const result = resolveWorkerModelSelection(owner, { model: "Sonnet" }, cursor);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("ambiguous");
  });

  it("rejects unknown models and unsupported effort instead of falling back", () => {
    const missing = resolveWorkerModelSelection(owner, { model: "not-a-real-model" }, cursor);
    expect(missing.ok).toBe(false);
    const unsupported = resolveWorkerModelSelection(owner, { effort: "xhigh" }, cursor);
    expect(unsupported.ok).toBe(false);
  });

  it("defaults Codex coordinators to Sol high and executors to Luna high", () => {
    expect(preferredCoordinatorSelection(codex)).toEqual({
      instanceId: "codex",
      model: "gpt-5.6-sol",
      effort: "high",
    });
    expect(resolveWorkerModelSelection(
      { instanceId: "codex", model: "gpt-5.6-sol", effort: "high" },
      {},
      codex,
    )).toEqual({
      ok: true,
      selection: { instanceId: "codex", model: "gpt-5.6-luna", effort: "high" },
    });
  });

  it("preserves explicit Codex worker model and effort overrides", () => {
    expect(resolveWorkerModelSelection(
      { instanceId: "codex", model: "gpt-5.6-sol", effort: "high" },
      { model: "gpt-5.6-terra", effort: "low" },
      codex,
    )).toEqual({
      ok: true,
      selection: { instanceId: "codex", model: "gpt-5.6-terra", effort: "low" },
    });
  });
});
