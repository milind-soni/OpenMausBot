import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import {
  claudeEndpointSchema,
  claudeEndpointUpdateSchema,
  claudeEndpointInfo,
  isClaudeEndpoint,
  newClaudeEndpoint,
  updateClaudeEndpoint,
  withClaudeEndpointInfo,
} from "./claude-endpoints.ts";
import { ClaudeDriver } from "./drivers/claude.ts";

const BASE = {
  displayName: "DeepSeek",
  baseUrl: "https://api.deepseek.com/anthropic/",
  token: "sk-fixture-secret",
  model: "deepseek-chat",
};

const cfg = () => ({
  instances: {
    claude: { driver: "claudeAgent", environment: { ANTHROPIC_AUTH_TOKEN: "parent-secret" }, config: { cli: "claude-wrapper" } },
    other: { driver: "codex", config: { cli: "codex-wrapper" } },
  },
}) as never;

describe("custom Claude endpoint", () => {
  it("uses the official Anthropic API key header without a bearer token", () => {
    const { instanceId, instances } = newClaudeEndpoint(cfg(), { ...BASE, baseUrl: "https://api.anthropic.com", model: "claude-sonnet-5" });
    expect(instances[instanceId].environment?.ANTHROPIC_API_KEY).toBe(BASE.token);
    expect(instances[instanceId].environment?.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it("creates its own instance with the endpoint's routing, its own directory and no parent credentials", () => {
    const source = cfg();
    const { instanceId, instances } = newClaudeEndpoint(source, { ...BASE, opusModel: "deepseek-reasoner", sonnetModel: "" });
    const entry = instances[instanceId];

    expect(instanceId).toMatch(/^claude-[0-9a-f-]{36}$/);
    expect(entry).toMatchObject({
      driver: "claudeAgent",
      displayName: "DeepSeek",
      access: "custom",
      config: {
        cli: "claude-wrapper",
        configDir: join(DATA_DIR, "providers", instanceId),
        requireApiKey: true,
        endpointModels: ["deepseek-chat", "deepseek-reasoner"],
      },
      environment: {
        ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
        ANTHROPIC_AUTH_TOKEN: "sk-fixture-secret",
        ANTHROPIC_API_KEY: "sk-fixture-secret",
        ANTHROPIC_MODEL: "deepseek-chat",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "deepseek-reasoner",
      },
    });
    expect(entry.environment).not.toHaveProperty("ANTHROPIC_DEFAULT_SONNET_MODEL");
    // The caller's config is left as it was: the fleet is copied, not edited.
    expect(Object.keys((source as { instances: object }).instances)).toEqual(["claude", "other"]);
    expect((source as { instances: Record<string, { environment?: object }> }).instances.claude.environment).toEqual({ ANTHROPIC_AUTH_TOKEN: "parent-secret" });
    // A second endpoint never shares the account's executable environment or directory.
    const second = newClaudeEndpoint({ instances }, BASE);
    expect(second.instanceId).not.toBe(instanceId);
    expect((second.instances[instanceId] as { environment: object }).environment).toEqual(entry.environment);
  });

  it("inherits the installed binary from whichever Claude account sets one", () => {
    const { instanceId, instances } = newClaudeEndpoint({
      instances: {
        claude: { driver: "claudeAgent", config: {} },
        "claude-work": { driver: "claudeAgent", config: { cli: "/opt/claude/bin/claude" } },
      },
    } as never, BASE);
    expect((instances[instanceId].config as { cli?: string }).cli).toBe("/opt/claude/bin/claude");
  });

  it("never inherits a Bedrock engine's binary; falls back to whichever other account sets one", () => {
    const bedrockOnly = newClaudeEndpoint({
      instances: { bedrock: { driver: "claudeAgent", config: { cli: "/opt/bedrock/bin/claude", bedrock: true } } },
    } as never, BASE);
    expect((bedrockOnly.instances[bedrockOnly.instanceId].config as { cli?: string }).cli).toBeUndefined();

    const withFallback = newClaudeEndpoint({
      instances: {
        bedrock: { driver: "claudeAgent", config: { cli: "/opt/bedrock/bin/claude", bedrock: true } },
        "claude-work": { driver: "claudeAgent", config: { cli: "/opt/claude/bin/claude" } },
      },
    } as never, BASE);
    expect((withFallback.instances[withFallback.instanceId].config as { cli?: string }).cli).toBe("/opt/claude/bin/claude");
  });

  it("reports only the address and models to a client, never the token", () => {
    const { instanceId, instances } = newClaudeEndpoint(cfg(), BASE);
    const info = claudeEndpointInfo(instances[instanceId]);
    expect(info).toEqual({
      baseUrl: BASE.baseUrl.replace(/\/$/u, ""),
      models: ["deepseek-chat"],
      tokenSaved: true,
      opusModel: "", sonnetModel: "", haikuModel: "", smallFastModel: "",
    });
    const described = withClaudeEndpointInfo([{ instanceId }, { instanceId: "claude" }], instances) as Array<Record<string, unknown>>;
    expect(JSON.stringify(described)).not.toContain("sk-fixture-secret");
    expect(described[0]).toMatchObject({ url: "https://api.deepseek.com/anthropic", claudeEndpoint: { tokenSaved: true } });
    expect(described[1]).not.toHaveProperty("claudeEndpoint");
    expect(isClaudeEndpoint(instances[instanceId])).toBe(true);
    expect(isClaudeEndpoint(instances.claude)).toBe(false);
  });

  it("edits in place, keeps an omitted token, and clears a model mapping left empty", () => {
    const { instanceId, instances } = newClaudeEndpoint(cfg(), { ...BASE, opusModel: "deepseek-reasoner" });
    const updated = updateClaudeEndpoint({ instances }, instanceId, {
      model: "deepseek-reasoner",
      opusModel: "",
    });
    const entry = updated.instances[instanceId];
    expect(entry.environment).toMatchObject({
      ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
      ANTHROPIC_AUTH_TOKEN: "sk-fixture-secret",
      ANTHROPIC_MODEL: "deepseek-reasoner",
    });
    expect(entry.environment).not.toHaveProperty("ANTHROPIC_DEFAULT_OPUS_MODEL");
    expect((entry.config as { endpointModels: string[] }).endpointModels).toEqual(["deepseek-reasoner"]);
    expect(updateClaudeEndpoint({ instances: updated.instances }, instanceId, { token: "sk-replaced" })
      .instances[instanceId].environment).toMatchObject({ ANTHROPIC_AUTH_TOKEN: "sk-replaced", ANTHROPIC_API_KEY: "sk-replaced" });
    // Nothing else in the fleet moves.
    expect(updated.instances.claude).toEqual(instances.claude);
  });

  it("keeps a discovered catalog when only a model mapping changes", () => {
    const { instanceId, instances } = newClaudeEndpoint(cfg(), { ...BASE, model: undefined });
    (instances[instanceId].config as { endpointModels: string[] }).endpointModels = ["model-a", "model-b"];
    for (const opusModel of ["model-b", ""]) {
      const entry = updateClaudeEndpoint({ instances }, instanceId, { opusModel }).instances[instanceId];
      expect((entry.config as { endpointModels: string[] }).endpointModels).toEqual(["model-a", "model-b"]);
    }
  });

  it("requires the token again when the address changes", () => {
    const { instanceId, instances } = newClaudeEndpoint(cfg(), BASE);
    expect(() => updateClaudeEndpoint({ instances }, instanceId, { baseUrl: "https://api.example.test/anthropic" }))
      .toThrow(/token again for the new address/);
    const moved = updateClaudeEndpoint({ instances }, instanceId, { baseUrl: "https://api.example.test/anthropic", token: "sk-moved" });
    expect(moved.instances[instanceId].environment).toMatchObject({
      ANTHROPIC_BASE_URL: "https://api.example.test/anthropic",
      ANTHROPIC_AUTH_TOKEN: "sk-moved",
    });
    // The saved address, however written, still needs no token.
    expect(updateClaudeEndpoint({ instances }, instanceId, { baseUrl: BASE.baseUrl }).instances[instanceId].environment)
      .toMatchObject({ ANTHROPIC_AUTH_TOKEN: "sk-fixture-secret" });
  });

  it("rejects a non-endpoint Claude instance, an unknown id and an endpoint with no token", () => {
    const { instances } = newClaudeEndpoint(cfg(), BASE);
    expect(() => updateClaudeEndpoint({ instances }, "claude", { model: "deepseek-chat" })).toThrow(/not a custom endpoint/);
    expect(() => updateClaudeEndpoint({ instances }, "missing", { model: "deepseek-chat" })).toThrow(/unknown instance/);
    const stripped = { instances: { ...instances, ghost: { driver: "claudeAgent", config: { endpointModels: ["m"] }, environment: { ANTHROPIC_BASE_URL: "https://x.test" } } } };
    expect(() => updateClaudeEndpoint(stripped as never, "ghost", { model: "m" })).toThrow(/token/i);
  });

  it("validates the address, token and model ids before anything is saved", () => {
    for (const body of [
      { ...BASE, baseUrl: "ftp://api.example.test" },
      { ...BASE, baseUrl: "https://user:pass@api.example.test" },
      { ...BASE, baseUrl: "not a url" },
      { ...BASE, token: "" },
      { ...BASE, token: "has\nnewline" },
      { ...BASE, model: "has space" },
      { ...BASE, model: "" },
      { ...BASE, model: "default" },
      { ...BASE, displayName: "Bad\nname" },
      { ...BASE, environment: { ANTHROPIC_BASE_URL: "https://x.test" } },
    ]) {
      expect(claudeEndpointSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
    expect(claudeEndpointSchema.safeParse(BASE).success).toBe(true);
    expect(claudeEndpointUpdateSchema.safeParse({}).success).toBe(false);
    expect(claudeEndpointUpdateSchema.safeParse({ token: "" }).success).toBe(false);
    expect(claudeEndpointUpdateSchema.safeParse({ model: "deepseek-reasoner" }).success).toBe(true);
  });

});

describe("Claude endpoint catalog", () => {
  const decoded = (raw: Record<string, unknown>) => ClaudeDriver.decodeConfig(raw);

  it("serves only the endpoint's models, the first one the default", async () => {
    const instance = await ClaudeDriver.create({
      instanceId: "claude-endpoint-fixture",
      displayName: "DeepSeek",
      enabled: true,
      environment: {
        ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
        ANTHROPIC_AUTH_TOKEN: "sk-fixture",
        ANTHROPIC_API_KEY: "sk-fixture",
        ANTHROPIC_MODEL: "deepseek-chat",
      },
      config: decoded({ configDir: "/tmp/omb-endpoint-fixture", requireApiKey: true, endpointModels: ["deepseek-chat", "deepseek-reasoner"] }),
    });
    try {
      expect(instance.models).toEqual({
        default: "deepseek-chat",
        options: [{ id: "deepseek-chat", label: "deepseek-chat", custom: true }, { id: "deepseek-reasoner", label: "deepseek-reasoner", custom: true }],
      });
    } finally {
      await instance.dispose();
    }
  });

  it("keeps hosted model assignment and endpoint models apart", () => {
    expect(() => decoded({ managed: true, endpointModels: ["deepseek-chat"] })).toThrow(/Invalid Claude endpoint models/);
    expect(() => decoded({ managedModels: ["claude-sonnet-5"], endpointModels: ["deepseek-chat"] })).toThrow(/Invalid hosted Claude models/);
    expect(() => decoded({ endpointModels: [] })).toThrow(/Invalid Claude endpoint models/);
    expect(() => decoded({ endpointModels: ["has space"] })).toThrow(/Invalid Claude endpoint models/);
    expect(decoded({ endpointModels: ["deepseek-chat[1m]"] }).endpointModels).toEqual(["deepseek-chat[1m]"]);
  });
});