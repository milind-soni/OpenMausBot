import { describe, expect, it } from "vitest";

import { decodeDshModelId, encodeDshModelId, flattenDshModelCatalog, mapDshEffortLevels } from "./models.ts";

describe("DSH model selection ids", () => {
  it("round trips provider and model ids with slashes without delimiter collisions", () => {
    const first = encodeDshModelId("open/router", "deepseek/chat/v3");
    const second = encodeDshModelId("open", "router/deepseek/chat/v3");

    expect(first).not.toEqual(second);
    expect(decodeDshModelId(first)).toEqual({ provider: "open/router", model: "deepseek/chat/v3" });
    expect(decodeDshModelId(second)).toEqual({ provider: "open", model: "router/deepseek/chat/v3" });
    expect(decodeDshModelId("not-a-dsh-model-id")).toBeNull();
  });
});

describe("flattenDshModelCatalog", () => {
  it("flattens all successful provider groups in host order with context and exact effort metadata", () => {
    const catalog = flattenDshModelCatalog({
      groups: [
        {
          id: "deepseek-official",
          name: "DeepSeek",
          models: [
            {
              id: "deepseek-chat",
              name: "DeepSeek Chat",
              contextWindow: 128_000,
              reasoning: { efforts: [{ id: "off", name: "Off" }, { id: "high", name: "High" }, { id: "max", name: "Max" }] },
            },
          ],
        },
        {
          id: "openrouter",
          name: "OpenRouter",
          models: [
            { id: "deepseek/deepseek-v3", name: "DeepSeek V3", reasoning: { efforts: [{ id: "minimal", name: "Minimal" }] } },
          ],
        },
      ],
      failures: [{ id: "offline-route", name: "Offline route", message: "unavailable" }],
    });

    expect(catalog.catalog).toEqual({
      default: encodeDshModelId("deepseek-official", "deepseek-chat"),
      options: [
        {
          id: encodeDshModelId("deepseek-official", "deepseek-chat"),
          label: "DeepSeek: DeepSeek Chat",
          contextWindow: 128_000,
          effortLevels: ["none", "high", "max"],
        },
        {
          id: encodeDshModelId("openrouter", "deepseek/deepseek-v3"),
          label: "OpenRouter: DeepSeek V3",
          effortLevels: ["minimal"],
        },
      ],
    });
    expect(catalog.diagnostics).toEqual([]);
  });

  it("keeps successful provider catalogs when another provider fails, and reports no catalog only when none remain", () => {
    expect(
      flattenDshModelCatalog({
        groups: [{ id: "working", name: "Working", models: [{ id: "model", name: "Model" }] }],
        failures: [{ id: "broken", name: "Broken", message: "connection failed" }],
      }).catalog?.options,
    ).toHaveLength(1);
    expect(
      flattenDshModelCatalog({
        groups: [{ id: "working", name: "Working", models: [{ id: "model", name: "Model" }] }],
        failures: [{ id: "broken", name: "Broken", message: "connection failed" }],
      }).diagnostics,
    ).toEqual([]);
    expect(
      flattenDshModelCatalog({
        groups: [],
        failures: [{ id: "broken", name: "Broken", message: "connection failed" }],
      }),
    ).toEqual({ catalog: null, diagnostics: ["Broken: connection failed"] });
  });

  it("maps only the exact DSH effort ids, including off to none", () => {
    expect(mapDshEffortLevels(["off", "minimal", "low", "medium", "high", "xhigh", "max", "unsupported", "low"])).toEqual([
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });
});
