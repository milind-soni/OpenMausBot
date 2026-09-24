import { afterEach, expect, it, vi } from "vitest";
import { GrokDriver } from "./grok.ts";

afterEach(() => vi.unstubAllGlobals());

it("uses the authenticated xAI language-model catalog and excludes non-text models", async () => {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ models: [
    { id: "grok-next", output_modalities: ["text"] },
    { id: "grok-image", output_modalities: ["image"] },
  ] }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  const instance = await GrokDriver.create({
    instanceId: "xai-test", displayName: "xAI", enabled: true,
    environment: { XAI_API_KEY: "test-secret" },
    config: { url: "https://example.invalid/v1", apiKeyEnv: "XAI_API_KEY" },
  });
  expect(await instance.discoverModels?.()).toEqual({
    default: "grok-next", options: [{ id: "grok-next", label: "grok-next" }],
  });
  expect(fetchMock.mock.calls[0][0]).toBe("https://example.invalid/v1/language-models");
  await instance.dispose();
});
