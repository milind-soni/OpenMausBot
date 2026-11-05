import { expect, it, vi } from "vitest";
import type { InstanceConfig } from "./contracts.ts";
import { discoverAgentEndpointModels } from "./agent-endpoint-models.ts";

function endpoint(codex: boolean, url = "https://gateway.example/v1"): InstanceConfig {
  return codex
    ? { driver: "codex", config: { endpoint: { url, models: ["old"] } }, environment: { OPENMAUSBOT_CODEX_API_KEY: "fixture-secret" } }
    : { driver: "claudeAgent", config: { endpointModels: ["old"] }, environment: { ANTHROPIC_BASE_URL: url, ANTHROPIC_API_KEY: "fixture-secret" } };
}
it.each([true, false])("discovers valid, unique per-agent model choices (Codex=%s)", async codex => {
  const entry = endpoint(codex);
  const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: [{ id: "model-a" }, { id: "model-b" }, { id: "model-a" }, { id: "invalid model" }, {}] }));
  await discoverAgentEndpointModels(entry, request);
  expect(request).toHaveBeenCalledWith("https://gateway.example/v1/models", expect.objectContaining({ redirect: "manual", signal: expect.any(AbortSignal), headers: expect.objectContaining({ authorization: "Bearer fixture-secret" }) }));
  expect(entry.config).toMatchObject(codex ? { endpoint: { models: ["model-a", "model-b"] } } : { endpointModels: ["model-a", "model-b"] });
  expect(entry.environment).not.toHaveProperty("ANTHROPIC_MODEL");
});
it.each([Response.json({ data: [] }), new Response("secret", { status: 302 }), new Response("secret", { status: 401 })])("rejects failed or empty discovery without exposing credentials", async response => {
  const entry = endpoint(true);
  await expect(discoverAgentEndpointModels(entry, vi.fn<typeof fetch>().mockResolvedValue(response))).rejects.toThrow("Could not discover gateway models");
  expect(entry.config).toMatchObject({ endpoint: { models: ["old"] } });
});
it.each([true, false])("keeps the standard catalog for official connections (Codex=%s)", async codex => {
  const entry = endpoint(codex, codex ? "https://api.openai.com/v1" : "https://api.anthropic.com");
  const request = vi.fn<typeof fetch>();
  await discoverAgentEndpointModels(entry, request);
  expect(request).not.toHaveBeenCalled();
});
