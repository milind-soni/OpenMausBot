import { describe, expect, it } from "vitest";

import { MODELS_SHOWN, searchModels, type ModelCatalogInstance } from "./internal-models.ts";

const engine = (instanceId: string, driverKind: string, displayName: string, options: Array<{ id: string; label: string; provider?: string }>, model = options[0]!.id): ModelCatalogInstance => ({
  instanceId, driverKind, displayName, snapshot: { state: "ready" }, models: { default: model, options }, capabilities: { effortLevels: ["low", "high"] },
});
const many = Array.from({ length: 30 }, (_, index) => ({ id: `vendor-${index}/model-${index}`, label: `Model ${index}`, provider: index % 2 ? "zai" : "moonshot" }));
const instances = [
  engine("claude", "claudeAgent", "Claude Code", [{ id: "claude-opus-5", label: "Claude Opus 5" }, { id: "claude-sonnet-5", label: "Claude Sonnet 5" }]),
  engine("openrouter", "openrouter", "OpenRouter", many, "vendor-3/model-3"),
];
const ids = (result: ReturnType<typeof searchModels>, instanceId: string) =>
  (result.instances.find((row) => row.instanceId === instanceId)?.models as { options: Array<{ id: string }> } | undefined)?.options.map((option) => option.id);

describe("list_models", () => {
  it("cuts a long catalog short without a search, keeping the default and the models in use, and says how many it left out", () => {
    const result = searchModels(instances, "", [{ instanceId: "openrouter", model: "vendor-20/model-20" }]);
    expect(ids(result, "claude")).toEqual(["claude-opus-5", "claude-sonnet-5"]);
    const shown = ids(result, "openrouter")!;
    expect(shown).toHaveLength(MODELS_SHOWN);
    expect(shown.slice(0, 2)).toEqual(["vendor-3/model-3", "vendor-20/model-20"]);
    expect(result.instances.find((row) => row.instanceId === "openrouter")).toMatchObject({ omitted: 22, state: "ready", effortLevels: ["low", "high"] });
    expect(result.instances.find((row) => row.instanceId === "claude")).not.toHaveProperty("omitted");
    expect(result.note).toContain("start_thread accepts any id the engine offers");
  });

  it("takes a word that names an engine as that engine, and filters models by the other words", () => {
    expect(searchModels(instances, "Claude  OPUS", []).instances.map((row) => row.instanceId)).toEqual(["claude"]);
    expect(ids(searchModels(instances, "Claude  OPUS", []), "claude")).toEqual(["claude-opus-5"]);
    expect(ids(searchModels(instances, "claudeagent", []), "claude")).toEqual(["claude-opus-5", "claude-sonnet-5"]);
    expect(ids(searchModels(instances, "model-1", []), "openrouter")).toEqual(["vendor-1/model-1", ...Array.from({ length: 10 }, (_, i) => `vendor-${10 + i}/model-${10 + i}`)]);
    expect(searchModels(instances, "model-1", []).instances.map((row) => row.instanceId)).toEqual(["openrouter"]);
    expect(ids(searchModels(instances, "zai model-2", []), "openrouter")).toEqual(["vendor-21/model-21", "vendor-23/model-23", "vendor-25/model-25", "vendor-27/model-27", "vendor-29/model-29"]);
    expect(ids(searchModels(instances, "openrouter", []), "openrouter")).toHaveLength(30);
    expect(searchModels(instances, "nothing-like-this", [])).toEqual({ instances: [], note: "Nothing matches that search. Try fewer words, or leave search out." });
  });
});
