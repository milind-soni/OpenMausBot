import { expect, it, vi } from "vitest";
import type { InstanceConfig } from "./contracts.ts";
import { discoverAgentEndpointModels, officialModels } from "./agent-endpoint-models.ts";

function endpoint(codex: boolean, url = "https://gateway.example/v1"): InstanceConfig {
  return codex
    ? { driver: "codex", config: { endpoint: { url, models: ["old"] } }, environment: { OPENMAUSBOT_CODEX_API_KEY: "fixture-secret" } }
    : { driver: "claudeAgent", config: { endpointModels: ["old"] }, environment: { ANTHROPIC_BASE_URL: url, ANTHROPIC_API_KEY: "fixture-secret" } };
}
it.each([true, false])("discovers valid, unique per-agent model choices (Codex=%s)", async codex => {
  const entry = endpoint(codex);
  const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: [{ id: "model-a" }, { id: "model-b" }, { id: "model-a" }, { id: "invalid model" }, {}] }));
  await discoverAgentEndpointModels(entry, request);
  expect(request).toHaveBeenCalledWith("https://gateway.example/v1/models", expect.objectContaining({ redirect: "manual", signal: expect.any(AbortSignal), headers: expect.objectContaining({ authorization: "Bearer fixture-secret", ...(codex ? {} : { "x-api-key": "fixture-secret", "anthropic-version": "2023-06-01" }) }) }));
  expect(entry.config).toMatchObject(codex ? { endpoint: { models: ["model-a", "model-b"] } } : { endpointModels: ["model-a", "model-b"] });
  expect(entry.environment).not.toHaveProperty("ANTHROPIC_MODEL");
});
it.each([
  [new Response("fixture-secret", { status: 401 }), "rejected the API key (HTTP 401)"],
  [new Response("fixture-secret", { status: 403 }), "rejected the API key (HTTP 403)"],
  [new Response("fixture-secret", { status: 404 }), "model catalog was not found (HTTP 404)"],
  [new Response("fixture-secret", { status: 302 }), "redirected the model request"],
  [new Response("fixture-secret", { status: 500 }), "model request failed (HTTP 500)"],
  [new Response("fixture-secret"), "did not return a JSON model catalog"],
  [Response.json({ data: [] }), "returned no supported model IDs"],
])("explains discovery failures without exposing gateway response bodies", async (response, detail) => {
  const entry = endpoint(true);
  const failure = await discoverAgentEndpointModels(entry, vi.fn<typeof fetch>().mockResolvedValue(response as Response)).catch(error => error);
  expect(failure.message).toContain(detail);
  expect(failure.message).not.toContain("fixture-secret");
  expect(failure.status).toBe(400);
  expect(entry.config).toMatchObject({ endpoint: { models: ["old"] } });
});
it.each([
  ["http://localhost:8317/v1", "localhost refers to OpenMausBot's server or container"],
  ["https://gateway.example/v1", "could not reach the gateway"],
])("explains network failures for %s without exposing raw exceptions", async (url, detail) => {
  const failure = await discoverAgentEndpointModels(endpoint(true, url), vi.fn<typeof fetch>().mockRejectedValue(new Error("fixture-secret"))).catch(error => error);
  expect(failure.message).toContain(detail);
  expect(failure.message).not.toContain("fixture-secret");
});
it("identifies a model discovery timeout", async () => {
  await expect(discoverAgentEndpointModels(endpoint(true), vi.fn<typeof fetch>().mockRejectedValue(new DOMException("fixture-secret", "TimeoutError"))))
    .rejects.toThrow("timed out");
});
it.each([true, false])("keeps the standard catalog for official connections (Codex=%s)", async codex => {
  const entry = endpoint(codex, codex ? "https://api.openai.com/v1" : "https://api.anthropic.com");
  const request = vi.fn<typeof fetch>();
  await discoverAgentEndpointModels(entry, request);
  expect(request).not.toHaveBeenCalled();
});
it.each([true, false])("restores the standard catalog when a gateway moves to the official URL (Codex=%s)", async codex => {
  const entry = endpoint(codex, codex ? "https://api.openai.com/v1" : "https://api.anthropic.com");
  await discoverAgentEndpointModels(entry, vi.fn<typeof fetch>());
  const models = codex ? (entry.config as any).endpoint.models : (entry.config as any).endpointModels;
  expect(models).toEqual(officialModels(codex));
  expect(models).not.toContain("old");
});
it("refuses a catalog larger than 2 MB without parsing it", async () => {
  const entry = endpoint(true);
  const huge = new Response(`{"data":[${'{"id":"m"},'.repeat(300_000)}{"id":"m"}]}`);
  await expect(discoverAgentEndpointModels(entry, vi.fn<typeof fetch>().mockResolvedValue(huge))).rejects.toThrow("larger than 2 MB");
  expect(entry.config).toMatchObject({ endpoint: { models: ["old"] } });
});
it("keeps at most 1,000 models", async () => {
  const entry = endpoint(true);
  const data = Array.from({ length: 1500 }, (_, index) => ({ id: `model-${index}` }));
  await discoverAgentEndpointModels(entry, vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data })));
  expect((entry.config as any).endpoint.models).toHaveLength(1000);
});
it("never offers Claude Code's reserved `default` as a gateway model", async () => {
  const entry = endpoint(false);
  await discoverAgentEndpointModels(entry, vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: [{ id: "default" }, { id: "model-a" }] })));
  expect((entry.config as any).endpointModels).toEqual(["model-a"]);
});
it("explains a gateway that drops the connection mid-catalog without exposing the error", async () => {
  const entry = endpoint(true);
  const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"data":[')); controller.error(new Error("fixture-secret")); } });
  const failure = await discoverAgentEndpointModels(entry, vi.fn<typeof fetch>().mockResolvedValue(new Response(body))).catch(error => error);
  expect(failure.message).toContain("closed the connection while sending its model catalog");
  expect(failure.message).not.toContain("fixture-secret");
  expect(failure.status).toBe(400);
});
