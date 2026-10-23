import { describe, expect, it } from "vitest";

import type { ConfigSection } from "@/components/ApiKeys";
import { BOT_ROLES } from "@/lib/bot-roles";
import { BUILT_IN_INSTANCE_DRIVERS } from "@/lib/built-in-instances";
import { CURATED_CONNECTOR_SLUGS } from "../../shared/connector-curated";
import { CREDENTIAL_TARGETS } from "../../shared/credential-request";
import { TOOL_SCOPE_SUPPORT } from "../../shared/tool-scope-support";
import {
  allow, APP, BOT_TEMPLATE, credentialProvider, ENGINE, engineForDriver, engineSlug, KEY_PROVIDER, SECTION_PROVIDER,
} from "./analytics-allowlist";

const HOSTILE = [
  "Boat", "BOAT", " boat", "boat ", "", "__proto__", "constructor", "toString", "hasOwnProperty", "prototype",
  "https://evil.example.com/boat", "evil.example.com", "ada@example.com", "sk-ant-api03-ZZtestSECRET0123456789", "boat_abc123",
  42, 0, true, null, undefined, {}, ["boat"], Object.create(null),
];

describe("allow", () => {
  it("passes a value only when its list has it", () => {
    expect(allow("boat", KEY_PROVIDER)).toBe("boat");
    expect(allow("gmail", APP)).toBe("gmail");
    for (const value of HOSTILE) expect(allow(value, KEY_PROVIDER), JSON.stringify(value) ?? "undefined").toBe("other");
  });
});

describe("engine slugs", () => {
  it("names every built-in driver kind, each with its own slug", () => {
    const slugs = Object.keys(TOOL_SCOPE_SUPPORT).map(engineForDriver);
    expect(slugs).not.toContain("other");
    expect(new Set(slugs).size).toBe(slugs.length);
    expect([...slugs].sort()).toEqual([...ENGINE].sort());
  });

  it("maps an instance through its driver, never sending the instance id or its name", () => {
    const instances = [
      { instanceId: "claude-3f0c2b1e-9d1a-4c55-8a51-0a3a6f1e2b7c", driverKind: "claudeAgent" },
      { instanceId: "Ada's work Claude", driverKind: "claudeAgent" },
      { instanceId: "chatgpt-7b2d1c3e-1111-4c55-8a51-0a3a6f1e2b7c", driverKind: "codex" },
      { instanceId: "openai-compat-0a3a6f1e-2b7c-4c55-8a51-3f0c2b1e9d1a", driverKind: "openai-compat" },
      { instanceId: "grok", driverKind: "grok" },
      { instanceId: "future", driverKind: "someFutureDriver" },
      { instanceId: "proto", driverKind: "__proto__" },
    ];
    expect(engineSlug(instances, "claude-3f0c2b1e-9d1a-4c55-8a51-0a3a6f1e2b7c")).toBe("claude");
    expect(engineSlug(instances, "Ada's work Claude")).toBe("claude");
    expect(engineSlug(instances, "chatgpt-7b2d1c3e-1111-4c55-8a51-0a3a6f1e2b7c")).toBe("codex");
    expect(engineSlug(instances, "openai-compat-0a3a6f1e-2b7c-4c55-8a51-3f0c2b1e9d1a")).toBe("openai_compat");
    expect(engineSlug(instances, "grok")).toBe("grok_api");
    for (const instanceId of ["future", "proto", "missing", undefined, null, 7]) expect(engineSlug(instances, instanceId)).toBe("other");
    for (const value of HOSTILE) expect(engineForDriver(value)).toBe("other");
  });

  it("names a built-in instance's engine for a viewer who cannot list instances, and nothing else", () => {
    expect(engineSlug([], "claude")).toBe("claude");
    expect(engineSlug([], "chatgpt")).toBe("codex");
    expect(engineSlug([], "xaiApi")).toBe("grok_api");
    expect(engineSlug([], "openrouter")).toBe("openai_compat");
    expect(engineSlug([], "gemini")).toBe("gemini");
    for (const instanceId of ["claude-3f0c2b1e-9d1a-4c55-8a51-0a3a6f1e2b7c", "Ada's work Claude", "company-claude", "__proto__", "toString", "constructor", ""]) {
      expect(engineSlug([], instanceId), instanceId).toBe("other");
    }
    for (const [instanceId, driverKind] of Object.entries(BUILT_IN_INSTANCE_DRIVERS)) expect(engineSlug([], instanceId), instanceId).toBe(engineForDriver(driverKind));
    expect(Object.values(BUILT_IN_INSTANCE_DRIVERS).map(engineForDriver)).not.toContain("other");
  });
});

describe("app, role and key lists", () => {
  it("knows the curated Composio apps and the built-in roles", () => {
    expect(APP).toEqual([...CURATED_CONNECTOR_SLUGS]);
    expect(BOT_TEMPLATE).toEqual(BOT_ROLES.map((role) => role.id));
    expect(BOT_TEMPLATE).toEqual(["assistant", "inbox", "research", "coder", "community", "ops"]);
  });

  it("names a provider for every Settings key row", () => {
    const rows = {
      composio: "composio", box: "boat", opencodeGo: "opencode_go", anthropic: "anthropic", openai: "openai",
      openrouter: "openrouter", openaiCompat: "openai_compat", xai: "xai", mistral: "mistral", cerebras: "cerebras",
      groq: "groq", meta: "meta", treg: "treg", deepseek: "deepseek",
    } satisfies Record<ConfigSection, string>;
    for (const [section, provider] of Object.entries(rows)) {
      expect(SECTION_PROVIDER[section as ConfigSection]).toBe(provider);
      expect(KEY_PROVIDER).toContain(provider);
    }
  });

  it("names a provider for every credential a bot can ask for in chat, and nothing else", () => {
    const expected = {
      boxToken: "boat", xaiApiKey: "xai", opencodeGoApiKey: "opencode_go", ttsKey: "elevenlabs", fishAudioKey: "fish_audio",
      openaiImageApiKey: "openai_image",
      onePasswordToken: "onepassword",
    };
    expect(Object.keys(expected).sort()).toEqual(Object.keys(CREDENTIAL_TARGETS).sort());
    for (const [target, provider] of Object.entries(expected)) expect(credentialProvider(target)).toBe(provider);
    for (const value of HOSTILE) expect(credentialProvider(value)).toBe("other");
  });
});
