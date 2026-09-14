import { describe, expect, it } from "vitest";

import { boxCredentialEnv } from "./box.ts";
import type { AppConfig } from "./config.ts";

// The box is created with `noEnv: true`, so the only keys its agents ever see
// are the ones this OpenMausBot forwards. Forward exactly what the user
// already configured here; never invent, never leak unrelated variables.
describe("boxCredentialEnv", () => {
  it("forwards the workspace Anthropic key and the known agent keys from the environment", () => {
    const cfg = { anthropic: { key: " sk-ant-workspace " } } as AppConfig;
    const env = {
      OPENAI_API_KEY: "sk-openai",
      DEEPSEEK_API_KEY: "sk-deepseek",
      XAI_API_KEY: "xai-not-a-box-key",
      OMB_BROWSER_CONNECTION: "private",
      CLAUDE_CODE_OAUTH_TOKEN: "",
    };
    expect(boxCredentialEnv(cfg, env)).toEqual({
      ANTHROPIC_API_KEY: "sk-ant-workspace",
      OPENAI_API_KEY: "sk-openai",
      DEEPSEEK_API_KEY: "sk-deepseek",
    });
  });

  it("is empty when nothing is configured, so the create body carries no env", () => {
    expect(boxCredentialEnv({} as AppConfig, {})).toEqual({});
  });

  it("never forwards an ANTHROPIC_API_KEY from the server's own environment (only the workspace key)", () => {
    expect(boxCredentialEnv({} as AppConfig, { ANTHROPIC_API_KEY: "sk-ant-stray" })).toEqual({});
  });
});
