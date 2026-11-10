import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { officialModels } from "./agent-endpoint-models.ts";
import {
  claudeBedrockSchema,
  claudeBedrockUpdateSchema,
  claudeBedrockInfo,
  isClaudeBedrock,
  newClaudeBedrock,
  updateClaudeBedrock,
  withClaudeBedrockInfo,
} from "./claude-bedrock.ts";
import { isClaudeEndpoint } from "./claude-endpoints.ts";
import { DATA_DIR } from "./config.ts";

const BASE = {
  displayName: "Bedrock US",
  awsProfile: "bedrock-prod",
  awsRegion: "us-east-1",
};

const cfg = () => ({
  instances: {
    claude: { driver: "claudeAgent", environment: { ANTHROPIC_AUTH_TOKEN: "parent-secret" }, config: { cli: "claude-wrapper" } },
    other: { driver: "codex", config: { cli: "codex-wrapper" } },
  },
}) as never;

describe("Claude on Amazon Bedrock", () => {
  it("creates its own instance with Bedrock routing, its own directory and no AWS/Anthropic secret", () => {
    const source = cfg();
    const { instanceId, instances } = newClaudeBedrock(source, { ...BASE, opusModel: "global.anthropic.claude-opus-5-5" });
    const entry = instances[instanceId];

    expect(instanceId).toMatch(/^claude-[0-9a-f-]{36}$/);
    expect(entry).toMatchObject({
      driver: "claudeAgent",
      displayName: "Bedrock US",
      access: "custom",
      config: {
        cli: "claude-wrapper",
        configDir: join(DATA_DIR, "providers", instanceId),
        bedrock: true,
      },
      environment: {
        CLAUDE_CODE_USE_BEDROCK: "1",
        AWS_PROFILE: "bedrock-prod",
        AWS_REGION: "us-east-1",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "global.anthropic.claude-opus-5-5",
      },
    });
    expect(entry.environment).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(entry.environment).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
    expect(entry.environment).not.toHaveProperty("requireApiKey");
    expect((entry.config as { requireApiKey?: boolean }).requireApiKey).toBeUndefined();
    // No model named: the default catalog is every official model under Bedrock's cross-region prefix.
    expect((entry.config as { endpointModels: string[] }).endpointModels).toEqual(officialModels(false).map((id) => `global.anthropic.${id}`));
    // The caller's config is left as it was: the fleet is copied, not edited.
    expect(Object.keys((source as { instances: object }).instances)).toEqual(["claude", "other"]);
  });

  it("inherits the installed binary from whichever Claude account sets one, never a Bedrock sibling's", () => {
    const { instanceId, instances } = newClaudeBedrock({
      instances: {
        claude: { driver: "claudeAgent", config: {} },
        "claude-work": { driver: "claudeAgent", config: { cli: "/opt/claude/bin/claude" } },
        "claude-bedrock-other": { driver: "claudeAgent", config: { cli: "/opt/claude/bin/claude-bedrock-fixture", bedrock: true } },
      },
    } as never, BASE);
    expect((instances[instanceId].config as { cli?: string }).cli).toBe("/opt/claude/bin/claude");
  });

  it("uses an explicit model as the only catalog entry when none of the tiers are set", () => {
    const { instanceId, instances } = newClaudeBedrock(cfg(), { ...BASE, model: "global.anthropic.claude-sonnet-5-5" });
    expect((instances[instanceId].config as { endpointModels: string[] }).endpointModels).toEqual(["global.anthropic.claude-sonnet-5-5"]);
    expect(instances[instanceId].environment?.ANTHROPIC_MODEL).toBe("global.anthropic.claude-sonnet-5-5");
  });

  it("reports only the profile, region and models to a client; never an AWS or Anthropic secret", () => {
    const { instanceId, instances } = newClaudeBedrock(cfg(), { ...BASE, model: "global.anthropic.claude-sonnet-5-5" });
    const info = claudeBedrockInfo(instances[instanceId]);
    expect(info).toEqual({
      awsProfile: "bedrock-prod",
      awsRegion: "us-east-1",
      models: ["global.anthropic.claude-sonnet-5-5"],
      opusModel: "", sonnetModel: "", haikuModel: "", smallFastModel: "",
    });
    const described = withClaudeBedrockInfo([{ instanceId }, { instanceId: "claude" }], instances) as Array<Record<string, unknown>>;
    expect(JSON.stringify(described)).not.toMatch(/AKIA|aws_secret|session_token/i);
    expect(described[0]).toMatchObject({ claudeBedrock: { awsProfile: "bedrock-prod", awsRegion: "us-east-1" } });
    expect(described[0]).not.toHaveProperty("url");
    expect(described[1]).not.toHaveProperty("claudeBedrock");
    expect(isClaudeBedrock(instances[instanceId])).toBe(true);
    expect(isClaudeBedrock(instances.claude)).toBe(false);
  });

  it("is never mistaken for a custom endpoint, even though both set endpointModels", () => {
    const { instanceId, instances } = newClaudeBedrock(cfg(), BASE);
    expect(isClaudeEndpoint(instances[instanceId])).toBe(false);
    expect(isClaudeBedrock(instances[instanceId])).toBe(true);
  });

  it("edits in place; an omitted field keeps its saved profile, region and models", () => {
    const { instanceId, instances } = newClaudeBedrock(cfg(), { ...BASE, opusModel: "global.anthropic.claude-opus-5-5" });
    const updated = updateClaudeBedrock({ instances }, instanceId, { awsRegion: "eu-west-1" });
    const entry = updated.instances[instanceId];
    expect(entry.environment).toMatchObject({
      AWS_PROFILE: "bedrock-prod",
      AWS_REGION: "eu-west-1",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "global.anthropic.claude-opus-5-5",
    });
    // Nothing else in the fleet moves.
    expect(updated.instances.claude).toEqual(instances.claude);
  });

  it("clears a model tier left empty", () => {
    const { instanceId, instances } = newClaudeBedrock(cfg(), { ...BASE, opusModel: "global.anthropic.claude-opus-5-5" });
    const updated = updateClaudeBedrock({ instances }, instanceId, { opusModel: "" });
    expect(updated.instances[instanceId].environment).not.toHaveProperty("ANTHROPIC_DEFAULT_OPUS_MODEL");
  });

  it("rejects a non-Bedrock Claude instance and an unknown id", () => {
    const { instances } = newClaudeBedrock(cfg(), BASE);
    expect(() => updateClaudeBedrock({ instances }, "claude", { awsRegion: "eu-west-1" })).toThrow(/not an Amazon Bedrock engine/);
    expect(() => updateClaudeBedrock({ instances }, "missing", { awsRegion: "eu-west-1" })).toThrow(/unknown instance/);
  });

  it("validates the profile, region, display name and model ids before anything is saved", () => {
    for (const body of [
      { ...BASE, awsProfile: "" },
      { ...BASE, awsProfile: "has space" },
      { ...BASE, awsRegion: "not-a-region" },
      { ...BASE, awsRegion: "US-EAST-1" },
      { ...BASE, model: "has space" },
      { ...BASE, model: "" },
      { ...BASE, model: "default" },
      { ...BASE, displayName: "Bad\nname" },
      { ...BASE, displayName: "" },
      { ...BASE, token: "sk-should-not-exist" },
    ]) {
      expect(claudeBedrockSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
    expect(claudeBedrockSchema.safeParse(BASE).success).toBe(true);
    expect(claudeBedrockUpdateSchema.safeParse({}).success).toBe(false);
    expect(claudeBedrockUpdateSchema.safeParse({ awsRegion: "not-a-region" }).success).toBe(false);
    expect(claudeBedrockUpdateSchema.safeParse({ awsRegion: "eu-west-1" }).success).toBe(true);
  });
});
