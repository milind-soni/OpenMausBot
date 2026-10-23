import { expect, it } from "vitest";
import { createModelName, directModelUrl } from "./instance-description.ts";
import type { ProviderRegistry } from "./harness/registry.ts";

it("labels the current model without caching a registry snapshot", () => {
  let name = "First";
  const registry = { get: () => ({ displayName: name, driverKind: "fixture", models: { options: [{ id: "model", label: "Model" }] } }) } as unknown as Pick<ProviderRegistry, "get">;
  const label = createModelName(registry);
  expect(label({ instanceId: "fixture", model: "model" })).toBe("First · Model");
  name = "Second";
  expect(label({ instanceId: "fixture", model: "model" })).toBe("Second · Model");
  expect(createModelName({ get: () => null })({ instanceId: "absent", model: "raw" })).toBe("raw");
});

it("reports only direct model endpoints and removes URL credentials", () => {
  expect(directModelUrl("openai-compat", { url: "https://fixture:fake@example.test/api?key=fake#fragment" })).toBe("https://example.test/api");
  expect(directModelUrl("claudeAgent", { url: "https://example.test/api" })).toBeUndefined();
  expect(directModelUrl("openai-compat", { url: "file:///fixture" })).toBeUndefined();
});
