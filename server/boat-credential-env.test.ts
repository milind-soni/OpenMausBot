import { describe, expect, it } from "vitest";

import { boatCredentialEnv } from "./boat.ts";
import type { AppConfig } from "./config.ts";

// The boat is created with `noEnv: true`, so the only keys its agents ever see
// are the ones this OpenMausBot forwards. Forward exactly what the user
// already configured here; never invent, never leak unrelated variables.
describe("boatCredentialEnv", () => {
  it("forwards the workspace Anthropic key and the known agent keys from the environment", () => {
    const cfg = { anthropic: { key: " sk-ant-workspace " } } as AppConfig;
    const env = {
      OPENAI_API_KEY: "sk-openai",
      DEEPSEEK_API_KEY: "sk-deepseek",
      XAI_API_KEY: "xai-not-a-box-key",
      OMB_BROWSER_CONNECTION: "private",
      CLAUDE_CODE_OAUTH_TOKEN: "",
    };
    expect(boatCredentialEnv(cfg, env)).toEqual({
      ANTHROPIC_API_KEY: "sk-ant-workspace",
      OPENAI_API_KEY: "sk-openai",
      DEEPSEEK_API_KEY: "sk-deepseek",
    });
  });

  it("is empty when nothing is configured, so the create body carries no env", () => {
    expect(boatCredentialEnv({} as AppConfig, {})).toEqual({});
  });

  it("never forwards Cloud Pro's included relay tokens into a computer's environment", () => {
    const env = {
      OPENAI_API_KEY: "sk-openai",
      OMB_CLOUD_BOAT_URL: "https://cloud.example.test/api/cloud/services/boat/api/box/v1",
      OMB_CLOUD_BOAT_TOKEN: "box_omb_included-relay-token",
      OMB_CLOUD_VOICE_URL: "https://cloud.example.test/api/cloud/services/voice/v1",
      OMB_CLOUD_VOICE_TOKEN: "omb_voice_included-relay-token",
    };
    expect(boatCredentialEnv({} as AppConfig, env)).toEqual({ OPENAI_API_KEY: "sk-openai" });
  });

  it("never forwards an ANTHROPIC_API_KEY from the server's own environment (only the workspace key)", () => {
    expect(boatCredentialEnv({} as AppConfig, { ANTHROPIC_API_KEY: "sk-ant-stray" })).toEqual({});
  });
});
