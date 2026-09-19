import { afterEach, describe, expect, it, vi } from "vitest";
import type { InstanceConfig } from "./contracts.ts";
import { openAIConnectionMetadata, prepareOpenAIConnection, probeOpenAIConnection } from "./openai-connections.ts";

const connection = (key = "fixture-key"): InstanceConfig => ({
  driver: "openai-compat", displayName: "Research provider", config: {
    auth: "bearer", url: "https://provider.example/v1", key, model: "shared/model", tools: false,
  },
});
const draft = { displayName: "Local model", auth: "none", url: "http://127.0.0.1:1234/v1" };
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("independent OpenAI-compatible connections", () => {
  it("redacts key values while distinguishing saved configuration from validation", () => {
    expect(openAIConnectionMetadata("research", connection())).toEqual({
      instanceId: "research", displayName: "Research provider", url: "https://provider.example/v1",
      auth: "bearer", configured: true, model: "shared/model", tools: false, provider: "", legacy: false,
    });
    expect(JSON.stringify(openAIConnectionMetadata("research", connection()))).not.toContain("fixture-key");
  });

  it("shows legacy effective credentials without copying them into a public view", () => {
    vi.stubEnv("OPENAI_COMPAT_API_KEY", "global-key");
    const legacy: InstanceConfig = { driver: "openai-compat", environment: { OPENAI_COMPAT_API_KEY: "saved-key" } };
    expect(openAIConnectionMetadata("openaiCompat", legacy)).toMatchObject({ configured: true, legacy: true });
    expect(prepareOpenAIConnection({ displayName: "Migrated" }, legacy).config).toMatchObject({ auth: "bearer", key: "saved-key" });
    expect(openAIConnectionMetadata("research", connection("")).configured).toBe(false);
  });

  it("creates an explicit keyless connection without inherited key, model, or routing", () => {
    vi.stubEnv("OPENAI_COMPAT_API_KEY", "global-key");
    vi.stubEnv("OPENAI_COMPAT_MODEL", "global-model");
    vi.stubEnv("OPENAI_COMPAT_PROVIDER", "global-routing");
    expect(prepareOpenAIConnection(draft)).toEqual({
      driver: "openai-compat", displayName: "Local model",
      config: { auth: "none", url: draft.url, key: "", model: "", provider: "", tools: true },
    });
    expect(openAIConnectionMetadata("local", prepareOpenAIConnection(draft))).toMatchObject({ auth: "none", configured: true, legacy: false });
  });

  it("keeps the selected endpoint key and unrelated instance configuration on a partial edit", () => {
    const original = connection();
    original.config = { ...original.config as object, secretStorage: "external", customOption: 12 };
    const updated = prepareOpenAIConnection({ displayName: "Renamed" }, original);
    expect(updated.config).toMatchObject(original.config as object);
    expect(original.displayName).toBe("Research provider");
  });

  it("requires a fresh key before binding a saved credential to a changed endpoint", () => {
    expect(() => prepareOpenAIConnection({ url: "https://other.example/v1" }, connection())).toThrow(/key again/u);
    expect(prepareOpenAIConnection({ url: "https://other.example/v1", key: "other-key" }, connection()).config)
      .toMatchObject({ key: "other-key", url: "https://other.example/v1" });
    expect(() => prepareOpenAIConnection({ key: "" }, connection())).toThrow(/key is required/u);
  });

  it("allows keyless selection to remove credentials while preserving the instance identity", () => {
    expect(prepareOpenAIConnection({ auth: "none" }, connection()).config).toMatchObject({ auth: "none", key: "" });
  });

  it.each([
    { displayName: "" }, { tools: "yes" }, { auth: "unsupported" }, { auth: null }, { key: "broken key" },
    { url: "https://user:secret@provider.example/v1" }, { provider: "provider\nother" },
  ])("rejects invalid drafts before persistence: case %#", (patch) => {
    expect(() => prepareOpenAIConnection(patch, connection())).toThrow();
  });

  it("uses a saved key for a catalog probe and identifies only catalog access", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: "model-a" }] })));
    vi.stubGlobal("fetch", fetch);
    await expect(probeOpenAIConnection({ kind: "catalog" }, connection())).resolves.toEqual({ ok: true, check: "models", models: ["model-a"] });
    expect(fetch).toHaveBeenCalledWith("https://provider.example/v1/models", expect.objectContaining({ headers: { authorization: "Bearer fixture-key" }, redirect: "error" }));
  });

  it("never probes a changed draft URL using a retained secret", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(probeOpenAIConnection({ kind: "catalog", url: "https://other.example/v1" }, connection())).rejects.toThrow(/key again/u);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends keyless response probes without any Authorization header or echoed reply", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "private reply" } }] })));
    vi.stubGlobal("fetch", fetch);
    await expect(probeOpenAIConnection({ ...draft, kind: "response", model: "local-model" })).resolves.toEqual({ ok: true, check: "response", models: ["local-model"] });
    expect(fetch.mock.calls[0][1]?.headers).toEqual({ "content-type": "application/json" });
  });
});
