import { describe, expect, it } from "vitest";

import { BROKERED_PROVIDERS, brokerRewrite, usableUpstream } from "./broker-env.ts";

const token = `omb_t0_${"a".repeat(48)}`;

describe("the broker's rewrite of a spawn's environment", () => {
  it("replaces each provider key with the token and points its base URL at the broker, keeping the real key in the grant", () => {
    const { env, grants, unbrokered } = brokerRewrite({
      PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-ant-real", OPENAI_API_KEY: "sk-openai-real", OPENAI_BASE_URL: "https://openrouter.ai/api/v1/",
      GEMINI_API_KEY: "gm-real", XAI_API_KEY: "xai-real", OMB_COMMS_TOKEN: "cap",
    }, token, 18080);
    expect(env).toEqual({
      PATH: "/usr/bin", OMB_COMMS_TOKEN: "cap", XAI_API_KEY: "xai-real",
      ANTHROPIC_API_KEY: token, ANTHROPIC_BASE_URL: `http://127.0.0.1:18080/b/${token}/anthropic`,
      OPENAI_API_KEY: token, OPENAI_BASE_URL: `http://127.0.0.1:18080/b/${token}/openai`,
      GEMINI_API_KEY: token, GOOGLE_GEMINI_BASE_URL: `http://127.0.0.1:18080/b/${token}/gemini`,
    });
    expect(grants).toEqual({
      anthropic: { upstream: "https://api.anthropic.com", headers: { "x-api-key": "sk-ant-real" } },
      openai: { upstream: "https://openrouter.ai/api/v1", headers: { authorization: "Bearer sk-openai-real" } },
      gemini: { upstream: "https://generativelanguage.googleapis.com", headers: { "x-goog-api-key": "gm-real" } },
    });
    expect(unbrokered).toEqual(["XAI_API_KEY"]);
    for (const key of ["sk-ant-real", "sk-openai-real", "gm-real"]) expect(JSON.stringify(env)).not.toContain(key);
  });

  it("changes nothing without a key, and leaves a token or a broker address alone", () => {
    expect(brokerRewrite({ PATH: "/usr/bin", ANTHROPIC_BASE_URL: "https://proxy.example" }, token, 1)).toEqual({ env: { PATH: "/usr/bin", ANTHROPIC_BASE_URL: "https://proxy.example" }, grants: {}, unbrokered: [] });
    const already = { ANTHROPIC_API_KEY: token, ANTHROPIC_BASE_URL: `http://127.0.0.1:18080/b/${token}/anthropic` };
    expect(brokerRewrite(already, `omb_t0_${"b".repeat(48)}`, 18080)).toEqual({ env: already, grants: {}, unbrokered: [] });
    const looped = { ANTHROPIC_API_KEY: "sk-real", ANTHROPIC_BASE_URL: `http://127.0.0.1:18080/b/${token}/anthropic` };
    expect(brokerRewrite(looped, token, 18080).grants).toEqual({});
  });

  it("a bearer-style Anthropic token and a bad base URL", () => {
    const { env, grants } = brokerRewrite({ ANTHROPIC_AUTH_TOKEN: "oauth-real", ANTHROPIC_BASE_URL: "ftp://x" }, token, 2);
    expect(grants).toEqual({ "anthropic-token": { upstream: "https://api.anthropic.com", headers: { authorization: "Bearer oauth-real" } } });
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe(token);
    expect(usableUpstream("https://u:p@host/", "https://d")).toBe("https://d");
    expect(usableUpstream("https://host/v1/", "https://d")).toBe("https://host/v1");
    expect(usableUpstream(undefined, "https://d")).toBe("https://d");
    expect(BROKERED_PROVIDERS.map((provider) => provider.name)).toEqual(["anthropic", "anthropic-token", "openai", "gemini", "google"]);
  });
});
