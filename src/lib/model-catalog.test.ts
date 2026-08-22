import { describe, expect, it } from "vitest";

import {
  modelMetadata,
  modelReadinessLabel,
  modelSearchText,
  modelSelectable,
} from "./model-catalog";

describe("fleet model picker metadata", () => {
  it("shows cost, host, and admission state", () => {
    const option = {
      id: "minimax-m3-oscar",
      label: "MiniMax M3 · Oscar",
      canonicalId: "minimax-m3-oscar",
      host: "hosted",
      costClass: "paid" as const,
      isDefault: false,
      selectable: true,
      status: { configured: true, reachable: true, verified: true, admitted: true, busy: false },
    };
    expect(modelMetadata(option)).toEqual(["minimax-m3-oscar", "Paid", "hosted", "Ready"]);
    expect(modelSelectable(option)).toBe(true);
  });

  it("makes a busy admitted model visibly unavailable", () => {
    const option = {
      id: "ollama::qwen3:14b",
      label: "Qwen on Windows",
      host: "GUSTAVO",
      costClass: "local" as const,
      selectable: false,
      reason: "GPU is busy",
      status: { configured: true, reachable: true, verified: true, admitted: true, busy: true },
    };
    expect(modelReadinessLabel(option)).toBe("Busy");
    expect(modelSelectable(option)).toBe(false);
    expect(modelSearchText(option)).toContain("gpu is busy");
  });

  it("keeps ordinary provider rows selectable for compatibility", () => {
    expect(modelSelectable({ id: "gpt-5.6-sol", label: "GPT-5.6 Sol" })).toBe(true);
  });
});
