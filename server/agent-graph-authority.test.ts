import { describe, expect, it } from "vitest";

import { graphAuthorityDigest } from "./agent-graph-authority.ts";

const base = {
  sourceSha: "a".repeat(40),
  release: "0.1.28",
  instanceId: "claude",
  engine: "claudeAgent",
  providerVersion: "2.1.232",
  cli: "/usr/local/bin/claude",
  cliIdentity: `sha256:${"f".repeat(64)}`,
  providerConfig: { cli: "/usr/local/bin/claude", permissionMode: "acceptEdits", apiKey: "secret-a" },
  environment: {
    ANTHROPIC_BASE_URL: "https://provider-a.test",
    CLAUDE_API_KEY: "secret-a",
  },
  capabilities: { approvalBroker: true, fullTaskScoped: true },
};

describe("agent graph authority digest", () => {
  it("changes on source, release, provider version, config, or enforcement drift", () => {
    const original = graphAuthorityDigest(base);
    for (const changed of [
      { ...base, sourceSha: "b".repeat(40) },
      { ...base, release: "0.1.29" },
      { ...base, providerVersion: "2.1.233" },
      { ...base, cli: "/opt/claude" },
      { ...base, cliIdentity: `sha256:${"0".repeat(64)}` },
      { ...base, providerConfig: { ...base.providerConfig, permissionMode: "auto" } },
      { ...base, environment: { ...base.environment, ANTHROPIC_BASE_URL: "https://provider-b.test" } },
      { ...base, capabilities: { ...base.capabilities, approvalBroker: false } },
    ]) expect(graphAuthorityDigest(changed)).not.toBe(original);
  });

  it("does not turn credential values into an authority fingerprint oracle", () => {
    expect(graphAuthorityDigest(base)).toBe(graphAuthorityDigest({
      ...base,
      providerConfig: { ...base.providerConfig, apiKey: "secret-b" },
    }));
    expect(graphAuthorityDigest(base)).toBe(graphAuthorityDigest({
      ...base,
      environment: { ...base.environment, CLAUDE_API_KEY: "secret-b" },
    }));
  });

  it("binds secret presence but not secret values, including case variants", () => {
    const withoutSecret = {
      ...base,
      environment: { ANTHROPIC_BASE_URL: base.environment.ANTHROPIC_BASE_URL },
    };
    const emptySecret = {
      ...base,
      environment: { ...withoutSecret.environment, cLaUdE_ApI_KeY: "" },
    };
    const configuredSecret = {
      ...base,
      environment: { ...withoutSecret.environment, cLaUdE_ApI_KeY: "secret-c" },
    };

    expect(graphAuthorityDigest(emptySecret)).not.toBe(graphAuthorityDigest(configuredSecret));
    expect(graphAuthorityDigest(configuredSecret)).toBe(graphAuthorityDigest({
      ...configuredSecret,
      environment: { ...configuredSecret.environment, cLaUdE_ApI_KeY: "secret-d" },
    }));
  });

  it("binds complete non-secret values and every environment entry", () => {
    const manyEntries = Object.fromEntries(
      Array.from({ length: 300 }, (_, index) => [`SETTING_${String(index).padStart(3, "0")}`, `value-${index}`]),
    );
    const original = {
      ...base,
      environment: { ...manyEntries, LONG_SETTING: `prefix-${"a".repeat(3_000)}` },
    };

    expect(graphAuthorityDigest(original)).not.toBe(graphAuthorityDigest({
      ...original,
      environment: { ...original.environment, SETTING_299: "changed" },
    }));
    expect(graphAuthorityDigest(original)).not.toBe(graphAuthorityDigest({
      ...original,
      environment: { ...original.environment, LONG_SETTING: `prefix-${"a".repeat(2_999)}b` },
    }));
  });
});
